/**
 * Credential byte-exactness across the password-auth routes.
 *
 * The body-shape helper `requireStringField` gained an opt-in `trim` flag. The
 * load-bearing invariant this test pins: the bytes `argon2.verify` sees for a
 * `password` on the custody re-auth routes (`/fresh-auth`, `/session-auth`)
 * MUST equal the bytes that were hashed at credential-set time and the bytes
 * `/login` verifies against. `password` is read with the default (NO-trim)
 * behaviour; the identifier/slug fields are read with `trim: true`. A
 * regression that trims the password input on either custody route would make
 * a whitespace-bearing credential authenticate at `/login` (raw verify) but be
 * rejected at `/fresh-auth` + `/session-auth` (trimmed verify) — a real
 * lockout from consent broadcasts and critical-action re-auth.
 *
 * The account is seeded with `password_hash = argon2.hash(<edge-whitespace
 * password>)`, modelling a credential whose stored hash was computed over the
 * raw, untrimmed value (signup / set-password / recover all hash the raw
 * password; `isPasswordValid` does not strip surrounding whitespace). The test
 * then sends the SAME byte-exact password to all three routes and asserts each
 * accepts it.
 *
 * Carve-out (root CLAUDE.md "Running Tests"):
 *   (a) Why mocking is used: `../../src/hive.js` broadcast helpers and
 *       `../../src/custody-crypto.js` `decryptKey` are mocked (third-party /
 *       chain surfaces non-trivial to run for real per-test), matching the
 *       sibling `custody-session-auth.test.ts`. No proof is broadcast here;
 *       the mints are asserted on their 200 envelope alone.
 *   (b) `verifyHiveSignature` runs REAL — this suite's focus IS credential
 *       verification semantics, so per clause (b) the auth middleware MUST NOT
 *       be mocked. Auth is the real JWT path (Bearer token signed with the
 *       real `config.sessionSecret`); the cryptographic JWT verify runs.
 *   (c) Real-path: argon2 hash + verify, Postgres `accounts` row, and the
 *       real `verifyHiveSignature` middleware all run integrated. The risk
 *       class (password byte-exactness across the set/login/re-auth paths) is
 *       exercised end-to-end here against real infrastructure.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';

const { sendOperationsMock } = vi.hoisted(() => ({
  sendOperationsMock: vi.fn().mockResolvedValue({ id: 'byte-exact-tx-id', block_num: 1 }),
}));

vi.mock('../../src/hive.js', async () => {
  const { MockBroadcastTimeoutError } = await import('../support/broadcast-mocks.js');
  return {
    hiveClient: {
      database: { getAccounts: vi.fn().mockResolvedValue([]) },
      broadcast: { sendOperations: (...args: unknown[]) => sendOperationsMock(...args) },
    },
    broadcastSendOperationsWithTimeout: (...args: unknown[]) => sendOperationsMock(...args),
    BroadcastTimeoutError: MockBroadcastTimeoutError,
    DEFAULT_BROADCAST_TIMEOUT_MS: 30_000,
  };
});

import { PrivateKey } from '@hiveio/dhive';
const TEST_POSTING_WIF = PrivateKey.fromSeed('pevo-byte-exact-seed').toString();
vi.mock('../../src/custody-crypto.js', () => ({
  decryptKey: () => TEST_POSTING_WIF,
}));

const { createApp } = await import('../../src/app.js');
const { getAppPool } = await import('../../src/app-db.js');
const { config } = await import('../../src/config.js');
const { _resetFreshAuthMemStoreForTests } = await import('../../src/lib/fresh-auth.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');

const app = createApp();

const RUN_ID = Date.now();
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const ALICE = `pbe${SUFFIX}a`; // State A: light + password, no ORCID
const ALICE_EMAIL = `pbe_alice_${RUN_ID}@example.com`;
// Edge whitespace around an otherwise policy-valid password. The leading and
// trailing spaces are the bytes a trim regression would strip. Interior space
// included to prove the value is preserved verbatim, not collapsed.
const ALICE_PASSWORD = '  Alice Edge Pass 1  ';

function bearerFor(username: string, custody: 'light' | 'self' = 'light'): string {
  const token = jwt.sign({ sub: username, custody }, config.sessionSecret, { expiresIn: '5m' });
  return `Bearer ${token}`;
}

let dbReachable = false;
{
  const pool = getAppPool();
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbReachable = true;
    } catch {
      dbReachable = false;
    }
  }
}

describe.skipIf(!dbReachable)('password byte-exactness across /login, /fresh-auth, /session-auth', () => {
  let aliceHash!: string;

  beforeAll(async () => {
    if (!dbReachable) return;
    // Hash the RAW, untrimmed password — modelling the signup/set-password/
    // recover paths, which all hash the raw value.
    aliceHash = await argon2.hash(ALICE_PASSWORD, { type: argon2.argon2id });
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    _resetFreshAuthMemStoreForTests();
    await clearRateLimitKeys([
      'custody-fresh-auth',
      'custody-session-auth',
      'auth-login',
    ]);

    const pool = getAppPool()!;
    await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [ALICE]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username = $1', [ALICE]).catch(() => {});

    // State A: light, password-only, no ORCID, active (verify_token NULL).
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, posting_key_enc, iv_posting, verify_token, expires_at)
       VALUES ($1, $2, $3, 'light', $4, $5, NULL, $6)`,
      [
        ALICE_EMAIL,
        ALICE,
        aliceHash,
        Buffer.from('placeholder-ciphertext'),
        Buffer.from('placeholder-iv'),
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      ],
    );
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [ALICE]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username = $1', [ALICE]).catch(() => {});
  });

  it('/login accepts the raw whitespace-bearing password (baseline: the credential authenticates somewhere)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email_or_username: ALICE, password: ALICE_PASSWORD });

    expect(res.status).toBe(200);
    expect(typeof res.body.data.token).toBe('string');
    expect(res.body.data.username).toBe(ALICE);
  });

  it('/fresh-auth accepts the SAME byte-exact password (no-trim parity with /login + signup hash)', async () => {
    const res = await request(app)
      .post('/api/custody/fresh-auth')
      .set('Authorization', bearerFor(ALICE))
      .send({ password: ALICE_PASSWORD, action: 'change_email' });

    expect(res.status).toBe(200);
    expect(typeof res.body.data.fresh_auth_proof).toBe('string');
    expect(res.body.data.mechanism).toBe('password');
  });

  it('/session-auth accepts the SAME byte-exact password (no-trim parity with /login + signup hash)', async () => {
    const res = await request(app)
      .post('/api/custody/session-auth')
      .set('Authorization', bearerFor(ALICE))
      .send({ password: ALICE_PASSWORD });

    expect(res.status).toBe(200);
    expect(typeof res.body.data.fresh_auth_proof).toBe('string');
    expect(res.body.data.mechanism).toBe('password');
  });

  it('the TRIMMED form of the password is rejected at /session-auth — confirms verify is byte-exact, not trim-tolerant', async () => {
    // Negative control: sending the trimmed credential must NOT authenticate,
    // proving the stored hash binds the exact bytes (including edge
    // whitespace). If the route trimmed its input, this trimmed send would
    // wrongly succeed — and the positive byte-exact sends above would have to
    // succeed for the wrong reason. The pair pins direction in both ways.
    const res = await request(app)
      .post('/api/custody/session-auth')
      .set('Authorization', bearerFor(ALICE))
      .send({ password: ALICE_PASSWORD.trim() });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

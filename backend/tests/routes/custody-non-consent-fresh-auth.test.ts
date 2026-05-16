/**
 * BACKEND-CUSTODY-BROADCAST-ORCID-FRESH-AUTH — non-consent broadcast fresh-auth
 * coverage. State A/B/C/D acceptance per `agents/docs/ARCHITECTURE.md` § 6.
 *
 * The non-consent branch of `POST /api/custody/broadcast` now requires a
 * `fresh_auth_proof` (closes ARCH.md § 6.5 invariant #1 on the non-consent
 * surface). Consume side is `consumeSessionFreshAuthToken` from
 * `src/lib/fresh-auth.ts`, which accepts either:
 *   - a session-kind proof (target-less, minted by
 *     `issueSessionFreshAuthToken` — used by ORCID `mode='session_auth'`), or
 *   - a consent_op-kind proof (target-bound, minted by `issueFreshAuthToken`
 *     — cross-kind accept for State A/B users who already mint per-op
 *     proofs via the existing `/custody/fresh-auth` path).
 *
 * Coverage shape (real-DB + mocked-dhive):
 *   - State A (password-only): broadcast with password-mechanism session-kind
 *     proof → 200. Also: cross-kind accept — consent_op-kind proof works on
 *     the non-consent surface.
 *   - State B (password + ORCID): broadcast with password OR ORCID
 *     mechanism session-kind proof → 200.
 *   - State C (ORCID-only, no password): broadcast with ORCID session-kind
 *     proof → 200. Previously blocked (no path to mint any kind of proof
 *     before this change).
 *   - State D (upgraded): broadcast → 403 ALREADY_UPGRADED regardless of
 *     proof. Encrypted keys are wiped at upgrade; nothing to decrypt.
 *   - Missing proof → 401 FRESH_AUTH_REQUIRED + reason 'missing'.
 *   - Cross-account proof (Bob's proof, Alice's JWT) → 403 + reason
 *     'username_mismatch'.
 *   - Replay (same proof used twice) → second call 401 + reason 'expired'.
 *
 * Justification per root CLAUDE.md "Carve-out for deterministic edge-case
 * coverage" clause (a):
 *  - `../../src/hive.js` broadcast helpers mocked — the dhive client is in
 *    the carve-out's "third-party libraries non-trivial to run for real
 *    per-test" target list. Real broadcast would sign and submit to a
 *    live witness. The chain-broadcast surface is covered end-to-end in
 *    the local-dev compose stack against pevotest, plus by the broadcast-
 *    error and timeout-propagation tests under `tests/lib/broadcast-error.test.ts`.
 *  - `../../src/custody-crypto.js` decryptKey mocked — same rationale as
 *    `tests/routes/custody-consent-ops.test.ts` (header lines 36-52). The
 *    AES-GCM round-trip is exercised by the signup-verify happy path in
 *    `tests/routes/signup-verify.test.ts`.
 *  - `verifyHiveSignature` middleware runs REAL — this suite's focus is
 *    authentication semantics on the non-consent path, so per clause (b)
 *    we must NOT mock the middleware. We pass a Bearer JWT signed with
 *    the real SESSION_SECRET path.
 *
 * Real:
 *   - argon2 hashing (real, for State A/B password_hash seeding).
 *   - Postgres (`accounts` writes for all four state rows).
 *   - Redis (or in-memory fallback) for fresh-auth storage.
 *   - verifyHiveSignature middleware (real JWT verify).
 *   - fresh-auth.ts module (real session-kind issue + consume).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { MockBroadcastTimeoutError } from '../support/broadcast-mocks.js';

// Mock chain broadcast: deterministic tx_id / block_num per call.
const { sendOperationsMock } = vi.hoisted(() => ({
  sendOperationsMock: vi.fn().mockResolvedValue({ id: 'non-consent-tx-id', block_num: 4321 }),
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

// Bypass AES-GCM decryption — return any valid WIF since broadcast is mocked.
import { PrivateKey } from '@hiveio/dhive';
const TEST_POSTING_WIF = PrivateKey.fromSeed('pevo-non-consent-fresh-auth-seed').toString();

vi.mock('../../src/custody-crypto.js', () => ({
  decryptKey: () => TEST_POSTING_WIF,
}));

const { createApp } = await import('../../src/app.js');
const { getAppPool } = await import('../../src/app-db.js');
const { config } = await import('../../src/config.js');
const {
  _resetFreshAuthMemStoreForTests,
  issueSessionFreshAuthToken,
  issueFreshAuthToken,
} = await import('../../src/lib/fresh-auth.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');

const app = createApp();

const RUN_ID = Date.now();
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const ALICE_A = `ncas${SUFFIX}a`;   // State A
const BOB_B = `ncbs${SUFFIX}b`;     // State B
const CARL_C = `nccs${SUFFIX}c`;    // State C
const DAVE_D = `ncds${SUFFIX}d`;    // State D
const ALICE_EMAIL = `nc_alice_${RUN_ID}@example.com`;
const BOB_EMAIL = `nc_bob_${RUN_ID}@example.com`;
const CARL_EMAIL = `nc_carl_${RUN_ID}@example.com`;
const DAVE_EMAIL = `nc_dave_${RUN_ID}@example.com`;
const ALICE_PASSWORD = 'AlicePassword1';
const BOB_PASSWORD = 'BobPassword1';
const DAVE_PASSWORD = 'DavePassword1';
const BOB_ORCID = '0000-0001-2345-6781';
const CARL_ORCID = '0000-0002-3456-7892';

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

function bearerFor(username: string, custody: 'light' | 'self' = 'light'): string {
  const token = jwt.sign({ sub: username, custody }, config.sessionSecret, { expiresIn: '5m' });
  return `Bearer ${token}`;
}

const VOTE_OP = (voter: string) => [
  'vote',
  { voter, author: 'someauthor', permlink: 'somepermlink', weight: 10000 },
];

describe.skipIf(!dbReachable)('BACKEND-CUSTODY-BROADCAST-ORCID-FRESH-AUTH — non-consent broadcast', () => {
  let aliceHash: string;
  let bobHash: string;
  let daveHash: string;

  beforeAll(async () => {
    if (!dbReachable) return;
    aliceHash = await argon2.hash(ALICE_PASSWORD, { type: argon2.argon2id });
    bobHash = await argon2.hash(BOB_PASSWORD, { type: argon2.argon2id });
    daveHash = await argon2.hash(DAVE_PASSWORD, { type: argon2.argon2id });
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    sendOperationsMock.mockReset();
    sendOperationsMock.mockResolvedValue({ id: 'non-consent-tx-id', block_num: 4321 });
    _resetFreshAuthMemStoreForTests();
    await clearRateLimitKeys(['custody-broadcast', 'custody-fresh-auth']);

    const pool = getAppPool()!;
    await pool.query(
      'DELETE FROM custody_audit_log WHERE username IN ($1, $2, $3, $4)',
      [ALICE_A, BOB_B, CARL_C, DAVE_D],
    ).catch(() => {});
    await pool.query(
      'DELETE FROM accounts WHERE username IN ($1, $2, $3, $4)',
      [ALICE_A, BOB_B, CARL_C, DAVE_D],
    ).catch(() => {});

    // State A: light, password-only, no ORCID.
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, posting_key_enc, iv_posting, verify_token, expires_at)
       VALUES ($1, $2, $3, 'light', $4, $5, NULL, $6)`,
      [
        ALICE_EMAIL,
        ALICE_A,
        aliceHash,
        Buffer.from('placeholder-ciphertext'),
        Buffer.from('placeholder-iv'),
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      ],
    );

    // State B: light, password + ORCID.
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, orcid, custody, posting_key_enc, iv_posting, verify_token, expires_at)
       VALUES ($1, $2, $3, $4, 'light', $5, $6, NULL, $7)`,
      [
        BOB_EMAIL,
        BOB_B,
        bobHash,
        BOB_ORCID,
        Buffer.from('placeholder-ciphertext'),
        Buffer.from('placeholder-iv'),
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      ],
    );

    // State C: light, NO password, ORCID-only. password_hash IS NULL.
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, orcid, custody, posting_key_enc, iv_posting, verify_token, expires_at)
       VALUES ($1, $2, NULL, $3, 'light', $4, $5, NULL, $6)`,
      [
        CARL_EMAIL,
        CARL_C,
        CARL_ORCID,
        Buffer.from('placeholder-ciphertext'),
        Buffer.from('placeholder-iv'),
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      ],
    );

    // State D: upgraded self-custody. password_hash preserved, encrypted keys
    // nulled, upgraded_at set, custody = 'self'.
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, posting_key_enc, iv_posting, upgraded_at, verify_token, expires_at)
       VALUES ($1, $2, $3, 'self', NULL, NULL, NOW(), NULL, $4)`,
      [
        DAVE_EMAIL,
        DAVE_D,
        daveHash,
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      ],
    );
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query(
      'DELETE FROM custody_audit_log WHERE username IN ($1, $2, $3, $4)',
      [ALICE_A, BOB_B, CARL_C, DAVE_D],
    ).catch(() => {});
    await pool.query(
      'DELETE FROM accounts WHERE username IN ($1, $2, $3, $4)',
      [ALICE_A, BOB_B, CARL_C, DAVE_D],
    ).catch(() => {});
  });

  // ─── State A ───────────────────────────────────────────────────────────

  describe('State A (password-only, no ORCID)', () => {
    it('broadcast vote with password-mechanism session-kind proof → 200', async () => {
      const proof = await issueSessionFreshAuthToken(ALICE_A, 'password');
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE_A))
        .send({
          fresh_auth_proof: proof.token,
          operations: [VOTE_OP(ALICE_A)],
        });
      expect(res.status).toBe(200);
      expect(res.body.data.tx_id).toBe('non-consent-tx-id');
    });

    it('cross-kind accept: consent_op-kind proof works on non-consent broadcast', async () => {
      // State A user mints a per-op (consent_op-kind) proof via the
      // existing /custody/fresh-auth path; reuses it for a sibling
      // non-consent broadcast. The cross-kind accept on the session
      // consume side makes this UX path work without forcing the SPA to
      // mint two separate proofs.
      const proof = await issueFreshAuthToken(ALICE_A, 'password', {
        action: 'author_accept',
        root_author: 'rootauthor',
        root_permlink: 'paper-v1',
      });
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE_A))
        .send({
          fresh_auth_proof: proof.token,
          operations: [VOTE_OP(ALICE_A)],
        });
      expect(res.status).toBe(200);
    });
  });

  // ─── State B ───────────────────────────────────────────────────────────

  describe('State B (password + ORCID)', () => {
    it('broadcast with password-mechanism session proof → 200', async () => {
      const proof = await issueSessionFreshAuthToken(BOB_B, 'password');
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(BOB_B))
        .send({
          fresh_auth_proof: proof.token,
          operations: [VOTE_OP(BOB_B)],
        });
      expect(res.status).toBe(200);
    });

    it('broadcast with ORCID-mechanism session proof → 200', async () => {
      const proof = await issueSessionFreshAuthToken(BOB_B, 'orcid');
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(BOB_B))
        .send({
          fresh_auth_proof: proof.token,
          operations: [VOTE_OP(BOB_B)],
        });
      expect(res.status).toBe(200);
    });
  });

  // ─── State C ───────────────────────────────────────────────────────────

  describe('State C (ORCID-only, passwordless)', () => {
    it('broadcast with ORCID-mechanism session proof → 200 (previously blocked)', async () => {
      // The task's primary motivating case: pre-change, State C had no
      // path to broadcast any non-consent op via the server. With
      // session-kind ORCID proof support, they can.
      const proof = await issueSessionFreshAuthToken(CARL_C, 'orcid');
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(CARL_C))
        .send({
          fresh_auth_proof: proof.token,
          operations: [VOTE_OP(CARL_C)],
        });
      expect(res.status).toBe(200);
    });
  });

  // ─── State D ───────────────────────────────────────────────────────────

  describe('State D (upgraded self-custody)', () => {
    it('JWT custody="light" against an upgraded row → 403 (encrypted keys wiped)', async () => {
      // State D rows have upgraded_at SET and posting_key_enc nulled. The
      // broadcast handler hits the upgraded-at gate before attempting
      // decrypt. The JWT carries custody='light' here — even with a valid
      // proof, the upgraded row gates the broadcast.
      const proof = await issueSessionFreshAuthToken(DAVE_D, 'password');
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(DAVE_D, 'light'))
        .send({
          fresh_auth_proof: proof.token,
          operations: [VOTE_OP(DAVE_D)],
        });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(sendOperationsMock).not.toHaveBeenCalled();
    });

    it('JWT custody="self" → 403 at the custody gate (no proof needed to gate)', async () => {
      // State D users with the correct self-custody JWT hit the early
      // custody gate (`custody !== 'light' → 403`) BEFORE the fresh-auth
      // check runs. The 403 here is the documented "use Keychain" gate,
      // not a fresh-auth rejection.
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(DAVE_D, 'self'))
        .send({
          operations: [VOTE_OP(DAVE_D)],
        });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(sendOperationsMock).not.toHaveBeenCalled();
    });
  });

  // ─── Gate-discriminator coverage ───────────────────────────────────────

  describe('Fresh-auth gate discriminators (non-consent path)', () => {
    it('missing proof → 401 FRESH_AUTH_REQUIRED + reason missing', async () => {
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE_A))
        .send({ operations: [VOTE_OP(ALICE_A)] });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(res.body.error.details?.reason).toBe('missing');
      expect(sendOperationsMock).not.toHaveBeenCalled();
    });

    it('cross-account proof (Bob mints, Alice broadcasts) → 403 + reason username_mismatch', async () => {
      const bobProof = await issueSessionFreshAuthToken(BOB_B, 'password');
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE_A))
        .send({
          fresh_auth_proof: bobProof.token,
          operations: [VOTE_OP(ALICE_A)],
        });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(res.body.error.details?.reason).toBe('username_mismatch');
      expect(sendOperationsMock).not.toHaveBeenCalled();
    });

    it('replay: same proof used twice → second call 401 + reason expired', async () => {
      const proof = await issueSessionFreshAuthToken(ALICE_A, 'password');
      const first = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE_A))
        .send({
          fresh_auth_proof: proof.token,
          operations: [VOTE_OP(ALICE_A)],
        });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE_A))
        .send({
          fresh_auth_proof: proof.token,
          operations: [VOTE_OP(ALICE_A)],
        });
      expect(second.status).toBe(401);
      expect(second.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(second.body.error.details?.reason).toBe('expired');
    });

    it('malformed proof shape → 401 + reason missing (non-string)', async () => {
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE_A))
        .send({
          fresh_auth_proof: 12345,
          operations: [VOTE_OP(ALICE_A)],
        });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(res.body.error.details?.reason).toBe('missing');
    });
  });
});

// Reference the timeout-error import so the unused-import lint rule stays
// happy in environments where the suite skips entirely.
void MockBroadcastTimeoutError;

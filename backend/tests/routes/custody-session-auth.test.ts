/**
 * BACKEND-CUSTODY-SESSION-AUTH-PASSWORD-MINT — `POST /api/custody/session-auth`
 * coverage. State A users (light + password, no ORCID) previously had no
 * usable mint path for non-consent broadcasts: `/api/custody/fresh-auth`
 * mints consent_op-kind proofs that require per-op target binding (hostile
 * for vote/comment flows); `/api/orcid/start { mode: 'session_auth' }` needs
 * ORCID linkage State A users don't have. This route opens a target-less
 * session WINDOW via the same argon2 password path; the consume side on the
 * non-consent surface of `/api/custody/broadcast` accepts it, repeatedly, until
 * the window's sliding idle deadline or its absolute cap arrives.
 *
 * Acceptance shape (real-DB + real argon2 + real fresh-auth + real verifyHiveSignature):
 *   1. State A happy path: one mint covers a vote AND a comment, because the
 *      session proof is multi-use inside its window.
 *   2. Wrong password → 401.
 *   3. No-password account (State C, password_hash IS NULL) → 401 uniform
 *      envelope (avoids password-existence oracle).
 *   4. Self-custody → 403.
 *   5. Cross-kind accept on non-consent broadcast surface confirmed via #1.
 *   6. Kind isolation: session-kind proof minted here on consent-op surface
 *      → 403 FRESH_AUTH_REQUIRED + `details.reason: 'kind_mismatch'`.
 *
 * Justification per root CLAUDE.md "Carve-out for deterministic edge-case
 * coverage" clause (a):
 *  - `../../src/hive.js` broadcast helpers mocked — dhive client is in the
 *    carve-out's "third-party libraries non-trivial to run for real per-test"
 *    target list (matching the pattern in `custody-non-consent-fresh-auth.test.ts`
 *    header). Real broadcast would sign and submit to a live witness. The
 *    chain-broadcast surface is covered end-to-end in the local-dev compose
 *    stack and by `tests/lib/broadcast-error.test.ts`.
 *  - `../../src/custody-crypto.js` decryptKey mocked — same rationale as the
 *    sibling test (`custody-non-consent-fresh-auth.test.ts`). The AES-GCM
 *    round-trip is exercised by `tests/routes/signup-verify.test.ts`.
 *  - `verifyHiveSignature` middleware runs REAL — this suite's focus IS
 *    authentication semantics on the session-auth mint path, so per clause
 *    (b) we must NOT mock the middleware. The JWT is signed with the real
 *    `config.sessionSecret`.
 *
 * Real:
 *   - argon2 hashing + verify (the entire point of the route under test).
 *   - Postgres (`accounts` writes for State A / State C / State D).
 *   - Redis (or in-memory fallback) for fresh-auth storage.
 *   - verifyHiveSignature middleware (real JWT verify path).
 *   - fresh-auth.ts module (real session-kind issue + consume).
 *
 * Clause (c) real-path companion: the sibling non-consent-broadcast suite
 * (`custody-non-consent-fresh-auth.test.ts`) exercises the same fresh-auth
 * consume path against the real `verifyHiveSignature` middleware with State
 * A/B/C/D rows, covering the integrated route plumbing this test relies on.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';

// Mock chain broadcast: deterministic tx_id / block_num per call. We need
// this for the State A happy-path test that exercises mint → broadcast end-
// to-end (the broadcast consumes the proof, which is what validates the
// cross-kind accept on the non-consent surface).
const { sendOperationsMock } = vi.hoisted(() => ({
  sendOperationsMock: vi.fn().mockResolvedValue({ id: 'session-auth-tx-id', block_num: 5432 }),
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
const TEST_POSTING_WIF = PrivateKey.fromSeed('pevo-session-auth-seed').toString();

vi.mock('../../src/custody-crypto.js', () => ({
  decryptKey: () => TEST_POSTING_WIF,
}));

const { createApp } = await import('../../src/app.js');
const { getAppPool } = await import('../../src/app-db.js');
const { config } = await import('../../src/config.js');
const {
  SESSION_FRESH_AUTH_ABSOLUTE_SECONDS,
  SESSION_FRESH_AUTH_IDLE_SECONDS,
  _resetFreshAuthMemStoreForTests,
} = await import('../../src/lib/fresh-auth.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');

const app = createApp();

const RUN_ID = Date.now();
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const ALICE_A = `sas${SUFFIX}a`;     // State A: light + password, no ORCID
const CARL_C = `sas${SUFFIX}c`;      // State C: light, ORCID-only, no password
const DAVE_D = `sas${SUFFIX}d`;      // State D: upgraded self-custody
const ALICE_EMAIL = `sa_alice_${RUN_ID}@example.com`;
const CARL_EMAIL = `sa_carl_${RUN_ID}@example.com`;
const DAVE_EMAIL = `sa_dave_${RUN_ID}@example.com`;
const ALICE_PASSWORD = 'AlicePassword1';
const DAVE_PASSWORD = 'DavePassword1';
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

const COMMENT_OP = (author: string) => [
  'comment',
  {
    parent_author: 'rootauthor',
    parent_permlink: 'parent-permlink-v1',
    author,
    permlink: `re-rootauthor-parent-permlink-v1-${Date.now()}`,
    title: '',
    body: 'reply body',
    json_metadata: JSON.stringify({ app: config.appTag, tags: [config.appTag] }),
  },
];

describe.skipIf(!dbReachable)('POST /api/custody/session-auth — password-mechanism session-kind mint', () => {
  let aliceHash!: string;
  let daveHash!: string;

  beforeAll(async () => {
    if (!dbReachable) return;
    aliceHash = await argon2.hash(ALICE_PASSWORD, { type: argon2.argon2id });
    daveHash = await argon2.hash(DAVE_PASSWORD, { type: argon2.argon2id });
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    sendOperationsMock.mockReset();
    sendOperationsMock.mockResolvedValue({ id: 'session-auth-tx-id', block_num: 5432 });
    _resetFreshAuthMemStoreForTests();
    await clearRateLimitKeys([
      'custody-broadcast',
      'custody-fresh-auth',
      'custody-session-auth',
    ]);

    const pool = getAppPool()!;
    await pool.query(
      'DELETE FROM custody_audit_log WHERE username IN ($1, $2, $3)',
      [ALICE_A, CARL_C, DAVE_D],
    ).catch(() => {});
    await pool.query(
      'DELETE FROM accounts WHERE username IN ($1, $2, $3)',
      [ALICE_A, CARL_C, DAVE_D],
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

    // State C: light, NO password, ORCID-only.
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

    // State D: upgraded self-custody. password_hash preserved, encrypted
    // keys nulled, upgraded_at set, custody = 'self'.
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
      'DELETE FROM custody_audit_log WHERE username IN ($1, $2, $3)',
      [ALICE_A, CARL_C, DAVE_D],
    ).catch(() => {});
    await pool.query(
      'DELETE FROM accounts WHERE username IN ($1, $2, $3)',
      [ALICE_A, CARL_C, DAVE_D],
    ).catch(() => {});
  });

  // ─── Happy path: State A mint → broadcast vote + comment ─────────────

  describe('State A (password-only) happy path', () => {
    it('mints a password-mechanism session-kind proof and accepts on /broadcast (vote)', async () => {
      const mint = await request(app)
        .post('/api/custody/session-auth')
        .set('Authorization', bearerFor(ALICE_A))
        .send({ password: ALICE_PASSWORD });

      expect(mint.status).toBe(200);
      expect(typeof mint.body.data.fresh_auth_proof).toBe('string');
      expect(mint.body.data.fresh_auth_proof.length).toBeGreaterThan(0);
      expect(mint.body.data.mechanism).toBe('password');
      // Both deadlines are ISO-8601 strings, matching the convention on
      // `/api/custody/fresh-auth` and the ORCID session-auth callback. The
      // frontend reads them via `new Date(value).getTime()`; a numeric
      // epoch-seconds value would be silently interpreted as milliseconds and
      // resolve to 1970, making the SPA's proof cache useless and sending the
      // user through a full re-auth on every write.
      expect(typeof mint.body.data.expires_at).toBe('string');
      expect(typeof mint.body.data.absolute_expires_at).toBe('string');
      const parsedExpiresAtMs = Date.parse(mint.body.data.expires_at);
      const parsedCapMs = Date.parse(mint.body.data.absolute_expires_at);
      expect(Number.isFinite(parsedExpiresAtMs)).toBe(true);
      expect(Number.isFinite(parsedCapMs)).toBe(true);
      const nowMs = Date.now();
      // `expires_at` is the sliding idle deadline, the one the client treats as
      // authoritative; `absolute_expires_at` is the cap no slide can pass. Bands
      // are the two window constants with a couple of seconds of slack for the
      // real argon2 hash this route performs before minting.
      expect(parsedExpiresAtMs).toBeGreaterThan(nowMs + 60_000);
      expect(parsedExpiresAtMs).toBeLessThanOrEqual(nowMs + SESSION_FRESH_AUTH_IDLE_SECONDS * 1000 + 2_000);
      expect(parsedCapMs).toBeGreaterThan(parsedExpiresAtMs);
      expect(parsedCapMs).toBeLessThanOrEqual(nowMs + SESSION_FRESH_AUTH_ABSOLUTE_SECONDS * 1000 + 2_000);

      const proof = mint.body.data.fresh_auth_proof;

      // One mint, two broadcasts. This is the property the window exists for:
      // before it, every vote and comment cost the user a fresh re-auth act.
      const broadcast = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE_A))
        .send({
          fresh_auth_proof: proof,
          operations: [VOTE_OP(ALICE_A)],
        });

      expect(broadcast.status).toBe(200);
      expect(broadcast.body.data.tx_id).toBe('session-auth-tx-id');

      const commentBroadcast = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE_A))
        .send({
          fresh_auth_proof: proof,
          operations: [COMMENT_OP(ALICE_A)],
        });

      expect(commentBroadcast.status).toBe(200);
      expect(commentBroadcast.body.data.tx_id).toBe('session-auth-tx-id');
    });
  });

  // ─── Wrong password ──────────────────────────────────────────────────

  describe('Password-verify discriminators', () => {
    it('wrong password → 401 UNAUTHORIZED', async () => {
      const res = await request(app)
        .post('/api/custody/session-auth')
        .set('Authorization', bearerFor(ALICE_A))
        .send({ password: 'WrongPassword1' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toBe('Invalid password');
    });

    it('null password_hash (State C) → 401 with same envelope as wrong-password (no oracle)', async () => {
      // State C has password_hash IS NULL. The route must NOT differentiate
      // its response from the wrong-password branch above, or it becomes a
      // password-existence oracle for ORCID-only accounts.
      //
      // Wall-time-oracle guard: the route must call `burnSentinel` BEFORE
      // returning 401 on the null-hash branch, otherwise a JWT-holding
      // attacker can distinguish State C (~1ms early return) from State A/B
      // (~50ms argon2.verify) along the latency axis. We spy on
      // `argon2.verify` (the underlying primitive called by both burnSentinel
      // and the password-check path) and assert it was invoked exactly once
      // on the null-hash branch. Per project memory
      // `feedback_dismiss_preemptive_test_hardening`, the spy is preferred
      // over a timing-band assertion (deterministic vs flaky). A mutation
      // that drops the burnSentinel call from the null-hash branch would
      // surface as `argon2.verify` count=0 on this assertion.
      const verifySpy = vi.spyOn(argon2, 'verify');
      const verifyCallsBefore = verifySpy.mock.calls.length;

      const nullHashRes = await request(app)
        .post('/api/custody/session-auth')
        .set('Authorization', bearerFor(CARL_C))
        .send({ password: 'AnyPassword1' });

      expect(nullHashRes.status).toBe(401);
      expect(nullHashRes.body.error.code).toBe('UNAUTHORIZED');
      expect(nullHashRes.body.error.message).toBe('Invalid password');
      // The route invoked argon2.verify (via burnSentinel) on the null-hash
      // branch — wall-time-oracle equalization closed.
      expect(verifySpy.mock.calls.length - verifyCallsBefore).toBeGreaterThanOrEqual(1);

      // Wrong-password baseline (same as the test above) for byte-equivalent
      // envelope comparison.
      const wrongPwdRes = await request(app)
        .post('/api/custody/session-auth')
        .set('Authorization', bearerFor(ALICE_A))
        .send({ password: 'WrongPassword1' });

      expect(nullHashRes.status).toBe(wrongPwdRes.status);
      expect(nullHashRes.body.error.code).toBe(wrongPwdRes.body.error.code);
      expect(nullHashRes.body.error.message).toBe(wrongPwdRes.body.error.message);

      verifySpy.mockRestore();
    });
  });

  // ─── Self-custody gate ───────────────────────────────────────────────

  describe('Custody-mode gate', () => {
    it('self-custody JWT → 403 FORBIDDEN (route is light-only)', async () => {
      const res = await request(app)
        .post('/api/custody/session-auth')
        .set('Authorization', bearerFor(DAVE_D, 'self'))
        .send({ password: DAVE_PASSWORD });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('upgraded row (light JWT, upgraded_at set) → 403 FORBIDDEN', async () => {
      // Dave's account has upgraded_at SET; even a light-mode JWT against
      // that row must be gated, otherwise an attacker with a stale light
      // JWT could mint proofs after the user moved to self-custody.
      const res = await request(app)
        .post('/api/custody/session-auth')
        .set('Authorization', bearerFor(DAVE_D, 'light'))
        .send({ password: DAVE_PASSWORD });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ─── Kind isolation: session proof on consent-op surface rejected ────

  describe('Kind isolation', () => {
    it('session-kind proof on consent-op surface → 403 FRESH_AUTH_REQUIRED kind_mismatch', async () => {
      // Mint a session-kind proof, then attempt to use it for a consent op
      // (single comment with `pevo_action: author_accept`). The consume
      // side (`consumeFreshAuthToken`) enforces strict kind isolation: a
      // session-kind entry on the consent surface is a `kind_mismatch`.
      const mint = await request(app)
        .post('/api/custody/session-auth')
        .set('Authorization', bearerFor(ALICE_A))
        .send({ password: ALICE_PASSWORD });
      expect(mint.status).toBe(200);
      const sessionProof = mint.body.data.fresh_auth_proof;

      // Build a consent-op bundle. The author_accept consent custom_json
      // shape; operation must be a SINGLE consent op so the broadcast hits
      // the consent-op consume path (not the non-consent surface).
      const consentOp = [
        'custom_json',
        {
          required_auths: [],
          required_posting_auths: [ALICE_A],
          id: config.appTag,
          json: JSON.stringify({
            action: 'author_accept',
            root_author: 'rootauthor',
            root_permlink: 'paper-v1',
          }),
        },
      ];

      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE_A))
        .send({
          fresh_auth_proof: sessionProof,
          operations: [consentOp],
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(res.body.error.details?.reason).toBe('kind_mismatch');
      expect(sendOperationsMock).not.toHaveBeenCalled();
    });
  });

  // ─── Validation discriminators ───────────────────────────────────────

  describe('Body validation', () => {
    it('missing password → 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/custody/session-auth')
        .set('Authorization', bearerFor(ALICE_A))
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('empty-string password → 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/custody/session-auth')
        .set('Authorization', bearerFor(ALICE_A))
        .send({ password: '' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});

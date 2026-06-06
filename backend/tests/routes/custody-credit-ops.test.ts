/**
 * Custody name-only-route credit-op endpoints (claim_authorship /
 * approve_authorship / revoke_authorship) behind a per-target fresh-auth gate.
 *
 * These reputation-weighty, identity-binding ops are broadcastable through the
 * same `POST /api/custody/broadcast` endpoint as the consent ops; per
 * `agents/docs/ARCHITECTURE.md` § 6.4 + § 6.5 invariant #1, a stolen JWT alone
 * must not be able to mint or revoke authorship credit. This suite mirrors the
 * `custody-consent-ops` coverage shape and adds the credit-op-specific
 * `author_index` binding axis.
 *
 * Coverage shape (real-DB + mocked-dhive):
 *  - POST /api/custody/fresh-auth (password mechanism) for credit ops
 *      - claim_authorship issuance with author_index → 200 + token.
 *      - missing author_index on claim/approve → 400.
 *      - revoke_authorship issuance (no author_index) → 200 + token.
 *  - POST /api/custody/broadcast for credit ops
 *      - claim_authorship with valid fresh-auth → 200; audit-log row carries
 *        auth_mechanism / fresh_auth_outcome / session_id / user_agent.
 *      - approve_authorship + revoke_authorship valid → 200.
 *      - claim_authorship WITHOUT fresh_auth_proof → 401 FRESH_AUTH_REQUIRED.
 *      - cross-paper / cross-action / cross-author_index proofs → 403
 *        target_mismatch.
 *      - replay (token reused) → 401 expired.
 *      - cross-account proof → 403 username_mismatch.
 *      - two credit ops in one bundle → 400 MULTIPLE_CONSENT_OPS.
 *
 * Mocks (same justification as `custody-consent-ops.test.ts`, per root
 * CLAUDE.md "Carve-out for deterministic edge-case coverage" clause (a)):
 *   - `../../src/hive.js` broadcast helpers — never hit chain (third-party
 *     dhive client is impractical to run for real per-test; real broadcast
 *     would sign and submit to a live witness). Real-path companion: the
 *     chain-broadcast surface is exercised end-to-end in the local-dev compose
 *     stack against pevotest and by `tests/lib/broadcast-error.test.ts`.
 *   - `../../src/custody-crypto.js` decryptKey — bypass AES-GCM; the real
 *     round-trip is pinned by `tests/routes/signup-verify.test.ts`.
 *
 * Real (clause (b) — auth verification runs real here): argon2 verify against
 * a seeded hash, Postgres (`accounts` + `custody_audit_log`), Redis (or
 * in-memory fallback) for fresh-auth storage, `verifyHiveSignature` middleware
 * (real JWT verify — NOT mocked), and the real `fresh-auth.ts` module. The
 * focus of this suite IS the fresh-auth gate, so the cryptographic JWT verify
 * path is exercised, not bypassed.
 *
 * Real-DB-required guard: `describe.skipIf(!dbReachable)` — CI without
 * HAF/Postgres skips rather than fails.
 */

import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { MockBroadcastTimeoutError } from '../support/broadcast-mocks.js';
import { fetchSettledAuditRowsWith } from '../support/audit-log-poll-settle.js';

/** Local hex-SHA-256 helper mirroring `hashUserAgentForAudit` from custody.ts
 *  so a regression that swaps the digest algorithm surfaces as an inequality
 *  on the row value. */
function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const { sendOperationsMock } = vi.hoisted(() => ({
  sendOperationsMock: vi.fn().mockResolvedValue({ id: 'credit-op-tx-id', block_num: 4321 }),
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
const TEST_POSTING_WIF = PrivateKey.fromSeed('pevo-credit-op-test-seed').toString();

vi.mock('../../src/custody-crypto.js', () => ({
  decryptKey: () => TEST_POSTING_WIF,
}));

const { createApp } = await import('../../src/app.js');
const { getAppPool } = await import('../../src/app-db.js');
const { config } = await import('../../src/config.js');
const {
  _resetFreshAuthMemStoreForTests,
  issueFreshAuthToken,
  creditOpFreshAuthTarget,
} = await import('../../src/lib/fresh-auth.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');

const app = createApp();

const RUN_ID = Date.now();
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const ALICE = `crda${SUFFIX}user`;
const BOB = `crdb${SUFFIX}user`;
const ALICE_EMAIL = `credit_alice_${RUN_ID}@example.com`;
const BOB_EMAIL = `credit_bob_${RUN_ID}@example.com`;
const ALICE_PASSWORD = 'AlicePassword1';
const BOB_PASSWORD = 'BobPassword1';

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

function bearerFor(username: string, custody: 'light' | 'self' | null = 'light'): string {
  const token = jwt.sign({ sub: username, custody }, config.sessionSecret, { expiresIn: '5m' });
  return `Bearer ${token}`;
}

function claimOp(broadcaster: string, paperAuthor: string, paperPermlink: string, authorIndex: number) {
  return [
    'custom_json',
    {
      required_auths: [],
      required_posting_auths: [broadcaster],
      id: config.appTag,
      json: JSON.stringify({
        action: 'claim_authorship',
        paper_author: paperAuthor,
        paper_permlink: paperPermlink,
        author_index: authorIndex,
      }),
    },
  ];
}

function approveOp(broadcaster: string, paperAuthor: string, paperPermlink: string, authorIndex: number) {
  return [
    'custom_json',
    {
      required_auths: [],
      required_posting_auths: [broadcaster],
      id: config.appTag,
      json: JSON.stringify({
        action: 'approve_authorship',
        claimer: 'someclaimer',
        paper_author: paperAuthor,
        paper_permlink: paperPermlink,
        author_index: authorIndex,
      }),
    },
  ];
}

function revokeOp(broadcaster: string, paperAuthor: string, paperPermlink: string) {
  return [
    'custom_json',
    {
      required_auths: [],
      required_posting_auths: [broadcaster],
      id: config.appTag,
      json: JSON.stringify({
        action: 'revoke_authorship',
        claimer: 'someclaimer',
        paper_author: paperAuthor,
        paper_permlink: paperPermlink,
        reason: 'unauthorized',
      }),
    },
  ];
}

describe.skipIf(!dbReachable)('custody name-only credit-op + per-target fresh-auth', () => {
  let aliceHash: string;

  beforeAll(async () => {
    if (!dbReachable) return;
    aliceHash = await argon2.hash(ALICE_PASSWORD, { type: argon2.argon2id });
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    sendOperationsMock.mockReset();
    sendOperationsMock.mockResolvedValue({ id: 'credit-op-tx-id', block_num: 4321 });
    _resetFreshAuthMemStoreForTests();
    await clearRateLimitKeys(['custody-broadcast', 'custody-fresh-auth']);

    const pool = getAppPool()!;
    await pool.query('DELETE FROM custody_audit_log WHERE username IN ($1, $2)', [ALICE, BOB]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username IN ($1, $2)', [ALICE, BOB]).catch(() => {});

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

    const bobHash = await argon2.hash(BOB_PASSWORD, { type: argon2.argon2id });
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, posting_key_enc, iv_posting, verify_token, expires_at)
       VALUES ($1, $2, $3, 'light', $4, $5, NULL, $6)`,
      [
        BOB_EMAIL,
        BOB,
        bobHash,
        Buffer.from('placeholder-ciphertext'),
        Buffer.from('placeholder-iv'),
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      ],
    );
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query('DELETE FROM custody_audit_log WHERE username IN ($1, $2)', [ALICE, BOB]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username IN ($1, $2)', [ALICE, BOB]).catch(() => {});
  });

  // ─── POST /api/custody/fresh-auth (password) for credit ops ────────────

  describe('POST /api/custody/fresh-auth (password) for credit ops', () => {
    it('claim_authorship with author_index → 200 + token', async () => {
      const res = await request(app)
        .post('/api/custody/fresh-auth')
        .set('Authorization', bearerFor(ALICE))
        .send({
          password: ALICE_PASSWORD,
          action: 'claim_authorship',
          paper_author: 'bob',
          paper_permlink: 'paper-1',
          author_index: 2,
        });
      expect(res.status).toBe(200);
      expect(res.body.data.fresh_auth_proof).toMatch(/^[0-9a-f]{64}$/);
      expect(res.body.data.mechanism).toBe('password');
    });

    it('claim_authorship missing author_index → 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/custody/fresh-auth')
        .set('Authorization', bearerFor(ALICE))
        .send({
          password: ALICE_PASSWORD,
          action: 'claim_authorship',
          paper_author: 'bob',
          paper_permlink: 'paper-1',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('approve_authorship non-integer author_index → 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/custody/fresh-auth')
        .set('Authorization', bearerFor(ALICE))
        .send({
          password: ALICE_PASSWORD,
          action: 'approve_authorship',
          paper_author: 'bob',
          paper_permlink: 'paper-1',
          author_index: 'two',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('revoke_authorship without author_index → 200 + token (no index on the wire)', async () => {
      const res = await request(app)
        .post('/api/custody/fresh-auth')
        .set('Authorization', bearerFor(ALICE))
        .send({
          password: ALICE_PASSWORD,
          action: 'revoke_authorship',
          paper_author: 'bob',
          paper_permlink: 'paper-1',
        });
      expect(res.status).toBe(200);
      expect(res.body.data.fresh_auth_proof).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ─── POST /api/custody/broadcast (credit ops) ──────────────────────────

  describe('POST /api/custody/broadcast (claim / approve / revoke)', () => {
    it('claim_authorship with valid fresh-auth → 200 + audit-log carries the four consent columns', async () => {
      const issued = await issueFreshAuthToken(
        ALICE,
        'password',
        creditOpFreshAuthTarget('claim_authorship', 'bob', 'paper-1', 2),
      );
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .set('User-Agent', 'PEvO-Credit/1.0')
        .send({
          fresh_auth_proof: issued.token,
          operations: [claimOp(ALICE, 'bob', 'paper-1', 2)],
        });
      expect(res.status).toBe(200);
      expect(res.body.data.tx_id).toBe('credit-op-tx-id');

      const pool = getAppPool()!;
      const rows = await fetchSettledAuditRowsWith<{
        auth_mechanism: string | null;
        fresh_auth_outcome: string | null;
        session_id: string | null;
        user_agent: string | null;
      }>({
        pool,
        username: ALICE,
        columns: 'auth_mechanism, fresh_auth_outcome, session_id, user_agent',
      });
      expect(rows.length).toBe(1);
      expect(rows[0].auth_mechanism).toBe('password');
      expect(rows[0].fresh_auth_outcome).toBe('verified');
      expect(rows[0].session_id).toMatch(/^[0-9a-f]{16}$/);
      expect(rows[0].user_agent).toBe(sha256Hex('PEvO-Credit/1.0'));
    });

    it('approve_authorship with valid fresh-auth → 200', async () => {
      const issued = await issueFreshAuthToken(
        ALICE,
        'password',
        creditOpFreshAuthTarget('approve_authorship', 'bob', 'paper-1', 3),
      );
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .send({
          fresh_auth_proof: issued.token,
          operations: [approveOp(ALICE, 'bob', 'paper-1', 3)],
        });
      expect(res.status).toBe(200);
    });

    it('revoke_authorship (no author_index) with valid fresh-auth → 200', async () => {
      const issued = await issueFreshAuthToken(
        ALICE,
        'password',
        creditOpFreshAuthTarget('revoke_authorship', 'bob', 'paper-1', undefined),
      );
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .send({
          fresh_auth_proof: issued.token,
          operations: [revokeOp(ALICE, 'bob', 'paper-1')],
        });
      expect(res.status).toBe(200);
    });

    it('claim_authorship WITHOUT fresh_auth_proof → 401 FRESH_AUTH_REQUIRED missing', async () => {
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .send({ operations: [claimOp(ALICE, 'bob', 'paper-1', 2)] });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(res.body.error.details?.reason).toBe('missing');
      expect(sendOperationsMock).not.toHaveBeenCalled();
    });

    it('proof minted for paper-x cannot broadcast claim on paper-y → 403 target_mismatch', async () => {
      const issued = await issueFreshAuthToken(
        ALICE,
        'password',
        creditOpFreshAuthTarget('claim_authorship', 'bob', 'paper-x', 2),
      );
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .send({
          fresh_auth_proof: issued.token,
          operations: [claimOp(ALICE, 'bob', 'paper-y', 2)],
        });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(res.body.error.details?.reason).toBe('target_mismatch');
      expect(sendOperationsMock).not.toHaveBeenCalled();
    });

    it('proof minted for claim cannot broadcast approve on the same slot → 403 target_mismatch', async () => {
      const issued = await issueFreshAuthToken(
        ALICE,
        'password',
        creditOpFreshAuthTarget('claim_authorship', 'bob', 'paper-1', 2),
      );
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .send({
          fresh_auth_proof: issued.token,
          operations: [approveOp(ALICE, 'bob', 'paper-1', 2)],
        });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(res.body.error.details?.reason).toBe('target_mismatch');
      expect(sendOperationsMock).not.toHaveBeenCalled();
    });

    it('proof minted for author_index 2 cannot broadcast claim on author_index 3 → 403 target_mismatch', async () => {
      const issued = await issueFreshAuthToken(
        ALICE,
        'password',
        creditOpFreshAuthTarget('claim_authorship', 'bob', 'paper-1', 2),
      );
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .send({
          fresh_auth_proof: issued.token,
          operations: [claimOp(ALICE, 'bob', 'paper-1', 3)],
        });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(res.body.error.details?.reason).toBe('target_mismatch');
      expect(sendOperationsMock).not.toHaveBeenCalled();
    });

    it('replay: same credit-op token used twice → second call 401 expired', async () => {
      const issued = await issueFreshAuthToken(
        ALICE,
        'password',
        creditOpFreshAuthTarget('claim_authorship', 'bob', 'paper-1', 2),
      );
      const first = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .send({
          fresh_auth_proof: issued.token,
          operations: [claimOp(ALICE, 'bob', 'paper-1', 2)],
        });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .send({
          fresh_auth_proof: issued.token,
          operations: [claimOp(ALICE, 'bob', 'paper-1', 2)],
        });
      expect(second.status).toBe(401);
      expect(second.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(second.body.error.details?.reason).toBe('expired');
    });

    it('cross-account: token issued for Bob used with Alice JWT → 403 username_mismatch', async () => {
      const bobToken = await issueFreshAuthToken(
        BOB,
        'password',
        creditOpFreshAuthTarget('claim_authorship', 'bob', 'paper-1', 2),
      );
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .send({
          fresh_auth_proof: bobToken.token,
          operations: [claimOp(ALICE, 'bob', 'paper-1', 2)],
        });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(res.body.error.details?.reason).toBe('username_mismatch');
    });

    it('two credit ops in one bundle → 400 MULTIPLE_CONSENT_OPS (proof not consumed)', async () => {
      const issued = await issueFreshAuthToken(
        ALICE,
        'password',
        creditOpFreshAuthTarget('claim_authorship', 'bob', 'paper-c', 2),
      );
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .send({
          fresh_auth_proof: issued.token,
          operations: [
            claimOp(ALICE, 'bob', 'paper-a', 1),
            claimOp(ALICE, 'bob', 'paper-b', 1),
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MULTIPLE_CONSENT_OPS');
      expect(sendOperationsMock).not.toHaveBeenCalled();

      // Proof was NOT consumed (multi-rejection runs before consume): a
      // follow-up single-op call with the same token + matching target lands.
      const followup = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .send({
          fresh_auth_proof: issued.token,
          operations: [claimOp(ALICE, 'bob', 'paper-c', 2)],
        });
      expect(followup.status).toBe(200);
    });
  });
});

// Reference the timeout-error import so the unused-import lint rule stays happy
// when the suite skips entirely.
void MockBroadcastTimeoutError;

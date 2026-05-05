/**
 * Round-3 of BACKEND-COAUTHOR-TRUST-MODEL — custody endpoint extension for
 * `author_accept` / `author_resign` consent ops behind a fresh-auth gate.
 *
 * Coverage shape (real-DB + mocked-dhive):
 *  - POST /api/custody/fresh-auth (password mechanism)
 *      - happy path → 200 + token
 *      - wrong password → 401
 *      - missing password → 400
 *      - self-custody JWT → 403
 *      - already-upgraded account → 403
 *      - rate limit (10/min) skipped — covered structurally by the limiter
 *        config; route-handler tests rebuild rate-limit state per file.
 *  - POST /api/custody/broadcast for consent ops
 *      - author_accept with valid fresh-auth → 200; audit-log row captures
 *        auth_mechanism / fresh_auth_outcome / session_id / user_agent.
 *      - author_resign with valid fresh-auth → 200; audit-log row captures
 *        the new fields.
 *      - author_accept WITHOUT fresh_auth_proof → 401 FRESH_AUTH_REQUIRED.
 *      - author_accept with already-consumed token (replay) → 401
 *        FRESH_AUTH_REQUIRED + reason 'expired'.
 *      - author_accept with token bound to a different username → 401
 *        FRESH_AUTH_REQUIRED + reason 'username_mismatch'.
 *      - non-consent op (vote) without fresh_auth_proof → 200 (no
 *        regression on the existing path).
 *
 * Mocks:
 *   - `../../src/hive.js` broadcast helpers — never actually hit chain.
 *   - `../../src/custody-crypto.js` decryptKey — bypass AES-GCM material.
 *
 * Real:
 *   - argon2 (real verify against a seeded hash).
 *   - Postgres (`accounts` + `custody_audit_log` writes).
 *   - Redis (or in-memory fallback) for fresh-auth storage.
 *   - verifyHiveSignature middleware (real JWT verify).
 *   - fresh-auth.ts module (real).
 *
 * Real-DB-required guard: `describe.skipIf(!dbReachable)` mirrors the
 * pattern in `custody-upgrade-null-hash.test.ts`. CI without HAF/Postgres
 * skips the suite rather than failing.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { MockBroadcastTimeoutError } from '../support/broadcast-mocks.js';

// Mock chain broadcast: every consent-op broadcast in this suite resolves
// to a fixed tx_id / block_num so we can assert audit-log rows without
// firing real chain ops. Same shape as the custody.test.ts mock; uses the
// shared MockBroadcastTimeoutError identity for the timeout instanceof
// path (not exercised in this suite — kept for parity with the file).
const { sendOperationsMock } = vi.hoisted(() => ({
  sendOperationsMock: vi.fn().mockResolvedValue({ id: 'consent-op-tx-id', block_num: 1234 }),
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

// Bypass AES-GCM decryption — return any valid WIF since broadcast is
// mocked. Same fixture-WIF as custody.test.ts.
import { PrivateKey } from '@hiveio/dhive';
const TEST_POSTING_WIF = PrivateKey.fromSeed('pevo-consent-op-test-seed').toString();

vi.mock('../../src/custody-crypto.js', () => ({
  decryptKey: () => TEST_POSTING_WIF,
}));

const { createApp } = await import('../../src/app.js');
const { getAppPool } = await import('../../src/app-db.js');
const { config } = await import('../../src/config.js');
const { _resetFreshAuthMemStoreForTests, issueFreshAuthToken } = await import('../../src/lib/fresh-auth.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');

const app = createApp();

const RUN_ID = Date.now();
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const ALICE = `cnsa${SUFFIX}user`;
const BOB = `cnsb${SUFFIX}user`;
const ALICE_EMAIL = `consent_alice_${RUN_ID}@example.com`;
const BOB_EMAIL = `consent_bob_${RUN_ID}@example.com`;
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

function authorAcceptOp(broadcaster: string, rootAuthor: string, rootPermlink: string) {
  return [
    'custom_json',
    {
      required_auths: [],
      required_posting_auths: [broadcaster],
      id: config.appTag,
      json: JSON.stringify({
        action: 'author_accept',
        root_author: rootAuthor,
        root_permlink: rootPermlink,
      }),
    },
  ];
}

function authorResignOp(broadcaster: string, rootAuthor: string, rootPermlink: string) {
  return [
    'custom_json',
    {
      required_auths: [],
      required_posting_auths: [broadcaster],
      id: config.appTag,
      json: JSON.stringify({
        action: 'author_resign',
        root_author: rootAuthor,
        root_permlink: rootPermlink,
      }),
    },
  ];
}

describe.skipIf(!dbReachable)('Round-3 BACKEND-COAUTHOR-TRUST-MODEL — custody consent-op + fresh-auth', () => {
  let aliceHash: string;

  beforeAll(async () => {
    if (!dbReachable) return;
    aliceHash = await argon2.hash(ALICE_PASSWORD, { type: argon2.argon2id });
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    sendOperationsMock.mockReset();
    sendOperationsMock.mockResolvedValue({ id: 'consent-op-tx-id', block_num: 1234 });
    _resetFreshAuthMemStoreForTests();
    await clearRateLimitKeys(['custody-broadcast', 'custody-fresh-auth']);

    const pool = getAppPool()!;
    await pool.query('DELETE FROM custody_audit_log WHERE username IN ($1, $2)', [ALICE, BOB]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username IN ($1, $2)', [ALICE, BOB]).catch(() => {});

    // Alice: light-custody account with a real argon2 hash + ciphertext
    // bytes (decryptKey is mocked, so the values can be placeholders).
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

    // Bob: light-custody account with a different password (used for the
    // cross-account replay test).
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

  // ─── POST /api/custody/fresh-auth (password mechanism) ────────────────

  describe('POST /api/custody/fresh-auth (password)', () => {
    it('happy path: correct password → 200 + token bound to JWT subject', async () => {
      const res = await request(app)
        .post('/api/custody/fresh-auth')
        .set('Authorization', bearerFor(ALICE))
        .send({ password: ALICE_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.data.fresh_auth_proof).toMatch(/^[0-9a-f]{64}$/);
      expect(res.body.data.mechanism).toBe('password');
      expect(typeof res.body.data.expires_at).toBe('number');
      // ~5 min in the future, give or take request latency.
      const now = Math.floor(Date.now() / 1000);
      expect(res.body.data.expires_at).toBeGreaterThan(now + 60);
      expect(res.body.data.expires_at).toBeLessThanOrEqual(now + 301);
    });

    it('wrong password → 401 UNAUTHORIZED', async () => {
      const res = await request(app)
        .post('/api/custody/fresh-auth')
        .set('Authorization', bearerFor(ALICE))
        .send({ password: 'WrongPassword1' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('missing password → 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/custody/fresh-auth')
        .set('Authorization', bearerFor(ALICE))
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('self-custody JWT → 403 FORBIDDEN (no password mechanism)', async () => {
      const res = await request(app)
        .post('/api/custody/fresh-auth')
        .set('Authorization', bearerFor(ALICE, 'self'))
        .send({ password: ALICE_PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('already-upgraded account → 403 FORBIDDEN', async () => {
      const pool = getAppPool()!;
      await pool.query('UPDATE accounts SET upgraded_at = NOW() WHERE username = $1', [ALICE]);
      const res = await request(app)
        .post('/api/custody/fresh-auth')
        .set('Authorization', bearerFor(ALICE))
        .send({ password: ALICE_PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ─── POST /api/custody/broadcast (consent ops) ─────────────────────────

  describe('POST /api/custody/broadcast (author_accept / author_resign)', () => {
    it('author_accept with valid fresh-auth → 200 + audit-log row carries auth_mechanism + session_id + user_agent', async () => {
      const issued = await issueFreshAuthToken(ALICE, 'password');
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .set('User-Agent', 'PEvO-Test/1.0')
        .send({
          fresh_auth_proof: issued.token,
          operations: [authorAcceptOp(ALICE, 'someroot', 'somepermlink-v1')],
        });
      expect(res.status).toBe(200);
      expect(res.body.data.tx_id).toBe('consent-op-tx-id');

      // Audit-log fire-and-forget; poll briefly for the row.
      const pool = getAppPool()!;
      const sql = `SELECT operation_type, auth_mechanism, fresh_auth_outcome, session_id, user_agent
                   FROM custody_audit_log WHERE username = $1`;
      const start = Date.now();
      let rows: Array<{
        operation_type: string;
        auth_mechanism: string | null;
        fresh_auth_outcome: string | null;
        session_id: string | null;
        user_agent: string | null;
      }> = [];
      while (Date.now() - start < 1500) {
        const r = await pool.query(sql, [ALICE]);
        if (r.rows.length >= 1) { rows = r.rows; break; }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(rows.length).toBe(1);
      expect(rows[0].auth_mechanism).toBe('password');
      expect(rows[0].fresh_auth_outcome).toBe('verified');
      expect(rows[0].session_id).toMatch(/^[0-9a-f]{16}$/);
      expect(rows[0].user_agent).toBe('PEvO-Test/1.0');
    });

    it('author_resign with valid fresh-auth → 200 + audit-log row', async () => {
      const issued = await issueFreshAuthToken(ALICE, 'password');
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .send({
          fresh_auth_proof: issued.token,
          operations: [authorResignOp(ALICE, 'someroot', 'somepermlink-v1')],
        });
      expect(res.status).toBe(200);

      const pool = getAppPool()!;
      const sql = `SELECT auth_mechanism FROM custody_audit_log WHERE username = $1`;
      const start = Date.now();
      let rows: Array<{ auth_mechanism: string | null }> = [];
      while (Date.now() - start < 1500) {
        const r = await pool.query(sql, [ALICE]);
        if (r.rows.length >= 1) { rows = r.rows; break; }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(rows.length).toBe(1);
      expect(rows[0].auth_mechanism).toBe('password');
    });

    it('author_accept WITHOUT fresh_auth_proof → 401 FRESH_AUTH_REQUIRED + reason missing', async () => {
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .send({ operations: [authorAcceptOp(ALICE, 'someroot', 'somepermlink-v1')] });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(res.body.error.details?.reason).toBe('missing');
      // Broadcast must NOT have run.
      expect(sendOperationsMock).not.toHaveBeenCalled();
    });

    it('replay: same token used twice → second call rejected with reason expired', async () => {
      const issued = await issueFreshAuthToken(ALICE, 'password');
      const first = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .send({
          fresh_auth_proof: issued.token,
          operations: [authorAcceptOp(ALICE, 'someroot', 'somepermlink-v1')],
        });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .send({
          fresh_auth_proof: issued.token,
          operations: [authorAcceptOp(ALICE, 'someroot', 'somepermlink-v1')],
        });
      expect(second.status).toBe(401);
      expect(second.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(second.body.error.details?.reason).toBe('expired');
    });

    it('cross-account: token issued for Bob used with Alice JWT → 401 username_mismatch', async () => {
      const bobToken = await issueFreshAuthToken(BOB, 'password');
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .send({
          fresh_auth_proof: bobToken.token,
          operations: [authorAcceptOp(ALICE, 'someroot', 'somepermlink-v1')],
        });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(res.body.error.details?.reason).toBe('username_mismatch');
    });

    it('non-consent op (vote) does NOT require fresh-auth — no regression', async () => {
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .send({
          operations: [
            ['vote', { voter: ALICE, author: 'someauthor', permlink: 'somepermlink', weight: 10000 }],
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.data.tx_id).toBe('consent-op-tx-id');
    });

    it('non-allowlisted custom_json action → 403 FORBIDDEN (allowlist regression)', async () => {
      const issued = await issueFreshAuthToken(ALICE, 'password');
      const res = await request(app)
        .post('/api/custody/broadcast')
        .set('Authorization', bearerFor(ALICE))
        .send({
          fresh_auth_proof: issued.token,
          operations: [
            ['custom_json', {
              required_auths: [],
              required_posting_auths: [ALICE],
              id: config.appTag,
              json: JSON.stringify({ action: 'definitely_not_allowed' }),
            }],
          ],
        });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });
});

// Reference the timeout-error import so the unused-import lint rule stays happy
// in environments where the suite skips entirely.
void MockBroadcastTimeoutError;

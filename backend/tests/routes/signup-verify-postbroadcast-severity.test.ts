/**
 * Regression pin: signup-verify `/confirm` + `/link` PostBroadcastWriteError
 * severity discrimination (BACKEND-REPUTATION-SSOT round-2 hold #1).
 *
 * The round-2 hold #1 fix is that both call sites pass
 * `classifyPostBroadcastSeverity(postErr)` as the 4th argument to
 * `new PostBroadcastWriteError(...)`. Without it, the default 'transient'
 * severity routes a permanent-class TypeError (programmer error in the
 * reputation-seed pipeline) through the user-facing "will reconcile
 * automatically" copy and the dashboard's transient-class disposition
 * instead of the operator-required path.
 *
 * Real-path companion: `broadcast-error.test.ts:364` pins the handler
 * branch (`severity:'permanent'` → 502 POST_BROADCAST_OPERATOR_REQUIRED);
 * `accreditation-idempotency.test.ts:402` pins the symmetric route-level
 * behavior on the accreditation surface. This file pins the signup-verify
 * call sites specifically — a mutation removing
 * `classifyPostBroadcastSeverity(postErr)` from either call site is
 * invisible to both of the above tests.
 *
 * **Carve-out clause-(a) justification:** Mocks
 * `seedAccreditationBonus` (a business-logic function) at module level so
 * the test can drive the post-broadcast TypeError path deterministically.
 * The real path requires a Hive broadcast to land + an in-process
 * TypeError to fire from the reputation seed pipeline; both are
 * non-deterministic at unit test scope. Real-path companion for the
 * **broadcast-error handler branch**: `broadcast-error.test.ts:364`
 * exercises `severity:'permanent'` → POST_BROADCAST_OPERATOR_REQUIRED
 * with real `handleBroadcastError`. Real-path companion for the
 * **route-level seed-throw cascade**: `accreditation-idempotency.test.ts:402`
 * exercises the same `seedAccreditationBonus → TypeError → 502
 * POST_BROADCAST_OPERATOR_REQUIRED` cascade through the accreditation
 * route. Both companion paths use real `verifyHiveSignature` /
 * `handleBroadcastError` / `classifyPostBroadcastSeverity` so the
 * structural mutation class is covered end-to-end at a sibling surface.
 */
import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';

const { getAccountsMock, broadcastJsonMock, createClaimedAccountMock, seedBonusMock } = vi.hoisted(() => ({
  getAccountsMock: vi.fn().mockResolvedValue([]),
  broadcastJsonMock: vi.fn().mockResolvedValue({ id: 'confirmed-on-chain-tx' }),
  createClaimedAccountMock: vi.fn().mockResolvedValue({ block_num: 12345 }),
  seedBonusMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: { getAccounts: getAccountsMock },
    broadcast: { json: broadcastJsonMock },
  },
  broadcastJsonWithTimeout: (...args: unknown[]) =>
    (broadcastJsonMock as (...a: unknown[]) => unknown)(...args),
  BroadcastTimeoutError: class BroadcastTimeoutError extends Error {
    public readonly timeoutMs: number;
    constructor(timeoutMs: number) {
      super(`Hive broadcast timed out after ${timeoutMs}ms`);
      this.name = 'BroadcastTimeoutError';
      this.timeoutMs = timeoutMs;
    }
  },
  DEFAULT_BROADCAST_TIMEOUT_MS: 30_000,
}));

vi.mock('../../src/account-creation.js', () => ({
  createClaimedAccount: createClaimedAccountMock,
  startAccountCreationWorker: vi.fn(),
  stopAccountCreationWorker: vi.fn(),
}));

vi.mock('../../src/reputation.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/reputation.js')>('../../src/reputation.js');
  return {
    ...actual,
    seedAccreditationBonus: seedBonusMock,
  };
});

import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { config } from '../../src/config.js';

if (!process.env.CUSTODY_ENCRYPTION_KEY || process.env.CUSTODY_ENCRYPTION_KEY.length < 32) {
  process.env.CUSTODY_ENCRYPTION_KEY = 'test-custody-encryption-key-32chars!';
}
config.pevoAdminPostingKey = config.pevoAdminPostingKey || PrivateKey.fromSeed('postbroadcast-severity-admin').toString();

const app = createApp();

const RUN_ID = Date.now();
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-6);

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

async function cleanupByUsername(username: string) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [username]).catch(() => {});
  await pool.query('DELETE FROM accounts WHERE username = $1', [username]).catch(() => {});
}

afterEach(() => {
  getAccountsMock.mockReset();
  getAccountsMock.mockResolvedValue([]);
  createClaimedAccountMock.mockReset();
  createClaimedAccountMock.mockResolvedValue({ block_num: 12345 });
  broadcastJsonMock.mockReset();
  broadcastJsonMock.mockResolvedValue({ id: 'confirmed-on-chain-tx' });
  seedBonusMock.mockReset();
  seedBonusMock.mockResolvedValue(undefined);
});

describe.skipIf(!dbReachable)('signup-verify /confirm: seedAccreditationBonus TypeError → 502 POST_BROADCAST_OPERATOR_REQUIRED', () => {
  const username = `sevcfm${SUFFIX}`;
  const email = `sev_confirm_${RUN_ID}@example.com`;
  const password = 'AccrConfirm1';
  const verifyToken = `confirmed:${'b2c3d4e5'.repeat(8)}`;

  async function reseedRow() {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await cleanupByUsername(username);
    await pool.query('DELETE FROM accounts WHERE email = $1', [email]).catch(() => {});
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await pool.query(
      `INSERT INTO accounts (email, password_hash, full_name, institution, field, verify_token, expires_at)
       VALUES ($1, $2, 'Severity Pin', 'MIT', 'physics', $3, $4)`,
      [email, passwordHash, verifyToken, expiresAt],
    );
  }

  afterAll(async () => cleanupByUsername(username));

  it('TypeError from seedAccreditationBonus → POST_BROADCAST_OPERATOR_REQUIRED, not POST_BROADCAST_FAILED', async () => {
    // Reseed inside the it() body so vitest's `retry:1` (set in
    // backend/vitest.config.ts) replays cleanly — /confirm consumes the
    // verify_token at signup-verify.ts:303 (sets to NULL) before the
    // broadcast even fires, so a retry without a fresh row would 400
    // "Invalid or expired token".
    await reseedRow();

    // Broadcast succeeds (chain op landed), then seed throws TypeError —
    // the permanent class that `seedAccreditationBonus` re-throws per
    // `broadcast-error.ts:47-55`. Without `classifyPostBroadcastSeverity`,
    // the default 'transient' severity emits POST_BROADCAST_FAILED + the
    // "reconcile automatically" copy. With it, POST_BROADCAST_OPERATOR_REQUIRED
    // + "please contact support".
    seedBonusMock.mockRejectedValueOnce(new TypeError('reputation seed shape regression'));
    broadcastJsonMock.mockResolvedValue({ id: 'signup-confirm-tx-permanent' });

    const res = await request(app)
      .post('/api/auth/confirm')
      .send({
        auth_token: verifyToken,
        username,
        keys: {
          owner_public: PrivateKey.fromSeed(`${username}-o`).createPublic().toString(),
          active_public: PrivateKey.fromSeed(`${username}-a`).createPublic().toString(),
          posting_public: PrivateKey.fromSeed(`${username}-p`).createPublic().toString(),
          memo_public: PrivateKey.fromSeed(`${username}-m`).createPublic().toString(),
          posting_private: PrivateKey.fromSeed(`${username}-p`).toString(),
          memo_private: PrivateKey.fromSeed(`${username}-m`).toString(),
        },
      });

    expect(res.status).toBe(502);
    expect(res.body.error?.code).toBe('POST_BROADCAST_OPERATOR_REQUIRED');
    expect(res.body.error?.code).not.toBe('POST_BROADCAST_FAILED');
    expect(res.body.error?.details).toMatchObject({
      retriable: false,
      outcome: 'confirmed',
      tx_id: 'signup-confirm-tx-permanent',
      failed_step: 'reputation_seed',
    });
    // signup-verify supplies a custom postBroadcastMsgFn that emits the
    // same per-step user message regardless of severity, so the
    // "please contact support" fallback copy is NOT asserted here. The
    // discriminator that matters is the response CODE
    // (POST_BROADCAST_OPERATOR_REQUIRED) — operator alert routing and
    // dashboard disposition both key off the code, not the user message.
    // Internal error must not leak.
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('reputation seed shape regression');
    // No JWT issued — the dangling-JWT class from round-1 hold #8 stays
    // closed.
    expect(res.body.data?.token).toBeFalsy();
  });
});

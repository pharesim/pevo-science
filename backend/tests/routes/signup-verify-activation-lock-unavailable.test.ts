/**
 * Redis-down fail-closed coverage for the signup-finalization activation lock.
 *
 * `createClaimedAccount` burns a finite claim token (an irreversible write), so
 * the per-auth_token activation lock that single-fires it does NOT degrade to a
 * no-lock / in-memory path when Redis is unavailable (unlike the idempotent
 * orcid/bridge locks). It fails closed: acquire returns
 * `{ acquired: false, reason: 'unavailable' }` and the route wrapper maps that to
 * a retriable 503 SERVICE_UNAVAILABLE, never proceeding lock-free.
 *
 * Two properties:
 *   (a) Unit: with Redis unavailable, `acquireSignupActivationLock(token)`
 *       resolves to `{ acquired: false, reason: 'unavailable' }`.
 *   (b) Route: with Redis unavailable, a valid /confirm body yields a 503
 *       SERVICE_UNAVAILABLE `{ retriable: true }` and `createClaimedAccount` is
 *       NEVER called (the lock short-circuits before any chain op).
 *
 * **Carve-out clause-(a)/(c) justification.**
 *   (a) `../../src/redis.js` is mocked so `getRedis()` returns null and
 *       `isRedisAvailable()` returns false for the whole file — this is the
 *       deterministic stand-in for a Redis outage, which cannot be induced
 *       reliably against a live Redis per-test. The lock's own
 *       `tryAcquireOnce` then takes the `!redis || !isRedisAvailable()` ->
 *       'unavailable' branch. `createClaimedAccount` + the Hive client are
 *       mocked only to assert non-invocation and to keep the route off the real
 *       chain; the pg app pool is NOT mocked (the route reads the real pool, but
 *       the lock short-circuits before any pg work). With Redis null, the
 *       /confirm rate-limit middleware falls back to its in-memory path, so the
 *       request still reaches the lock.
 *   (b) /confirm carries no verifyHiveSignature middleware — its resume-path
 *       auth is the in-handler posting-key proof, which is not reached here
 *       (the lock fails closed first). No auth middleware is mocked.
 *   (c) Real-path companion: `signup-verify-concurrent-activation.test.ts`
 *       drives the real activation lock against real Redis + Postgres
 *       (single-fire), and `signup-verify-activation-recovery.test.ts` exercises
 *       the real lock's held->409 path. This file covers ONLY the
 *       Redis-unavailable fail-closed branch those real-Redis suites cannot
 *       reach.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';

vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
}));

const { getAccountsMock, broadcastJsonMock, createClaimedAccountMock } = vi.hoisted(() => ({
  getAccountsMock: vi.fn().mockResolvedValue([]),
  broadcastJsonMock: vi.fn().mockResolvedValue({ id: 'mock-tx' }),
  createClaimedAccountMock: vi.fn().mockResolvedValue({ block_num: 12345 }),
}));

vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: { getAccounts: getAccountsMock },
    broadcast: { json: broadcastJsonMock },
  },
  broadcastJsonWithTimeout: (...args: unknown[]) =>
    (broadcastJsonMock as (...a: unknown[]) => unknown)(...args),
  broadcastAdminCustomJson: (payload: Record<string, unknown>, timeoutMs?: number) =>
    (broadcastJsonMock as (...a: unknown[]) => unknown)(
      { required_auths: [], required_posting_auths: [], json: JSON.stringify(payload) },
      undefined,
      timeoutMs,
    ),
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

import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { config } from '../../src/config.js';
import { acquireSignupActivationLock } from '../../src/lib/signup-activation-lock.js';

if (!process.env.CUSTODY_ENCRYPTION_KEY || process.env.CUSTODY_ENCRYPTION_KEY.length < 32) {
  process.env.CUSTODY_ENCRYPTION_KEY = 'test-activation-unavailable-32chars!';
}
config.pevoAdminPostingKey = config.pevoAdminPostingKey || PrivateKey.fromSeed('activation-unavailable-admin').toString();

const app = createApp();
const RUN_ID = Date.now();

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

function buildKeys(username: string) {
  return {
    owner_public: PrivateKey.fromSeed(`${username}-o`).createPublic().toString(),
    active_public: PrivateKey.fromSeed(`${username}-a`).createPublic().toString(),
    posting_public: PrivateKey.fromSeed(`${username}-p`).createPublic().toString(),
    memo_public: PrivateKey.fromSeed(`${username}-m`).createPublic().toString(),
    posting_private: PrivateKey.fromSeed(`${username}-p`).toString(),
    memo_private: PrivateKey.fromSeed(`${username}-m`).toString(),
  };
}

afterEach(() => {
  getAccountsMock.mockReset().mockResolvedValue([]);
  broadcastJsonMock.mockReset().mockResolvedValue({ id: 'mock-tx' });
  createClaimedAccountMock.mockReset().mockResolvedValue({ block_num: 12345 });
});

// ─────────────────────────────────────────────────────────────────
// (a) Unit: Redis-unavailable acquire fails closed with reason 'unavailable'.
// ─────────────────────────────────────────────────────────────────
describe('acquireSignupActivationLock — Redis unavailable', () => {
  it('returns { acquired: false, reason: "unavailable" } when Redis is down (no in-memory fallback)', async () => {
    const lock = await acquireSignupActivationLock('tok');
    expect(lock.acquired).toBe(false);
    // Narrow the discriminated union before reading `reason`.
    if (!lock.acquired) {
      expect(lock.reason).toBe('unavailable');
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// (b) Route: Redis-unavailable /confirm fails closed with a retriable 503,
//     and never reaches the irreversible createClaimedAccount.
// ─────────────────────────────────────────────────────────────────
describe.skipIf(!dbReachable)('/confirm fails closed (503) when Redis is unavailable', () => {
  const username = `lkun${(RUN_ID % 100000).toString(36).padStart(4, '0').slice(-6)}`;

  it('returns 503 SERVICE_UNAVAILABLE { retriable: true } and does NOT call createClaimedAccount', async () => {
    // A well-formed /confirm body (valid username + all key fields). The lock is
    // acquired BEFORE any pg row work, so the 503 fires regardless of whether a
    // pending row exists; createClaimedAccount is never reached.
    const res = await request(app)
      .post('/api/auth/confirm')
      .send({
        auth_token: `confirmed:${'b0'.repeat(32)}`,
        username,
        keys: buildKeys(username),
      });

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error?.details?.retriable).toBe(true);
    // Fail-closed: the irreversible chain op never ran without the single-fire guard.
    expect(createClaimedAccountMock).not.toHaveBeenCalled();
  });
});

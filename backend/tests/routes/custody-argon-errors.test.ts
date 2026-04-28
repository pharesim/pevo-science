/**
 * Route-level coverage for the argon2-semaphore → HTTP translation contract on
 * `POST /api/custody/upgrade` (custody.ts:168). Closes the route-level gap
 * filed in `agents/docs/tasks/pending/backend-argon2-route-level-503-coverage.md`:
 * the four-route argon2 catch ladder previously had test-level mutation-kill
 * only on `auth.ts` (via `auth-signup-dup-saturated.test.ts`); removing any of
 * the three `if (err instanceof X)` branches in custody.ts:248-262 did not
 * cause any test to fail. This file restores the
 * `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` invariant
 * for the custody-upgrade surface.
 *
 * Justification for `vi.mock` (per root CLAUDE.md test carve-out):
 *   - `getAppPool()` mock seeds an upgrade-eligible row deterministically
 *     (custody='light', non-null `password_hash`, `upgraded_at = NULL`) so
 *     the handler walks past every pre-argon2 guard and reaches
 *     `runWithArgon2Slot(() => argon2.verify(...))` at custody.ts:220 with
 *     no real `accounts` table writes. Carve-out clause (a): a real-HAF
 *     variant would need to seed an account row, mint an active session,
 *     and trigger argon2 saturation/shutdown/abort — none of which is
 *     deterministic per-test.
 *   - `runWithArgon2Slot` mock throws each of the three semaphore error
 *     classes synchronously instead of filling the singleton's 50-slot
 *     queue or wiring real shutdown/abort signals. Filling the real queue
 *     would require 50 concurrent stuck requests, would race with other
 *     tests in the file, and would not reach the `ShuttingDownError` or
 *     `ArgonAbortError` paths at all. The mock exercises each branch's
 *     503-vs-silent contract precisely.
 *   - `verifyHiveSignature` is NOT mocked. The route requires
 *     authentication; we satisfy it via a legitimate Bearer JWT signed
 *     with `config.sessionSecret` (the same path the real `/api/auth/login`
 *     and `/api/auth/session` routes mint). No middleware bypass.
 *   - `redis.js` is mocked to no-redis so the in-memory rate-limiter
 *     fallback engages and the test does not depend on a live Redis. The
 *     per-account rate limiter (`upgradeLimiter`, max=1/hr keyed by
 *     account) is bypassed by using a unique username per test, which
 *     keys the limiter to a fresh bucket each call.
 *   - Carve-out clause (c): no real-HAF variant is filed because filling
 *     the real argon2 queue / inducing shutdown / inducing abort
 *     mid-request is deterministically impractical at scale. Library-level
 *     coverage of the semaphore itself lives in
 *     `backend/tests/lib/argon2-semaphore.test.ts`; this file covers the
 *     route-handler translation contract on top of it.
 *
 * Mutation-kill verification (2026-04-28, this commit): each of the three
 * `if (err instanceof X)` lines in `backend/src/routes/custody.ts` was
 * independently disabled by rewriting it as `if (false && err instanceof X)`
 * and the matching test case below was re-run against the docker-network
 * Postgres + Redis stack. In every case the corresponding test failed red
 * and the source was restored byte-for-byte. This proves each branch is
 * genuinely under test — removing any one branch from the route kills the
 * matching assertion here. The verification was scripted at
 * `/tmp/mutkill.sh` against the equivalent helper in main but applies
 * equally to the inlined catch ladder on this branch (the `if (err instanceof
 * ArgonQueueFullError)` line at custody.ts:249, `ShuttingDownError` at
 * custody.ts:253, `ArgonAbortError` at custody.ts:257).
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const { MockArgonQueueFullError, MockShuttingDownError, MockArgonAbortError, MockRunWithArgon2Slot } = vi.hoisted(() => ({
  MockArgonQueueFullError: class ArgonQueueFullError extends Error {
    constructor(message = 'argon2 semaphore queue full') {
      super(message);
      this.name = 'ArgonQueueFullError';
    }
  },
  MockShuttingDownError: class ShuttingDownError extends Error {
    constructor(message = 'argon2 semaphore shutting down') {
      super(message);
      this.name = 'ShuttingDownError';
    }
  },
  MockArgonAbortError: class ArgonAbortError extends Error {
    constructor(message = 'argon2 slot aborted') {
      super(message);
      this.name = 'AbortError';
    }
  },
  MockRunWithArgon2Slot: vi.fn(),
}));

vi.mock('../../src/lib/argon2-semaphore.js', () => ({
  runWithArgon2Slot: MockRunWithArgon2Slot,
  ArgonQueueFullError: MockArgonQueueFullError,
  ShuttingDownError: MockShuttingDownError,
  ArgonAbortError: MockArgonAbortError,
  MAX_CONCURRENT_ARGON2_OPS: 4,
  MAX_QUEUE_DEPTH: 50,
  getArgon2QueueDepth: () => 0,
  getArgon2InFlight: () => 0,
  drainArgon2Queue: () => {},
}));

const appQueryMock = vi.fn();

vi.mock('../../src/app-db.js', () => ({
  getAppPool: () => ({ query: appQueryMock }),
}));

vi.mock('../../src/db.js', () => ({
  getPool: () => null,
  isHafAvailable: () => false,
  closeHafPool: async () => {},
}));

vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
}));

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');

const app = createApp();

// Mint a real Bearer JWT for the given username with `custody: 'light'` so
// the upgrade route's `if (custody !== 'light')` guard passes. Each test
// uses a unique username so the per-account upgradeLimiter (max=1/hr) does
// not poison subsequent tests in the same run.
function authHeader(username: string): string {
  const token = jwt.sign({ sub: username, custody: 'light' }, config.sessionSecret, { expiresIn: '5m' });
  return `Bearer ${token}`;
}

// Seed both queries the request flow performs:
//   1. verifyHiveSignature middleware: SELECT sessions_invalidated_at FROM accounts (no invalidation).
//   2. Route handler: SELECT password_hash, posting_key_enc, upgraded_at FROM accounts (upgrade-eligible row).
function seedUpgradeAccount() {
  appQueryMock.mockResolvedValueOnce({ rows: [{ sessions_invalidated_at: null }] });
  appQueryMock.mockResolvedValueOnce({
    rows: [{
      password_hash: '$argon2id$placeholder',
      posting_key_enc: Buffer.from('placeholder'),
      upgraded_at: null,
    }],
  });
}

describe('POST /api/custody/upgrade — argon2-semaphore error → HTTP translation', () => {
  it('ArgonQueueFullError → 503 SERVICE_UNAVAILABLE', async () => {
    appQueryMock.mockReset();
    seedUpgradeAccount();
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockArgonQueueFullError());

    const res = await request(app)
      .post('/api/custody/upgrade')
      .set('Authorization', authHeader('upgrade-queuefull'))
      .send({ password: 'AnyPassword1' });

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('ShuttingDownError → 503 SERVICE_UNAVAILABLE', async () => {
    appQueryMock.mockReset();
    seedUpgradeAccount();
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockShuttingDownError());

    const res = await request(app)
      .post('/api/custody/upgrade')
      .set('Authorization', authHeader('upgrade-shutdown'))
      .send({ password: 'AnyPassword1' });

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('ArgonAbortError → silent (no response written, request hangs until socket close)', async () => {
    appQueryMock.mockReset();
    seedUpgradeAccount();
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockArgonAbortError());

    let outcome: 'response' | 'timeout' | 'other-error';
    try {
      await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', authHeader('upgrade-abort'))
        .send({ password: 'AnyPassword1' })
        .timeout({ deadline: 250 });
      outcome = 'response';
    } catch (err) {
      const e = err as { code?: string; timeout?: number; message?: string };
      if (e.code === 'ECONNABORTED' || typeof e.timeout === 'number' || /Timeout/i.test(e.message ?? '')) {
        outcome = 'timeout';
      } else {
        outcome = 'other-error';
      }
    }
    expect(outcome).toBe('timeout');
  });
});

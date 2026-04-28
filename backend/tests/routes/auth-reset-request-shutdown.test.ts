/**
 * Route test for BE-RESET-REQUEST-SHUTDOWN-ENUMERATION:
 * `POST /api/auth/reset-request` MUST return the same status code on the
 * unknown-email branch as on the known-email branch when the argon2
 * semaphore is shutting down (SIGTERM drain). Before the fix, the
 * unknown-email branch ran `burnSentinel`, which rethrew `ShuttingDownError`,
 * which the outer catch translated to 503 via `handleArgonError` — while the
 * known-email branch never touched argon2 and returned 200 from the SMTP
 * fall-through. That status-code differential was a direct email-enumeration
 * oracle on every rolling-deploy drain window: paired probes (one known + one
 * unknown email) returned 200 vs 503 deterministically.
 *
 * The fix is Option A from the task: catch `ShuttingDownError` on the
 * unknown-email branch and fall through to the same generic 200 the
 * known-email branch returns. Any other error (including `ArgonQueueFullError`
 * and `ArgonAbortError`) still propagates to the outer catch.
 *
 * Justification for `vi.mock` (per root CLAUDE.md test carve-out, clauses
 * a/b/c):
 *   (a) Real-path impracticality: the only way to drive a real
 *       `ShuttingDownError` through the live argon2 semaphore is to invoke
 *       `drainArgon2Queue()` against the singleton mid-test, which is racy
 *       with concurrent suite runs against the same process and would leave
 *       the singleton drained for sibling tests. Per-test mocking of
 *       `runWithArgon2Slot` injects the error class deterministically without
 *       touching the singleton.
 *   (b) `getAppPool()` is mocked to return seeded/empty rows for the two
 *       branches, matching the established pattern in
 *       `auth-signup-dup-saturated.test.ts`. `verifyHiveSignature` is NOT
 *       mocked — `/reset-request` is unauthenticated.
 *   (c) No real-HAF variant is filed because the drain scenario is
 *       fundamentally a singleton-state mutation; route-level real-HAF
 *       coverage of the steady-state 200 lives in `auth.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

// Hoisted error classes shared with the semaphore mock and the test body so
// `instanceof` checks inside the route handler resolve to the same class the
// test injects. Mirrors the pattern in `auth-signup-dup-saturated.test.ts`.
const {
  MockArgonSemaphoreError,
  MockArgonQueueFullError,
  MockShuttingDownError,
  MockArgonAbortError,
  MockRunWithArgon2Slot,
} = vi.hoisted(() => {
  abstract class ArgonSemaphoreError extends Error {}
  class ArgonQueueFullError extends ArgonSemaphoreError {
    constructor(message = 'argon2 semaphore queue full') {
      super(message);
      this.name = 'ArgonQueueFullError';
    }
  }
  class ShuttingDownError extends ArgonSemaphoreError {
    constructor(message = 'argon2 semaphore shutting down') {
      super(message);
      this.name = 'ShuttingDownError';
    }
  }
  class ArgonAbortError extends ArgonSemaphoreError {
    constructor(message = 'argon2 slot aborted') {
      super(message);
      this.name = 'AbortError';
    }
  }
  return {
    MockArgonSemaphoreError: ArgonSemaphoreError,
    MockArgonQueueFullError: ArgonQueueFullError,
    MockShuttingDownError: ShuttingDownError,
    MockArgonAbortError: ArgonAbortError,
    MockRunWithArgon2Slot: vi.fn(),
  };
});

vi.mock('../../src/lib/argon2-semaphore.js', () => ({
  runWithArgon2Slot: MockRunWithArgon2Slot,
  ArgonSemaphoreError: MockArgonSemaphoreError,
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

// HAF + Redis stubs — neither is needed by /reset-request.
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

const app = createApp();

describe('POST /api/auth/reset-request — drain-window enumeration fix', () => {
  it('unknown-email returns 200 during shutdown (matches known-email 200) instead of 503', async () => {
    // Empty rows = unknown-email branch; the handler will call burnSentinel.
    appQueryMock.mockReset();
    appQueryMock.mockResolvedValueOnce({ rows: [] });

    // Force the burnSentinel argon2.verify to throw ShuttingDownError, as
    // would happen on any incoming request mid-drain after `drainArgon2Queue`
    // has fired.
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockShuttingDownError());

    const res = await request(app)
      .post('/api/auth/reset-request')
      .send({ email: 'unknown-during-drain@mit.edu' });

    expect(res.status).toBe(200);
    // Critical: NOT 503. Before the fix, ShuttingDownError propagated to the
    // outer catch and `handleArgonError` translated it to 503, while the
    // known-email branch returned 200 — the enumeration oracle this fix
    // closes.
    expect(res.status).not.toBe(503);
    expect(res.body.data?.message).toBe('If an account exists with that email, a reset link has been sent.');
  });

  it('known-email returns 200 during shutdown (sanity check; the known branch never touches argon2)', async () => {
    // Seed: existing account row. Known-email branch issues a DB UPDATE for
    // the reset token, then attempts SMTP. Without a configured SMTP host
    // (config.smtpHost is unset in the test env) the handler logs a warning
    // and falls through to the uniform 200. The argon2 semaphore is never
    // touched on this branch, so shutdown does not affect it.
    appQueryMock.mockReset();
    // SELECT id, username
    appQueryMock.mockResolvedValueOnce({ rows: [{ id: 42, username: 'known-user' }] });
    // UPDATE accounts SET reset_token = ...
    appQueryMock.mockResolvedValueOnce({ rows: [] });

    // Even if the semaphore mock would throw, this branch never calls into
    // it. Reset to a no-op for safety.
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/auth/reset-request')
      .send({ email: 'known-during-drain@mit.edu' });

    expect(res.status).toBe(200);
    expect(res.body.data?.message).toBe('If an account exists with that email, a reset link has been sent.');
  });

  it('unknown-email still returns 503 when the semaphore is queue-full (drain fix is ShuttingDownError-only)', async () => {
    // ArgonQueueFullError is a saturation signal, not a shutdown signal: the
    // server is still serving traffic, the timing oracle the burn closes is
    // still at risk, and the rest of the cluster is healthy. Returning 503
    // (with Retry-After) is the correct behavior; the fix MUST NOT widen the
    // catch to swallow it. The status-code differential under saturation is
    // already documented as an accepted tradeoff in the wrapping-primitive
    // convention doc — saturation is rare and operator-visible, while
    // shutdown is predictable on every deploy.
    appQueryMock.mockReset();
    appQueryMock.mockResolvedValueOnce({ rows: [] });

    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockArgonQueueFullError());

    const res = await request(app)
      .post('/api/auth/reset-request')
      .send({ email: 'unknown-saturated@mit.edu' });

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
  });
});

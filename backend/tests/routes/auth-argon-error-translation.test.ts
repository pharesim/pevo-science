/**
 * Route-level integration coverage for the argon2-semaphore → HTTP-response
 * translation contract on every `auth.ts` endpoint that calls
 * `runWithArgon2Slot` (directly or transitively via burnSentinel).
 *
 * Locks the security invariant from `backend-argon2-error-routes-test-coverage.md`:
 * a mutation that drops `instanceof ArgonQueueFullError` / `ShuttingDownError`
 * / `ArgonAbortError` from any route's catch chain — or from `burnSentinel`'s
 * propagate-on-semaphore-error guard — would not be caught by the
 * library-level handler tests alone. Each route × each error class wires the
 * full Express stack so the wire-level outcome (status, body, Retry-After,
 * silent-no-write) is asserted end-to-end.
 *
 * ── vi.mock carve-out justification (per root CLAUDE.md "Running Tests") ──
 *
 * (a) IMPRACTICALITY OF REAL HAF/REAL-QUEUE-SATURATION:
 *     - `runWithArgon2Slot` mock throws `ArgonQueueFullError` /
 *       `ShuttingDownError` / `ArgonAbortError` synchronously rather than
 *       requiring 50 concurrent stuck argon2 hashes (MAX_QUEUE_DEPTH=50)
 *       AND a real SIGTERM-drain mid-test (which would poison every
 *       subsequent test in the same Vitest worker — `drainArgon2Queue`
 *       on the singleton is irreversible, see argon2-semaphore.ts:362-369).
 *       The mock injects the exact errors the production handler is required
 *       to catch; the route-level translation is what's under test, not the
 *       semaphore's saturation logic (covered by `tests/lib/argon2-semaphore.test.ts`).
 *     - `getAppPool()` mock seeds DB rows deterministically without writing
 *       to the real `accounts` table during a test run, identical to the
 *       precedent set by `auth-signup-dup-saturated.test.ts`.
 *
 * (b) `verifyHiveSignature` is NOT mocked. None of the auth.ts argon-using
 *     endpoints (`/login`, `/resend-verification`, `/reset-request`,
 *     `/reset`, `/recover`) require it — they're unauthenticated by design.
 *     `/custody/upgrade` and `/settings/set-password` (covered by sibling
 *     test files) DO require it; those files satisfy the middleware via a
 *     legitimate Bearer JWT signed with `config.sessionSecret`, never via
 *     mock injection.
 *
 * (c) REAL-HAF VARIANT: the library-level coverage at
 *     `tests/lib/argon2-error-handler.test.ts` (10 tests) asserts the same
 *     three-class translation contract against the real handler with a
 *     mocked-Express response. This file complements that coverage by
 *     exercising the FULL Express stack (routing, middleware, body parsing,
 *     header serialization, sendError/sendOk shape). A real-HAF variant
 *     would require the queue-saturation mechanism described in (a), which
 *     is impractical at unit-test scale.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

// Hoisted error classes shared with the semaphore mock so the route's
// `instanceof` checks resolve to the same constructors the test injects.
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

// HAF + Redis stubs — the argon-error paths covered here don't depend on
// either. Redis-disabled mode falls back to in-memory rate limiting and
// in-memory replay caches (which we don't exercise here either).
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
const { SERVICE_UNAVAILABLE_MESSAGE } = await import('../../src/lib/argon2-error-handler.js');

const app = createApp();

// Per-route minimum body needed to traverse middleware + validation and
// reach the catch-block where `handleArgonError` triages the thrown error.
// Values are deliberately bland — these tests never assert on happy-path
// content, only on the 503 / silent-abort translation.
type RouteCase = {
  name: string;
  method: 'post';
  path: string;
  body: Record<string, unknown>;
  // Seeded DB rows (called via appQueryMock) that the route will read
  // before hitting argon2. Empty array = "no row found" path.
  seedRows: () => void;
};

const routes: RouteCase[] = [
  {
    name: 'POST /api/auth/login (known account, hits argon2.verify)',
    method: 'post',
    path: '/api/auth/login',
    body: { email_or_username: 'alice@mit.edu', password: 'AnyPassword1' },
    seedRows: () => {
      // Single-row response with non-null password_hash drives the route to
      // `runWithArgon2Slot(() => argon2.verify(...))` at auth.ts:738.
      appQueryMock.mockResolvedValueOnce({
        rows: [{
          id: 1,
          email: 'alice@mit.edu',
          username: 'alice',
          password_hash: '$argon2id$placeholder',
          verify_token: null,
          custody: 'light',
          upgraded_at: null,
          expires_at: null,
          login_failures: 0,
        }],
      });
    },
  },
  {
    name: 'POST /api/auth/resend-verification (known email, hits argon2.verify)',
    method: 'post',
    path: '/api/auth/resend-verification',
    body: { email: 'bob@mit.edu', password: 'AnyPassword1' },
    seedRows: () => {
      // password_hash present → route runs runWithArgon2Slot(verify) at
      // auth.ts:591 instead of falling into burnSentinel.
      appQueryMock.mockResolvedValueOnce({
        rows: [{ id: 2, password_hash: '$argon2id$placeholder', verify_token: 'pending-token' }],
      });
    },
  },
  {
    name: 'POST /api/auth/reset-request (unknown email, hits burnSentinel → runWithArgon2Slot)',
    method: 'post',
    path: '/api/auth/reset-request',
    body: { email: 'unknown@mit.edu' },
    seedRows: () => {
      // Empty rows → unknown-email branch → burnSentinel → runWithArgon2Slot
      // (auth.ts:830). Exercises the burn-side semaphore catch chain.
      appQueryMock.mockResolvedValueOnce({ rows: [] });
    },
  },
  {
    name: 'POST /api/auth/reset (valid token, hits argon2.hash)',
    method: 'post',
    path: '/api/auth/reset',
    body: { token: 'a'.repeat(64), password: 'NewPassword1' },
    seedRows: () => {
      // Token row with future expiry → route runs runWithArgon2Slot(hash)
      // at auth.ts:936. Date 1 hour in the future avoids the expired branch.
      appQueryMock.mockResolvedValueOnce({
        rows: [{
          id: 3,
          username: 'carol',
          reset_token_expires_at: new Date(Date.now() + 60 * 60 * 1000),
        }],
      });
    },
  },
  {
    name: 'POST /api/auth/recover (unknown user + password provided, hits burnSentinel → runWithArgon2Slot)',
    method: 'post',
    path: '/api/auth/recover',
    body: {
      username: 'dave',
      memo_key: 'STM5fakekey',
      new_email: 'dave@mit.edu',
      new_password: 'NewPassword1',
    },
    seedRows: () => {
      // Empty rows → unknown-username branch with passwordProvided=true →
      // burnSentinel(new_password) → runWithArgon2Slot at auth.ts:1034.
      appQueryMock.mockResolvedValueOnce({ rows: [] });
    },
  },
];

describe.each(routes)('argon error → HTTP translation: $name', (route) => {
  it('ArgonQueueFullError → 503 SERVICE_UNAVAILABLE + Retry-After: 5 + generic body', async () => {
    appQueryMock.mockReset();
    route.seedRows();
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockArgonQueueFullError());

    const res = await request(app)[route.method](route.path).send(route.body);

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error?.message).toBe(SERVICE_UNAVAILABLE_MESSAGE);
    expect(res.headers['retry-after']).toBe('5');
    // Body MUST NOT leak the underlying chokepoint or deployment state.
    expect(res.body.error?.message).not.toMatch(/argon|authentication|shut\s?down/i);
  });

  it('ShuttingDownError → 503 SERVICE_UNAVAILABLE + Retry-After: 30 + generic body', async () => {
    appQueryMock.mockReset();
    route.seedRows();
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockShuttingDownError());

    const res = await request(app)[route.method](route.path).send(route.body);

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error?.message).toBe(SERVICE_UNAVAILABLE_MESSAGE);
    expect(res.headers['retry-after']).toBe('30');
  });

  it('ArgonAbortError → silent (no response written, request hangs until socket close)', async () => {
    // Contract: the route catches ArgonAbortError and returns WITHOUT writing
    // a response (the client socket is gone in production; here supertest's
    // socket is still open so the request observably hangs). We give it 250ms
    // to either respond (mutation) or time out (correct silent path), then
    // assert the latter. 250ms is well under Vitest's default 30s testTimeout
    // and well above the few-ms a real handler would take to write any
    // response if the mutation were in place.
    appQueryMock.mockReset();
    route.seedRows();
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockArgonAbortError());

    const reqPromise = request(app)[route.method](route.path)
      .send(route.body)
      .timeout({ deadline: 250 });

    // supertest's `.timeout()` rejects with a timeout error when the deadline
    // expires without a response; that rejection IS the silent-abort proof.
    // Any other outcome (resolved with a 200/4xx/5xx response, OR rejected
    // with a non-timeout error) means the route did NOT hold the socket
    // silent and the contract has been broken.
    let outcome: { kind: 'response'; status: number } | { kind: 'timeout' } | { kind: 'other-error'; err: unknown };
    try {
      const res = await reqPromise;
      outcome = { kind: 'response', status: res.status };
    } catch (err) {
      const e = err as { code?: string; timeout?: number; message?: string };
      // superagent surfaces deadline-exceeded as `code === 'ECONNABORTED'`
      // with a `.timeout` property set. Match either signal robustly.
      if (e.code === 'ECONNABORTED' || typeof e.timeout === 'number' || /Timeout/i.test(e.message ?? '')) {
        outcome = { kind: 'timeout' };
      } else {
        outcome = { kind: 'other-error', err };
      }
    }

    expect(outcome.kind).toBe('timeout');
  });
});

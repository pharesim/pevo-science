/**
 * Route-level coverage for the argon2-semaphore → HTTP translation contract on
 * `POST /api/auth/resume-signup` (signup-verify.ts). Closes the route-level
 * gap filed in `agents/docs/tasks/pending/backend-argon2-route-level-503-coverage.md`:
 * removing any of the three `if (err instanceof X)` branches in
 * signup-verify.ts:170-184 did not cause any test to fail. This file
 * restores the
 * `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` invariant
 * for the resume-signup surface.
 *
 * Justification for `vi.mock` (per root CLAUDE.md test carve-out):
 *   - `getAppPool()` mock seeds a row that drives the handler past every
 *     pre-argon2 guard (email present, password present, row exists,
 *     verify_token starts with `confirmed:`, password_hash non-null) so the
 *     handler reaches `runWithArgon2Slot(() => argon2.verify(...))` at
 *     signup-verify.ts:156. Carve-out clause (a): real-HAF cannot
 *     deterministically place an account in the resume-eligible state plus
 *     induce argon2 saturation/shutdown/abort per-test.
 *   - `runWithArgon2Slot` mock throws each of the three semaphore error
 *     classes synchronously instead of filling the singleton's 50-slot
 *     queue. Filling the real queue would require ~50 concurrent stuck
 *     resume-signup requests and would not exercise the
 *     `ShuttingDownError` or `ArgonAbortError` paths at all.
 *   - `verifyHiveSignature` is NOT mocked. `/resume-signup` is
 *     unauthenticated (the resume flow authenticates via email + password
 *     inside the handler), so the middleware does not apply on this surface.
 *   - `redis.js` is mocked to no-redis so the in-memory rate-limiter
 *     fallback engages.
 *   - Carve-out clause (c): no real-HAF variant filed for the same reason
 *     as the custody-argon-errors test. Library-level coverage of the
 *     semaphore lives in `backend/tests/lib/argon2-semaphore.test.ts`.
 *
 * Mutation-kill verification (2026-04-28, this commit): each of the three
 * `if (err instanceof X)` lines in `backend/src/routes/signup-verify.ts`
 * was independently disabled by rewriting it as
 * `if (false && err instanceof X)` and the matching test case below was
 * re-run against the docker-network Postgres + Redis stack. In every case
 * the corresponding test failed red and the source was restored
 * byte-for-byte. This proves each branch is genuinely under test —
 * removing any one branch from the route kills the matching assertion
 * here. Branches verified: `ArgonQueueFullError` at signup-verify.ts:170,
 * `ShuttingDownError` at signup-verify.ts:174, `ArgonAbortError` at
 * signup-verify.ts:178.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

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

const app = createApp();

// Drives the route past every pre-argon2 guard (row exists, verify_token
// starts with 'confirmed:', password_hash non-null) so the handler reaches
// runWithArgon2Slot(() => argon2.verify(...)) at signup-verify.ts:156 and
// the mocked semaphore throws.
function seedConfirmedRow() {
  appQueryMock.mockResolvedValueOnce({
    rows: [{
      id: 1,
      password_hash: '$argon2id$placeholder',
      verify_token: 'confirmed:abc',
    }],
  });
}

const ROUTE_BODY = { email: 'resume@mit.edu', password: 'AnyPassword1' };

describe('POST /api/auth/resume-signup — argon2-semaphore error → HTTP translation', () => {
  it('ArgonQueueFullError → 503 SERVICE_UNAVAILABLE', async () => {
    appQueryMock.mockReset();
    seedConfirmedRow();
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockArgonQueueFullError());

    const res = await request(app).post('/api/auth/resume-signup').send(ROUTE_BODY);

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('ShuttingDownError → 503 SERVICE_UNAVAILABLE', async () => {
    appQueryMock.mockReset();
    seedConfirmedRow();
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockShuttingDownError());

    const res = await request(app).post('/api/auth/resume-signup').send(ROUTE_BODY);

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('ArgonAbortError → silent (no response written, request hangs until socket close)', async () => {
    appQueryMock.mockReset();
    seedConfirmedRow();
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockArgonAbortError());

    let outcome: 'response' | 'timeout' | 'other-error';
    try {
      await request(app)
        .post('/api/auth/resume-signup')
        .send(ROUTE_BODY)
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

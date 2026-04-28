/**
 * Route test for the BE-ARGON2-JSLEVEL-CONCURRENCY-CAP round-3 hold P1 fix:
 * the `/signup` duplicate-email burn `.catch()` MUST rethrow
 * `ArgonQueueFullError` (and `ShuttingDownError`) so the outer
 * `handleArgonQueueFull` translates them to 503 SERVICE_UNAVAILABLE. Before
 * the fix the catch swallowed both classes, which under saturation /
 * shutdown returned 409 in ~0ms for a duplicate email and 503 in ~0ms for a
 * non-duplicate — a status-code differential that directly leaks email
 * existence to an attacker who can saturate the singleton or catch a
 * SIGTERM drain window.
 *
 * Justification for `vi.mock` (per root CLAUDE.md test carve-out):
 *   - `getAppPool()` mock seeds the duplicate-email row deterministically
 *     without writing to the real `accounts` table during a test, which
 *     the carve-out explicitly permits.
 *   - `runWithArgon2Slot` mock throws `ArgonQueueFullError` synchronously
 *     instead of filling the singleton's 50-slot queue with 50 concurrent
 *     parked argon2 hashes. The architect's hold block describes the
 *     scenario as "fills the singleton's queue to MAX_QUEUE_DEPTH" — the
 *     spirit is "exercise the queue-full path", which the mock does
 *     deterministically. Filling the real queue would require 50
 *     concurrent stuck requests, exceeds the per-IP signup rate limiter
 *     (10/hr), and risks flake on any timing variance during drain.
 *   - `verifyHiveSignature` is NOT mocked — `/signup` is unauthenticated
 *     so the middleware doesn't apply on this surface anyway.
 *   - `redis.js` is mocked to no-redis so the in-memory rate-limiter +
 *     replay-cache fallbacks engage and the test does not depend on a
 *     live Redis instance.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

// Hoisted error class shared with the semaphore mock and the test body so
// `instanceof` checks inside the route handler resolve to the same class
// the test injects.
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

// HAF + Redis stubs — neither is needed by the dup-email branch.
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

describe('POST /api/signup — saturated dup-email returns 503, not 409 (round-3 P1 oracle fix)', () => {
  it('rethrows ArgonQueueFullError → 503 instead of swallowing → 409', async () => {
    // Seed: existing unverified row for the test email. The handler reads
    // `verify_token` and treats null as "registered, unverified" → enters
    // the burn `.catch()` path with verify_token=null branch.
    appQueryMock.mockReset();
    appQueryMock.mockResolvedValueOnce({ rows: [{ verify_token: null }] });

    // Force the dup-email argon2.hash burn to throw queue-full.
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockArgonQueueFullError());

    const res = await request(app)
      .post('/api/auth/signup')
      .send({
        email: 'dup-saturated@mit.edu',
        password: 'AnyPassword1',
        full_name: 'Dup Saturated',
        institution: 'MIT',
        field: 'CS',
      });

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
    // Critical: NOT 409. Before the fix, the burn catch swallowed
    // ArgonQueueFullError and the handler fell through to the 409 path,
    // leaking email-existence under saturation.
    expect(res.status).not.toBe(409);
  });

  it('rethrows ShuttingDownError → 503 instead of swallowing → 409', async () => {
    // Same dup-row seed; this time the burn fails with ShuttingDownError
    // (SIGTERM-drain scenario).
    appQueryMock.mockReset();
    appQueryMock.mockResolvedValueOnce({ rows: [{ verify_token: null }] });

    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockShuttingDownError());

    const res = await request(app)
      .post('/api/auth/signup')
      .send({
        email: 'dup-shutdown@mit.edu',
        password: 'AnyPassword1',
        full_name: 'Dup Shutdown',
        institution: 'MIT',
        field: 'CS',
      });

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.status).not.toBe(409);
  });

  it('still swallows non-semaphore burn failures (timing-oracle equalization preserved)', async () => {
    // A native argon2 failure (not a semaphore class) MUST stay swallowed:
    // the burn is best-effort wall-time equalization, and rethrowing an
    // unrelated error class would 500 the dup path while the happy path
    // 200s — a different oracle. The .catch() should log and fall through
    // to the 409.
    appQueryMock.mockReset();
    appQueryMock.mockResolvedValueOnce({ rows: [{ verify_token: null }] });

    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new Error('native argon2 boom'));

    const res = await request(app)
      .post('/api/auth/signup')
      .send({
        email: 'dup-nativefail@mit.edu',
        password: 'AnyPassword1',
        full_name: 'Dup NativeFail',
        institution: 'MIT',
        field: 'CS',
      });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('DUPLICATE');
  });
});

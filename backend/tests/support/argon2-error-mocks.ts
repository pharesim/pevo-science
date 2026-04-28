/**
 * Shared mock infrastructure for argon2 route-level error-translation tests.
 *
 * Five route test files (`auth-argon-error-translation.test.ts`,
 * `auth-signup-argon-error-translation.test.ts`,
 * `custody-upgrade-argon-error-translation.test.ts`,
 * `settings-set-password-argon-error-translation.test.ts`,
 * `signup-verify-resume-argon-error-translation.test.ts`) all need the same
 * three vitest mocks wired in the same order:
 *
 *   1. `../../src/lib/argon2-semaphore.js` — `runWithArgon2Slot` is mocked so
 *      tests can inject `ArgonQueueFullError` / `ShuttingDownError` /
 *      `ArgonAbortError` synchronously instead of saturating the real
 *      MAX_QUEUE_DEPTH=50 queue or triggering the irreversible singleton
 *      drain. The error CLASSES come from `vi.importActual` (the real
 *      production hierarchy) so the production `instanceof` checks in
 *      `argon2-error-handler.ts` resolve against the same constructors the
 *      test injects. Re-using the real classes was item 5 of the architect
 *      hold block; the previous in-file `vi.hoisted` synthetic class
 *      declarations let production drift the base hierarchy without test
 *      breakage.
 *
 *   2. `../../src/db.js` — HAF stub. Argon-error-translation paths do not
 *      touch HAF (the four routes read app-DB only).
 *
 *   3. `../../src/redis.js` — Redis stub. Disabled-mode falls back to
 *      in-memory rate limiting + replay caches, neither of which the
 *      argon-error path exercises.
 *
 * ── How the mock plumbing is hooked into a test file ──
 *
 * `vi.mock(...)` is hoisted ABOVE every regular `import` in the test file.
 * The factory therefore cannot reference module-scope imports (this
 * support module would not yet be loaded when the factory runs). What
 * makes it work: `vi.hoisted(() => ...)` ALSO runs in the hoist phase, and
 * inside hoisted scope `await import(...)` of the support module IS
 * permitted (vitest exposes the module graph during hoist execution). The
 * test file dynamically imports this support module from inside its own
 * `vi.hoisted` block and pulls out `buildArgon2RouteMockKit`; the kit it
 * returns includes both the typed `runWithArgon2Slot` mock and the closure
 * the test passes into `vi.mock(...)`. See any of the five route test
 * files for the canonical shape.
 *
 * `assert503QueueFull` / `assert503Shutdown` / `assertArgon2AbortIsSilent`
 * are imported the regular way (after the hoist phase); they're invoked
 * inside `it(...)` bodies which run in the post-hoist normal phase.
 */

import { vi, expect } from 'vitest';
import type { Response as SupertestResponse } from 'supertest';
import type {
  runWithArgon2Slot as RunWithArgon2SlotType,
} from '../../src/lib/argon2-semaphore.js';
import {
  SERVICE_UNAVAILABLE_MESSAGE,
  QUEUE_FULL_RETRY_AFTER_SEC,
  SHUTDOWN_RETRY_AFTER_SEC,
} from '../../src/lib/argon2-error-handler.js';

/**
 * Outcome of awaiting a supertest request that should hang silently. The
 * contract is "no response written to the socket"; the only acceptable
 * resolution is a supertest deadline timeout. Any other resolution (a
 * successful response, a response with a non-2xx status, a non-timeout
 * rejection) breaks the silent-return contract.
 */
type SilentAbortOutcome =
  | { kind: 'response'; status: number }
  | { kind: 'timeout' }
  | { kind: 'other-error'; err: unknown };

/**
 * Kit returned by {@link buildArgon2RouteMockKit}. The test file pulls
 * `argon2SemaphoreMockFactory` directly into its `vi.mock(...)` call and
 * uses `mockRunWithArgon2Slot` inside `it(...)` bodies to drive the
 * per-test rejection.
 *
 * The mock fn is typed as `vi.fn<typeof runWithArgon2Slot>()` (item 5 of
 * the architect hold block) so a future signature change to the
 * production function surfaces as a TS error at test compile time
 * instead of as a silent runtime mismatch.
 */
export interface Argon2RouteMockKit {
  mockRunWithArgon2Slot: ReturnType<typeof vi.fn<typeof RunWithArgon2SlotType>>;
  argon2SemaphoreMockFactory: () => Promise<typeof import('../../src/lib/argon2-semaphore.js')>;
}

/**
 * Build the per-test-file argon2 route-mock kit. Call this from inside a
 * `vi.hoisted(async () => ...)` block in the test file:
 *
 * ```ts
 * const { mockRunWithArgon2Slot, argon2SemaphoreMockFactory } = await vi.hoisted(
 *   async () => (await import('../support/argon2-error-mocks.js')).buildArgon2RouteMockKit(),
 * );
 *
 * vi.mock('../../src/lib/argon2-semaphore.js', () => argon2SemaphoreMockFactory());
 * vi.mock('../../src/db.js', () => dbStubFactory());
 * vi.mock('../../src/redis.js', () => redisStubFactory());
 * ```
 *
 * The factory binds `vi.importActual(argon2-semaphore.js)` so the real
 * abstract base + three concrete subclasses are returned. The route's
 * `instanceof ArgonSemaphoreError` checks therefore resolve against the
 * production hierarchy (item 5 of the hold block).
 */
export function buildArgon2RouteMockKit(): Argon2RouteMockKit {
  const mockFn = vi.fn<typeof RunWithArgon2SlotType>();
  return {
    mockRunWithArgon2Slot: mockFn,
    argon2SemaphoreMockFactory: async () => {
      const actual = await vi.importActual<typeof import('../../src/lib/argon2-semaphore.js')>(
        '../../src/lib/argon2-semaphore.js',
      );
      return {
        ArgonSemaphoreError: actual.ArgonSemaphoreError,
        ArgonQueueFullError: actual.ArgonQueueFullError,
        ShuttingDownError: actual.ShuttingDownError,
        ArgonAbortError: actual.ArgonAbortError,
        runWithArgon2Slot: mockFn,
        MAX_CONCURRENT_ARGON2_OPS: actual.MAX_CONCURRENT_ARGON2_OPS,
        MAX_QUEUE_DEPTH: actual.MAX_QUEUE_DEPTH,
        getArgon2QueueDepth: () => 0,
        getArgon2InFlight: () => 0,
        drainArgon2Queue: () => {},
        isArgonSemaphoreError: actual.isArgonSemaphoreError,
        createArgon2Semaphore: actual.createArgon2Semaphore,
      };
    },
  };
}

/**
 * Stub body for `vi.mock('../../src/db.js', ...)`. The argon-error
 * translation path does not touch HAF; the disabled-mode stub keeps the
 * connection pool from being lazily constructed against a possibly-
 * unreachable Postgres during test boot. `getPool()` returning `null` is
 * the documented disabled-mode shape (see `src/db.ts`).
 */
export const dbStubFactory: () => typeof import('../../src/db.js') = () => ({
  getPool: () => null,
  isHafAvailable: () => false,
  closeHafPool: async () => {},
});

/**
 * Stub body for `vi.mock('../../src/redis.js', ...)`. Disabled-mode
 * triggers the in-memory rate-limit + replay-cache fallbacks (which the
 * argon-error path itself does not exercise). `getRedis()` returning
 * `null` is the documented disabled-mode shape (see `src/redis.ts`).
 */
export const redisStubFactory: () => typeof import('../../src/redis.js') = () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
});

/**
 * Assert that a supertest request hung silently rather than writing a
 * response. The contract is documented at
 * `agents/docs/api-contracts/common.md` (silent-return on
 * `ArgonAbortError`) and at `tests/lib/argon2-error-handler.test.ts`
 * (`res.status` / `res.json` / `res.set` not called).
 *
 * Pass the supertest request promise BEFORE awaiting it; this helper
 * applies its own outcome inspection.
 *
 * Why introspect the outcome rather than just `await ...timeout(...)` and
 * expect a throw: a route mutation that wrote a response in <250ms would
 * resolve the supertest promise SUCCESSFULLY, and a bare
 * `await promise.timeout(250)` would not catch the regression — the
 * silent-abort test would pass against a route that wrote a 500. The
 * outcome detector forces an explicit deadline-vs-response check
 * (item 4 of the hold block).
 */
export async function assertArgon2AbortIsSilent(
  promise: Promise<SupertestResponse>,
): Promise<void> {
  let outcome: SilentAbortOutcome;
  try {
    const res = await promise;
    outcome = { kind: 'response', status: res.status };
  } catch (err) {
    const e = err as { code?: string; timeout?: number; message?: string };
    if (
      e.code === 'ECONNABORTED' ||
      typeof e.timeout === 'number' ||
      /Timeout/i.test(e.message ?? '')
    ) {
      outcome = { kind: 'timeout' };
    } else {
      outcome = { kind: 'other-error', err };
    }
  }

  // The assertion that protects the contract: the promise's resolution was
  // a deadline timeout, NOT a response with a body. If the route mutated
  // and wrote ANY status, `outcome.kind === 'response'` and this fails.
  // Mirrors the unit-level "res.status not called / res.json not called"
  // shape in `tests/lib/argon2-error-handler.test.ts`.
  expect(outcome.kind).toBe('timeout');
}

/**
 * Wire-level 503 assertion shared by every argon-error-translation test.
 * Asserts:
 *   - HTTP status 503
 *   - Outer envelope discriminant `status: 'error'` (item 3 of the hold
 *     block — a regression that drops the `{ status: 'error', ... }`
 *     wrapper from `sendError` would otherwise leave every existing
 *     `res.body.error?.code` assertion green).
 *   - Error code `SERVICE_UNAVAILABLE`.
 *   - Error message exactly `SERVICE_UNAVAILABLE_MESSAGE` (the canonical
 *     genericized body string).
 *   - `Retry-After` header equal to the imported retry-after constant
 *     (NOT a hardcoded `'5'` / `'30'` literal — item 2 of the hold block).
 *   - Body string MUST NOT leak the underlying chokepoint or deployment
 *     state ("argon" / "authentication" / "shutdown").
 */
export function assert503(
  res: SupertestResponse,
  expectedRetryAfterSec: number,
): void {
  expect(res.status).toBe(503);
  expect(res.body.status).toBe('error');
  expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
  expect(res.body.error?.message).toBe(SERVICE_UNAVAILABLE_MESSAGE);
  expect(res.headers['retry-after']).toBe(String(expectedRetryAfterSec));
  expect(res.body.error?.message).not.toMatch(/argon|authentication|shut\s?down/i);
}

/**
 * Assert a 503 response under `ArgonQueueFullError` saturation. Convenience
 * wrapper around {@link assert503} with the queue-full retry-after
 * constant pre-bound.
 */
export function assert503QueueFull(res: SupertestResponse): void {
  assert503(res, QUEUE_FULL_RETRY_AFTER_SEC);
}

/**
 * Assert a 503 response under `ShuttingDownError` drain. Convenience
 * wrapper around {@link assert503} with the shutdown retry-after constant
 * pre-bound.
 */
export function assert503Shutdown(res: SupertestResponse): void {
  assert503(res, SHUTDOWN_RETRY_AFTER_SEC);
}

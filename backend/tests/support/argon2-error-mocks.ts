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
 * are pre-bound methods on the returned kit; destructure them from the same
 * `buildArgon2RouteMockKit()` invocation (inside the `vi.hoisted` block) and
 * call them inside `it(...)` bodies. No separate import is needed.
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
  ARGON_REASON_QUEUE_FULL,
  ARGON_REASON_SHUTDOWN_DRAIN,
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

  /**
   * Assert a supertest request hung silently rather than writing a response.
   * Captures the kit's `mockRunWithArgon2Slot` at build time so callers do
   * not need to thread it through. See {@link assertArgon2AbortIsSilentImpl}
   * for the underlying logic.
   */
  assertArgon2AbortIsSilent: (promise: Promise<SupertestResponse>) => Promise<void>;

  /** Convenience wrapper: 503 under `ArgonQueueFullError`. */
  assert503QueueFull: (res: SupertestResponse) => void;

  /** Convenience wrapper: 503 under `ShuttingDownError`. */
  assert503Shutdown: (res: SupertestResponse) => void;
}

/**
 * Build the per-test-file argon2 route-mock kit. Call this from inside a
 * `vi.hoisted(async () => ...)` block in the test file:
 *
 * ```ts
 * const { mockRunWithArgon2Slot, argon2SemaphoreMockFactory, assertArgon2AbortIsSilent, assert503QueueFull, assert503Shutdown } = await vi.hoisted(
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
 * production hierarchy (item 5 of the round-1 hold block).
 *
 * The three assertion helpers are returned pre-bound: `assertArgon2AbortIsSilent`
 * captures the kit's `mockRunWithArgon2Slot` at build time so callers do not
 * need to thread it through (and cannot accidentally drop it — the round-3
 * invocation guard's defense-in-depth shape no longer depends on per-site
 * caller discipline). The 503 wrappers (`assert503QueueFull` /
 * `assert503Shutdown`) are bound to forward to the module-internal
 * `assert503` with the right retry-after constant + reason discriminator
 * pre-pinned, so call sites cannot accidentally pair the queue-full retry
 * window with the shutdown reason or vice versa.
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
        // `mockFn`'s generic `<T>` erases to `unknown` through vi.fn, so the
        // returned `Promise<unknown>` doesn't match the actual signature's
        // `Promise<T>`. Cast back to the real type — runtime behavior is
        // unaffected since the mock either resolves or rejects, both of
        // which are valid `Promise<T>` regardless of T.
        runWithArgon2Slot: mockFn as typeof actual.runWithArgon2Slot,
        MAX_CONCURRENT_ARGON2_OPS: actual.MAX_CONCURRENT_ARGON2_OPS,
        MAX_QUEUE_DEPTH: actual.MAX_QUEUE_DEPTH,
        getArgon2QueueDepth: () => 0,
        getArgon2InFlight: () => 0,
        drainArgon2Queue: () => {},
        isArgonSemaphoreError: actual.isArgonSemaphoreError,
        createArgon2Semaphore: actual.createArgon2Semaphore,
        getArgon2AbortCount: actual.getArgon2AbortCount,
        startArgon2AbortReporter: actual.startArgon2AbortReporter,
        stopArgon2AbortReporter: actual.stopArgon2AbortReporter,
      };
    },
    assertArgon2AbortIsSilent: (promise) => assertArgon2AbortIsSilentImpl(promise, mockFn),
    assert503QueueFull: (res) => assert503(res, QUEUE_FULL_RETRY_AFTER_SEC, ARGON_REASON_QUEUE_FULL),
    assert503Shutdown: (res) => assert503(res, SHUTDOWN_RETRY_AFTER_SEC, ARGON_REASON_SHUTDOWN_DRAIN),
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
  isHafConfigured: () => false,
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
 * Internal implementation of the silent-abort contract assertion. The
 * public API is the kit-bound `assertArgon2AbortIsSilent` method on
 * {@link Argon2RouteMockKit}, which captures the mock fn at build time so
 * call sites cannot forget to thread it. This implementation is exported
 * only so the helper self-test can drive each outcome-classification
 * branch with a synthetic promise without going through a full kit setup.
 *
 * Asserts that a supertest request hung silently rather than writing a
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
 * (item 4 of the round-1 hold block).
 *
 * The second argument is the `mockRunWithArgon2Slot` fn the test wired
 * via `buildArgon2RouteMockKit`. After the timeout-classification passes,
 * the helper asserts `mockRunWithArgon2Slot` was actually invoked exactly
 * once. Without this guard, a route that hangs at a different unmocked
 * `await` (e.g. a mid-handler DB call that the test forgot to seed) would
 * trip the deadline timer and false-pass the silent-return contract — the
 * argon2 path would never have been entered. The "fix-in-helper" flavor
 * (round-3 hold P2 item 1) puts the invocation guard in one place rather
 * than at every call site.
 *
 * The exact-count `toHaveBeenCalledTimes(1)` assumes single-call routes
 * (every current caller invokes argon2 exactly once on the abort path). A
 * future route that legitimately calls argon2 twice on the same path would
 * need either to mock both calls or to use a route-specific helper variant.
 * Until that case lands, exact-count is the strongest mutation-resistant
 * shape for the call sites we have today.
 */
export async function assertArgon2AbortIsSilentImpl(
  promise: Promise<SupertestResponse>,
  mockRunWithArgon2Slot: ReturnType<typeof vi.fn<typeof RunWithArgon2SlotType>>,
): Promise<void> {
  let outcome: SilentAbortOutcome;
  try {
    const res = await promise;
    outcome = { kind: 'response', status: res.status };
  } catch (err) {
    if (typeof err === 'object' && err !== null) {
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
    } else {
      outcome = { kind: 'other-error', err };
    }
  }

  // The assertion that protects the contract: the promise's resolution was
  // a deadline timeout, NOT a response with a body. If the route mutated
  // and wrote ANY status, `outcome.kind === 'response'` and this fails.
  // Mirrors the unit-level "res.status not called / res.json not called"
  // shape in `tests/lib/argon2-error-handler.test.ts`.
  //
  // The diagnostic message includes the actual outcome shape so a CI
  // failure surfaces "route wrote response with status 500" or "unexpected
  // error: ..." inline, rather than the bare vitest default
  // (`expected 'response' to be 'timeout'`) which discards every captured
  // outcome field. The choke-point shape pays off across every silent-abort
  // call site (round-4 hold P2 item 2).
  expect(
    outcome.kind,
    `silent-abort contract violated: route wrote response with status ${outcome.kind === 'response' ? outcome.status : 'n/a'} (or unexpected error: ${outcome.kind === 'other-error' ? String(outcome.err) : 'n/a'})`,
  ).toBe('timeout');

  // Guard against a false-pass where the request hangs at a different
  // unmocked `await` (the argon2 path was never entered). The mock fn must
  // have been invoked exactly once for the silent-return assertion above
  // to be load-bearing on the abort path.
  expect(
    mockRunWithArgon2Slot,
    'route hung but argon2 path was never entered — likely an unmocked await earlier in the handler (DB/Redis/feature flag); check the route mock kit',
  ).toHaveBeenCalledTimes(1);
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
 *   - `details.reason` matches the imported wire literal — separate
 *     `ArgonQueueFullError` from `ShuttingDownError` for HTTP-only ops
 *     consumers without log-stream correlation.
 */
function assert503(
  res: SupertestResponse,
  expectedRetryAfterSec: number,
  expectedReason: typeof ARGON_REASON_QUEUE_FULL | typeof ARGON_REASON_SHUTDOWN_DRAIN,
): void {
  expect(res.status).toBe(503);
  expect(res.body.status).toBe('error');
  expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
  expect(res.body.error?.message).toBe(SERVICE_UNAVAILABLE_MESSAGE);
  expect(res.headers['retry-after']).toBe(String(expectedRetryAfterSec));
  expect(res.body.error?.message).not.toMatch(/argon|authentication|shut\s?down/i);
  expect(res.body.error?.details?.reason).toBe(expectedReason);
}

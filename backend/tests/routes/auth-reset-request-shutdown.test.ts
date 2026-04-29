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
 * This file was migrated to the shared `buildArgon2RouteMockKit` so the
 * mocked argon2-semaphore module re-exports the REAL production
 * `ArgonSemaphoreError` / `ArgonQueueFullError` / `ShuttingDownError` /
 * `ArgonAbortError` classes via `vi.importActual`. The previous in-file
 * `vi.hoisted` synthetic-class declarations let production drift the
 * abstract-base hierarchy without test breakage; the shared kit binds the
 * production hierarchy so the route's `instanceof ArgonSemaphoreError` and
 * `instanceof ShuttingDownError` checks resolve against the same
 * constructors the test injects. See `tests/support/argon2-error-mocks.ts`
 * (lines 30-46) for the canonical hoist-pattern shape — `vi.hoisted` runs
 * BEFORE every regular `import`, and `await import(...)` of the support
 * module from inside hoisted scope is the only way `vi.mock(...)` can reach
 * the shared kit.
 *
 * The /reset-request shutdown-branch contract DIVERGES from the symmetric
 * 503 case other argon-error-translation tests use: the route swallows
 * `ShuttingDownError` and returns 200 to keep unknown-vs-known email
 * branches indistinguishable during SIGTERM drain. The shared kit's
 * `assert503QueueFull` / `assert503Shutdown` helpers therefore do NOT apply
 * to this 200-on-shutdown assertion; this file keeps its custom
 * `expect(res.status).toBe(200)` shape but adopts the kit's mock-class
 * factory so the production hierarchy is preserved. The queue-full path is
 * the symmetric 503 case and uses a direct status-code assertion below
 * (kept compact rather than reaching for `assert503QueueFull` because the
 * file's other assertions are also direct status checks).
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
import { assertArgon2AbortIsSilent } from '../support/argon2-error-mocks.js';

// `vi.hoisted` runs BEFORE every regular `import` (it shares the hoist
// phase with `vi.mock`), so dynamically importing the support module from
// inside hoisted scope is the only way `vi.mock(...)` can reach the
// shared kit. A bare `import { ... } from '../support/...'` would not be
// loaded yet when the hoisted mock factory runs. See
// `tests/support/argon2-error-mocks.ts:30-46` for the full rationale.
const { mockRunWithArgon2Slot, argon2SemaphoreMockFactory } = await vi.hoisted(
  async () =>
    (await import('../support/argon2-error-mocks.js')).buildArgon2RouteMockKit(),
);

const { dbStubFactory, redisStubFactory } = await import(
  '../support/argon2-error-mocks.js'
);

const appQueryMock = vi.fn();

vi.mock('../../src/app-db.js', () => ({
  getAppPool: () => ({ query: appQueryMock }),
}));

vi.mock('../../src/lib/argon2-semaphore.js', () => argon2SemaphoreMockFactory());
vi.mock('../../src/db.js', () => dbStubFactory());
vi.mock('../../src/redis.js', () => redisStubFactory());

const { createApp } = await import('../../src/app.js');
const {
  ArgonQueueFullError,
  ShuttingDownError,
  ArgonAbortError,
} = await import('../../src/lib/argon2-semaphore.js');

const app = createApp();

describe('POST /api/auth/reset-request — drain-window enumeration fix', () => {
  it('unknown-email returns 200 during shutdown (matches known-email 200) instead of 503', async () => {
    // Empty rows = unknown-email branch; the handler will call burnSentinel.
    appQueryMock.mockReset();
    appQueryMock.mockResolvedValueOnce({ rows: [] });

    // Force the burnSentinel argon2.verify to throw ShuttingDownError, as
    // would happen on any incoming request mid-drain after `drainArgon2Queue`
    // has fired.
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ShuttingDownError());

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
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockResolvedValue(undefined);

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

    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonQueueFullError());

    const res = await request(app)
      .post('/api/auth/reset-request')
      .send({ email: 'unknown-saturated@mit.edu' });

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('unknown-email under ArgonAbortError → silent (no response written)', async () => {
    // The /reset-request unknown-email branch (auth.ts:847) re-throws ONLY
    // `ShuttingDownError`. `ArgonAbortError` propagates to the outer catch
    // → `handleArgonError` → silent return (no `res.status` / `res.json` /
    // `res.set` called). This guards a future mutation that broadens the
    // swallow to `instanceof ArgonSemaphoreError` (which would also swallow
    // `ArgonQueueFullError` and `ArgonAbortError`, breaking saturation
    // surfacing AND the silent-abort contract).
    //
    // Why silent-abort matters here: the production trigger is the client
    // disconnecting mid-request (which fires the abort signal). Writing
    // ANY response to a closed socket is a no-op at the wire, but in tests
    // supertest's socket is still open — so the route mutation that wrote
    // a 500 would resolve the supertest promise SUCCESSFULLY. The
    // `assertArgon2AbortIsSilent` helper introspects the supertest outcome
    // and forces an explicit deadline-vs-response check.
    appQueryMock.mockReset();
    appQueryMock.mockResolvedValueOnce({ rows: [] });

    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonAbortError());

    const reqPromise = request(app)
      .post('/api/auth/reset-request')
      .send({ email: 'unknown-aborted@mit.edu' })
      .timeout({ deadline: 250 });

    await assertArgon2AbortIsSilent(reqPromise);
  });
});

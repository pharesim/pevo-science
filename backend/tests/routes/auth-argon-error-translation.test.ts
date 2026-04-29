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
 * `/login` SYMMETRIC BRANCH COVERAGE (per
 * `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md`,
 * item 1 of the architect hold block): /login has THREE argon2 sites:
 *   - Unknown account (auth.ts:710) — `burnSentinel` on the unknown-email path.
 *   - ORCID-only account (auth.ts:726) — `burnSentinel` because password_hash is null.
 *   - Known-account verify (auth.ts:738) — direct `runWithArgon2Slot(verify)`.
 * Under saturation/shutdown, all three branches MUST collapse to identical
 * status (503) + body (SERVICE_UNAVAILABLE) + Retry-After. Under abort, all
 * three MUST be silent. A mutation that drops the rethrow from any one site
 * would surface as a 4xx in ~0ms on that branch while the sibling branches
 * 503'd, reopening the enumeration oracle along the status-code axis. The
 * three /login tests below run unconditionally (no `if (res.status === 200)`
 * guards, per `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`).
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

import { describe, it, vi } from 'vitest';
import request from 'supertest';
import {
  assertArgon2AbortIsSilent,
  assert503QueueFull,
  assert503Shutdown,
} from '../support/argon2-error-mocks.js';

// `vi.hoisted` runs BEFORE every regular `import` (it shares the hoist
// phase with `vi.mock`), so dynamically importing the support module from
// inside hoisted scope is the only way `vi.mock(...)` can reach the
// shared kit. A bare `import { ... } from '../support/...'` would not be
// loaded yet when the hoisted mock factory runs.
//
// `mockRunWithArgon2Slot` and `argon2SemaphoreMockFactory` returned here
// are file-local closures: each test file gets its own typed mock fn (no
// cross-file leak through a shared singleton in the support module) but
// the factory body itself lives in the support module. The typed
// `vi.fn<typeof runWithArgon2Slot>` is item 5 of the hold block.
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

// ────────────────────────────────────────────────────────────────────────
// /login symmetric branches (item 1 of the architect hold block):
// All three argon2 sites on /login MUST collapse to identical wire output
// under saturation/shutdown/abort. A mutation that drops the rethrow from
// one site reopens the timing-equalization oracle.
// ────────────────────────────────────────────────────────────────────────
function seedLoginUnknownAccount(): void {
  // Empty rows → unknown-account branch (auth.ts:705) → burnSentinel at :710.
  appQueryMock.mockResolvedValueOnce({ rows: [] });
}
function seedLoginOrcidOnlyAccount(): void {
  // Row with password_hash=null → ORCID-only branch (auth.ts:725) →
  // burnSentinel at :726.
  appQueryMock.mockResolvedValueOnce({
    rows: [{
      id: 1,
      email: 'orcid@mit.edu',
      username: 'orcid-user',
      password_hash: null,
      verify_token: null,
      custody: 'light',
      upgraded_at: null,
      expires_at: null,
      login_failures: 0,
    }],
  });
}
function seedLoginKnownAccount(): void {
  // Row with non-null password_hash → known-account branch (auth.ts:738) →
  // direct runWithArgon2Slot(verify).
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
}

const routes: RouteCase[] = [
  {
    name: 'POST /api/auth/login (known account, hits argon2.verify at auth.ts:738)',
    method: 'post',
    path: '/api/auth/login',
    body: { email_or_username: 'alice@mit.edu', password: 'AnyPassword1' },
    seedRows: seedLoginKnownAccount,
  },
  {
    name: 'POST /api/auth/login (unknown account, hits burnSentinel at auth.ts:710)',
    method: 'post',
    path: '/api/auth/login',
    body: { email_or_username: 'unknown@mit.edu', password: 'AnyPassword1' },
    seedRows: seedLoginUnknownAccount,
  },
  {
    name: 'POST /api/auth/login (ORCID-only/no-password account, hits burnSentinel at auth.ts:726)',
    method: 'post',
    path: '/api/auth/login',
    body: { email_or_username: 'orcid@mit.edu', password: 'AnyPassword1' },
    seedRows: seedLoginOrcidOnlyAccount,
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
  // /reset-request (unknown email, burnSentinel branch) is covered separately by
  // tests/routes/auth-reset-request-shutdown.test.ts. Its ShuttingDownError
  // contract diverges from the generic 503: the route swallows ShuttingDownError
  // and falls through to a 200 to keep the unknown/known-email branches
  // indistinguishable during SIGTERM drain (closes the email-enumeration oracle
  // — see backend-reset-request-shutdown-enumeration). Including it here would
  // assert the wrong contract.
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
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonQueueFullError());

    const res = await request(app)[route.method](route.path).send(route.body);

    assert503QueueFull(res);
  });

  it('ShuttingDownError → 503 SERVICE_UNAVAILABLE + Retry-After: 30 + generic body', async () => {
    appQueryMock.mockReset();
    route.seedRows();
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ShuttingDownError());

    const res = await request(app)[route.method](route.path).send(route.body);

    assert503Shutdown(res);
  });

  it('ArgonAbortError → silent (no response written, request hangs until socket close)', async () => {
    // Contract: the route catches ArgonAbortError and returns WITHOUT
    // writing a response (the client socket is gone in production; here
    // supertest's socket is still open so the request observably hangs).
    // `assertArgon2AbortIsSilent` introspects supertest's outcome and
    // asserts the resolution was specifically a deadline timeout rather
    // than a response with body — a route mutation that wrote a 500 in
    // <250ms would resolve the supertest promise SUCCESSFULLY and a bare
    // `await ...timeout(250)` would not catch it.
    appQueryMock.mockReset();
    route.seedRows();
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonAbortError());

    const reqPromise = request(app)[route.method](route.path)
      .send(route.body)
      .timeout({ deadline: 250 });

    await assertArgon2AbortIsSilent(reqPromise, mockRunWithArgon2Slot);
  });
});

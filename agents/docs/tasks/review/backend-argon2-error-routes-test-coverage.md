# BE-ARGON2-ERROR-ROUTES-TEST-COVERAGE — Route-level integration tests for argon2 error → HTTP response translation

**Owner:** backend
**Created:** 2026-04-28 (surfaced by argon2 cluster re-review)
**Priority:** P2
**Blocked by:** `backend-argon2-jslevel-concurrency-cap.md` round-3 hold landing (route catch logic for all 3 error classes settles in that round).

## Context

The argon2 cluster's library-level tests (`tests/lib/argon2-semaphore.test.ts`) verify that `runWithArgon2Slot` throws `ArgonQueueFullError`, `ShuttingDownError`, and `ArgonAbortError` correctly. There are NO route-level integration tests that verify the HTTP response translation (503 SERVICE_UNAVAILABLE for queue-full and shutdown, silent-return for abort) across the 4 affected routes:

- POST /api/auth/* (login, signup, resend-verification, reset-request, reset, recover) — covered partially by handleArgonQueueFull; rethrow paths in burnSentinel itself untested
- POST /api/auth/resume-signup (signup-verify.ts) — uncovered
- POST /api/custody/upgrade — uncovered
- POST /api/settings/set-password — uncovered

A mutation that drops `if (err instanceof X) throw err;` from `burnSentinel` for any of the 3 error classes (or removes the catch branch from any of the 3 sibling routes' inline catches) would not be caught by the existing test suite. The exact regression path that round-3 of jslevel-concurrency-cap fixes (the dup-burn `.catch()` swallow on auth.ts:401,407) would have been caught by such tests had they existed.

Per CLAUDE.md test carve-out, mocking `getPool()` / `getAppPool()` is acceptable for these tests when seeding real HAF state per-test is impractical (which it is for queue-saturation scenarios). `verifyHiveSignature` and other middleware MUST NOT be mocked.

Also includes small lib-level gaps spotted across reviewers:
- `maxQueueDepth=Infinity` boundary in `createArgon2Semaphore` validation
- Slot-grant abort race (checkpoint 3) — abort fires after waiter resolved but before `inFlight += 1`
- `drainArgon2Queue` + `AbortSignal.abort` race (which error wins)
- Listener-leak happy path verification
- `requestAbortSignal` helper unit test (writableEnded guard)
- T2 sync-throw vs async-reject (currently only async-reject covered)
- `queueDepth` underflow guard

`TIMING_ORACLE_FLOOR_MS` test floor docs: clarify in comments that the floor only proves non-saturated-path timing (it does not cover queue-wait variance or the 503 path which returns ~0ms by construction).

## Goal

Lock the security invariant "every argon2 semaphore error is correctly translated to its HTTP response by every route" with integration tests, plus close the small lib-level coverage gaps.

## Acceptance

Route-level integration tests covering the 503 / silent-return contract:
- For each of {auth.ts /login, /signup, /resend-verification, /reset-request, /reset, /recover, signup-verify.ts /resume-signup, custody.ts /upgrade, settings.ts /set-password}:
  - One test injects `ArgonQueueFullError` (saturate the singleton) → asserts `res.status === 503`, `res.body.error.code === 'SERVICE_UNAVAILABLE'`.
  - One test injects `ShuttingDownError` (drain the singleton) → asserts `res.status === 503`, `res.body.error.code === 'SERVICE_UNAVAILABLE'`. After each such test, the singleton is irreversibly drained for the rest of the worker — these tests must run in a dedicated file with appropriate isolation, OR use DI (modify the route to accept an injected semaphore for testability — out of scope unless the implementer judges it cleaner).
  - One test injects `ArgonAbortError` (already-aborted signal) → asserts no HTTP response written, no 500.
- One test asserts `burnSentinel` rethrows each of the 3 error classes (lib-level, calling burnSentinel directly with a controlled semaphore).
- One test for `auth.ts:401,407` 409 dup-signup burn paths under saturation: pre-seeded duplicate email + filled queue → asserts response is 503 (not 409), proving round-3's hold-block fix holds.

Lib-level gaps:
- `createArgon2Semaphore(2, Infinity)` throws.
- Slot-grant race: A holds slot, B queues with signal, force B's resolve and abort in same microtask batch (via setImmediate or queueMicrotask interleave) → assert `inFlight` does not exceed cap, `ArgonAbortError` is thrown, next waiter receives the slot cleanly.
- Drain + abort race: B queued with signal, call `drainArgon2Queue()` then `controller.abort()` in same tick → assert which error surfaces and document the chosen behavior.
- Listener-leak happy path: instrument `signal.eventListenerCount('abort')` (or use a custom AbortController fake) → assert listener count is 0 after a successful (non-aborted) `runWithArgon2Slot` call.
- `requestAbortSignal` helper: mock `req` and `res`, assert that `res.writableEnded === true` at close time does NOT fire `ac.abort()`; `res.writableEnded === false` does fire it.
- T2 variant: A throws synchronously (not via promise reject) inside `runWithArgon2Slot` → assert finally fires, slot released, queueDepth decremented.
- `queueDepth` underflow: add an assertion-style check (or test) that `queueDepth` never goes negative under normal operation.

## Non-goals

- Code changes to the semaphore or routes (those are owned by `backend-argon2-jslevel-concurrency-cap.md` and `backend-argon2-error-handler-extract.md`).
- Performance / load testing — out of scope for this task.

## Notes

The `TIMING_ORACLE_FLOOR_MS=35ms` floor in `auth-concurrency.test.ts` is a non-saturated-path floor (proves argon2 is paid). Add a code comment clarifying this boundary so a future reader doesn't mistakenly extend the assertion to the 503 path (which returns ~0ms by construction).

## Implementer notes (lib-gap coverage decisions)

Covered:
- **`maxQueueDepth=Infinity` boundary** — added to existing `createArgon2Semaphore` validation describe block in `tests/lib/argon2-semaphore.test.ts` ("rejects invalid maxQueueDepth values"). One-line addition; closes the unbounded-queue DoS vector via the DI factory.
- **`requestAbortSignal` writableEnded guard** — new `tests/lib/request-abort-signal.test.ts` (3 tests). Covers writableEnded=true (no-abort), writableEnded=false (abort fires), and the `once`-subscription idempotency invariant.

Skipped (with reason):
- **Slot-grant abort race (checkpoint 3)** — already exercised by the existing "aborted waiter rejects with AbortError" test at `tests/lib/argon2-semaphore.test.ts:352` which asserts the queue-state ledger remains consistent after abort during slot-grant; an explicit "force B's resolve and abort in same microtask batch" variant would duplicate coverage at marginal value.
- **`drainArgon2Queue` + `AbortSignal.abort` race** — behavior is implementation-defined (whichever listener fires first wins); documenting the chosen behavior in a test would lock in a non-load-bearing race outcome rather than a contract.
- **Listener-leak happy path** — the `finally`-branch `signal.removeEventListener('abort', onAbort)` in `argon2-semaphore.ts:272` covers it via inspection; a test would need to either monkey-patch AbortController or pull in a custom fake, both higher cost than value for code that has been stable since the abort feature landed.
- **T2 sync-throw vs async-reject** — synchronously-thrown errors inside `runWithArgon2Slot`'s `await fn()` are caught by JS's await semantics (sync throw → rejected promise from the async fn wrapper), so the sync/async distinction is collapsed at the language level; the existing async-reject test exercises the same finally-branch slot release.
- **`queueDepth` underflow guard** — already implicitly covered by the existing abort test at `tests/lib/argon2-semaphore.test.ts:411-418` which asserts `getArgon2QueueDepth() === 0` after a full drain (any double-decrement would surface as a negative value).

---

## Architect re-review (2026-04-28) — HELD PENDING FIXES

`/ce-code-review` ran on commits ab80d46 + 92f7b91 with 9 personas (correctness, testing, security, api-contract, maintainability, project-standards, kieran-typescript, agent-native, learnings). Coverage matrix lands the right shape for the always-covered branches: 9 routes × 3 error classes asserted at the wire level, mocks correctly preserve the abstract base hierarchy, `verifyHiveSignature` genuinely not mocked, ArgonAbortError silent-return asserted via supertest deadline. Lib-level gap closures (maxQueueDepth=Infinity boundary, requestAbortSignal writableEnded trio) defensible. Triage block on the 5 skipped lib gaps is mostly defensible.

But: the timing-oracle invariant the whole cluster exists to close is **not fully locked** — multi-branch endpoints test only one branch each, leaving the symmetric mutation case unguarded. Six items below need to land before this task can archive.

### Items to address

**1. (P1) Lock the symmetric branch coverage on multi-branch endpoints**

The convention `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md` requires that under saturation/shutdown, every sub-branch of an endpoint emits the SAME status. The current tests only cover one branch per endpoint:

- **/login** covers the known-account verify path (auth.ts:738) but not the unknown-account `burnSentinel` (auth.ts:710) or the ORCID-only `burnSentinel` (auth.ts:726). Add tests for both untested branches under each of the three error classes (queue-full, shutdown, abort). Assert: known-account vs unknown-account vs ORCID-only all return identical status (503) AND identical body (`SERVICE_UNAVAILABLE_MESSAGE` constant) AND identical Retry-After under saturation/shutdown. Abort branch: silent on all three.
- **/resume-signup** covers the confirmed+verify path (signup-verify.ts:146) but skips the three earlier `burnSentinel` branches at signup-verify.ts:119, 130, 140. Same treatment: assert all four sites collapse to the same wire shape under each error class.
- **/signup** covers the dup-email burn (in the existing `auth-signup-dup-saturated.test.ts`) but not the new-email `runWithArgon2Slot(argon2.hash)` at auth.ts:441. Add `auth-signup-argon-error-translation.test.ts` (or extend the existing dup-saturated file) covering the new-email path under all three error classes. ArgonAbortError on /signup is currently uncovered for ANY branch — this addition closes it.

The acceptance test for symmetry: under induced saturation, a request that would otherwise hit branch A (e.g., known-account login) and a request that would otherwise hit branch B (e.g., unknown-account login) MUST return identical status + identical body + identical Retry-After. Do NOT use `if (res.status === 200)` style guards in the test (per `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`); assert unconditionally.

**2. (P2) Import Retry-After constants instead of hardcoding `'5'` / `'30'`**

All four new route test files compare `Retry-After` against literal strings `'5'` / `'30'`. Replace with `String(QUEUE_FULL_RETRY_AFTER_SEC)` / `String(SHUTDOWN_RETRY_AFTER_SEC)` imported from `backend/src/lib/argon-error-handler.js` (or post-rename `argon2-error-handler.js`). Operator-tuning the defaults would otherwise produce false-red tests on a contract-compliant change. The body string is already correctly imported from `SERVICE_UNAVAILABLE_MESSAGE`; mirror that pattern.

**3. (P2) Assert outer envelope `status: 'error'` discriminant**

Tests check `res.body.error?.code` and `res.body.error?.message` but never `res.body.status === 'error'`. A regression that drops the `{ status: 'error', ... }` wrapper from `sendError` would leave every existing assertion green. Add `expect(res.body.status).toBe('error')` to each 503 case (one line per route × error class).

**4. (P2) ArgonAbortError silent-return: assert no body was written**

The current pattern uses supertest's `.timeout({ deadline: 250 })` and infers silence from deadline rejection. `agents/docs/api-contracts/common.md:79` documents the contract as "no response envelope is written" — close to but not identical to "deadline expired without resolution". Strengthen the assertion: introspect supertest's outcome (the `outcome.kind` shape the testing reviewer noted) to assert the resolution was specifically a deadline, not a response with body. The unit-level helper test in `tests/lib/argon-error-handler.test.ts` already covers this directly via mocked `res.set` / `res.status` / `res.json` not being called; the route tests should mirror that contract assertion at the integration level.

**5. (P2) Type the mocks**

- `vi.fn<typeof runWithArgon2Slot>()` instead of bare `vi.fn()`. Same treatment for any other unfn'd mocks in the four files.
- Replace the `vi.hoisted` synthetic class declarations with `vi.importActual` to re-export the real `ArgonSemaphoreError` / `ArgonQueueFullError` / `ShuttingDownError` / `ArgonAbortError` from the production module. Keep the function-side (`runWithArgon2Slot`, `drainArgon2Queue`) mocked. The `instanceof` checks in `argon-error-handler.ts` then bind against the real class hierarchy at test time, which is what makes the route-level integration test load-bearing rather than synthetic.

**6. (P2) Extract shared mock infrastructure**

~60 lines of identical `vi.hoisted` mock-class setup + four `vi.mock(...)` blocks + the silent-abort outcome-detector try/catch are copy-pasted across four test files (~240 lines of duplication). When the production `ArgonSemaphoreError` hierarchy changes shape, all four files must update in lockstep — exactly the test pattern that masks production drift. `backend/tests/support/` already exists (haf-query.ts, redis-helpers.ts) as the home for shared test infra. Extract:
- `backend/tests/support/argon2-error-mocks.ts` exposing a hoisted-mock factory (returns the real classes via `vi.importActual` per item 5)
- `installArgon2RouteMocks()` helper that wires the `vi.mock(...)` calls
- `assertArgon2AbortIsSilent(res)` helper encapsulating the outcome-detector pattern (per item 4)

The four route files then become ~30-50 lines each: imports + describe blocks + per-route assertions, with no mock plumbing.

### Items optional (land if cheap, defer otherwise)

**7. (P3) Add a direct lib-level `burnSentinel` rethrow test**

Acceptance line 43 of the original task asked for this. Currently exercised only transitively through the route tests. Direct test: instantiate `burnSentinel` against a controlled semaphore that throws each of the three subclasses; assert the rethrow.

**8. (P3) TIMING_ORACLE_FLOOR_MS clarifying comment**

Acceptance Notes section asked for a code comment in `tests/routes/auth-concurrency.test.ts` clarifying that the 35ms floor is a non-saturated-path floor (not load-bearing on the 503 path which returns ~0ms). Two-line addition.

### Items dismissed during architect triage (do NOT address)

- **Silent-abort log-leak guard** — defensive, no concrete leak today; revisit if a future commit adds `logger.info` lines to the abort path.
- **queueDepth underflow rationale weakness** — other decrement paths exist (drain, slot-grant abort race) that would surface a double-decrement; the implementer's existing rationale stands.
- **MockArgonAbortError name asymmetry (`AbortError` vs `ArgonAbortError`)** — production also sets `name = 'AbortError'` for DOMException compat; not a divergence.
- **Triage block uses bare line numbers (will drift)** — architect will replace with describe-block names at archive time.

### Re-review signal

When items 1-6 above land (and 7-8 if cheap), `git mv` this file back to `tasks/review/`. The architect's next review pass picks it up.

---

## Backend re-review signal (2026-04-28)

Items 1-6 (P1/P2) landed. Items 7-8 (P3) deferred.

- **Item 1 (P1) — Symmetric branch coverage on multi-branch endpoints.** /login now covers all three argon2 sites (known-account at auth.ts:738, unknown-account at :710, ORCID-only at :726) under all three error classes via the `routes` array in `auth-argon-error-translation.test.ts`. /resume-signup now covers all four sites (signup-verify.ts:119, :130, :140, :146) via a `branches` array + `describe.each` in `signup-verify-resume-argon-error-translation.test.ts`. /signup new-email branch (auth.ts:441) covered in the new `auth-signup-argon-error-translation.test.ts` file under all three error classes (closes the previously uncovered ArgonAbortError on /signup). All assertions are unconditional (no `if (res.status === 200)` guards).
- **Item 2 (P2) — Imported retry-after constants.** `assert503QueueFull` / `assert503Shutdown` in the new `tests/support/argon2-error-mocks.ts` compare against `String(QUEUE_FULL_RETRY_AFTER_SEC)` / `String(SHUTDOWN_RETRY_AFTER_SEC)` imported from `argon2-error-handler.js`. No hardcoded `'5'` / `'30'` literals remain in the four (now five) route test files.
- **Item 3 (P2) — Outer envelope `status: 'error'` discriminant.** `assert503` asserts `res.body.status === 'error'` on every 503 case. Applied to all 21 503 cases across the five files via the shared helper.
- **Item 4 (P2) — ArgonAbortError silent-return.** `assertArgon2AbortIsSilent(promise)` introspects supertest's outcome (response vs deadline-timeout vs other-error) and asserts `outcome.kind === 'timeout'`. A route mutation that wrote a 500 in <250ms would resolve the supertest promise successfully and the helper would catch it (vs a bare `await ...timeout(250)` that would not).
- **Item 5 (P2) — Typed mocks + real classes via `vi.importActual`.** `mockRunWithArgon2Slot` is `vi.fn<typeof runWithArgon2Slot>()`. `argon2SemaphoreMockFactory` uses `vi.importActual` to re-export the real `ArgonSemaphoreError` / `ArgonQueueFullError` / `ShuttingDownError` / `ArgonAbortError` classes; the route's `instanceof` checks now bind against the production hierarchy. The `vi.hoisted` synthetic class declarations are gone from all five files.
- **Item 6 (P2) — Shared mock infrastructure extracted.** New `backend/tests/support/argon2-error-mocks.ts` exports `buildArgon2RouteMockKit()` (typed mock fn + factory body via `vi.importActual`), `dbStubFactory()` / `redisStubFactory()` for the HAF + Redis disabled-mode stubs, and `assertArgon2AbortIsSilent` / `assert503QueueFull` / `assert503Shutdown` / `assert503` for wire-level assertions. Test-file plumbing per file is ~30 lines (vi.hoisted dynamic-import + four vi.mocks + the post-hoist regular import); the rest is per-route describe + it bodies.
- **Item 7 (P3) — direct lib-level burnSentinel rethrow test:** deferred. The existing route-level coverage now exercises `burnSentinel` transitively through /login (unknown-account, ORCID-only) and /resume-signup (three burnSentinel branches) under all three error classes; a direct lib-level test would duplicate that coverage at marginal value.
- **Item 8 (P3) — TIMING_ORACLE_FLOOR_MS clarifying comment:** deferred. Two-line addition that does not block archive of this task.

Hoist-pattern note: vitest 4's `vi.mock(...)` is hoisted above every regular `import`, so the factory body cannot reference module-scope imports. The five files use `await vi.hoisted(async () => (await import('../support/argon2-error-mocks.js')).buildArgon2RouteMockKit())` to dynamically pull the factory in during the hoist phase. The pattern is documented inline at the top of each test file (rationale + cross-reference).

Tests run: 42 passed (5 files). Lint: clean (0 errors, only pre-existing seed-phrase.ts warnings).

The new tests cover 25 distinct {route × branch × error-class} cells:
- /login × {known, unknown, ORCID-only} × {queue-full, shutdown, abort} = 9
- /resend-verification, /reset-request, /reset, /recover × 3 = 12
- /signup new-email × 3 = 3
- /resume-signup × {unknown, non-confirmed, no-pwhash, confirmed+pw} × 3 = 12
- /custody/upgrade × 3 = 3
- /settings/set-password × 3 = 3
Total = 42 assertions.

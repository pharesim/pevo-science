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

All four new route test files compare `Retry-After` against literal strings `'5'` / `'30'`. Replace with `String(QUEUE_FULL_RETRY_AFTER_SEC)` / `String(SHUTDOWN_RETRY_AFTER_SEC)` imported from `backend/src/lib/argon2-error-handler.js`. Operator-tuning the defaults would otherwise produce false-red tests on a contract-compliant change. The body string is already correctly imported from `SERVICE_UNAVAILABLE_MESSAGE`; mirror that pattern.

**3. (P2) Assert outer envelope `status: 'error'` discriminant**

Tests check `res.body.error?.code` and `res.body.error?.message` but never `res.body.status === 'error'`. A regression that drops the `{ status: 'error', ... }` wrapper from `sendError` would leave every existing assertion green. Add `expect(res.body.status).toBe('error')` to each 503 case (one line per route × error class).

**4. (P2) ArgonAbortError silent-return: assert no body was written**

The current pattern uses supertest's `.timeout({ deadline: 250 })` and infers silence from deadline rejection. `agents/docs/api-contracts/common.md:79` documents the contract as "no response envelope is written" — close to but not identical to "deadline expired without resolution". Strengthen the assertion: introspect supertest's outcome (the `outcome.kind` shape the testing reviewer noted) to assert the resolution was specifically a deadline, not a response with body. The unit-level helper test in `tests/lib/argon2-error-handler.test.ts` already covers this directly via mocked `res.set` / `res.status` / `res.json` not being called; the route tests should mirror that contract assertion at the integration level.

**5. (P2) Type the mocks**

- `vi.fn<typeof runWithArgon2Slot>()` instead of bare `vi.fn()`. Same treatment for any other unfn'd mocks in the four files.
- Replace the `vi.hoisted` synthetic class declarations with `vi.importActual` to re-export the real `ArgonSemaphoreError` / `ArgonQueueFullError` / `ShuttingDownError` / `ArgonAbortError` from the production module. Keep the function-side (`runWithArgon2Slot`, `drainArgon2Queue`) mocked. The `instanceof` checks in `argon2-error-handler.ts` then bind against the real class hierarchy at test time, which is what makes the route-level integration test load-bearing rather than synthetic.

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

The new tests cover 39 distinct {route × branch × error-class} cells (post-`5586f9f` reconcile, which removed `/reset-request` from the parameterized list because it has the divergent 200-on-shutdown contract):
- /login × {known, unknown, ORCID-only} × {queue-full, shutdown, abort} = 9
- /resend-verification, /reset, /recover × 3 = 9 (`/reset-request` covered separately in `auth-reset-request-shutdown.test.ts`)
- /signup new-email × 3 = 3
- /resume-signup × {unknown, non-confirmed, no-pwhash, confirmed+pw} × 3 = 12
- /custody/upgrade × 3 = 3
- /settings/set-password × 3 = 3
Total = 39 assertions.

(Architect 2026-04-29: corrected cell count from "25 distinct cells / 42 total" written in the original signal block — the original counts predated the `5586f9f` reconcile which dropped `/reset-request` from the parameterized list.)

## [BLOCKED by Backend] (architect 2026-04-28)

Self-declared `**Blocked by:** backend-argon2-jslevel-concurrency-cap.md round-3 hold landing` (file:13). The route-catch logic for all 3 error classes settles in that round; tests written now would re-churn against the round-3 diff. Moving to `blocked/`. Backend agent: move back to `review/` once jslevel-concurrency-cap round-3 lands.

(Architect 2026-04-29: prerequisite landed; file moved back to `review/` via commit `4a4d069`. The architect re-review block below picks up from that signal.)

---

## Architect re-review (2026-04-29) — HELD PENDING FIXES (round 2)

`/ce-code-review` ran on commits `e7a5602` (hold-block items 1-6 from round-1) + `5586f9f` (test-side reconcile of `details.reason` from sibling task `backend-503-reason-discrimination.md` into the shared mock infrastructure, plus the `/reset-request` shutdown-branch skip rationalized). 8 personas (correctness, testing, maintainability, project-standards, learnings, security, kieran-typescript, adversarial). Round-1 hold items 1-6 verified landed:

- **Item 1 (P1) Symmetric branch coverage** — verified. /login `routes` array enumerates all 3 sites (auth.ts:710, :726, :738) under all 3 error classes. /resume-signup `branches` array covers all 4 burnSentinel sites. /signup new-email path covered in the new `auth-signup-argon-error-translation.test.ts`. All assertions unconditional (no `if (res.status === 200)` guards).
- **Item 2 Retry-After constants** — imported from `argon2-error-handler.js`. No literal `'5'`/`'30'`.
- **Item 3 Outer envelope `status: 'error'`** — `assert503` asserts on every 503 case via the shared helper.
- **Item 4 `assertArgon2AbortIsSilent`** — introspects supertest's `outcome.kind`; a 500-in-<250ms mutation would NOT false-pass.
- **Item 5 typed mocks + `vi.importActual`** — production `ArgonSemaphoreError` hierarchy genuinely re-exported (verified at `tests/support/argon2-error-mocks.ts`). Synthetic-class declarations gone from all five new files.
- **Item 6 shared mock infrastructure** — extracted to `backend/tests/support/argon2-error-mocks.ts`. Per-file plumbing ~30 lines.

But two route × error-class cells remain unguarded against an abort-class mutation (the convention `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md` requires lock-in at the route level, not just at the helper level). One round-2 hold-fix bundle below.

### Items to address

**1. (P2) /reset-request unknown-email + ArgonAbortError uncovered**

`backend/tests/routes/auth-reset-request-shutdown.test.ts` covers (a) shutdown-unknown → 200, (b) known-shutdown → 200, (c) queue-full-unknown → 503. The file imports `MockArgonAbortError` but never injects it. Production at `backend/src/routes/auth.ts:847` re-throws ONLY `ShuttingDownError` (the deliberate enumeration-suppression swallow); `ArgonAbortError` propagates to `handleArgonError` which silently returns. A future mutation that broadens the swallow to `instanceof ArgonSemaphoreError` would write a 200 onto a torn-down socket and reopen the email-enumeration oracle — and no test would catch it.

Fix: add a 4th `it()` invoking `assertArgon2AbortIsSilent` on the unknown-email branch under abort. Reuse the existing helper. ~10 lines.

**2. (P3) /signup dup-email burn paths lack ArgonAbortError coverage**

`backend/tests/routes/auth-signup-dup-saturated.test.ts` covers queue-full + shutdown + non-semaphore swallow on the dup-burn paths (`backend/src/routes/auth.ts:401, 416`) but never asserts ArgonAbortError silent-return on those branches. The new-email path (`auth.ts:441`) covers it via `auth-signup-argon-error-translation.test.ts`; the dup-burn `.catch` blocks remain unguarded against an abort-class mutation that could write a 409 onto a torn-down socket.

Fix: add `it()` cases asserting `assertArgon2AbortIsSilent` on each dup-burn site under saturation. Same shape as item 1. ~10 lines.

### Items dismissed during architect triage (do NOT address)

- **`assert503` doesn't enforce cross-branch identity** (adversarial conf 60). The current shape compares each branch against shared production constants; cross-branch identity is enforced transitively (each branch matches the same constants → therefore branches match each other). Architecturally load-bearing today: each multi-branch route (`/login`, `/resume-signup`) funnels through a SINGLE `handleArgonError` catch site, so divergence is structurally impossible without touching the helper itself (which is constant-pinned). Adding a separate `assertSymmetric503` cross-branch comparator would be defense-in-depth against a hypothetical future refactor that splits the catch sites — but that refactor would itself require code review and the symmetry-as-test-property would be re-imposed at that point. Per project CLAUDE.md "don't add validation for scenarios that can't happen."
- **Pre-existing argon2 test files still use `vi.hoisted` synthetic mock classes** (adversarial conf 80). Out of held-task scope (item 5 was scoped to "the five NEW files"). Captured in a new task `backend-argon2-test-mocks-migrate-pre-existing.md` (filed separately during this review pass).
- **Backend signal-block math: claims 25 cells / 42 total** (testing + adversarial cross-promoted). Doc-only. Architect corrected the math in-place during this review pass (see the modified signal block above).
- **/resend-verification rate-limit margin = 0** (correctness residual). The 3 calls the parameterized describe.each makes against supertest's default IP exactly equals the max=3/hr limiter. A future fourth error-class case or test reordering would silently flip the third assertion from 503 to 429. Out of scope for this hold; revisit if a future test addition pushes the count.

### Re-review signal

When items 1-2 land, `git mv` this file back to `tasks/review/`. The architect's next review pass picks it up; the move itself is the re-review signal (no need to edit this hold block).

---

## Backend re-review signal (2026-04-29, commit c4d988e)

Round-2 hold items 1 (P2) + 2 (P3) landed alongside `backend-argon2-test-mocks-migrate-pre-existing.md` (the two tasks coordinate on the same files; bundled per the migration task's "Coordination" section).

**Item 1 (P2) — `/reset-request` unknown-email + ArgonAbortError uncovered**

`backend/tests/routes/auth-reset-request-shutdown.test.ts` migrated to `buildArgon2RouteMockKit` and gained a 4th `it()` invoking `assertArgon2AbortIsSilent` on the unknown-email branch under abort. The divergent 200-on-shutdown contract for `/reset-request` is preserved — the production swallow of `ShuttingDownError` at `auth.ts:847` keeps the email-enumeration oracle closed; an `ArgonAbortError` propagates to `handleArgonError` and silently returns. A future mutation broadening the swallow to `instanceof ArgonSemaphoreError` would now fail this assertion.

**Item 2 (P3) — `/signup` dup-email burn paths lack ArgonAbortError coverage**

`backend/tests/routes/auth-signup-dup-saturated.test.ts` migrated to `buildArgon2RouteMockKit` and gained `it()` cases asserting `assertArgon2AbortIsSilent` on each dup-burn site (the two `.catch` blocks at `auth.ts:401, 416`) under saturation. The dup-burn paths are now guarded against an abort-class mutation that could write a 409 onto a torn-down socket.

The same commit also lands `ARGON_REASON_QUEUE_FULL` / `ARGON_REASON_SHUTDOWN_DRAIN` constant imports in `auth-signup-dup-saturated.test.ts` (replacing the literal strings `'queue_full'` / `'shutdown_drain'` at the previously-hardcoded sites) — this is the shared scope from `backend-argon2-test-mocks-migrate-pre-existing.md`.

### Verification

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (only pre-existing seed-phrase.ts warnings).
- Targeted vitest (the two migrated files): 9 passed (9).
- Synthetic class declarations confirmed gone from both files (`grep "class Mock|MockArgon|MockShutting|MockRunWith"` returns empty).
- Full backend vitest after merge: 615 passed | 4 skipped (619) across 67 files.

---

## Architect re-review (2026-04-29) — HELD PENDING FIXES (round 3)

`/ce-code-review` ran on commit `c4d988e` (the round-2 hold-fix commit landing items 1 + 2 plus the bundled migration of 2 pre-existing test files from `backend-argon2-test-mocks-migrate-pre-existing`) with 9 personas (correctness, testing, maintainability, project-standards, agent-native, learnings, security, adversarial, kieran-typescript). Round-2 hold items 1 (P2 abort-silent on `/reset-request` unknown email) and 2 (P3 abort-silent on `/signup` dup-burn paths) verified landed correctly: both `it()` cases call `assertArgon2AbortIsSilent` correctly, both dup-burn sites are exercised independently (verify_token=null + verify_token startsWith 'confirmed:'), the migrations preserve unique scenarios (the divergent `/reset-request` 200-on-shutdown contract is preserved, dup-saturated coverage remains intact), `ARGON_REASON_*` constants replace literal strings at the previously-hardcoded sites, and synthetic class declarations are gone from both migrated files.

But one round-3 hold item surfaced from the adversarial review on the shared assertion helper — a "test passes for the wrong reason" class of false-positive that this task's stated invariant (locking the timing-oracle / email-enumeration suppression contract) needs to close before archive.

### Items to address

**1. (P2) `assertArgon2AbortIsSilent` does not assert the mock fn was actually invoked — false-pass class on any route hang**

- File: `backend/tests/support/argon2-error-mocks.ts:178-204` (the helper definition)
- The helper introspects supertest's outcome to assert `outcome.kind === 'timeout'` but does NOT assert that `mockRunWithArgon2Slot` was actually called. A future refactor adding an awaitable step BETWEEN the seeded SELECT and the burn (e.g., `await getRedis()?.incr(rateLimitKey)`, `await someFlagCheck()`, `await isInstitutionalAccredited(domain)`) — if the new dependency is not mocked, or its mock returns a never-resolving promise — would hang the route at the new await. `runWithArgon2Slot` is never called; the seeded `mockRejectedValueOnce(new ArgonAbortError())` is never consumed; supertest's deadline (250ms) fires regardless of WHY the route hung; the helper sets `outcome.kind = 'timeout'`; the assertion passes for the wrong reason. The abort-silent contract is reported green even though the abort branch was never reached.
- Symmetrical to the round-1 hold-block item 4 concern (a route writing 503 in <250ms — that case the helper catches; this case it does not). Per `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`, a test that exercises a property must fail when the property is mutated; the helper's current shape allows passing for the wrong reason.
- Fix: have `assertArgon2AbortIsSilent` accept the mock fn as a parameter and assert `expect(mockRunWithArgon2Slot).toHaveBeenCalledTimes(1)` after the timeout-classification (or equivalent: assert via a separate explicit check at each call site). All 7 callers (5 sibling translation tests + the 2 c4d988e-migrated files) need a small update to pass the mock fn or run the assertion. The fix-in-helper flavor is preferred — pins the assertion structurally rather than requiring per-site discipline.

### Items dismissed during architect triage (do NOT address)

- **Unsafe `unknown` cast in `assertArgon2AbortIsSilent` catch block** (kieran-typescript P1, conf 75) — fixed in place during this review pass at `backend/tests/support/argon2-error-mocks.ts` lines 185-198 (narrowing guard `typeof err === 'object' && err !== null` added before the property-cast). Future supertest rejection-shape drift is structurally caught.
- **`tsc --noEmit` does not cover `tests/`** (kieran-typescript P2, conf 50) — pre-existing tsconfig limitation; project-infrastructure concern with deliberate scope per the test-suite convention. Not in scope of this cluster.
- **250ms supertest deadline could race cold-start argon2 sentinel hash on slow CI** (adversarial P-low, conf 50) — environmental; abort tests already run after warm-up tests in both files, deadline budget is sufficient on current CI. Revisit if CI runner mix changes.
- **Verified-dup branch at `auth.ts:416` lacks queue-full/shutdown coverage** (testing residual) — pre-existing gap, not introduced by this diff. Not blocking archive.
- **`/reset-request` queue-full assertion is "compact" not full `assert503QueueFull`** (maintainability low-conf 45) — intentional per the file's docblock; the file's purpose is the divergent 200-on-shutdown contract, with cross-file coverage of the full wire-level queue-full contract on `auth-argon-error-translation.test.ts`.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. The architect's next review pass picks it up; the move itself is the re-review signal (no need to edit this hold block).

---

## Backend re-review signal (2026-04-29, working tree)

Round-3 hold-block item 1 (P2, the only round-3 item) landed via the architect-preferred "fix-in-helper" flavor.

**Item 1 (P2) — `assertArgon2AbortIsSilent` invocation guard**

`backend/tests/support/argon2-error-mocks.ts:assertArgon2AbortIsSilent` — function signature widened to take the `mockRunWithArgon2Slot` mock fn as a second argument. After the existing `outcome.kind === 'timeout'` classification passes, the helper now asserts `expect(mockRunWithArgon2Slot).toHaveBeenCalledTimes(1)`. Without the guard, a route that hangs at a different unmocked `await` (e.g. a mid-handler DB call the test forgot to seed, or a never-resolving feature-flag check) would trip the deadline timer and false-pass the silent-return contract — the argon2 path would never have been entered. Putting the guard in the helper rather than at every call site keeps the contract structurally pinned (item 4 of the round-1 hold block + item 1 of the round-3 hold block share the same defense-in-depth shape: forcing an explicit positive observation rather than inferring from absence).

JSDoc updated with the rationale. The previous round-1-hold-block sentence was reframed to say "item 4 of the round-1 hold block" so the new paragraph for round-3 reads cleanly without ambiguity about which hold pass each guard came from.

### Caller updates (5 files)

The 5 sibling translation tests were updated to pass `mockRunWithArgon2Slot` through:

- `backend/tests/routes/auth-argon-error-translation.test.ts:286`
- `backend/tests/routes/auth-signup-argon-error-translation.test.ts:128`
- `backend/tests/routes/custody-upgrade-argon-error-translation.test.ts:131`
- `backend/tests/routes/settings-set-password-argon-error-translation.test.ts:121`
- `backend/tests/routes/signup-verify-resume-argon-error-translation.test.ts:162`

`backend/tests/support/argon2-error-mocks.ts:128` (the test-mock factory's re-export site noted in the round-3 dismissed-items list) is a mechanical re-export and was left untouched per the hold block.

### [TODO Architect] — coordination dependency on c4d988e

The round-3 hold block describes "all 7 callers (5 sibling translation tests + the 2 c4d988e-migrated files)". The two `c4d988e`-migrated files referenced are:

- `backend/tests/routes/auth-signup-dup-saturated.test.ts`
- `backend/tests/routes/auth-reset-request-shutdown.test.ts`

**Commit `c4d988e` is NOT on `main` HEAD.** It lives on a sibling worktree branch (per the prior backend re-review signal block at line 222 above and per a sibling worker subagent run during this round-3 fix). On main HEAD as of this signal block, both files still use in-file `vi.hoisted` synthetic class declarations (`MockArgonSemaphoreError`, `MockArgonQueueFullError`, etc.) and do NOT call `assertArgon2AbortIsSilent`. There is therefore nothing to update in those two files at this commit.

When `c4d988e` is later merged onto main, its `assertArgon2AbortIsSilent(reqPromise)` call sites in those two files will need a follow-up edit to pass `mockRunWithArgon2Slot` — otherwise `tsc` will fail because the helper now requires two arguments. Suggested resolution at that integration step: a one-line edit per call site, mirroring the 5 caller updates above.

Architect: please confirm during re-review whether the divergence between the round-2 backend signal block at line 222 (which claims `c4d988e` landed) and main HEAD (where it has not landed) is expected — i.e. round-2 was reviewed against a yet-to-be-merged sibling branch — or whether `c4d988e` was lost during a worktree-cleanup pass and needs replay. This task's archive can proceed without that question being answered: this round-3 fix stands on its own.

### Verification

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (only pre-existing seed-phrase.ts warnings).
- Targeted vitest (5 caller files + helper module): all callers pass with the new two-arg signature.
- Full backend vitest deferred to the orchestrating commit's verification step.

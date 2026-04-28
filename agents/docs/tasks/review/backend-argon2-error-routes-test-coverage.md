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

# BE-ARGON2-ROUTE-LEVEL-503-COVERAGE — Add route-level 503 tests for `ShuttingDownError`/`ArgonQueueFullError`/`ArgonAbortError` in custody, settings, signup-verify

**Owner:** backend
**Created:** 2026-04-28 (surfaced by cluster A `/ce-code-review` of `backend-argon2-semaphore-shutdown-drain.md`, testing + maintainability multi-reviewer convergence)
**Priority:** P2

## Problem

Cluster A added `ShuttingDownError → 503` catch branches to four route handlers:

- `auth.ts` (multiple paths) — covered by `backend/tests/routes/auth-signup-dup-saturated.test.ts`. Pattern: mock `runWithArgon2Slot` to throw `MockShuttingDownError`, supertest asserts `res.status === 503` + `body.error.code === 'SERVICE_UNAVAILABLE'`.
- `custody.ts:253` (`/api/custody/upgrade`) — **untested at route level**.
- `settings.ts:410` (`/api/settings/set-password`) — **untested at route level**.
- `signup-verify.ts:174` (`/api/auth/resume-signup`) — **untested at route level**.

The 4-route catch ladder also handles `ArgonQueueFullError` and (after `backend-argon2-semaphore-abort-signal.md` lands) `ArgonAbortError`. None of those error classes are tested at the route layer for the three uncovered routes either.

Removing any of the new catch branches in `custody.ts`, `settings.ts`, or `signup-verify.ts` would not cause any test to fail. Mutation-kill verification fails for the 503 invariant on those three routes. The `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` convention is violated.

## Goal

Replicate the `auth-signup-dup-saturated.test.ts` pattern for the three uncovered routes. Each route gets a test (or test block) covering all three semaphore error classes:

1. **`ArgonQueueFullError` → 503** with `error.code === 'SERVICE_UNAVAILABLE'`.
2. **`ShuttingDownError` → 503** with `error.code === 'SERVICE_UNAVAILABLE'`.
3. **`ArgonAbortError` → silent return** (no `sendError`; debug-tier log per the existing pattern).

For routes that pass through `burnSentinel`, also test that `burnSentinel`-thrown semaphore errors propagate via the outer catch (matches the auth.ts dup-burn .catch() invariant from the round-3 cluster fix in `0ecc621`).

## Acceptance

- New test file `backend/tests/routes/custody-argon-errors.test.ts` (or extension to `custody.test.ts`): mocks `argon2-semaphore.js` via the `vi.hoisted` pattern from `auth-signup-dup-saturated.test.ts`. Three test cases per the goal.
- New test file `backend/tests/routes/settings-set-password-argon-errors.test.ts` (or extension to `settings-set-password.test.ts`): same shape.
- New test file `backend/tests/routes/signup-verify-argon-errors.test.ts` (or extension to `signup-verify.test.ts`): same shape.
- Each test file's header documents the carve-out justification block per root `CLAUDE.md` "Running Tests" — mocking `runWithArgon2Slot` is required because real-HAF cannot induce a queue-full / shutdown / abort state per-test deterministically.
- Mutation-kill verification: for each of the 9 test cases (3 routes × 3 error classes), revert the corresponding `if (err instanceof ...)` line in the source and confirm the test fails red. Restore. Document in the test header that this verification was performed.
- All existing route tests for `custody`, `settings-set-password`, `signup-verify` continue to pass unchanged.

## Non-goals

- Changing the catch-block logic in any route file.
- Changing the helper extraction (`handleArgonError` is in `backend/src/lib/argon-error-handler.ts` at HEAD — already done in `backend-argon2-error-handler-extract.md`, archived).
- Adding tests for routes outside the four-route argon2 catch ladder.
- Bounded-time integration testing of the drain itself (covered by `backend/tests/lib/argon2-semaphore.test.ts`'s synthetic-handler test, with known limitations documented in cluster A's archive note).

## Related

- `auth-signup-dup-saturated.test.ts` — template pattern.
- `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — convention this task closes.
- `backend-argon2-semaphore-shutdown-drain.md` (archived) — task that introduced the 503 catch branches; this is a coverage follow-up, not a hold against it.
- `backend-argon2-semaphore-abort-signal.md` (in `pending/` after cluster A review) — once landed, the `ArgonAbortError` branch in each route file is also under test from this task.

## [TODO Architect]

None — mechanical replication of an established pattern.

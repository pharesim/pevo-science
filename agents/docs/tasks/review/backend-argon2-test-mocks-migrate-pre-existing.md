# BACKEND-ARGON2-TEST-MOCKS-MIGRATE-PRE-EXISTING — Migrate two pre-existing argon2 route test files to shared `buildArgon2RouteMockKit` and import the `ARGON_REASON_*` constants

**Owner:** backend
**Created:** 2026-04-29 (architect, surfaced by cluster A re-review of `backend-argon2-error-routes-test-coverage.md` (round 2) and the now-archived `backend-503-reason-discrimination.md`)
**Priority:** P3

## Context

Cluster A's `backend-argon2-error-routes-test-coverage.md` extracted shared argon2 route-test infrastructure to `backend/tests/support/argon2-error-mocks.ts`:

- `buildArgon2RouteMockKit()` — typed mock fn + factory closure binding the real production class hierarchy via `vi.importActual`
- `assert503QueueFull` / `assert503Shutdown` / `assert503` / `assertArgon2AbortIsSilent` — wire-level assertion helpers
- `dbStubFactory` / `redisStubFactory` — inert stubs for the disabled-mode shape

Five new `*-argon-error-translation.test.ts` files use this kit. **Two pre-existing argon2 test files were not migrated**:

- `backend/tests/routes/auth-reset-request-shutdown.test.ts`
- `backend/tests/routes/auth-signup-dup-saturated.test.ts`

They still use the original `vi.hoisted` synthetic-class declaration pattern that the cluster's hold-block item 5 set out to eliminate. Task 5's acceptance was scoped to "the five NEW files," so leaving these two unmigrated was correct at the time, but the cluster's standardization is now visibly incomplete: a future test author copying from a sibling has a 2-in-7 chance of landing on the bad precedent.

Additionally, the now-archived `backend-503-reason-discrimination.md` extended `auth-signup-dup-saturated.test.ts` to assert `body.error.details.reason` — but the assertions at lines 141 and 172 hardcode the literals `'queue_full'` / `'shutdown_drain'` rather than importing `ARGON_REASON_QUEUE_FULL` / `ARGON_REASON_SHUTDOWN_DRAIN` from `backend/src/lib/argon2-error-handler.js`. The four sibling translation tests use the constants via the shared `assert503*` helpers; this file is the lone outlier.

## Goal

Bring both pre-existing files into line with the shared infrastructure so the cluster's testing surface is uniform and a future test author copying from any sibling lands on the canonical pattern.

## Acceptance

1. **`auth-reset-request-shutdown.test.ts` and `auth-signup-dup-saturated.test.ts` use `buildArgon2RouteMockKit` from `tests/support/argon2-error-mocks.ts`.** Both files import the real `ArgonSemaphoreError` / `ArgonQueueFullError` / `ShuttingDownError` / `ArgonAbortError` classes via `vi.importActual` (through the shared kit's factory). No synthetic class declarations remain in either file.
2. **`auth-signup-dup-saturated.test.ts` imports `ARGON_REASON_QUEUE_FULL` / `ARGON_REASON_SHUTDOWN_DRAIN` from `backend/src/lib/argon2-error-handler.js`** and uses them in the `details.reason` assertions instead of literal strings. Optionally migrate the same file to use `assert503QueueFull` / `assert503Shutdown` from the shared kit if the assertion shapes align without churn.
3. **The two files retain their unique test scenarios.** Migration is structural; the test cases themselves are unchanged:
   - `auth-reset-request-shutdown.test.ts` keeps the divergent /reset-request 200-on-shutdown contract coverage (production at `backend/src/routes/auth.ts:847` deliberately swallows `ShuttingDownError` to keep email enumeration closed).
   - `auth-signup-dup-saturated.test.ts` keeps the dup-email-saturated coverage with the burn-on-409 paths.
4. **`npx tsc --noEmit` clean.** **`npm run lint` clean.** Both files pass the targeted vitest run.

## Coordination — coverage gap on `auth-reset-request-shutdown.test.ts`

A separate cluster-A round-2 hold (`backend-argon2-error-routes-test-coverage.md`, hold-block item 1) requires this same file to add a 4th `it()` invoking `assertArgon2AbortIsSilent` on the unknown-email branch under abort. **That work and this migration touch the same file.** Land them in the same commit so the abort-silent assertion lands inside the migrated structure (using the shared kit's `assertArgon2AbortIsSilent` helper rather than a hand-rolled supertest deadline).

A symmetric gap exists on `auth-signup-dup-saturated.test.ts` (cluster-A round-2 hold item 2): add `it()` cases asserting `assertArgon2AbortIsSilent` on each dup-burn site under saturation. Same coordination — land alongside the migration.

If the two cluster-A hold-block items above are addressed FIRST in the held tasks' own hold-cycle, this migration task becomes a structural cleanup with no coverage delta. If this migration is addressed FIRST, the shared-kit helpers are in place and the cluster-A hold-block items become 5-line additions. Either order is fine; the implementer can choose.

## Non-goals

- Rewriting the test scenarios. Only the mock infrastructure and constant imports change.
- Migrating any other test file outside the two named.
- Touching production code.
- Adding new test cases beyond the cluster-A hold items mentioned in Coordination.

## Notes

The `auth-reset-request-shutdown.test.ts` divergence is deliberate: production returns 200 (not 503) on `ShuttingDownError` to keep email enumeration closed during SIGTERM. Migration must preserve that. The shared kit's `assert503QueueFull` / `assert503Shutdown` helpers are designed for the symmetric 503 case — for the divergent 200 case, keep the file's existing custom assertions but use the kit's mock-class factory for the error class hierarchy.

The hoisted-pattern documentation at the top of each new translation test file (cross-reference to `tests/support/argon2-error-mocks.ts:30-46`) is the canonical example. Copy that comment header and the `await vi.hoisted(async () => (await import('../support/argon2-error-mocks.js')).buildArgon2RouteMockKit())` shape directly.

## Files of record

- `backend/tests/routes/auth-reset-request-shutdown.test.ts` (target)
- `backend/tests/routes/auth-signup-dup-saturated.test.ts` (target)
- `backend/tests/support/argon2-error-mocks.ts` (source of canonical pattern)
- `backend/tests/routes/auth-argon-error-translation.test.ts` (reference example using the kit)

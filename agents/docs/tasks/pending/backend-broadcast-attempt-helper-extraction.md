# BACKEND-BROADCAST-ATTEMPT-HELPER-EXTRACTION — Factor `logBroadcastAttempt` closure into shared `lib/broadcast-error.ts` factory

**Owner:** backend
**Created:** 2026-05-11 (surfaced by `backend-bridge-custody-broadcast-discrimination` round-2 review, maintainability reviewer M-2 anchor 75)
**Priority:** P2

## Context

Round-2 of `backend-bridge-custody-broadcast-discrimination` added a per-attempt audit-log helper `logBroadcastAttempt(outcome, extra?)` inside the `/api/custody/broadcast` route handler in `backend/src/routes/custody.ts`. The helper captures `username`, `op_types`, `op_count` via closure and branches on `outcome ∈ {success, failure, timeout}` to dispatch `logger.info` (success) vs `logger.warn` (failure/timeout) with the same event-and-context shape.

`backend/src/routes/bridge.ts` defines a structurally identical closure inside its `/register` (and historically `/update`, retired in `e647abb`) handler — same fields captured, same outcome branching, same event-shape, only the event-label string differs (`bridge.register.attempt` vs `custody.broadcast.attempt`).

The pattern that motivated extracting `backend/tests/support/broadcast-mocks.ts` on the test side (round-2 hold item 1) recurs on the production side. If the branching logic, the `attempt_n` field shape (currently hardcoded — see `backend-bridge-custody-broadcast-discrimination` round-3 hold item 1), the extra-spread direction, or the level dispatch ever needs to change, both closures must be updated in sync. There is no mechanical guarantee of symmetry — a future maintainer editing custody.ts will not know to update bridge.ts.

## Acceptance

1. Extract a factory in `backend/src/lib/broadcast-error.ts` (next to `handleBroadcastError`, since they share the `LogContext` interface):

   ```ts
   export type AttemptOutcome = 'success' | 'failure' | 'timeout';

   export function makeLogBroadcastAttempt(
     eventLabel: string,                    // e.g. 'custody.broadcast.attempt'
     baseContext: LogContext,                // username, op_types, op_count, etc.
     loggerInstance: Logger = logger,        // injectable for tests
   ): (outcome: AttemptOutcome, extra?: Record<string, unknown>) => void {
     return (outcome, extra) => {
       const level = outcome === 'success' ? 'info' : 'warn';
       loggerInstance[level]({ ...baseContext, ...extra, outcome, event: eventLabel }, 'broadcast attempt');
     };
   }
   ```

   (Signature is illustrative; final shape is the implementer's choice as long as the symmetry property is enforced.)

2. Replace the inline closure in `custody.ts` (around line 461) with a call to `makeLogBroadcastAttempt('custody.broadcast.attempt', {username, op_types, op_count})`. Replace in `bridge.ts` (`/register` only — `/update` is retired) with `makeLogBroadcastAttempt('bridge.register.attempt', {username, op_types, op_count, identifier, permlink})` or equivalent.

3. The `event:` literal goes AFTER the spread of `extra` so the helper-set value wins per the spread-after-literal convention.

4. Coordinate with `backend-bridge-custody-broadcast-discrimination` round-3 hold item 1: if `attempt_n` is removed from the helper output (recommended in that hold), the factory does not declare it; if it's kept as a placeholder, the factory accepts an optional `attemptN` parameter defaulting to undefined.

## Tests

1. Add a unit test for `makeLogBroadcastAttempt` in `backend/tests/lib/broadcast-error.test.ts` verifying:
   - `outcome: 'success'` calls `logger.info`, not `logger.warn`.
   - `outcome: 'failure'` and `outcome: 'timeout'` call `logger.warn`.
   - The event field is set to the factory's `eventLabel` argument.
   - A caller-supplied `extra.event` does NOT override the factory's event (spread-after-literal property).
   - Base context fields are spread BEFORE extras (so a caller-supplied `username` in `extra` would override the base — which is correct behavior since the factory is closing over the request scope's base context, and callers may want to override per-call).

2. The existing custody-route and bridge-route specs that assert on the audit-log shape continue to work unchanged (the helper preserves the shape).

## Coordination

- Cross-references `backend-bridge-custody-broadcast-discrimination` round-3 hold item 1 (`attempt_n` placeholder decision).
- Cross-references `backend-bridge-outer-catch-event-discriminators` follow-up task (same event-shape convention).
- Path-scoped staging applies; this task touches `backend/src/lib/broadcast-error.ts`, `backend/src/routes/custody.ts`, `backend/src/routes/bridge.ts`, and `backend/tests/lib/broadcast-error.test.ts`. No api-contract docs touched.

## Out of scope

- Extending the factory to other broadcast routes (orcid, accreditation). Those routes have their own audit-log shapes that don't match the custody/bridge pattern exactly; a separate sweep would file a different task.
- Adding rate-limiting or idempotency to the audit log. The idempotency-cluster follow-up task tracks that.

## Priority rationale

P2 because the duplication is real and the maintenance cost compounds with each new broadcast route that adopts the audit-log pattern. Not blocking any current shipping work; the consolidation is an investment.

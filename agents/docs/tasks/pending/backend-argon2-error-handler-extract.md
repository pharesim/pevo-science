# BE-ARGON2-ERROR-HANDLER-EXTRACT — Consolidate argon2 error catch logic across 4 routes; eliminate 3-way instanceof drift

**Owner:** backend
**Created:** 2026-04-28 (surfaced by argon2 cluster re-review)
**Priority:** P2
**Blocked by:** `backend-argon2-jslevel-concurrency-cap.md` round-3 hold landing (avoids merge-conflict churn against the round-3 fix to auth.ts:401,407).

## Context

After the argon2 cluster (jslevel-concurrency-cap, shutdown-drain, abort-signal) landed, every route that calls `runWithArgon2Slot` must catch three distinct error classes:
- `ArgonQueueFullError` → 503 SERVICE_UNAVAILABLE
- `ShuttingDownError` → 503 SERVICE_UNAVAILABLE
- `ArgonAbortError` → silent return (client already disconnected)

`auth.ts:236-242` factored this into a `handleArgonQueueFull(res, err): boolean` helper but never exported it. The 3 sibling routes (`custody.ts`, `signup-verify.ts`, `settings.ts`) inline the same 3-way instanceof chain. Already drifted: maintainability reviewer noted custody.ts logs a `username` field in the error context that the others omit. A future 4th error class would require updates in 4 sites with no compiler enforcement.

Additional related items surfaced by the same review pass:
- The function name `handleArgonQueueFull` no longer matches scope (handles 3 error kinds).
- The boolean side-effect return contract (`if (handleArgonQueueFull(res, err)) return;`) is fragile — a caller that omits `return` falls through to a 500 with double-respond. No test catches this.
- The 3 error classes have no shared base; catch sites do 3 `instanceof` checks.
- `requestAbortSignal` helper duplicated verbatim across 4 route files (auth.ts, custody.ts, settings.ts, signup-verify.ts) per the abort-signal task's "no shared new file per the file-list scope" constraint. The duplication is intentional but needs to be resolved as part of consolidation.
- `argon2-semaphore.ts` has both `{ once: true }` AND explicit `removeEventListener` in finally on the abort listener — one is always a no-op. Reader confusion.

## Goal

Centralize argon2 error handling and cross-file helpers into the backend `lib/` module. Eliminate the 3-way inline instanceof checks and the requestAbortSignal duplication.

## Approach (suggested)

1. Add `ArgonSemaphoreError` abstract base class in `argon2-semaphore.ts`. Make `ArgonQueueFullError`, `ShuttingDownError`, `ArgonAbortError` extend it. Catch sites can then do a single `if (err instanceof ArgonSemaphoreError) ...` to identify any semaphore error.
2. Move `handleArgonQueueFull` to `backend/src/lib/argon2-error-handler.ts` (or export from `argon2-semaphore.ts`). Rename to `handleArgon2Error`. Reconsider the boolean side-effect contract — prefer one of:
   - `void` return that throws if it can't handle (forces caller to wrap in try/catch — discouraged given the catch is already inside try/catch).
   - Returning the same `boolean` but documenting the contract loudly with a JSDoc `@returns` and adding a route-level test (in `backend-argon2-error-routes-test-coverage.md`) that asserts double-respond doesn't happen if a future caller omits the `return`.
3. Move `requestAbortSignal` to `backend/src/lib/request-abort-signal.ts`. Replace the 4 inline copies with imports.
4. Pick one of `{ once: true }` OR explicit `removeEventListener` in argon2-semaphore.ts abort listener — drop the redundant one.

## Acceptance

- `ArgonSemaphoreError` base class exists; all 3 concrete errors extend it.
- `handleArgon2Error` (renamed) exported from a shared module; imported and used by all 4 affected routes (auth, custody, signup-verify, settings).
- `requestAbortSignal` lives in one shared module; all 4 routes import it.
- Inline 3-way instanceof checks removed from custody.ts, signup-verify.ts, settings.ts.
- argon2-semaphore.ts abort listener uses one cleanup mechanism, not both.
- `npx tsc --noEmit` clean; full backend test suite passes.

## Non-goals

- Behavioral changes to error handling. This is a structural consolidation only — same status codes, same response shapes, same logs.
- Changes to the underlying semaphore or argon2 invariants.

# BACKEND-MAKELOGBROADCASTATTEMPT-CAST-NARROW — migrate 9 `Parameters<typeof makeLogBroadcastAttempt>[2]` casts to a named-type form

**Owner:** Backend Agent
**Created:** 2026-05-18 (architect, cluster-D follow-up from `backend-tests-typecheck-coverage` round-2 review)
**Priority:** P3

## Problem

`backend-tests-typecheck-coverage` round-1 item 3 replaced the 5 `as unknown as Parameters<typeof handleBroadcastError>[2]` casts in `backend/tests/lib/broadcast-error.test.ts` with `as unknown as HandleBroadcastErrorOpts` (named-type form imported from `backend/src/lib/broadcast-error.ts:338`). The named-type form is robust against signature refactors — the structural `Parameters<typeof>[2]` index silently shifts if the function gains a leading parameter — and is greppable across the suite by the type name.

The same structural-index fragility class survives at 9 sites in the same file for the **sibling helper** `makeLogBroadcastAttempt`, at approximately `backend/tests/lib/broadcast-error.test.ts:949-1192`. These were intentionally scoped out of the parent task (which targeted only `handleBroadcastError[2]`) and are tracked as a cluster-D architect carry-forward from the round-2 re-review.

## Goal

Mirror the named-type-cast migration for `makeLogBroadcastAttempt`:

1. **Add a named type export** for the third parameter shape of `makeLogBroadcastAttempt` in `backend/src/lib/broadcast-error.ts` (analogous to the existing `HandleBroadcastErrorOpts` at `:338`). Suggested name: `MakeLogBroadcastAttemptOpts` (or whatever fits the existing naming style; preserve the export at module scope so other test files can import it consistently).
2. **Import the named type** in `backend/tests/lib/broadcast-error.test.ts` alongside the existing `HandleBroadcastErrorOpts` import.
3. **Replace all 9 occurrences** of `as unknown as Parameters<typeof makeLogBroadcastAttempt>[2]` with `as unknown as MakeLogBroadcastAttemptOpts`.

The two-step `as unknown as <T>` form is preserved (load-bearing — the cast objects violate the discriminated union or contain fields absent from the named type; the intermediate `unknown` is required).

## Acceptance

1. New named type exported from `backend/src/lib/broadcast-error.ts` for `makeLogBroadcastAttempt`'s third parameter.
2. All 9 `Parameters<typeof makeLogBroadcastAttempt>[2]` occurrences in `backend/tests/lib/broadcast-error.test.ts` replaced with the named-type form.
3. Greppable: `grep -n "Parameters<typeof makeLogBroadcastAttempt>\[2\]" backend/tests/lib/broadcast-error.test.ts` → 0 matches; `grep -n "<NamedTypeName>" backend/tests/lib/broadcast-error.test.ts` → 1 import + 9 cast sites.
4. `npx tsc --noEmit -p backend/tsconfig.json` and `npx tsc --noEmit -p backend/tests/tsconfig.json` both clean.
5. `npx vitest run tests/lib/broadcast-error.test.ts` against real infrastructure — same 42/42 (or current count) pass as before, no behavior change.

## Out of scope

- Any other `Parameters<typeof X>[N]` casts elsewhere in the test suite — file separately if a future review surfaces them as a pattern.
- Refactoring `makeLogBroadcastAttempt`'s signature itself.

## References

- `backend-tests-typecheck-coverage` round-1 hold item 3 (the canonical named-type cast migration the architect prescribed; archived when the parent task closes).
- `backend/src/lib/broadcast-error.ts:338` (the existing `HandleBroadcastErrorOpts` export — the reference shape for the new export).
- `backend/tests/lib/broadcast-error.test.ts:~949-1192` (the 9 sites to migrate).

## Priority rationale

P3 because the structural-index fragility is latent — it surfaces only if `makeLogBroadcastAttempt` gains a leading parameter or shuffles its signature. No active type error today; the migration is preventive consistency with the sibling helper's already-migrated casts.

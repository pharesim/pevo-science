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

---

## Backend re-review signal (2026-05-18, working tree)

Round-1 implementation landed cleanly. Single commit, scope as prescribed.

- **Acceptance #1:** New named type `MakeLogBroadcastAttemptOpts` exported from `backend/src/lib/broadcast-error.ts`, co-located with `makeLogBroadcastAttempt` (declared just below `AttemptOutcome`, above the function definition). Shape preserves the existing structural type: `{ info: typeof logger.info; warn: typeof logger.warn }`. The function signature was updated to use the named type (`loggerInstance: MakeLogBroadcastAttemptOpts = logger`) so the named type is the single source of truth — a future refactor of the third parameter goes through the type rather than diverging across declaration and consumers.
- **Acceptance #2 + #3:** Import block in `backend/tests/lib/broadcast-error.test.ts` now includes `type MakeLogBroadcastAttemptOpts` alongside `type HandleBroadcastErrorOpts` (the sibling exemplar). All 9 `as unknown as Parameters<typeof makeLogBroadcastAttempt>[2]` occurrences replaced with `as unknown as MakeLogBroadcastAttemptOpts`. The two-step `as unknown as <T>` form is preserved — test fixtures inject `vi.fn`-spied `{ info, warn }` shapes that don't carry every pino method, so the intermediate `unknown` is load-bearing.
- **Acceptance #4 (grep gates):**
  - `grep -n "Parameters<typeof makeLogBroadcastAttempt>\[2\]" backend/tests/lib/broadcast-error.test.ts` → 0 matches.
  - `grep -n "MakeLogBroadcastAttemptOpts" backend/tests/lib/broadcast-error.test.ts` → 10 matches (1 import + 9 cast sites).
- **Acceptance #5:** `npx tsc --noEmit -p backend/tsconfig.json` clean. `npx tsc --noEmit -p backend/tests/tsconfig.json` clean (0 errors; the residual-drift follow-up archived 2026-05-18 cleared the 249-error backlog the round-2 task body referenced).
- **Acceptance #6:** Targeted vitest deferred to the parent's serialized post-fan-out run.

**Notes:**

- The naming follows the architect's "or whatever fits the existing naming style" carve-out by matching the sibling `HandleBroadcastErrorOpts` exemplar. Strictly the third parameter is a logger instance (not opts), but the `-Opts` suffix is the established convention in this file and the consistency wins over literal accuracy.
- Production behavior is unchanged: the named type is structurally identical to the inline shape it replaces; the function's call sites in `backend/src/` continue to pass the module-scope `logger` (default-argument).


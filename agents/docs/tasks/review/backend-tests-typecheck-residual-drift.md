# BACKEND-TESTS-TYPECHECK-RESIDUAL-DRIFT — clear the 249-error baseline in `npm run typecheck:tests` and chain it into `typecheck`

**Owner:** Backend Agent
**Created:** 2026-05-16 (backend, round-1 hold path (b) of `backend-tests-typecheck-coverage`)
**Priority:** P2

## Problem

The parent task `backend-tests-typecheck-coverage` delivered the structural foundation: `backend/tests/tsconfig.json` extending the root tsconfig with `tests/` included, plus a standalone `npm run typecheck:tests` script in `backend/package.json`. It also fixed the in-scope LogContext typo-bypass sites in `backend/tests/lib/broadcast-error.test.ts`.

But Acceptance #4's intent (original wording) was that `typecheck:tests` runs "alongside" `typecheck` — i.e., the canonical pre-merge command (`npm run typecheck`) fans out to both so a new LogContext typo or other test-file type drift is caught on commit, not on a separate manual invocation. Chaining was deferred because `npm run typecheck:tests` exits non-zero today with **249 errors across 56 test files**, all pre-existing pre-test-tsconfig drift. Chaining now would block every backend commit on noise the parent task did not introduce.

This follow-up clears the baseline and chains the script.

## Why path (b) at the parent

Parent task round-1 hold item 1 framed two paths:

- (a) Fix-and-chain in the parent task — clear the 249 errors and chain, all in one PR-equivalent. Realistic scope was rejected because the 249 errors span auth helpers, custody routes, idempotency tests, wot-broadcast specs, support fixtures, etc. — each category needs its own per-file judgment call (real fix vs `@ts-expect-error` vs file-level exclude). Bundling that volume of edits with the LogContext fix made the parent commit unreviewable.
- (b) Defer-and-document — keep the parent scoped to the LogContext fix + structural tsconfig + standalone script, and file THIS task for the chaining step. Picked because the 249-error backlog is pre-existing drift unrelated to the LogContext typo-protection contract the parent enforces.

## Acceptance

1. **Baseline-categorize the 249 errors.** Run `cd backend && npx tsc --noEmit -p tests/tsconfig.json` and bucket each error into one of:

   - **(A) Real type drift to fix.** The test imports/exports/uses a type whose shape changed in `src/` and the test wasn't updated. Genuine bug; fix the test.
   - **(B) Missing type import / wrong type-only-import marker.** Easy fix; add the import.
   - **(C) Vitest globals not declared.** The `types:["node"]` in `tests/tsconfig.json` excludes vitest globals; if a test uses `expect`/`describe`/`it` without explicit imports, fix the tsconfig (add `"vitest/globals"` to `types:[]`) or add explicit imports per file.
   - **(D) `wot-broadcast-timeout.test.ts` CommonJS-module top-level-await.** TS1309 errors. Either set `"module":"esnext"` in the tests-tsconfig (overriding the root if it inherits CommonJS), add a `// @ts-expect-error` per line, or convert the top-level-await to an IIFE-wrapped async.
   - **(E) Test-fixture type-system corner case.** E.g., `tests/support/argon2-error-mocks.ts` mocks a module without the full export shape and gets TS2322. Either widen the mock typing, add a fixture-local `@ts-expect-error` with rationale, or `as unknown as <RealType>` cast at the mock boundary.
   - **(F) Genuinely intractable for now.** Add a per-file exclude to `backend/tests/tsconfig.json` with an inline comment citing why the file is excluded and what the unblock condition is.

2. **Apply the per-category fix.** Categories (A) and (B) are no-judgment fixes — land them. (C) and (D) are tsconfig-shape decisions; pick the cleanest option and document the decision in `agents/backend/CLAUDE.md` if it's a convention future test additions should follow. (E) and (F) are case-by-case.

3. **Chain `typecheck:tests` into `typecheck`.** Once `npm run typecheck:tests` exits zero against `backend/tests/tsconfig.json`, update `backend/package.json` so `npm run typecheck` runs both. Two reasonable shapes:

   - `"typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tests/tsconfig.json"` (simple chain — fails fast on the first config that errors).
   - Or split: `"typecheck:src"` + `"typecheck:tests"` + `"typecheck": "npm run typecheck:src && npm run typecheck:tests"`. Slightly more grep-friendly; pick whichever the project standard prefers.

4. **Spot-check the gate.** Add a typo'd LogContext field to ONE test file (e.g., `{ usrname: 'alice' }`); confirm `npm run typecheck` fails on it; then remove the case. Same shape as the parent task's Acceptance #5 spot-check — verbal verification is the criterion, no fixture left behind.

## Tests

The typecheck step IS the test. The act of clearing the backlog + chaining is mutation-checked by the next typecheck run. No new unit specs.

## Out of scope

- Adding tsc coverage to `frontend/tests/` — UI agent's call, separate task.
- Refactoring any of the production types whose drift caused category (A) errors — fix the test to match the production type, not the other way around. If a production type is genuinely wrong, file a separate task.
- Re-litigating the `TestLogContext` widening cast pattern. The parent task closed that question via path (a) (`run` promoted to declared `LogContext` field). This task may surface analogous patterns in OTHER test files; treat each on its own merits per category (A)–(F) above.

## References

- Parent task: `agents/docs/tasks/pending/backend-tests-typecheck-coverage.md` (round-1 hold item 1, path (b) defer-and-document).
- Architect re-review on commit `c90d890` (2026-05-16) surfacing the 249-error baseline via testing T1+T2 and project-standards PS-2 (cross-reviewer conf 100).
- Baseline error breakdown (from a single `tsc --noEmit -p tests/tsconfig.json` run on commit `cfdc904`): 249 errors across 56 files. Top offenders include `tests/wot-broadcast-timeout.test.ts` (TS1309 await-at-top-level), `tests/support/argon2-error-mocks.ts` + `tests/support/argon2-error-mocks.test.ts` (TS2322 mock-shape mismatch, TS2554 arg-count), plus per-file noise across the auth/custody/idempotency suites.

## Priority rationale

P2 because the typo-protection gate IS already wired for the load-bearing case (LogContext typos in `broadcast-error.test.ts`) by the parent task — the gate works for the file most likely to drift, and the standalone `npm run typecheck:tests` script lets operators run it on demand. The chained pre-merge guarantee is the gap, and clearing 249 errors across 56 files is a multi-commit triage exercise that benefits from being its own task rather than blocking the parent's archive.

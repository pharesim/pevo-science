# UI-LOADDHIVE-ROTATION-SIGNUP-VERIFY — route signup-verify.js dhive import through loadDhive

**Owner:** UI Agent
**Created:** 2026-05-16 (architect, follow-up from /ce-code-review round-6 of ui-seed-phrase-keychain-compat)
**Priority:** P3

## Problem

`frontend/src/pages/signup-verify.js:380` still uses bare `await import('@hiveio/dhive')` rather than the cached `loadDhive` exported from `frontend/src/hive-keys.js`. The convention established by `ui-seed-phrase-keychain-compat` rounds 4-5 (commits `f648303` and `2fe8a98`) is that every frontend dhive consumer in the upgrade/derivation flow routes through `loadDhive` so the dynamic-import cache is shared across callsites. `settings.js` is fully migrated; `signup-verify.js` was not in scope of those rounds and still emits a parallel `await import(...)` at line 380.

Runtime impact is zero. The browser module registry deduplicates the underlying fetch; both `import()` calls resolve to the same module object. The cost is convention inconsistency: a future reader inspecting "how does PEvO load dhive on the frontend" sees two patterns and has to figure out which is canonical. The `loadDhive` JSDoc says the export exists so callers "can reuse the cached module instead of issuing a parallel `await import('@hiveio/dhive')`" — `signup-verify.js`'s bare import violates that contract for the same reason `_performUpgradeKeyRotation` did before round-5.

## Acceptance criteria

1. Replace `await import('@hiveio/dhive')` at `frontend/src/pages/signup-verify.js:380` with `await loadDhive()`. Add `loadDhive` to the file's existing import from `frontend/src/hive-keys.js` (the file likely already imports other helpers from that module; just append `loadDhive` to the existing import list).
2. Verify no other `await import('@hiveio/dhive')` callsites remain in `frontend/src/` outside of `frontend/src/hive-keys.js` itself: `grep -rn "await import.*@hiveio/dhive" frontend/src/` after the change should match only `frontend/src/hive-keys.js`'s internal cache definition. If any other callsite is found, note it in the signal block — the architect will decide whether to widen this task's scope or file a sibling.
3. Run the existing test file covering `signup-verify.js` (likely `frontend/tests/unit/pages-signup-verify.test.js` or a similar slug) and confirm no regressions. If the test file mocks `@hiveio/dhive` via `vi.mock`, no test-side change is needed (the same mock resolves through `loadDhive`'s internal `await import(...)`).

## Out of scope

- Any other refactor of `signup-verify.js`. The change is the one-line swap plus the import-list update.
- Backend changes.
- Adding `loadDhive` callsites anywhere else.

## Cross-references

- `frontend/src/hive-keys.js:13-22` — `loadDhive` definition (cached module-level `_dhive`).
- `frontend/src/pages/settings.js` (canonical-pattern reference) — every dhive consumer routes through `loadDhive` after `ui-seed-phrase-keychain-compat` round 5.
- Source: `/ce-code-review` round-6 of `ui-seed-phrase-keychain-compat` (2026-05-16), maintainability-ui-r5 residual_risk. Discovered during architect re-review of UI half commit `2fe8a98`.

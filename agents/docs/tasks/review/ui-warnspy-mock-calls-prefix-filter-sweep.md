# UI-WARNSPY-MOCK-CALLS-PREFIX-FILTER-SWEEP — Migrate sibling `warnSpy.mock.calls[0][1]` reads to prefix-filtered `find()` form

**Owner:** UI Agent
**Created:** 2026-05-04
**Priority:** P3
**Surfaced by:** Cluster E architect review (2026-05-04) — finding #23 against `ui-upgrade-credential-wipe.md` round-4 (commit `9af76fd`).

## Context

The round-4 fix for FE-UPGRADE-CREDENTIAL-WIPE migrated the leak-guard test at `frontend/tests/unit/pages-settings.test.js:494` from `warnSpy.mock.calls[0]` to `warnSpy.mock.calls.find((c) => c[0] === '[custody upgrade]')` (with a `toBeDefined()` sanity check before dereferencing `[1]`). The migration is correct: it makes the assertion refactor-stable against any earlier intermediate `console.warn` shifting the index.

Six sibling tests in the same file still use the bare `warnSpy.mock.calls[0][1]` index pattern at lines 217, 268, 303, 330, 363, 1062. Each is equally susceptible to an intermediate `console.warn` shifting the index — the same fragility class round-3 hold item #3 named.

## Goal

Sweep all 6 sites. For each:

1. Identify the production code's `console.warn` prefix (e.g. `'[email]'`, `'[orcid link]'`, `'[password]'`) by reading the corresponding handler in `frontend/src/pages/settings.js`.
2. Replace `warnSpy.mock.calls[0]` with `warnSpy.mock.calls.find((c) => c[0] === '<prefix>')`.
3. Add `expect(warnArgs).toBeDefined()` before dereferencing `[1]`.

If production code at a site does not emit a prefix string, note it in the implementation but do not refactor production code in this task — file as a separate task if any sites lack prefixes.

## Non-goals

- Refactoring production `console.warn` calls to add prefixes (file as a separate task if any sites lack prefixes).
- Migrating `warnSpy.mock.calls[0]` patterns in OTHER test files (out of scope for this sweep).
- Changing the underlying assertion semantics.

## Deliverable

- All 6 sites migrated to the `find()` + `toBeDefined()` pattern.
- Test suite still passes (`npx vitest run tests/unit/pages-settings.test.js`).
- No production code changes.

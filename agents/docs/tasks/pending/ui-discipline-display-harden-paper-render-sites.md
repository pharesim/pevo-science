# FE-DISCIPLINE-DISPLAY-HARDEN-PAPER-RENDER-SITES — Apply `titleCaseDiscipline` at the 5 remaining render sites

**Owner:** UI
**Created:** 2026-04-28 (surfaced by FE-DISCIPLINE-DISPLAY-HARDEN review, maintainability reviewer P1)
**Priority:** P1

## Context

FE-DISCIPLINE-DISPLAY-HARDEN (commit `69ca1ef`) introduced `titleCaseDiscipline()` in `frontend/src/lib/discipline-display.js` and migrated the two **dropdown OPTION** sites:

- `frontend/src/components/paper-feed.js:18` — option text
- `frontend/src/pages/search.js:53` — option text

Both also dropped the `class="capitalize"` on the surrounding select/option.

Five other discipline render sites still use `class="capitalize"` against `paper.discipline` (or `accreditation.field`):

- `frontend/src/components/paper-card.js:16` — `<span class="badge-discipline capitalize" x-text="paper.discipline">`
- `frontend/src/pages/paper-detail.js:266` — identical pattern
- `frontend/src/pages/profile.js:47, 73, 226` — variants on `paper.discipline` and `accreditation.field`
- `frontend/src/pages/search.js:94` — search-result row discipline label (NOT the option dropdown that WAS migrated)

These sites read canon-lowered values from the backend (per BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME for paper sites; accreditation field is already lowercased at submission). With CSS `text-transform: capitalize` on canon-lower input:

- `'physics'` → `'Physics'` ✓
- `'computer science'` → `'Computer Science'` ✓
- `'theory of computation'` → `'Theory Of Computation'` ✗ (stopword `of` should stay lowercase)
- `'ml'` → `'Ml'` ✗ (initialism should be ALL-CAPS)

The exact bugs `titleCaseDiscipline()` exists to fix still surface at every paper card, every paper detail page, every profile-papers list, and every search-result row — i.e., the high-traffic paths.

## Goal

At each of the 5 sites:
1. Replace `x-text="paper.discipline"` (or `accreditation.field`) with `x-text="titleCaseDiscipline(paper.discipline)"` (or the appropriate field).
2. Remove `class="... capitalize ..."` (drop only the `capitalize` token; preserve other classes).
3. Ensure `titleCaseDiscipline` is exposed on the relevant Alpine data factory at each route. Most sites are inside paper-feed / search / profile / paper-detail factories — verify exposure or add the import + factory entry.

## Non-goals

- Changing the helper's stopword/initialism sets (separate concern; English-only is documented).
- Moving display logic to backend (separate architectural call; out of scope).
- Migrating any non-discipline field that uses `capitalize` (only discipline / accreditation.field).

## Tests

Per FE-DISCIPLINE-DISPLAY-HARDEN round-1 hold #1 (add factory-exposure specs), mirror that test pattern at any new factory the helper is exposed on. Targeted unit/integration coverage:

- For each consumer that exposes the helper on its data factory, assert `factory().titleCaseDiscipline === <imported helper>` (identity-equal).
- DOM-level / Playwright assertion: discipline-rendering elements no longer carry `class="capitalize"`. (Optional; robustness over speed.)

## Acceptance

- All 5 sites render `titleCaseDiscipline(paper.discipline)` (or equivalent) instead of raw `paper.discipline` + CSS capitalize.
- No remaining `class="capitalize"` on any element rendering a discipline value (`grep -r 'capitalize.*discipline\|discipline.*capitalize' frontend/src/`).
- Helper exposed on every consumer factory that needs it.
- Factory-exposure specs land per the test pattern above.

## Related

- FE-DISCIPLINE-DISPLAY-HARDEN (archived) — the predecessor task that migrated the dropdown-option sites only. Original task description named only `paper-feed.js` + `search.js` as consumers; the broader render surface was outside its mechanical scope. This task closes the gap.

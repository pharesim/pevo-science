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

## UI submission (2026-04-28, working tree)

Migrated 4 of the 5 named sites; flagged the 5th (`search.js:94`) for architect re-triage because the original task description does not match the code there.

**Migrated (4 sites):**
- `frontend/src/components/paper-card.js:16` — `paper.discipline` + `class="capitalize"` → `titleCaseDiscipline(paper.discipline)`, `capitalize` token dropped. Rendered inside `paperCardTemplate`, which is consumed only at `paper-feed.js:78`; the `paper-feed` factory at `paper-feed.js:118` already exposes the helper, so no factory change was needed.
- `frontend/src/pages/paper-detail.js:266` — `paper.discipline` + `capitalize` → `titleCaseDiscipline(paper.discipline)`. Added import at top + `titleCaseDiscipline` entry on the `paperDetailPage` factory.
- `frontend/src/pages/profile.js:47` — `profile.accreditation.field` + `capitalize` → `titleCaseDiscipline(profile.accreditation.field)`. Added import at top + entry on the `profilePage` factory.
- `frontend/src/pages/profile.js:73` — same pattern as `:47`.
- `frontend/src/pages/profile.js:226` — `paper.discipline` + `capitalize` → `titleCaseDiscipline(paper.discipline)`.

**Flagged (1 site, NOT migrated): `frontend/src/pages/search.js:94`.** Task description labels this as a "search-result row discipline label", but the line actually renders a result-type badge using `badge-discipline` styling — the `x-text` is `$t(result.type === 'review' ? 'search.typeReviews' : 'search.typePapers')`, i.e. a translation key for "Reviews"/"Papers". Search results have no `result.discipline` field (verified via `grep -n "result\." src/pages/search.js`). Wrapping a translated, already-cased string in `titleCaseDiscipline()` would be semantically wrong (it expects a canonical lowercased discipline name). Architect choice: (a) drop just the redundant `capitalize` class on this badge, (b) drop the whole `badge-discipline` class (it was likely copy-pasted styling), or (c) leave as-is and amend the task scope to exclude this site. Default reading: option (a) — drop only `capitalize` — but flagging for explicit triage.

**Factory-exposure tests added (2 of 4 needed for full coverage):**
- `tests/unit/pages-paper-detail.test.js` — new `factory exposes titleCaseDiscipline` describe block asserting `comp.titleCaseDiscipline === <imported helper>` (identity-equal).
- `tests/unit/pages-profile.test.js` — same shape.

The other two factories (`paper-feed`, `search`) already expose the helper (from FE-DISCIPLINE-DISPLAY-HARDEN). Their factory-exposure specs are tracked under the FE-DISCIPLINE-DISPLAY-HARDEN round-1 hold task (`ui-discipline-display-harden.md`), not duplicated here.

**Verification:**
- `grep -rn 'capitalize.*discipline\|discipline.*capitalize' src/` returns only the flagged `search.js:94` line. The acceptance grep is otherwise clean for the migrated sites.
- `npx vitest run` → 995/995 pass (was 993; +2 factory-exposure specs).
- `npm run build` → clean.

---

**Architect re-review (2026-04-28) — HELD PENDING FIXES (round 1):**

Round-1 `/ce-code-review` on commit `fd315fe` (6 personas: correctness, testing, maintainability, project-standards, agent-native, learnings). 2 hold items below; out-of-scope items dismissed; cluster-wide learning deferred.

1. **P1 — `frontend/src/pages/researchers.js:73` is a 6th discipline render site missed by the acceptance grep** (maintainability MAINT-DISCIPLINE-MIGRATION-INCOMPLETE 0.90). Line 73 renders `r.field` (researcher accreditation field, fed by the same backend column `accreditations.ts:52` `cj.json::jsonb ->> 'field'` as the `profile.accreditation.field` sites this commit DID migrate at `profile.js:47/73`). Same canonical concept, same pre-migration `class="capitalize"` pattern, but the implementer's acceptance grep `grep -rn 'capitalize.*discipline|discipline.*capitalize' src/` did NOT match because this site uses `r.field`, not `discipline`. After this commit, `/profile/<user>` correctly title-cases via the helper while `/researchers` still shows the broken `'Theory Of Computation'` / `'Ml'` form via the CSS hack — exactly the inconsistency this task was filed to eliminate.

   Required fixes:
   - Migrate `frontend/src/pages/researchers.js:73` — `r.field` + `class="capitalize"` → `titleCaseDiscipline(r.field)`, drop only the `capitalize` token (preserve other classes).
   - Add `import { titleCaseDiscipline } from '../lib/discipline-display.js'` (or whatever the relative path is from `pages/researchers.js`) at the top of the file.
   - Expose `titleCaseDiscipline` on the Alpine `researchersPage` factory (or whatever the factory is named).
   - Add a factory-exposure regression spec at `frontend/tests/unit/pages-researchers.test.js` matching the pattern in `pages-profile.test.js:59-64` (or equivalent in the sibling specs): `expect(comp.titleCaseDiscipline).toBe(titleCaseDiscipline)` (identity-equal).
   - **Widen the acceptance grep** before re-review signal: instead of `grep -rn 'capitalize.*discipline|discipline.*capitalize' src/`, use `grep -rn 'class="[^"]*capitalize[^"]*"' frontend/src/` and verify every remaining match is intentionally NOT a discipline-shaped field (or migrate it). Document the per-line reasoning for any retained `capitalize` matches in the re-review signal block so the next round does not have to re-derive it.

2. **P2 — `frontend/src/pages/search.js:94` — drop `capitalize` only (architect's decision baked in)** (implementer-flagged + maintainability MAINT-SEARCH-BADGE-DISCIPLINE-MISUSE 0.85). The implementer correctly refused to wrap this in `titleCaseDiscipline()` — verified via grep that `result.discipline` does not exist on search result entries; the line renders a translation-keyed result-type label (`$t('search.typeReviews|Papers')`), not a discipline. **Architect choice: option (a) — drop only the `capitalize` token, preserve `badge-discipline` styling.** Smallest blast radius. The `badge-discipline` class is being applied to a non-discipline element (a copy-paste styling smell), but addressing that is a separate visual-design concern; it does NOT belong in a discipline-canon migration task. i18n strings are author-cased at source; `text-transform: capitalize` is at minimum a no-op for English and risks mangling in other locales.

   Required fix:
   - At `frontend/src/pages/search.js:94`, drop only the `capitalize` token from `<span class="badge-discipline capitalize" x-text="$t(...)">`. Preserve `badge-discipline`. No factory exposure needed (no helper invoked).
   - Update the task body's "Migrated (4 sites)" / "Flagged (1 site)" disposition to reflect the final outcome: the original task description's "5 sites" was wrong; `search.js:94` is intentionally a `capitalize`-class drop (not a `titleCaseDiscipline()` wrap), and `researchers.js:73` joins as the actual 5th site.

**Dismissed from round-1 findings (architect triage):**
- **P3** Factory-exposure specs check identity-equality only; no spec verifies the helper is actually invoked from the rendered template (testing 0.75, also flagged on the sibling FE-DISCIPLINE-DISPLAY-HARDEN round-2 0.75). Cluster-wide gap, not regression-from-this-commit. The Playwright e2e suite covers this probabilistically; deterministic template-mounting tests would be substantial new test infrastructure (jsdom + Alpine init + template parse) and merit deliberate UI-agent buy-in, not a unilateral hold-block. Captured as a compound-engineering candidate; deferred to `/ce-compound` post-archive.
- **P3** Transitive coverage assumption for `paper-card.js` (testing 0.60). `paperCardTemplate` is consumed only at `paper-feed.js:78`; the parent factory exposes the helper. Consumer set is small today; structural contract documented in this task's body. Below gate.

**Cluster-wide learning surfaced (deferred to `/ce-compound` post-archive, not a hold item):**
- "Alpine factory must expose every imported helper used in template expressions." Factory-exposure specs guard the binding-missing failure mode (silent ReferenceError at `x-text` evaluation), not the template-expression-mutation failure mode. The four parallel factory-exposure specs (paper-feed, search, paper-detail, profile) are uniform but cover only the binding axis. A future migration of this shape should consider whether template-mounting tests are warranted at the same time.

**Path to re-archive:** (1) UI applies items 1 + 2 on this task. (2) UI re-review signal block below the hold. (3) Architect re-reviews round-2 with `/ce-code-review` and archives on clean.

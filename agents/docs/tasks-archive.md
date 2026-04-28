## BE-PROFILE-PAPER-DISCIPLINE-CANON (archived 2026-04-28) — Round-2 clean ✓

# BE-PROFILE-PAPER-DISCIPLINE-CANON — Route `toPaperSummary` discipline through `paperDisciplineField()`

**Owner:** backend
**Created:** 2026-04-28 (surfaced by BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME review, correctness + maintainability cross-reviewer)
**Priority:** P2

## Context

BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME (commit `9882573`) introduced `paperDisciplineField(raw: string | null | undefined): string | null` in `backend/src/types/disciplines.ts` and routed all three response-shaping sites in `backend/src/routes/papers.ts` (list mapping, continuation-chain head-override, `buildPaperDetail`) through it. The helper's JSDoc states explicitly: "Every response-shaping site that surfaces a paper's discipline must route through this so future drift becomes a type-check failure at the helper call site, not a whack-a-mole across routes."

One out-of-boundary site was deliberately left unrouted by the implementer (flagged in the task signal block):

- `backend/src/helpers.ts:98` — `toPaperSummary()` builds `discipline: (pevo.discipline as string) || ''`.
- Consumer at `backend/src/routes/profile.ts:238` — `/api/profile/:account` papers list.

After this commit, `/api/papers` list+detail return canon_name lowercased. `/api/profile/:account/papers` still surfaces on-chain casing. Same field name, divergent normalization. A client round-tripping a paper's `discipline` back through `?discipline=` sees inconsistent canon-vs-echo behavior across endpoints.

## Goal

Route the profile-papers `discipline` field through `paperDisciplineField()` so `/api/profile/:account/papers` matches the `/api/papers` canon contract.

Mechanical blocker: `PaperSummary.discipline` is typed `string` (not `string | null`). Two fix shapes:

- **(a) Widen the type** to `string | null` and update consumers downstream (frontend renders fine on null per the existing `paper.discipline` capitalize sites — those sites are also being migrated under `ui-discipline-display-harden-paper-render-sites.md`).
- **(b) Coalesce at the boundary** — `discipline: paperDisciplineField(pevo.discipline) ?? ''` keeps `string`; preserves the historical "absent → empty string" shape.

## Recommendation

**(b) Coalesce at the boundary.** Less downstream churn; the helper's null-vs-empty distinction is a return-shape preference of the helper, not a contract on `PaperSummary.discipline`. Frontend + bridge consumers already treat `''` as absent.

The `as string | null | undefined` cast on the helper input becomes redundant if/when BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME round-2 hold #2 (widen helper to `unknown`) lands; coordinate.

## Tests

Real-HAF spec in `backend/tests/routes/profile.test.ts` (or wherever `/api/profile/:account/papers` is exercised): assert each `paper.discipline` in the response is its own lowercased form (mirrors the parallel spec on `/api/papers`).

Mocked-pool carve-out: seed a paper row through `toPaperSummary` with `pevo.discipline = '  Computer Science  '`, assert response `discipline === 'computer science'` (or `''` if you prefer the absent-coalesce path; pick one and pin it).

## Acceptance

- `toPaperSummary` routes `pevo.discipline` through `paperDisciplineField()`.
- `/api/profile/:account/papers` response canon-lowers each paper's `discipline` field.
- Test coverage matches the `/api/papers` canon coverage (real-HAF parity + mocked-pool deterministic pin).
- `agents/docs/api-contracts/profile.md` (if it exists) gets a parallel field note. (Architect-owned; flag via `[TODO Architect]` if needed.)

---

## Implementer re-review signal (2026-04-28, backend) — round 1

**Decision:** picked option (b) "Coalesce at the boundary" per the architect's recommendation in the task body. `PaperSummary.discipline` stays typed as `string` (not widened to `string | null`); the call site coalesces with `?? ''` to preserve the historical "absent → empty string" shape. Less downstream churn, no consumer migration needed.

**Code change** (`backend/src/helpers.ts`):
- Added `import { paperDisciplineField } from './types/disciplines.js'` (the helper was widened to `unknown` parameter in BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME round-2 commit `6e7a43f`, so the call site needs no cast).
- Replaced `discipline: (pevo.discipline as string) || ''` at line 113 with `discipline: paperDisciplineField(pevo.discipline) ?? ''`. The helper trims + lowercases on success and returns `null` for missing/non-string/empty input; `?? ''` collapses null → empty string per the `string` typing of `PaperSummary.discipline`.

**Tests landed:**
- `backend/tests/routes/profile.test.ts` (real-HAF) — added a parity assertion under the existing `GET /api/profile/:username/papers` describe block. For each paper in the response, `paper.discipline === paper.discipline.toLowerCase()`. Vacuous on all-lowercase corpus (acknowledged in the test docstring), but pins the response shape so a regression that bypasses the helper surfaces here. The mocked-pool sibling test exercises the trim+lowercase transform deterministically.
- `backend/tests/routes/disciplines-canon-mocked.test.ts` (mocked-pool) — new spec in the existing `GET /api/search` cache-key describe block: seeds a paper row through the `fetchUserPapersFromHaf` SQL with `pevo.discipline = '  Computer Science  '` (whitespace-padded mixed case), asserts response `discipline === 'computer science'`. Mocks both halves of the count + data Promise.all by SQL-shape filtering on `FROM user_papers` + `count(*)::int AS total` vs. `ORDER BY`.

**Tests run** (with docker-IP env overrides per CLAUDE.md):
- `tests/routes/disciplines-canon-mocked.test.ts` → 20/20 passed (was 19; +1 new case).
- `tests/routes/profile.test.ts` (real-HAF) → 5/5 passed (was 4; +1 new case).
- `npm run lint` clean (2 pre-existing warnings on `seed-phrase.ts`, unchanged).

**Coordination note:** the helper-input cast (`as string | null | undefined`) that the original task body called out as redundant once BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME round-2 hold #2 lands has indeed been collapsed — the call site is simply `paperDisciplineField(pevo.discipline)` with no cast. The architect's "coordinate" note in the task body has been honored.

### [TODO Architect]

**Contract update needed (architect-owned, before archive):**
- `agents/docs/api-contracts/profiles.md` — the contract file exists (verified via `ls`). The per-paper `discipline` field on the `GET /api/profile/:username/papers` response shape needs a parallel field note matching the one already added to `papers.md` in BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME round-2:
  > `discipline` is canon_name (lowercased + trimmed); matches `/api/disciplines.canon_name`, round-trippable through the URL filter; absent values surface as `''` (`PaperSummary` types `discipline` as `string`, not nullable).

---

**Architect re-review (2026-04-28) — HELD PENDING FIXES (round 1):**

Round-1 `/ce-code-review` on commit `fa7db9b` (7 personas: correctness, testing, maintainability, project-standards, kieran-typescript, agent-native, learnings). 1 P2 hold item; out-of-scope items filed as separate Pending task; dismissed items enumerated at end.

1. **P2 — Move new spec to the correct describe block** (testing T1 0.90 + maintainability 0.90, 2-reviewer convergence). The new `it('GET /api/profile/:username/papers — toPaperSummary canon-lowers + trims whitespace-padded mixed case to canon')` block was appended at `backend/tests/routes/disciplines-canon-mocked.test.ts:806` INSIDE `describe('GET /api/search — ?q= LIKE-escape SQL contract (BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP)')` (which starts at line 739). The natural home is the existing `describe('per-paper "discipline" response field — canon_name (lowercased) via paperDisciplineField()')` block at line 449, which already houses the parallel `/api/papers` list / detail-chain-1 / detail-chain>1 head-override canon specs. Position the moved spec as the 4th case so the four parallel specs read in dependency order: list mapping (`papers.ts:400`) → detail buildPaperDetail (`papers.ts:1005`) → continuation-chain head-override (`papers.ts:613`) → profile-papers (`helpers.ts:113`). Re-run `npx vitest run tests/routes/disciplines-canon-mocked.test.ts` after the move to verify pass count is preserved.

**Architect-side fix-in-place (applied this pass):**
- `agents/docs/api-contracts/profiles.md` — added per-paper `discipline` field note for the `GET /api/profile/:username/papers` response shape, mirroring the one added to `papers.md` in the parallel BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME round-2. Closes the implementer's `[TODO Architect]` flag in the round-1 signal block above.

**Dismissed from round-1 findings (architect triage):**
- **P3** Whitespace-only behavior change (`'   '` collapses to `''` post-helper, was kept verbatim by old `(pevo.discipline as string) || ''`) (correctness, low/no severity, implementer flagged as intended). Architect concurs: this aligns with `/api/papers` canon shape and is the explicit goal of the "coalesce-at-the-boundary" decision. Not a regression.
- **P3** File-header carve-out enumeration not updated for BE-PROFILE-PAPER-DISCIPLINE-CANON (testing 0.80 + project-standards 0.55). The new describe block has its own inline preamble; the in-block preamble already justifies the carve-out adequately. Cosmetic; not blocking.
- **P3** Data-half mock filter `'FROM user_papers' && 'ORDER BY'` not unique across queries fired by `/api/profile/:username/papers` (testing 0.65). The reputation enrichment path matches both fragments but the discipline assertion only depends on the first data-call result; the test is correct today. Below the gate; structural fragility documented in residual_risks for future maintainers.
- **P3** Bridge.ts:351 cast cleanup (kieran-typescript 0.75 cross-task with BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME). Dismissed cluster-wide as P3 cosmetic on a non-response-shaping site (on-chain write); single-site follow-up below file-creation threshold; revisit if a wider `bridge.ts` type-honesty audit surfaces the pattern across multiple sites.

**Filed as separate Pending tasks (out of scope for this hold):**
- `backend-app-ssr-discipline-canon.md` — maintainability P2 finding (conf 85) that `backend/src/app.ts:347` JSON-LD SSR `jsonLd.about = pevoMeta.discipline` bypasses `paperDisciplineField()`, contradicting the helper's "every response-shaping site must route through this" claim. Public surface for academic indexers/search engines. Out of this task's named boundary.

**Cluster-wide learning surfaced (deferred to `/ce-compound` post-archive, not a hold item):**
- Factory-exposure specs guard the helper-binding subclass of silent template failures, not the template-expression-mutation subclass. A revert of `x-text="titleCaseDiscipline(paper.discipline)"` to `x-text="paper.discipline"` (or a typo in the helper name) passes every cluster test. Cluster-wide gap; e2e Playwright is the probabilistic backstop. Not surfaced to this task's hold; captured as compound-engineering candidate.

**Path to re-archive:** (1) Backend applies item 1 on this task. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-2 with `/ce-code-review` and archives on clean.

---

## Backend re-review signal (2026-04-28, working tree → moved to `tasks/review/`) — round 2

**Hold item 1 — APPLIED.** Moved the new `it('GET /api/profile/:username/papers — toPaperSummary canon-lowers + trims (BE-PROFILE-PAPER-DISCIPLINE-CANON)')` block from inside `describe('GET /api/search — ?q= LIKE-escape SQL contract (BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP)')` (was at the misplaced `disciplines-canon-mocked.test.ts:806`) into `describe('per-paper \`discipline\` response field — canon_name (lowercased) via paperDisciplineField()')` (the canon block opening at the original `:449`).

Positioned as the 4th case per architect directive, so the four parallel canon specs now read in dependency order:
1. `:487` — `/api/papers` list mapping (`papers.ts:400`)
2. `:525` — `/api/papers/:author/:permlink` `buildPaperDetail` chain length 1 (`papers.ts:1005`)
3. `:559` — `/api/papers/:author/:permlink` continuation-chain head-override chain length > 1 (`papers.ts:613`)
4. `:653` — `/api/profile/:username/papers` `toPaperSummary` (`helpers.ts:113`) ← moved this pass

The LIKE-escape describe (now at `:783`) retains only its three intended specs (papers-search bind LIKE-escape, papers-search ESCAPE clause, reviews-search ESCAPE clause). Spec body unchanged — pure relocation, no semantic edit.

**Tests run** (with docker-IP env overrides per CLAUDE.md):
- `npx vitest run tests/routes/disciplines-canon-mocked.test.ts` → 20/20 passed (pass count preserved post-move).

---

## FE-DISCIPLINE-DISPLAY-HARDEN-PAPER-RENDER-SITES (archived 2026-04-28) — Round-2 clean ✓

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

---

## UI re-review signal (2026-04-28, working tree)

Round-2 fixes applied per architect hold items 1 + 2.

**Item 1 — `frontend/src/pages/researchers.js:73` migrated (5th discipline render site).**
- `frontend/src/pages/researchers.js:73` — `r.field` + `class="capitalize"` → `titleCaseDiscipline(r.field)`, `capitalize` token dropped.
- Added `import { titleCaseDiscipline } from '../lib/discipline-display.js'` at the top of the file.
- Exposed `titleCaseDiscipline` on the `researchersPage` Alpine factory (sibling to `formatDate`).
- Added factory-exposure regression spec at `frontend/tests/unit/pages-researchers.test.js` (`describe('factory exposes titleCaseDiscipline')`) matching the `pages-profile.test.js:59-64` pattern: `expect(comp.titleCaseDiscipline).toBe(titleCaseDiscipline)` (identity-equal).

**Item 2 — `frontend/src/pages/search.js:94` `capitalize` token dropped (architect option a).**
- `<span class="badge-discipline capitalize" x-text="$t(...)">` → `<span class="badge-discipline" x-text="$t(...)">`. `badge-discipline` styling preserved per architect choice.

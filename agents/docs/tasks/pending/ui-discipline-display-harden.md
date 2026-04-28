# FE-DISCIPLINE-DISPLAY-HARDEN — Title-case disciplines for display; drop client-side lowercase dedup after backend lands

**Owner:** UI Agent
**Priority:** P1
**Created:** 2026-04-21
**Surfaced by:** FE-DISCIPLINE-CASE-NORMALIZE archive review (2026-04-21d).

## Context

FE-DISCIPLINE-CASE-NORMALIZE relies on CSS `text-transform: capitalize` for display, which only titlecases the first letter of each word. Fails for initialisms ("ML" → "Ml", "AI" → "Ai") and titles-with-stopwords ("Theory of Computation" → "Theory Of Computation"). Task claim "display stays titlecased" is only true for simple single-word lowercase disciplines.

## Goal

Replace CSS capitalize with a JS display helper that preserves typographical conventions. Two independent changes:

1. **Display helper.** Add `frontend/src/lib/discipline-display.js` exporting `titleCaseDiscipline(lowercaseName)`. Handle stopwords via a small English list (`of, and, for, in, the, to, a, an`) that stay lowercase when not the first word. Handle initialisms via a known-set lookup (`['ml', 'ai', 'nlp', 'dna', 'rna', 'gpu', 'cpu', ...]`) that render ALL-CAPS. Default: first-letter-of-each-word capitalization. Update consumers in `paper-feed.js` + `search.js` to render options via `titleCaseDiscipline(d.name)` instead of raw `{{ d.name }}` + CSS capitalize.
2. **Drop client-side dedup** once **BE-DISCIPLINE-CANONICALIZE** lands. Switch to the new `{ canon_name, display_name, paper_count }` backend response shape; use `canon_name` as the URL value and `titleCaseDiscipline(display_name)` as the rendered text.

## Non-goals

i18n of the stopword/initialism sets (English-only; future follow-up if non-English disciplines surface). Configurable initialism lists via backend.

## Blocked on

BE-DISCIPLINE-CANONICALIZE (for part 2). Part 1 (the display helper) can land independently.

## Deliverable

Move to Review with helper + 15-20 unit tests (initialisms, stopwords, mixed case, edge cases) + consumer rendering tests.

## UI submission note (2026-04-22)

Part 1 landed in `69ca1ef` + merge `c68b84e`. Helper added at `frontend/src/lib/discipline-display.js`; `components/paper-feed.js` and `pages/search.js` now render via `titleCaseDiscipline(d.display_name)` (both already consume `display_name` from the backend); 21 Vitest cases in `tests/unit/discipline-display.test.js` pass.

Flag for architect: the "Blocked on" claim may be stale. `frontend/src/lib/discipline-filter.js` already consumes the `{canon_name, display_name}` shape BE-DISCIPLINE-CANONICALIZE was supposed to introduce, which suggests that backend work has already landed. Recommend the architect verify before archiving — either (a) Part 2 is already effectively done and the task archives as-is, or (b) Part 2 surfaces as a new follow-up task (drop client-side lowercase dedup, wire remaining consumers to `canon_name` URL value).

---

**Architect re-review (2026-04-28) — HELD PENDING FIXES (round 1):**

Round-1 `/ce-code-review` on commit `69ca1ef` (4 personas: correctness, testing, maintainability, project-standards). 1 P2 hold item; 1 P1 follow-up task filed for the broader render-site scope concern.

Verified Part 2 stale-block premise: `frontend/src/lib/discipline-filter.js` indeed has no client-side dedup loop to retire (post-grep verification by maintainability reviewer); the dropdown OPTION sites in `paper-feed.js` and `search.js` already consume `canon_name` for URL value and `titleCaseDiscipline(display_name)` for render text. Task is effectively complete in its named scope.

1. **P2 — Factory-exposure tests for `titleCaseDiscipline`** (testing 0.75). All 21 unit tests exercise the helper standalone. The diff also exposes the helper on the Alpine data factory at `paper-feed.js:118` and `search.js:182` — without that exposure, the `x-text="...titleCaseDiscipline(d.display_name)..."` template fires a silent ReferenceError at runtime. No test asserts the factory wiring. Add two specs (one per factory) that import the factory function, instantiate it, and assert `factory().titleCaseDiscipline === <imported helper>` (identity-equal to the imported reference). ~5 lines per spec; mechanical.

**Dismissed from round-1 findings (architect triage):**
- **P3** Hyphenated-segment stopword bypass `'state-of-the-art' → 'State-Of-The-Art'` (maintainability 0.85). Behavior covered by JSDoc + tests; inline comment polish not required.
- **P3** `INITIALISMS` set has no documented sync mechanism with backend taxonomy (maintainability 0.75). Manual sync acceptable for a 7-entry English-only helper; bigger restructure (move display_form to backend) deserves its own design discussion if it ever surfaces.
- **P3** Empty-segment hyphen edges (`foo--bar`, `-foo`, `foo-`) untested (testing 0.70). Branch is correctly handled (`capitalizeWord('') → ''`); inputs unrealistic in real discipline names.
- **P3** Stale "Blocked on BE-DISCIPLINE-CANONICALIZE for Part 2" claim (architectural-state). Backend has landed; verified `discipline-filter.js` has no client-side dedup loop to retire; Part 2's named consumers (paper-feed.js + search.js dropdown options) are migrated. Task is effectively complete in its named scope.

**Filed as separate Pending tasks (out of scope for this hold):**
- `ui-discipline-display-harden-paper-render-sites.md` — P1 maintainability finding that 5 other discipline render sites still use `class="capitalize"` against `paper.discipline` (`paper-card.js:16`, `paper-detail.js:266`, `profile.js:47/73/226`, `search.js:94`). The original task scoped only the OPTION dropdowns in `paper-feed.js` + `search.js`; the broader render surface (paper cards, paper details, profile pages, search-result rows) inherits the `'ml' → 'Ml'` and `'theory of computation' → 'Theory Of Computation'` bugs the helper exists to fix. The BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME implementer's prior claim that those sites are "fine because canon-lower input + CSS capitalize works" was incomplete — CSS capitalize handles word-boundary capitalization but not stopwords or initialisms.

**Path to re-archive:** (1) UI applies item 1. (2) UI re-review signal block below the hold. (3) Architect re-reviews round-2 and archives on clean.

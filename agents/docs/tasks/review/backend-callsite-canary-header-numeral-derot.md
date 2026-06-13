# BACKEND-CALLSITE-CANARY-HEADER-NUMERAL-DEROT — drop the duplicated count numerals from the callsite-canary header so the CALLSITES table is the single inventory

**Owner:** backend
**Created:** 2026-06-12 (architect, from the clean round-5 re-review of the papers-listing task; pre-existing structural smell elected at triage as the fix that ends the count-rot class)
**Priority:** P3 (no live defect; the header is currently accurate — this prevents the FIFTH reconciliation round, not a present inaccuracy)

## Problem

The header docblock of `backend/tests/excludeSelfReviewWhere-callsite-canaries.test.ts` restates, in prose, numbers that the `CALLSITES` data table three screens below already encodes: the total SQL-site count, the callsite-file count, and the per-file breakdown. Four consecutive review rounds on the papers-listing task were spent reconciling those prose numerals after they drifted from the table (stale "8 sites"/"8 files" counts, a wrong "three reputation.ts sites" narration, a renamed `expected` field). Prose duplicating derivable data rots every time the data changes; the assertions only enforce the table.

Separately, the same header narrates coordination state: "The architect's hold-block fix recipe asked for runtime SQL inspection via mock-pool." Hold blocks are coordination artifacts; the sentence should describe the design alternative behaviorally, not cite who asked for what in which hold.

## Goal

The header explains WHY the canary exists and HOW it works without embedding any number that restates `CALLSITES` data, and without coordination-state references.

### Suggested approach

- Replace numeral-bearing phrases with table references: "a revert at any callsite listed in `CALLSITES` below" instead of "any one of the 11 SQL sites"; "read each callsite file listed in `CALLSITES`" instead of "each of the 6 callsite files". The per-file scope list (which file contributes which call sites, and why papers.ts contributes 2) is explanatory prose worth keeping — keep the SYMBOL-level explanations, drop the arithmetic narration ("2+2+1+1+1+4 = 11"-style totals) that re-derives the table.
- Reword the "architect's hold-block fix recipe" sentence to a behavioral framing, e.g. "Runtime SQL inspection via mock-pool was considered and ruled out:".
- No assertion, `CALLSITES`, or `minOccurrences` changes. Comment-only.

## Acceptance

- No count numeral in the header prose restates a value derivable from the `CALLSITES` table (greppable check: the header contains no standalone "11", "6 callsite", or per-file sum narration tied to the table's contents).
- No coordination-state reference ("hold-block", round ordinals, task slugs) remains in the file.
- Assertions and the `CALLSITES` table unchanged; canary green.
- Per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`, the replacement prose introduces no fresh slug/line/SHA/round anchor.
- `npm run typecheck` + `npm run lint` clean.

## Cross-references

- `backend/tests/excludeSelfReviewWhere-callsite-canaries.test.ts` (the header + `CALLSITES` table).
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`.
- Archived parent in `tasks-archive.md`: `BACKEND-PAPERS-LISTING-CORRELATED-SUBQUERIES` (rounds 2-5 were all prose-numeral reconciliations).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Backend completion note (2026-06-14)

Header de-rotted: the prose no longer restates any count derivable from the `CALLSITES` table. The "11 SQL sites", "6 callsite files", "five route modules", "That's 11 callsites", "the four reputation.ts sites", and "papers.ts contributes 2 (not 3)" numerals are replaced with `CALLSITES`-table references ("a revert at any callsite listed in `CALLSITES`", "read each callsite file listed in `CALLSITES`") and the kept symbol-level explanations (the `validReviewWhere` composition sites; the listing's combined rev_agg LATERAL is why `papers.ts` pins one combined site rather than one per metric). Coordination-state references removed: the "architect's hold-block fix recipe asked for ..." sentence reworded to a behavioral "Runtime SQL inspection via mock-pool was considered and ruled out:" framing, and "(mirrors the architect's hold-block list)" dropped.

Assertions, the `CALLSITES` table, and `minOccurrences` are unchanged; the canary stays green. Comment-only; the replacement prose introduces no fresh slug/line/SHA/round anchor (greppable check clean: no standalone "11", "6 callsite", per-file sum narration, or "hold-block"/architect/round references remain).

Verification: `npm run typecheck` + `npm run lint` clean (one pre-existing `author-supersession.ts` warning, untouched). The canary itself runs in the parent's post-merge full-suite pass.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

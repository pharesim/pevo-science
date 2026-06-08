# BACKEND-PAPERS-LISTING-VOTES-AGGREGATE-CTE — sort=votes still runs accreditedVoteCount as a per-row correlated subquery

**Owner:** backend
**Created:** 2026-06-06 (split from backend-papers-listing-correlated-subqueries at architect review; the staged-delivery option that task's Notes anticipated)
**Priority:** P2 (sort=votes cold-cache renders only; the default date-sort path is already collapsed)

## Problem

The /api/papers listing's correlated-subquery collapse landed in two arms: review_count + avg_rating merged into one rev_agg LATERAL, and citation counts inverted into the paper_citation_counts CTE. The third arm from the parent task's structural plan did not ship: when `sort=votes`, the `accreditedVoteCount` helper still runs as a per-row correlated subquery over the HAF vote tables (the highest-cardinality tables in the query), so a 20-row cold page render under sort=votes still pays ~20 correlated vote scans.

## Goal

Per the parent task's structural arm: build an accredited-votes aggregate CTE keyed by (page.author, page.permlink), joined ONLY when sort=votes; otherwise omitted entirely.

## Acceptance

- EXPLAIN (ANALYZE) on real HAF for a sort=votes page shows the vote aggregation executing once per request, not once per page row.
- sort=votes ordering matches the previous shape (net_votes parity; canary in the style of review-agg-single-scan.test.ts — import the shared predicate helpers rather than hand-rolling them, per that task's round-1 hold item 3).
- Non-votes sorts do not pay the votes-CTE cost (plan shows the CTE absent or unexecuted).
- Comment anchors on stable symbols. `npm run typecheck` + `npm run lint` clean.

## Cross-references

- `backend/src/routes/papers.ts` — `fetchPapersFromHaf` voteSelect / accreditedVoteCount conditional assembly.
- `backend/src/hafsql.ts` — `accreditedVoteCount` helper.
- `agents/docs/tasks/pending/backend-papers-listing-correlated-subqueries.md` — parent task (held round-1; its hold block records the architect's EXPLAIN evidence for the citation arm).

## [BLOCKED by Architect] (2026-06-09) — premise invalidated by real-HAF EXPLAIN; the CTE is a ~3300x regression, not an improvement

Backend implemented the aggregate CTE exactly as specified (`accreditedVoteCountsCteBody` keyed by (author, permlink), built + LEFT JOINed only when `sort=votes`, parity-pinned vs the correlated form) and ran `EXPLAIN` on the live Mahdi HAF node for both shapes over the same page. The result contradicts the task's structural premise. Reverted the code; nothing landed.

**Why the correlated form is already efficient (unlike the citation arm).** The vote view `hafsql.operation_vote_view` (over `operations`) has an author+permlink index, `hafsql_author_permlink_idx`. The per-row correlated `accreditedVoteCount('c.author','c.permlink')` resolves each paper's votes via an `Index Scan using hafsql_author_permlink_idx` with `Index Cond: author = … AND permlink = …` — a cheap, paper-scoped indexed lookup. The citation arm was a CTE win precisely because reverse-citation ("who cites paper X") has NO index, so its correlated form did a full corpus scan per row. Votes are the opposite case.

**EXPLAIN evidence (plan-only, 2-row page, real HAF):**
- OLD per-row correlated form: total cost ≈ **206,927**; inner scan is `Index Scan using hafsql_author_permlink_idx` (paper-scoped).
- NEW aggregate CTE form: total cost ≈ **691,396,430** (~3300x). The `GroupAggregate` cannot use the author/permlink index because it groups across ALL papers, so it does a `Parallel Seq Scan on operations` over the full vote corpus (~5e8 rows) and a ~1.2e9-row `Sort` for the `DISTINCT ON`. `papers.test.ts` (real-path companion) hung on the `sort=votes` path under this plan and had to be killed.

**Root cause.** ORDER BY net_votes does force net_votes for every paper matching the listing filter, but each is an indexed point-lookup, so the correlated form scales with (matching papers × small indexed scan), whereas the naive aggregate pays one full-corpus vote aggregation regardless of page size. The aggregate only wins when the matching set is large enough that N indexed lookups exceed a full-corpus group-by — not the case for a listing page.

**Options for the architect to decide (not landing any without direction):**
1. **Drop the task.** The correlated form is already index-optimal for `sort=votes`; the parent task's "third structural arm" does not transfer from citations to votes. (Recommended — the EXPLAIN shows no win is available via a standalone aggregate.)
2. **Re-scope to a candidate-paper-scoped aggregate:** add a `candidate_papers` CTE (the listing's filtered set) and aggregate votes only for `(author,permlink) IN candidate_papers` so the index is usable. This is a larger redesign and is unlikely to beat the already-indexed correlated form materially; it trades N indexed subplans for one indexed semi-join + group-by. Needs an EXPLAIN bake-off before committing.

Moving to `blocked/` for the architect to pick (1) or (2), or supply a different target. The acceptance criterion "vote aggregation executing once per request" is technically met by the CTE but at a catastrophic cost, so the underlying goal (faster `sort=votes`) is reversed.

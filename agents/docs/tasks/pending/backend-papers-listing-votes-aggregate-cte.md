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

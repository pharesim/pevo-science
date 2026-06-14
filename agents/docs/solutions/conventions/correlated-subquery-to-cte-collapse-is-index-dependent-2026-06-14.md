---
title: Collapsing a per-row correlated subquery into a corpus-wide aggregate CTE is an index-dependent optimization, not a universal win
date: 2026-06-14
category: conventions
module: backend/src/routes/papers.ts + backend/src/hafsql.ts
problem_type: convention
component: database
severity: medium
applies_when:
  - "Tempted to replace a per-row correlated subquery (a scalar subquery referencing the outer row, or a per-row LATERAL) with a single aggregate/group-by CTE keyed by the page's rows"
  - "Generalizing a CTE-collapse that won on one listing arm to a sibling arm over a different HAF view"
  - "Writing an acceptance bullet that demands 'the aggregate executes once per request, not once per row' without an EXPLAIN bake-off"
  - "Reviewing a perf task whose premise is 'correlated subqueries are slow, collapse them to a CTE'"
tags:
  - performance
  - sql
  - correlated-subquery
  - cte
  - aggregate
  - explain-analyze
  - index
  - haf
related_components:
  - database
---

# Collapsing a per-row correlated subquery into a corpus-wide aggregate CTE is an index-dependent optimization, not a universal win

## Context

The `/api/papers` listing carried several per-row correlated subqueries. Two were successfully collapsed into single-scan CTEs: review_count + avg_rating merged into one `rev_agg` LATERAL aggregate, and reverse-citation counts inverted into a once-per-request `paper_citation_counts` CTE. A third arm — the `sort=votes` `accreditedVoteCount` correlated subquery — was prescribed the same treatment on the assumption that the pattern transfers.

It does not. The implementer built the aggregate CTE (`accreditedVoteCountsCteBody`, keyed by `(author, permlink)`, joined only when `sort=votes`) and ran EXPLAIN on the live HAF node for both shapes over the same page. The aggregate CTE was a **~3300x regression**, not an improvement, and the real-path test hung under its plan.

## Guidance

Before collapsing a per-row correlated subquery into a corpus-wide aggregate CTE, EXPLAIN **both** shapes on real data. The collapse is a win only when the correlated per-row probe **lacks a selective index** (so each per-row evaluation is forced into a scan); it is a **regression** when the probe is already an indexed point-lookup over a **bounded** page set.

The deciding question: does the per-row probe have an index that turns it into a cheap point-lookup?

- **No index on the probe** (the win case): the correlated form does a full scan per row — N rows times a corpus scan. A single corpus-wide aggregate computed once beats N scans. This is why the reverse-citation arm collapsed cleanly: "who cites paper X" has no reverse index, so the correlated form scanned the whole corpus per row.
- **Selective index on the probe** (the regression case): the correlated form is N cheap indexed point-lookups, and N is bounded by the page size. A naive aggregate CTE that groups across the WHOLE table cannot use the per-row index (it is grouping, not probing), so it pays one full-corpus group-by regardless of page size — which is far more work than N indexed lookups. This is the votes case: the vote view has an author+permlink index, so the per-row `accreditedVoteCount(author, permlink)` is an `Index Scan` point-lookup.

## Why This Matters

EXPLAIN evidence from the votes arm on the live HAF node, same page:

- **Correlated form:** total cost ~206,927. The inner scan is `Index Scan using hafsql_author_permlink_idx` with `Index Cond: author = ... AND permlink = ...` — a paper-scoped indexed point-lookup per row.
- **Aggregate CTE form:** total cost ~691,396,430 (~3300x). The `GroupAggregate` cannot use the author/permlink index because it groups across ALL papers, so it falls to a `Parallel Seq Scan` over the ~5e8-row vote corpus plus a ~1.2e9-row `Sort` for the `DISTINCT ON`. The real-path test hung under this plan and had to be killed.

The general trap: "correlated subqueries are slow, collapse them into a CTE" reads as a universal optimization, and it transferred convincingly from one listing arm to another in the same file. But `ORDER BY net_votes` forcing the metric for every matching paper scales with (matching papers x small indexed scan) when the probe is indexed — which beats one corpus-wide group-by for any bounded page. The aggregate only wins when the matching set is large enough that N indexed lookups exceed a full-corpus group-by, which a listing page never is.

## When to Apply

Whenever a perf task or review proposes replacing a per-row correlated subquery / per-row LATERAL with a page-keyed aggregate or group-by CTE over a HAF view. Check whether the correlated probe is index-backed first; if it is, the correlated form is likely already optimal for a bounded page and the collapse is a pessimization. Treat "the aggregate executes once per request" as necessary-but-not-sufficient: once-per-request at corpus-scan cost is worse than N-per-page at indexed-lookup cost. Always EXPLAIN both shapes on real data before committing — and record the EXPLAIN verdict durably (the plan files are ephemeral). A candidate-paper-scoped aggregate (group only over the page's filtered key set, so the index is usable) is the middle option, but it trades N indexed subplans for one indexed semi-join + group-by and rarely beats the already-indexed correlated form materially — bake it off before assuming it helps. Note that HAF indexes are fixed external infrastructure and cannot be added to make a chosen shape faster.

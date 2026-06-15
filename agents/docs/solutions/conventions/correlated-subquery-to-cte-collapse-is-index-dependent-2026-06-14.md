---
title: Collapsing a per-row correlated subquery into a corpus-wide aggregate CTE is an index-dependent optimization, not a universal win
date: 2026-06-14
last_updated: 2026-06-15
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

## Follow-on: batching ONLY the revote arm is the safe inverse case (and its votes-sort hazard)

The guidance above keeps the **native** vote arm per-row index-backed. The **revote** arm of `accreditedVoteCount` (the `custom_json`-namespace form that takes an app-tag param) is the opposite case, and it IS a legitimate batch candidate once scale demands it. Its only index-backed predicate is `custom_id`; the residual filter on the JSON-extracted `author`/`permlink`/`action` is a scan. While the APP_TAG `custom_json` namespace stays small (accreditations + vouches + revotes + param-updates, platform-wide) that residual is sub-ms; once it grows, the per-row revote subquery becomes an O(namespace × rows) cost on the per-row callsites — most exposed: the comment-tree walk (`fetchCommentsTreeFromHaf`, no LIMIT, depth-bounded) and the paper-detail enrichment reviews-list (inside `fetchEnrichmentFromHaf`'s walker time budget).

The correct optimization is to collapse ONLY the revote arm to a single `custom_id = <app_tag> AND action = 'revote'` scan per request plus a JS latest-signal-per-`(voter, author, permlink)` merge. This does NOT contradict the index-dependence rule above: the regression case was collapsing the **native** arm (an indexed point-lookup); the revote arm's residual is NOT index-backed, so one corpus scan + a JS merge beats N residual scans. The proven shape already exists in the same codebase — `batchResolveVotes` (one native scan + one revote scan per request, merged in JS) and the `revoteMap` block inside `fetchEnrichmentFromHaf`.

**Watch-out — the votes-sort path does not convert cleanly.** The profile votes-sort callsite lets Postgres `ORDER BY net_votes` reflect revotes *inside SQL*, with correct `LIMIT`/`OFFSET` pagination. A JS revote merge breaks SQL-side ordering: the revote-adjusted count is no longer a column the `ORDER BY` can key on. Converting it requires either (a) fetch-all → merge → sort → slice in JS (which forfeits SQL pagination), or (b) a precomputed revote-adjusted-count CTE the `ORDER BY` keys on. Resolve this before converting the votes-sort path, or leave that one callsite on the per-row helper if it stays cheap. The other revote-aware callsites (single-doc reviews, the comment-tree walk, the enrichment reviews-list) carry no SQL-side ordering dependency and convert cleanly.

This is why the batched form is a deferred optimization rather than the shipped default: the per-row helper is correct and sub-ms at current scale (single-digit namespace, near-zero revotes), and the votes-sort ordering hazard makes a blanket conversion non-trivial. Trigger the batch only when an EXPLAIN shows the revote `custom_json` scan dominating one of the per-row endpoints, or the enrichment endpoint brushes its walker time budget. The durable in-code pointer is the `PERF / scaling note` in `accreditedVoteCount`.

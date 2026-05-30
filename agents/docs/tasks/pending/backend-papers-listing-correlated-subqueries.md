# BACKEND-PAPERS-LISTING-CORRELATED-SUBQUERIES — up to 80 correlated HAF subqueries per page on cold cache

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #11 high severity, performance)
**Priority:** P1 (every refresh and every cold cache key combo pays the full 80-subquery cost)

## Problem

The data SELECT in [routes/papers.ts:1060-1108](backend/src/routes/papers.ts#L1060-L1108) inlines four scalar subqueries per page row:

1. `accreditedVoteCount`
2. `reviewCount`
3. `avgRating` (two near-identical scans over the same accredited-review row set)
4. `citationCount` (a jsonb containment scan over the entire `pevotest` paper corpus)

A 20-row page = up to 80 correlated subqueries on multi-million-row HAF tables. SWR caching absorbs steady-state, but every refresh and every cold cache combo `(page × limit × sort × order × discipline × keyword × author × language × source)` pays the full cost.

## Goal

Collapse the per-row correlated subqueries to a small fixed number of aggregate scans bounded by the page-key set.

### Suggested approach (two staged wins)

1. **Quick (small effort, modest win):** merge `reviewCount` and `avgRating` into ONE correlated subquery returning both aggregates from one scan over the same accredited-review row set.
2. **Structural (large effort, big win):** build the page row set in a CTE, then `LEFT JOIN` three aggregate CTEs keyed by `(page.author, page.permlink)`:
   - One for accredited reviews (count + avg in one CTE).
   - One for accredited votes (when `sort=votes`).
   - One for citations using an inverted CTE that unnests every PEvO paper's `pevo.citations` once and groups by `(cited_author, cited_permlink)`.

Collapses ~60-80 per-row subquery executions to 3 aggregate scans bounded by the page-key set. Citation scan still hits the corpus once, not 20 times.

## Acceptance

- Per-page query plan (verified via `EXPLAIN ANALYZE` on a dev HAF) shows the citation scan happens ONCE per request, not 20 times.
- Existing listing tests stay green; result shape unchanged.
- A cold-cache page render measurably faster (benchmark before/after on a representative `(filter, sort)` combo on dev HAF — note the delta in the completion note).
- The `sort=votes` path still produces correct ordering (the votes aggregate CTE is only joined when sort=votes; otherwise omitted).
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Big finding; split into the two stages if the structural rewrite needs review separately. The quick win (merge reviewCount+avgRating) is small enough to land standalone.
- The citation count's per-row constructed JSONB defeat (rank #23) is subsumed by the structural arm here. If the structural rewrite ships, mark #23's `backend-citation-count-inverted-cte` task as resolved-by-this.
- This is not a route-shape change; it's a query-shape change. Cache invalidation keys do not need to move.

## Cross-references

- [backend/src/routes/papers.ts](backend/src/routes/papers.ts) lines 1060-1108 (data SELECT with inline subqueries), 1101-1108 (citation containment specifically).
- [backend/src/reputation.ts](backend/src/reputation.ts) — the inverted citation aggregation pattern already exists in the reputation cycle; reuse the shape.
- HAF-query review run `w274tijk0` rank #11 (and #23 — subsumable).

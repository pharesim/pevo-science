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

## Architect re-review (2026-06-06) — HELD PENDING FIXES:

`/ce-code-review` (correctness + adversarial on Opus; testing/maintainability/project-standards/performance/learnings on Sonnet) confirmed the rev_agg merge (commit 8c58a7c3) is behavior-preserving: predicate and arithmetic parity verified byte-for-byte against the pre-merge shapes, LEFT JOIN LATERAL row-preservation / param binding / divergence shapes attacked on real Postgres and held. Architect gathered EXPLAIN (ANALYZE, BUFFERS) evidence on real HAF for the citation arm (landed via the sibling citation-count task): the paper_citation_counts corpus subquery executes ONCE per request (Subquery Scan loops=1, Sort-materialized; plan healthy even with the CTE inlined by the PG>=12 planner — no MATERIALIZED pin needed). Five items before archive:

1. **Failing companion canary — suite red at HEAD.** `tests/excludeSelfReviewWhere-callsite-canaries.test.ts` still requires `minOccurrences: 3` for `src/routes/papers.ts`; the merge consolidated the listing's two call sites into one rev_agg LATERAL, so the actual count is 2 and the assertion fails (verified by running the file). Update minOccurrences to 2, the `callsites` array entry (listing rev_agg LATERAL combined + paper-detail review list), and the header's mirror list of pinned callsites.
2. **Make the clause (c) companion claim true.** `review-agg-single-scan.test.ts`'s header cites `papers.test.ts` as asserting the `review_count` / `avg_rating` envelope fields; it asserts neither, so dropping either column from the listing SELECT passes every real-HAF test. Add `toHaveProperty('review_count')` and `toHaveProperty('avg_rating')` to papers.test.ts's listing structure check.
3. **Canary hardening (one edit).** In review-agg-single-scan.test.ts: replace the hand-rolled `reviewWhere()` predicate replica with imports of `validReviewWhere` / `excludeSelfReviewWhere` from `hafsql.js` (the reputation-paper-reviews-self-exclusion canary already imports them — a helper change must turn this canary red too); add a same-reviewer-second-review corpus row (pins the no-DISTINCT count semantics) and a malformed-rating row (one dimension '6' or missing — pins the `[1-5]` gate staying ahead of the `::float` casts in both shapes).
4. **Completion signal block with rev_agg evidence.** Append a completion note with EXPLAIN (ANALYZE) evidence for the rev_agg LATERAL against real HAF (expected: one indexed parent-pair scan per page row) plus the before/after observation the acceptance asks for. The citation-arm evidence is recorded above. The sort=votes aggregate-CTE arm is split out to `backend-papers-listing-votes-aggregate-cte` (new pending task) and is NOT required here.
5. **Stale anonParam comment.** The comment above the anonParam allocation in `fetchPapersFromHaf` still says it is "only used in SELECT subqueries (review/citation count)"; the citation arm no longer uses anonParam at all and the review aggregate is now the rev_agg LATERAL join. Reword against the current shape.

Dismissed at triage: jsonb_array_length cap on the citations unnest (chain-capped metadata; one scan per request is strictly cheaper than the old per-row form).

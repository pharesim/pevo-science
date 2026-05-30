# BACKEND-SEARCH-COUNT-DATA-WINDOW-FUNCTION — count + data queries duplicate the full CTE chain and WHERE evaluation per request

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #20 medium severity, performance)
**Priority:** P2 (~2× the necessary work on every cache miss)

## Problem

`fetchPapersFromHaf`, `searchPapersFromHaf`, and `searchReviewsFromHaf` in [routes/papers.ts:1114-1141](backend/src/routes/papers.ts#L1114-L1141), [routes/search.ts:119-144](backend/src/routes/search.ts#L119-L144), and [routes/search.ts:231-260](backend/src/routes/search.ts#L231-L260) issue parallel count+data queries — each re-materializes the `active_accreditations + retracted_papers` CTEs and re-evaluates the same complex WHERE.

The `accred_ranked` `ROW_NUMBER OVER PARTITION` scans every accredit/revoke custom_json. ~2× the necessary work on every cache miss.

## Goal

Use a window-function shape (`count(*) OVER ()`) in the data query so total is computed in the same scan.

### Suggested approach

Use `count(*) OVER ()::int AS total` in the data query (already established at [accreditations.ts:75](backend/src/routes/accreditations.ts#L75); match the `dataResult.rows[0]?.total ?? 0` zero-row degrade).

Keep per-site scope rather than fanning out — each site has subtle differences:
- Papers: parent_join differences, multiple SELECT subqueries.
- Search reviews: parent_join structure differs.

## Acceptance

- All three sites use the window-function shape; counts match prior shape exactly (regression test per site comparing old vs new `total` for a representative seed).
- Empty-result page returns `total: 0` correctly (the `?? 0` degrade).
- Pagination semantics unchanged (total drives "next page" / "has more" UI decisions).
- `EXPLAIN ANALYZE` confirms CTEs materialize once per request, not twice.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Interacts with #11 (papers listing N+1) — the structural arm of #11 builds a page CTE; layer this window-function on top.
- Independent of #23 (citation count inverted CTE), but related theme.

## Cross-references

- [backend/src/routes/papers.ts](backend/src/routes/papers.ts) lines 1114-1141.
- [backend/src/routes/search.ts](backend/src/routes/search.ts) lines 119-144, 231-260.
- [backend/src/routes/accreditations.ts](backend/src/routes/accreditations.ts) line 75 (precedent).
- HAF-query review run `w274tijk0` rank #20.

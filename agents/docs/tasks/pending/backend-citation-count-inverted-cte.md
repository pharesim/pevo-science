# BACKEND-CITATION-COUNT-INVERTED-CTE — citation count uses correlated JSONB containment with per-row constructed JSONB

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #23 medium severity, performance)
**Priority:** P2 (N independent full PEvO-paper scans per cold-cache page render)

## Problem

`citationCountSelect` in [routes/papers.ts:1101-1108](backend/src/routes/papers.ts#L1101-L1108) filters with:

```sql
ci.json_metadata -> $appTag -> 'citations'
  @> jsonb_build_array(jsonb_build_object('author', c.author, 'permlink', c.permlink))
```

The contained value is constructed per outer row, defeating constant folding. `@>` on path-extracted JSONB can't use a top-level GIN index even if one existed. Result: N independent full PEvO-paper scans per cold-cache page render.

## Goal

Replace per-row correlated containment with a single aggregate CTE that unnests every PEvO paper's `pevo.citations` once.

### Suggested approach

Add a `paper_citation_counts` CTE that unnests every PEvO paper's `pevo.citations` once and `GROUP BY (cited_author, cited_permlink)`, then `LEFT JOIN` once on the page CTE.

The reputation cycle already does a similar inverted aggregation — reuse the shape.

## Acceptance

- `EXPLAIN ANALYZE` confirms the PEvO-paper corpus is scanned ONCE per request for citation counts, not 20 times.
- Citation counts match the previous shape exactly (regression test comparing old vs new counts for a representative seed).
- Empty-citation papers still get `0` (no row in the CTE → LEFT JOIN NULL → COALESCE to 0).
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- **Best handled as part of #11's structural arm** (`backend-papers-listing-correlated-subqueries`). If #11's structural fix ships, this is subsumed; close this task as resolved-by-#11. Filed standalone in case #11 only ships the "quick" arm (merge reviewCount+avgRating) and defers the structural rewrite.

## Cross-references

- [backend/src/routes/papers.ts](backend/src/routes/papers.ts) lines 1101-1108 (`citationCountSelect`).
- [backend/src/reputation.ts](backend/src/reputation.ts) — sibling inverted-citation aggregation pattern to reuse.
- HAF-query review run `w274tijk0` rank #23.

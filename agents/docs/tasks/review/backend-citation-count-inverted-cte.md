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

## Architect re-review (2026-06-06) — HELD PENDING FIXES:

`/ce-code-review` (9 reviewers) confirmed the inverted CTE (commit 4065e8e6) achieves the structural goal. The EXPLAIN acceptance criterion is now satisfied with architect-gathered evidence on real HAF: the deduped corpus subquery executes ONCE per request (Subquery Scan loops=1, Sort-materialized inner; the PG>=12 planner inlines the CTE but does NOT re-correlate — no `AS MATERIALIZED` pin needed). The "resolved-by-#11" contingency in Notes did not fire: this task's structural arm landed standalone; papers-listing shipped the quick rev_agg arm separately. One item before archive:

1. **Type-coercion parity divergence (reproduced on real Postgres).** The old `@>` containment is JSONB-type-sensitive; the new `cit ->> 'author'` / `cit ->> 'permlink'` extraction text-coerces JSON numbers and booleans. A citation element `{"author":"victim","permlink":123}` broadcast by any accredited account now counts against a real paper `victim/123` where the old shape counted 0 (verified old=0/new=1; all-digit permlinks are valid on Hive). This violates the acceptance's "counts match the previous shape exactly" and is a citation-count inflation vector. Add `AND jsonb_typeof(cit -> 'author') = 'string' AND jsonb_typeof(cit -> 'permlink') = 'string'` to the deduped inner WHERE, and extend the synthetic-VALUES parity corpus with numeric- and boolean-valued citation rows asserting old = new = 0.

## Backend re-review signal (2026-06-06, working tree):

Hold item 1 landed. `npm run typecheck` + `npm run lint` clean; the citation canary suite is green against real HAF.

- **Production guard (`routes/papers.ts`, `paper_citation_counts` deduped inner WHERE):** added `AND jsonb_typeof(cit -> 'author') = 'string'` and `AND jsonb_typeof(cit -> 'permlink') = 'string'`, replacing the strictly-weaker `cit ->> 'author'/'permlink' IS NOT NULL` element checks (a JSON string is non-null, so the typeof guards subsume them — noted in the CTE comment). This restores the old `@>` containment's JSONB-type sensitivity that the `->>` text-coercion had dropped.
- **Behavioral parity (`tests/routes/citation-count-inverted-cte.test.ts`):** extended the synthetic-VALUES corpus with three accredited citers carrying type-confused citation elements — numeric permlink `{"author":"victim","permlink":123}`, numeric author `{"author":456,"permlink":"paper-X"}`, boolean permlink `{"author":"victim2","permlink":true}` — and page targets `victim/123`, `456/paper-X`, `victim2/true`. Both the old `@>` shape and the new inverted-CTE shape assert 0 for all three (no inflation). The accredited-set membership of the new citers proves the type guard, not the accreditation gate, does the exclusion. Mirrored the two guards into the test's `newSql` copy so parity holds.
- **Source-level shape pin:** added an always-runs pin asserting `routes/papers.ts` contains both `jsonb_typeof(cit -> 'author') = 'string'` and `jsonb_typeof(cit -> 'permlink') = 'string'`, so a revert is caught even when HAF is unconfigured and the behavioral canary skips.

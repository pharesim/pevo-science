# BACKEND-SEARCH-TYPE-ALL-TOTAL-TEST — `type=all` search summed-total (`paperTotal + reviewTotal`) is untested

**Owner:** backend
**Created:** 2026-05-30 (review spinoff from `backend-search-count-data-window-function`, archived 2026-05-30; testing reviewer P3, conf 75)
**Priority:** P3

## Problem

The `type=all` search path computes `total = (paperResult?.total ?? 0) + (reviewResult?.total ?? 0)` in `searchPapers` (`backend/src/routes/search.ts`). After the count-consolidation landed (`count(*) OVER ()::int AS total` per branch), no test pins this summed total against non-zero results from both branches. A regression swapping the sum for `Math.max(...)`, or returning only one branch's total, would pass the suite. The existing `search-partial-degradation.test.ts` only asserts `data.length` and warn-event shape, not the summed `meta.total`.

## Goal

Pin the `type=all` summed-total invariant.

### Suggested approach

Add one test to the `type=all` suite that stubs both branches with `total: N` rows (N_papers for the papers branch, N_reviews for the reviews branch) and asserts `res.body.meta.total === N_papers + N_reviews`. Reuse the existing mock shape from `search-partial-degradation.test.ts` (same carve-out applies; document under clause (a) if a new mock is introduced).

## Acceptance

- A `type=all` request with both branches returning non-zero totals asserts `meta.total` equals the sum of the two branch totals.
- Existing `type=all` / partial-degradation tests stay green.
- Comment anchors clean (no slugs/round-numbers/line-numbers/SHAs in test source).
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Spun off so the otherwise-clean count-consolidation could archive without holding on a P3 secondary-path test gap.
- The perf observation from the parent review (`count(*) OVER ()` foreclosing index early-termination on the default date sort) is NOT part of this task — it is a net win at single-instance scale and only warrants an `EXPLAIN` check if listing latency regresses in practice.

## Cross-references

- [backend/src/routes/search.ts](backend/src/routes/search.ts) — `searchPapers` `type=all` total-summation.
- [backend/tests/routes/search-partial-degradation.test.ts](backend/tests/routes/search-partial-degradation.test.ts) — existing `type=all` mock shape to reuse.

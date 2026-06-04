# BACKEND-COMMENTS-TREE-CACHE-CANONICAL-PER-PAPER — recursive comment-tree CTE re-walks the full tree on every page and every 3s block tick

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #19 medium severity, performance)
**Priority:** P2 (any active paper re-walks the tree roughly every 3s per cache-key variant)

## Problem

[routes/comments.ts:115-180](backend/src/routes/comments.ts#L115-L180) builds a recursive `comment_tree` CTE that walks up to depth 20 from the paper root, materializes the full set in `filtered`, then applies LIMIT/OFFSET. The count query duplicates the walk. Cache key fans out across `(paper, page, sort, order, limit)`, and `hafCache` is volatile (block-watcher clears it every ~3s), so any active paper re-walks the tree roughly every 3s per cache-key variant.

## Goal

Cache one canonical tree per paper and do sort/order/slice/enrichment in JS.

### Suggested approach

Cache one canonical tree per paper as `comments:tree:${author}:${permlink}` holding `{rows, total}`. Sort/order/slice/enrichment all happen in JS. Eliminates the duplicate count walk too (`total = rows.length`). One Redis DEL on invalidation instead of N pagination keys.

## Acceptance

- Cache hit rate for an active paper measurably improves under repeated polling (verify on dev with a script or load shape).
- Response shape unchanged from the SPA's perspective.
- Invalidation on a new reply still wipes the canonical key (one DEL).
- Sort orders supported today (newest/oldest/popular?) all produce identical results post-change.
- Pagination correctness preserved (especially edge cases at offset boundaries).
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.
- Redis key prefix `${config.appTag}:` discipline maintained.

## Notes

- Independent of #8 (notifications cache key) but same family of fix.
- Block-watcher invalidation: if the canonical key uses the same volatile-cache layer, this fix's benefit is partially offset. Consider `stable: true` with a short explicit TTL (e.g. 30s) and a precise DEL on new-comment broadcast.

## Cross-references

- [backend/src/routes/comments.ts](backend/src/routes/comments.ts) lines 115-180 (recursive CTE + LIMIT/OFFSET + count duplicate).
- [backend/src/cache.ts](backend/src/cache.ts) — `hafCache` and `stable` flag semantics.
- HAF-query review run `w274tijk0` rank #19.

---

## Architect re-review (2026-05-30) — HELD PENDING FIXES

Round-1 review on commit `b80d1dec`. Response-shape/contract preserved and the count-walk elimination verified. Four items hold archive:

1. **Missing sort tie-breaker → page tearing** (P2, code). `paginateTree`'s comparator has no secondary key, and the recursive CTE has no `ORDER BY`, so tied rows (`net_votes` ties, same-block `created`) keep arbitrary scan order that can differ between the page-1 and page-2 fetches (separate 30s `stable` cache windows) — duplicating one comment and skipping another across pages. The docblock's "deterministic ordering" claim is false. Fix: add `permlink` (then `author`) as deterministic secondary/tertiary tiebreakers applied before the order flip, and correct the docblock.

2. **Sort/pagination tests too weak** (P1, tests). The sort-parity test asserts only SET equality, never ORDER (an inverted asc/desc or a wrong sort key passes). Add: per-variant ordering assertions (`data[i] <= data[i+1]` in the declared direction; asc keys === desc keys reversed); an `offset >= total` case asserting `data:[]` and `meta.total === full count`; and `meta.total === data.length` on a non-empty `limit=200` fetch (the `total = rows.length` invariant is currently pinned only by the 0-comment orphan paper). These are what would catch item 1's regression.

3. **Orphaned task-slug anchor** (P2). The enrichment-map comment cites `BACKEND-REPUTATION-SSOT`, inside the block this commit refactored. Reword to the behavioral statement it stands for ("chain is SSoT; the reputation batch map is a performance cache; a stale entry for a revoked account must not produce a non-zero score").

4. **Type-soundness** (P2). `hafCache.getOrSet(...)` lacks an explicit generic, so the `tree!` non-null assertion discards the null branch rather than the checker enforcing it; use `getOrSet<{ rows: EnrichedComment[]; total: number }>(...)` + a real `if (!tree) return sendError(...)` guard. Also type the row query via `pool.query<RawCommentRow>(...)` with a named interface to drop the unsound `as string`/`as number` casts.

---

## Backend re-review signal (2026-06-04)

All four round-1 hold items landed in `routes/comments.ts` + `tests/routes/comments.test.ts`:

1. **Sort tie-breaker.** `paginateTree`'s comparator now applies `permlink` then `author` as secondary/tertiary keys before the order flip. (permlink, author) is unique per comment, so the comparator is a total order and the whole composite is negated for `desc`, making desc exactly asc reversed. The docblock now documents this and notes the recursive CTE intentionally has no `ORDER BY` (the JS total order fully determines output regardless of scan order, so an SQL sort would only add cost rather than affect correctness).
2. **Sort/pagination tests.** Added three specs: per-variant monotonic-ordering assertions plus `desc === asc reversed` (kills an inverted/wrong sort key, which the prior SET-equality test could not); an `offset > total` case asserting `data:[]` with `meta.total === full count`; and `meta.total === data.length` on a non-empty `limit=200` fetch (the `total = rows.length` invariant was previously pinned only by the 0-comment orphan paper).
3. **Orphaned task-slug anchor.** The enrichment-map comment no longer cites the task slug; it states the behavioral invariant directly (chain is SSoT; the reputation batch map is a performance cache; a stale entry for a revoked/unaccredited account must not surface a non-zero score).
4. **Type-soundness.** `getOrSet<{ rows: EnrichedComment[]; total: number } | null>(...)` plus an explicit `if (!tree) return sendError(503, …, { retriable: true })` guard (no `!` assertion, so the checker enforces the null branch). The row query is typed via `pool.query<RawCommentRow>(...)` with a named `RawCommentRow` interface (`accredited_votes` is `::int` → JS number), dropping the `as string`/`as number` casts.

Verified: `comments.test.ts` green against real HAF; `npm run typecheck` + `npm run lint` clean. Response shape unchanged.

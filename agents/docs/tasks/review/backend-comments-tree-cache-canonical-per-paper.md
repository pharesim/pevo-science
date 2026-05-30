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

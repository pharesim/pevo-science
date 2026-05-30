# BACKEND-NOTIFICATIONS-BLOCK-CURSOR-BOUNDARY-DROP — strict-greater cursor with LIMIT cut mid-block silently drops boundary-block events

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #9 high severity, correctness)
**Priority:** P1 (chain has the events; the feed/digest never re-fetches them)

## Problem

All UNION arms in [notification-queries.ts:186-188, 454-456, 558-565](backend/src/notification-queries.ts#L186-L188) and [digest.ts:170](backend/src/digest.ts#L170) filter `block_num > $2`, `ORDER BY block_num ASC LIMIT $3`, then return `latest_block = max(returned blocks)`. Frontend and digest feed `latest_block` back as the next cursor.

If a single block produces more recipient-relevant events than the remaining LIMIT budget, the **overflow at that boundary block is permanently dropped** — chain still has them, feed never re-fetches them. `has_more` is computed but neither caller consults it.

## Goal

Stop silently dropping boundary-block events. Use `has_more` to either re-fetch the boundary block on the next poll or loop until exhausted, depending on caller.

### Suggested approach

**Smallest fix:** have callers consult `has_more`.

- **Frontend (notifications poll path):** when `has_more === true`, set the next cursor to `latest_block - 1` so the next poll re-fetches the boundary block. The frontend already dedups by `${block_num}_${type}_${actor}_${permlink}` so re-fetch is safe.
- **Digest path:** equivalent dedup is needed, or a same-cursor re-issue loop until `has_more === false` before advancing `last_digest_block`. Simplest correct shape: advance `last_digest_block` ONLY when `has_more === false`.

## Acceptance

- Regression test: seed a block that produces (LIMIT + 5) recipient-relevant events; assert the next poll (with the suggested cursor adjustment) returns the remaining 5 plus dedups the first LIMIT.
- Equivalent test for the digest path: a digest run that hits the boundary advances `last_digest_block` only on the run where `has_more === false`, and the rolled-over events appear in the next digest.
- Existing single-block-within-budget cases unchanged.
- The SPA dedup key continues to suppress re-fetched events from rendering twice.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Interacts with #8: if the cache-key fix drops `sinceBlock`, ensure the in-app filter respects whatever cursor adjustment ships here.
- Independent of #7 (dedup at the SQL layer).

## Cross-references

- [backend/src/notification-queries.ts](backend/src/notification-queries.ts) lines 186-188, 454-456, 558-565 (cursor + has_more emission).
- [backend/src/digest.ts](backend/src/digest.ts) line 170 (digest consumer).
- Frontend notifications poll path (touches `latest_block` consumption — likely `frontend/src/lib/notifications.js` or similar; verify path during implementation).
- HAF-query review run `w274tijk0` rank #9.

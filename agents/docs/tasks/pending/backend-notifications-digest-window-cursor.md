# BACKEND-NOTIFICATIONS-DIGEST-WINDOW-CURSOR — digest re-fires edits of pre-cursor content and drops boundary-block overflow

**Owner:** backend
**Created:** 2026-06-05 (architect review of the notifications group; consolidates the digest-side residue of the edit/revote dedup review with the digest half of the split cursor-boundary task)
**Priority:** P1 (both failure modes amplify into email)

## Problem

Two independent defects in how `runDigest` (backend/src/digest.ts) consumes `fetchNotificationsFromHaf`:

1. **Window-relative dedup re-fires.** The per-arm DISTINCT ON dedup in `notification-queries.ts` deduplicates only among rows above the `$2` floor the caller passes. The digest passes `last_digest_block` as that floor, so an edit or revote landing after the last digest of content published before it has no publication row to lose against — it becomes the sole member of its dedup group and re-fires. Every digest cycle emails a duplicate line per edit of pre-cursor content. This is the original edit-spam bug surviving on the digest path; the SPA route already escaped it by computing the batch against a wide window floor (chain head - 100k) and applying the cursor in-app (`applySinceBlockFilter` in routes/notifications.ts).

2. **Boundary-block overflow drop.** The digest advances `last_digest_block` unconditionally after a run. When a single block produces more recipient-relevant events than the LIMIT budget, the batch is cut mid-block, `has_more` is emitted but never consulted, and the overflow events are permanently skipped — chain has them, no future digest re-fetches them.

## Goal

Make the digest consume the batch the same way the SPA route does, and never advance the cursor past undelivered events.

### Suggested approach

- Call `fetchNotificationsFromHaf` with the same wide window floor the SPA route uses (chain head - 100k, genesis-clamped), not `last_digest_block`.
- Apply `last_digest_block` as an in-app cursor filter over the returned events (mirror the `applySinceBlockFilter` strict `>` semantics; consider extracting/reusing rather than duplicating the filter).
- Advance `last_digest_block` ONLY when the run drained the window: either loop on the batch until `has_more === false` within a run, or advance to the last fully-delivered block and let the next digest resume. Simplest correct shape per the original task: advance only when `has_more === false`.

## Acceptance

- Regression test: publication in digest window N, edit in window N+1 → no duplicate digest line in run N+1.
- Boundary-overflow test: a block producing LIMIT+N recipient-relevant events → run advances `last_digest_block` only when `has_more === false`; rolled-over events appear in the next digest exactly once.
- Existing single-block-within-budget digest cases unchanged.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- The route-side `has_more` recomputation fix (held on `backend-notifications-cache-key-since-block-miss`) does NOT gate this task: the digest consumes `fetchNotificationsFromHaf`'s raw batch `has_more`, which is computed correctly at the SQL layer.
- Wide-floor cost: the digest currently enjoys a narrow scan (`last_digest_block` floor). Moving to the 100k floor makes each digest query as heavy as the SPA refill; digests run far less often than polls, so this is acceptable. Do not reuse the SPA's per-(account,limit) cache for the digest unless it falls out naturally.

## Cross-references

- backend/src/digest.ts (`runDigest`, `last_digest_block` advance).
- backend/src/notification-queries.ts (per-arm DISTINCT ON dedup, `$2` floor semantics, `has_more` emission).
- backend/src/routes/notifications.ts (`applySinceBlockFilter`, the SPA-path precedent for wide-floor + in-app cursor).
- Frontend half of the original cursor-boundary task: `ui-notifications-block-cursor-boundary-rewind` (blocked on the route `has_more` fix).

# UI-NOTIFICATIONS-DROP-REWIND-AND-BLOCK-CAP — remove the cursor rewind; reconcile the client caps with whole-block delivery

**Owner:** ui
**Created:** 2026-06-09 (architect decision from `architect-notifications-block-granular-cursor-stall`, unified root-cause scope)
**Priority:** P2 (paired with `backend-notifications-route-newest-first-whole-block`; completes the stall fix)

## Background

The backend route is moving to **newest-first fetch + whole-block delivery**: every block in a response is now
delivered atomically and `latest_block` is always a complete block. With that guarantee, the SPA's
`latest_block - 1` rewind is no longer needed and is in fact harmful for the single-oversized-block case (it
re-stalls). The client must instead always advance the cursor to `latest_block`. See the archived architect
decision (`architect-notifications-block-granular-cursor-stall`) and the updated `has_more` bullet in
`agents/docs/api-contracts/notifications.md` (2026-06-09).

## Spec (`frontend/src/notifications.js`)

1. **Drop the rewind.** In the poll loop, when `batch.latest_block > cursor`, set the cursor to
   `batch.latest_block` unconditionally. Remove the `batch.has_more ? batch.latest_block - 1 : batch.latest_block`
   branch. Update the comment block above it to describe the new contract (whole-block delivery → advance to
   `latest_block`; no rewind). Anchor on behavioral semantics, not the removed rewind, not line numbers / task
   slugs / SHAs. The authoritative statement is the `has_more` bullet in
   `agents/docs/api-contracts/notifications.md`.

2. **Reconcile `MAX_EVENTS` with whole-block delivery.** A single response may now exceed `limit` (and could in
   principle exceed `MAX_EVENTS = 200` for a citation-fan-out block). Verify the merge + slice
   (`[...batch.events, ...this.events]` then `.slice(0, MAX_EVENTS)`) keeps the **newest** events for display
   rather than silently dropping them: `batch.events` is ascending and is prepended, so a `slice(0, MAX_EVENTS)`
   on the merged array keeps the front (oldest-of-batch) and can drop newer in-memory events. Confirm the
   intended display order and fix the slice direction if it drops newest events. This interaction predates this
   task but whole-block delivery makes an over-`MAX_EVENTS` single response reachable, so it must be confirmed
   here.

3. **Reconcile `seenBlock` / `unreadCount` / `markAllRead`.** `unreadCount` counts `e.block_num > seenBlock`
   over the in-memory events, and `markAllRead` sets `seenBlock = max(block_num)`. If a single response is
   truncated by `MAX_EVENTS`, `markAllRead` could set `seenBlock` past events that were dropped before the user
   saw them, permanently zeroing their unread count. Confirm the behavior is acceptable or guard it (e.g. only
   advance `seenBlock` to the max of events actually retained/shown).

4. **No tight-loop regression.** Confirm dropping the rewind does not convert the cap-top `has_more: true` park
   into a tight re-poll loop. Polling is timer-driven (5-min base), not `has_more`-driven, so it should not;
   confirm the scheduler still gates on the timer only.

## Acceptance

- The poll loop advances the cursor to `batch.latest_block` with no rewind; the comment matches the new
  contract and is anchor-clean.
- `MAX_EVENTS` slice keeps the newest events (verified/fixed) and `markAllRead`/`unreadCount` do not zero
  unread for never-shown events.
- No tight re-poll loop on a persistent `has_more: true`.
- Any existing notifications UI tests updated; manual smoke of the bell feed against the new backend.

## Deploy ordering

Ship **after or atomically with** `backend-notifications-route-newest-first-whole-block`; never frontend-first.
A no-rewind client against the old splitting backend silently loses events on every limit-boundary-split block.
The SPA bundle is served from `backend/public`, so the safe shape is one deploy that swaps both and restarts the
backend.

## Cross-references

- `frontend/src/notifications.js` (poll loop, `MAX_EVENTS`, `seenBlock`/`unreadCount`/`markAllRead`).
- `agents/docs/api-contracts/notifications.md` (`has_more` / `latest_block` bullets, 2026-06-09 contract).
- Paired backend task: `backend-notifications-route-newest-first-whole-block`.
- Origin: the rewind this task removes was added by archived `ui-notifications-block-cursor-boundary-rewind`;
  the redesign supersedes it.

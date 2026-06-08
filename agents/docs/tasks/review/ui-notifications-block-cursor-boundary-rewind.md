# UI-NOTIFICATIONS-BLOCK-CURSOR-BOUNDARY-REWIND — poll() must consult has_more and rewind the cursor at a LIMIT-cut boundary

**Owner:** ui
**Created:** 2026-06-05 (architect split of the cross-zone cursor-boundary task; frontend half)
**Priority:** P2 (silent event drop at high-activity boundaries; backend digest half tracked separately)

## Problem

The notifications poll loop in frontend/src/notifications.js advances its stored cursor to the response's `latest_block` unconditionally. When the backend response carries `has_more === true` (the server's LIMIT cut the batch mid-window), the events beyond the cut are never re-fetched: the next poll's cursor has already advanced past them. Chain has the events; the bell feed never shows them.

## Goal

When a poll response has `has_more === true`, do not advance the cursor past undelivered events: set the next poll cursor to `latest_block - 1` so the boundary block is re-fetched. The SPA dedup key (`${block_num}_${type}_${actor}_${permlink}`) makes the overlap safe to re-render.

## Acceptance

- Unit test (frontend/tests/unit/notifications.test.js): a response with `has_more: true` rewinds the next cursor to `latest_block - 1`; a response with `has_more: false` advances to `latest_block` as today.
- Re-fetched boundary events are deduplicated by the existing SPA key (no double render).
- Comment anchors clean; frontend build green.

## Notes

- Respect the ROUTE-layer `has_more` (the value `applySinceBlockFilter` emits after the in-app cursor filter), not any assumption about the raw SQL batch.

## [BLOCKED by Backend] (2026-06-05) — RESOLVED 2026-06-08 (architect, moved to `tasks/pending/`)

**RESOLVED 2026-06-08.** Both backend hold items this task depends on landed in `backend-notifications-cache-key-since-block-miss` round 2 (2026-06-06): item 1 (window-batch starvation — internal fetch cap decoupled from the response `limit`) and item 2 (`has_more` recomputed as `filtered.length > events.length || batch.has_more`, no longer forced `false` when the in-app cursor filter removes events). The backend re-review explicitly flagged this ui task for unblock (the zone-audit hook blocks backend from moving a `ui-*` file). The route-layer `has_more` emitted by `applySinceBlockFilter` is now a reliable rewind trigger — build the cursor-rewind consumer against it per this task's Notes (respect the route-layer value, not the raw SQL batch). Original blocking detail preserved below.

The route currently recomputes `has_more` incorrectly (forced `false` whenever the in-app cursor filter removes any event), so a rewind consumer built today would never fire. The fix is item 2 of the architect hold on `backend-notifications-cache-key-since-block-miss` (coupled with the window-batch starvation redesign, item 1, which also changes what `has_more` ranges over). The backend agent moves this task to `pending/` when those hold items land, per the note in that hold block.

## UI implementation note (2026-06-08)

Implemented in `frontend/src/notifications.js` poll loop: the cursor-advance now
reads `batch.has_more` and writes `latest_block - 1` when true, `latest_block`
otherwise. Unit coverage added in `frontend/tests/unit/notifications.test.js`
(`cursor update` block): has_more=true rewinds to latest_block-1, has_more=false
advances to latest_block, plus a two-poll case proving the boundary block is
re-fetched on the next poll and the overlap is deduplicated by the existing SPA
key. Full notifications unit suite green (27 tests); frontend build green.

**For architect during review — contract-doc discrepancy:** `agents/docs/api-contracts/notifications.md`
(the `has_more` field-details bullet) instructs clients to "re-poll with
`since_block` = `latest_block`". That advice drops intra-block boundary events:
the route filter is strict `> since_block`, so re-polling at `latest_block` skips
any events sharing `latest_block` that the LIMIT cut. This task (and the
implemented fix) use `latest_block - 1` to re-fetch the boundary block. The
contract file is architect-owned; flagging rather than editing it. Recommend
updating that bullet to `latest_block - 1` (or documenting the rewind) so the
contract and the SPA agree.

## Cross-references

- frontend/src/notifications.js (poll loop, cursor advance).
- backend/src/routes/notifications.ts (`applySinceBlockFilter`, `has_more`/`latest_block` emission).
- agents/docs/api-contracts/notifications.md (cursor and `has_more` contract).
- Backend digest half of the original task: `backend-notifications-digest-window-cursor`.

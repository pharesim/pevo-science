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

## UI implementation note (2026-06-09)

Landed in `frontend/src/notifications.js` (+ `tests/unit/notifications.test.js`). Commit `088890aa`
(code) and this task-file move.

**Item 1 (drop rewind).** The poll loop now `setCursor(username, batch.latest_block)` unconditionally
when `latest_block > cursor`; the `has_more ? latest_block - 1 : latest_block` branch is gone. The
comment block above it describes whole-block delivery (server never splits a Hive block, so advancing
straight to `latest_block` cannot skip intra-block events; a persistent `has_more` drains on the next
timer-driven poll). Anchored on behavioral semantics, no line/slug/SHA references and no `agents/docs/`
path in the production comment.

**Item 2 (MAX_EVENTS + display order) — DECISION, please confirm at review.** The dropdown
(`index.html` notifications `x-for`) renders `events` in raw array order with no reverse/sort. The merge
is `[...batch.events, ...this.events]` (ascending batch prepended). A bare `slice(0, MAX_EVENTS)` keeps
the array front, which for a single oversized whole-block (a citation fan-out >200) is the OLDEST of
that block, dropping the newest. Chosen fix: **only when `deduped.length > MAX_EVENTS`, retain the
newest MAX_EVENTS by `block_num` (sort desc + slice); under the cap, preserve arrival order unchanged.**
This is the minimal, scope-respecting fix: the common (<=200) path keeps its exact current order, so no
product-visible reordering except in the rare over-cap case. I did NOT globally flip the feed to
newest-first (that would fix the pre-existing "newest renders at the bottom of a batch" oddity but is
out of this task's scope). Flag if you'd prefer the global newest-first reorder instead.

**Item 3 (seenBlock).** `markAllRead` still sets `seenBlock = max(block_num of in-memory events)`.
Because item 2 guarantees `events` retains the newest MAX_EVENTS, that max is the newest event the user
could have seen, so advancing `seenBlock` never zeroes unread for a newer-but-dropped event (a drop only
sheds events older than what is retained). Added a comment stating this invariant; no guard needed.

**Item 4 (no tight loop).** Confirmed: `_scheduleNext` is timer-only (`setTimeout(..., _currentInterval)`,
5-min base after success); nothing re-polls on `has_more`. Dropping the rewind cannot create a tight loop.
No change.

**Tests.** `notifications.test.js`: the `rewinds cursor to latest_block - 1` test became
`advances cursor to latest_block when has_more is true (no rewind)`; the boundary-refetch test became
`advances the cursor with no rewind across consecutive polls`; added
`retains the newest events when a single response exceeds the cap` (250-event batch -> keeps blocks
51..250, drops block 1). Full frontend unit suite green (1413 pass; the 3 `pages-edit.test.js`
`_mountEditors` unhandled rejections are pre-existing and unrelated). Build green.

**Deploy ordering (unchanged).** Per the "Deploy ordering" section above, ship after/atomically with
`backend-notifications-route-newest-first-whole-block` (still in `tasks/pending/`); never frontend-first.
NOT manually smoke-tested against the new backend because that route change is not yet deployed; unit
tests mock `fetchNotifications` against the documented (2026-06-09) contract shape.

## Architect review (2026-06-09) — items 1–4 VERIFIED; HELD PENDING ORDERING FIX

Reviewed commit `088890aa` via `/ce-code-review` (8 personas; correctness/adversarial on the session
model). **All four spec items landed and verify against the documented whole-block contract:** the
rewind is dropped (cursor advances to `latest_block` unconditionally), `_scheduleNext` is timer-only
(no tight loop on a persistent `has_more`), the empty-batch cursor advance and the failure/backoff path
are unaffected, and the generation guard / `refresh()` race traced clean. project-standards is fully
clean (anchor-clean comments, no emdash, no new logs). No P0.

**Backend pairing is NOT a hold reason.** The client is correct against the future whole-block backend,
the "never frontend-first" constraint is already documented in this task, and the SPA is served from
`backend/public` (same deploy unit) so atomic co-deploy is the safety mechanism — no code-level
capability flag is wanted. Once the fixes below land and re-review passes, this archives without waiting
for `backend-notifications-route-newest-first-whole-block`.

**HELD PENDING FIXES:**

1. **(P2) Make the feed order consistent — sort newest-first unconditionally** (`notifications.js`,
   your flagged Item-2 decision). Today the over-cap branch sorts descending while the under-cap branch
   keeps arrival order, so one oversized poll flips the feed asc→desc and the next under-cap poll renders
   a mixed `[asc-new, desc-old]` list (4 reviewers independently flagged it). Sort newest-first by
   `block_num` in BOTH cases so the cap becomes a pure tail-trim — drop the size ternary, e.g.
   `this.events = [...deduped].sort((a, b) => b.block_num - a.block_num).slice(0, MAX_EVENTS)`. This also
   fixes the pre-existing "newest renders at the bottom of a batch" oddity. Keep the comment anchored on
   behavioral semantics.
2. **(P3) Narrow the two overclaiming comments.**
   - The `markAllRead`/`seenBlock` comment asserts an unread-integrity guarantee the cap does not
     provide. The code is correct and strictly better than before, but the cap inherently sheds the
     OLDEST-unread events beyond `MAX_EVENTS` (they leave memory and stop counting toward `unreadCount`)
     independent of `markAllRead`. State that honest trade-off instead of "never zeroes unread."
   - The over-cap comment says "retain the newest" — true ACROSS blocks, but a single oversized block
     (> `MAX_EVENTS` events sharing one `block_num`) defeats the `b.block_num - a.block_num` comparator
     (stable no-op → keeps the arrival-order front). The architecture doc
     (`forward-cursor-feed-newest-first-and-rewind-masks-cap-edge`) explicitly defers the
     >cap-for-one-recipient-in-one-block case as a single-instance non-concern, so NO code fix is needed
     — just stop claiming the single-block case is handled.
3. **(P3) Tests.** Add an order assertion to the over-cap test (`store.events[0].block_num === 250`) so
   a regression to ascending / `slice(0, MAX_EVENTS)` fails; add a `toHaveBeenCalledTimes(1)` fence after
   poll 1 in the consecutive-polls test (tight-loop guard); and restore a cross-poll dedup assertion (the
   deleted `remainder` event was the only coverage of merge+dedup across polls under the new cursor
   contract). If fix 1 lands, the order assertion is trivial.

When the fixes land, `git mv` this file back to `tasks/review/`.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## UI re-review signal (2026-06-09, commit 7aacd479 on main)

All three hold-block fixes landed in `frontend/src/notifications.js` (+
`tests/unit/notifications.test.js`).

- **Fix 1 (P2, newest-first feed order).** The merge now sorts the deduped array
  by `block_num` descending and trims to `MAX_EVENTS` on EVERY poll — the
  over-cap-only ternary is gone, so the cap is a pure tail-trim. An oversized
  whole-block poll can no longer flip the list asc<->desc against the next
  under-cap poll, and the pre-existing "newest renders at the bottom of a batch"
  oddity is fixed. The comment is anchored on behavioral semantics (no line/slug/
  SHA references).
- **Fix 2 (P3, narrowed comments).** The `markAllRead`/`seenBlock` comment now
  states the honest bounded-feed trade-off (the cap sheds the OLDEST events
  beyond `MAX_EVENTS`, which leave memory and stop counting toward `unreadCount`
  regardless of `markAllRead`) instead of claiming it "never zeroes unread." The
  merge/sort comment stops claiming the single-oversized-block case is handled:
  it notes events sharing one `block_num` are not separable by the comparator and
  marks that a deferred single-instance non-concern. No code fix for the
  single-block tie case, per the architecture deferral.
- **Fix 3 (P3, tests).** Added the newest-first order assertion to the over-cap
  test (`store.events[0].block_num === 250`); added a new `renders newest-first
  under the cap` test (pins the common-path order against an ascending
  regression); added a `toHaveBeenCalledTimes(1)` tight-loop fence after poll 1
  in the consecutive-polls test; and restored cross-poll merge+dedup coverage —
  the boundary event re-arrives in poll 2 and dedups while a new `remainder`
  event (block 100) merges in and renders ahead of the boundary (block 99).

**Verification.** `tests/unit/notifications.test.js` green — 29 pass (up from 27;
+2 from the new under-cap-order test and the dedup assertions folded into the
consecutive-polls test). Full frontend unit suite + build run at the end of the
UI batch (this is one of three held tasks landing together). Per the "Deploy
ordering" section, ship after/atomically with
`backend-notifications-route-newest-first-whole-block`; never frontend-first. Not
manually smoke-tested against the new backend (that route change is not yet
deployed); unit tests mock `fetchNotifications` against the documented
(2026-06-09) whole-block contract shape.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

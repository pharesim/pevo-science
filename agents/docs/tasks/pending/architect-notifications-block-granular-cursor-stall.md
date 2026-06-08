# ARCHITECT-NOTIFICATIONS-BLOCK-GRANULAR-CURSOR-STALL — block-granular forward cursor can stall when one block exceeds the page limit

**Owner:** architect
**Created:** 2026-06-08 (review follow-up from `ui-notifications-block-cursor-boundary-rewind`)
**Priority:** P2 (latent; unreachable at current beta scale, real failure mode at scale)

## Problem

The notifications cursor is a single Hive block number, and pagination is strict forward (`block_num > since_block`) sliced to the response `limit`. After the rewind fix landed (poll rewinds the cursor to `latest_block - 1` when the route reports `has_more === true`), a new failure mode exists for one input shape: **a single block whose event count for one account exceeds the response `limit` (50)**.

Trace (verified against `backend/src/routes/notifications.ts` `applySinceBlockFilter` and `frontend/src/notifications.js` poll loop):

1. One block `B` alone holds more than `limit` events for the account.
2. The cursor sits at `B - 1` (either initially or after a prior rewind). `filterEventsAfter` keeps all events `> B - 1` (i.e. `>= B`); `slice(0, limit)` returns 50 events all from block `B`. `latest_block = B`, `has_more = true` (`filtered.length > events.length`).
3. The SPA guard `batch.latest_block > cursor` passes (`B > B-1`), so it rewinds: `nextCursor = B - 1`. No net progress.
4. Every subsequent poll repeats step 2-3 identically. The cursor pins at `B - 1`, the same 50 events re-deliver (collapsed by dedup), events 51+ in block `B` never surface, and because the cursor never advances past `B - 1`, **all newer events beyond block `B` are also blocked**. The feed freezes. The response is `status: ok` so the failure-backoff path never engages.

This trades the pre-rewind failure mode (silent drop of the 51+ events, but the feed kept advancing) for a full stall in this tail. Neither pure-rewind nor a client-side force-advance fully resolves it: force-advancing past `B` re-introduces silent drop of the 51+ events. Only finer cursor granularity (or whole-block delivery) eliminates the failure.

## Reachability

Effectively nil in the current accredited single-instance beta: it requires 50+ review/vote/citation/reply events targeting one account inside one 3-second block. Filed as a latent design limit to resolve before any scale-up, not a beta blocker.

## Goal

Decide and document the cursor-granularity fix so a single oversized block cannot stall the feed. Candidate approaches to evaluate:

- **Whole-block delivery**: never let the response `limit` cut mid-block. Deliver all events of the boundary block even if it overshoots `limit` (bounded by the internal fetch cap). The cursor stays block-granular; `has_more` then ranges only over whole undelivered blocks, so a rewind always makes progress.
- **Composite cursor**: `(block_num, intra_block_index)` so the cursor can express "halfway through block B". Larger contract change (affects `since_block` shape, the SPA localStorage cursor, and the digest cursor) and breaks the current integer-cursor API.
- **Raise/derive `limit` for the boundary block only**: weaker; still cappable.

Whole-block delivery is the likely choice (keeps the integer cursor, contained to `applySinceBlockFilter`). Confirm the internal fetch cap (`NOTIFICATION_WINDOW_FETCH_CAP`) bounds the overshoot acceptably, then write the backend implementation task.

## Acceptance

- Design decision recorded (which approach, why) and `agents/docs/api-contracts/notifications.md` updated if the cursor contract changes.
- Backend implementation task filed under `tasks/pending/` with a concrete spec.
- A regression test pins: a single block with more than `limit` events for one account drains fully and the cursor advances past it (no stall).

## Cross-references

- `backend/src/routes/notifications.ts` (`applySinceBlockFilter`, `has_more`/`latest_block` emission).
- `frontend/src/notifications.js` (poll loop cursor rewind).
- `agents/docs/solutions/architecture-patterns/cursor-agnostic-cache-must-dominate-result-set-2026-06-05.md` (the starvation-fix design this stall is the residual tail of).
- Origin: archived task `ui-notifications-block-cursor-boundary-rewind` (review 2026-06-08).

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

---

## DECISION (2026-06-09) — unified root-cause fix; whole-block delivery + newest-first fetch

Scope was widened from the single-block stall to the shared `fetchNotificationsFromHaf` fetch-ordering / `has_more` contract, because adversarial design verification (workflow `wf_182b09cb-09d`) and prior-art tracing showed the narrow framing was both insufficient and dangerous:

- **The narrow "drop the SPA rewind + whole-block delivery at the response-limit edge" plan is strictly worse than the status quo.** The SPA `latest_block - 1` rewind is load-bearing at the *fetch-cap* edge (1000), not just the response-`limit` edge (50). The batch is `ORDER BY block_num ASC LIMIT 1000` (OLDEST 1000 events) with no tie-breaker, so the cap cuts through a block at the batch's newest tail. Dropping the rewind lets the SPA advance past a cap-truncated block → permanent silent skip + multi-day stall. The real residual trigger is "total in-window events > 1000" (normal for an active author), not "one block > 1000 events."
- **Root cause = oldest-first fetch.** A "what's new" feed must fetch newest-first; oldest-first starves any account with >1000 in-window events.
- **Two sibling tasks depend on this decision:** `backend-notifications-cache-key-since-block-miss` (PARKED) documents the route ">CAP window starvation" and asked whoever scopes the redesign to fold it in; `backend-notifications-digest-window-cursor` (BLOCKED, P1 re-send cascade) is explicitly blocked on this task settling "the fetch-ordering + has_more contract for both consumers."

User decisions (2026-06-09): **unified root-cause scope** + **newest-first route fetch**.

### The settled contract for the shared `fetchNotificationsFromHaf`

- Add a deterministic same-block tie-breaker (HAF op `id`, the convention the sibling `backend-window-cte-deterministic-tiebreaker` task established for 10 sites but excluded this query) so the cap cut is reproducible.
- Add a `direction` parameter (`'asc' | 'desc'`); always return ascending events.
- Drop the partial boundary block when the cap was hit, so neither consumer is ever handed a cap-truncated block. `batch.has_more` = cap was hit.
- **Route** consumes `'desc'` (newest-first) + whole-block delivery in `applySinceBlockFilter`; `has_more = filtered.length > delivered.length` (do NOT OR-in `batch.has_more`); client always advances to `latest_block` (rewind removed). Eliminates both the single-block stall and the >CAP starvation; bell-feed history for >cap-events-behind accounts is bounded to the newest `cap` (digest covers the rest).
- **Digest** consumes `'asc'` (oldest-first) + advances `last_digest_block` to the highest delivered block each non-empty run (the partial-block drop makes every delivered block whole, killing the re-send cascade). Does NOT switch to newest-first.
- Cursor stays an integer Hive block number end-to-end.

### Rejected

- **Composite cursor `(block_num, intra_block_index)`** — the only complete fix for a single block exceeding the fetch cap, but it breaks the integer-cursor contract across the API, the SPA localStorage cursor, and the digest `last_digest_block` BIGINT column, and requires an intra-block paging fetch architecture conflicting with the wide-floor cross-window dedup. Its unique trigger (>1000 valid distinct-account events in one 3s block targeting one account) is effectively unreachable at accredited single-instance beta scale. Documented as the escalation path; raising `NOTIFICATION_WINDOW_FETCH_CAP` is the cheap interim knob (LIMIT bounds rows returned, not scanned).
- **Raise `limit` for the boundary block only** — a weaker, still-cappable form of whole-block delivery; subsumed.

### Deploy constraint

Backend-first or atomic; never frontend-first (a no-rewind client against the old splitting backend silently loses events on every limit-boundary-split block). SPA bundle is served from `backend/public`, so swap both and restart the backend together.

### Deliverables (this decision)

- `agents/docs/api-contracts/notifications.md` — `has_more` / `latest_block` / window bullets updated to the new contract (whole-block delivery, always-advance, newest-N window).
- `backend-notifications-route-newest-first-whole-block` (filed in `pending/`) — the route + shared `fetchNotificationsFromHaf` refactor + regression tests.
- `ui-notifications-drop-rewind-and-block-cap` (filed in `pending/`) — drop the rewind + reconcile `MAX_EVENTS` / `seenBlock`.
- `backend-notifications-digest-window-cursor` — `[BLOCKED by Architect]` cause resolved; block re-characterized and kept in `blocked/` gated on the route task landing the shared-function signature change (per the layered-dependency rule), with the settled digest advance contract recorded inline.
- `backend-notifications-route-comment-stale-rewind` (in `review/`) — flagged SUPERSEDED (its docblock describes the rewind this decision removes).

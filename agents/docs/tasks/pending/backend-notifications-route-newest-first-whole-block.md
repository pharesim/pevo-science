# BACKEND-NOTIFICATIONS-ROUTE-NEWEST-FIRST-WHOLE-BLOCK — newest-first fetch + whole-block delivery for the SPA notifications feed

**Owner:** backend
**Created:** 2026-06-09 (architect decision from `architect-notifications-block-granular-cursor-stall`, unified root-cause scope)
**Priority:** P2 (resolves the block-granular stall AND the route-side >CAP window starvation; both currently latent at beta scale, real at scale)

## Background

This is the route-consumer half of the settled fetch-ordering / `has_more` contract for the shared
`fetchNotificationsFromHaf`. The digest-consumer half is `backend-notifications-digest-window-cursor`; both
build on the `fetchNotificationsFromHaf` signature change specified here. See the archived architect decision
(`architect-notifications-block-granular-cursor-stall`) and the `cursor-agnostic-cache-must-dominate-result-set`
solution doc for the why.

Root cause being fixed: `fetchNotificationsFromHaf` fetches `ORDER BY block_num ASC LIMIT <cap>` (the OLDEST
`cap` events above a wide window floor) with **no deterministic tie-breaker**. Two failures follow for the SPA
route:

1. **Single-block stall.** A single Hive block holding more than the response `limit` (50) events for one
   account freezes the feed: the response slices mid-block, the SPA rewinds the cursor to `latest_block - 1`,
   and never advances past that block.
2. **>CAP window starvation.** For any account with more than `cap` (1,000) events in the ~3.5-day window (a
   popular author, or a victim an accredited actor floods with cheap events), the oldest-first fetch never
   materializes the newest events; a caught-up cursor strips the whole cached batch and the bell feed silently
   truncates, parking at the cap-top with `events: []` + `has_more: true`.

A naive "drop the SPA rewind + whole-block delivery at the response-limit edge only" fix is **strictly worse
than the status quo**: the rewind is load-bearing at the *fetch-cap* edge, and removing it lets the SPA advance
past a cap-truncated boundary block, converting the (lossless) stall into a permanent silent skip. This task
therefore fixes the fetch ORDER and the cap edge, not just the limit edge.

## Decision (settled by architect; implement, do not re-litigate)

- The SPA bell feed fetches **newest-first**: it wants the most recent activity; older gaps for very
  high-volume accounts are acceptable and are covered by the email digest.
- The digest keeps **oldest-first** drain (separate task).
- Neither consumer is ever handed a cap-truncated (partial) block: the shared fetch drops the partial boundary
  block when the cap is hit.
- Cursor stays an integer Hive block number end-to-end (no composite cursor). Composite-cursor `(block_num,
  intra_block_index)` is rejected: it breaks the integer-cursor contract across the API, the SPA localStorage
  cursor, and the digest `last_digest_block` BIGINT column, and requires an intra-block paging fetch
  architecture that conflicts with the wide-floor cross-window dedup. Its only unique benefit (a single block
  whose events exceed the fetch cap) is effectively unreachable at accredited single-instance beta scale.

## Spec

### 1. `fetchNotificationsFromHaf` — shared refactor (`backend/src/notification-queries.ts`)

This signature change is the foundation the digest task also consumes; land it here.

- **Add a deterministic same-block tie-breaker.** Project each arm's HAF op `id` (`co.id` for comment-derived
  arms 1a/1b/5/6a/6b, `v.id` for vote arms 2a/2b/2c, `cj.id` for custom_json arms 3/4/7/8/9) as a new selected
  column, and extend the final `ORDER BY block_num <dir>` to `ORDER BY block_num <dir>, id <dir>`. This is the
  same monotonic `id` tie-breaker convention established by the sibling task that landed the 10
  vote/window-CTE sites (which explicitly excluded this notifications query); cite the convention doc
  `agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md`
  Rule 2 in a one-line anchor comment (convention-path anchor only; no task slug / round / line number / SHA).
  Verify every UNION-ALL arm projects an `id` (the three views `operation_comment_view`, `operation_vote_view`,
  `operation_custom_json_view` all expose `id`).
- **Add a `direction` parameter** (`'asc' | 'desc'`) controlling the outer `ORDER BY ... LIMIT` and the
  in-function presentation. `fetchNotificationsFromHaf(account, floor, cap, direction)`. The function ALWAYS
  returns `batch.events` in ascending `block_num` order regardless of direction (the route reverses a `'desc'`
  fetch in-app or via `ORDER BY ... DESC` then a final ascending sort before returning — pick the clearer
  implementation; the returned contract is "ascending events").
- **Drop the partial boundary block when the cap was hit.** Compute `capHit = rows.length >= cap`. When
  `capHit`, the cap cut through the boundary block at the truncated end (the OLDEST block for `'desc'`, the
  NEWEST block for `'asc'`). Remove every event sharing that boundary block's `block_num` so the batch never
  exposes a cap-truncated block. Set `batch.has_more = capHit` (events beyond the cap exist below/above the
  delivered set). Note: dropping the boundary block can in the pathological single-block-exceeds-cap case empty
  the batch; that is the documented residual (see below) and is acceptable.
- Keep the existing 30s-timeout swallow-to-null behavior unchanged.

### 2. Route consumption — newest-first (`backend/src/routes/notifications.ts`)

- The route calls `fetchNotificationsFromHaf(account, windowFloor, NOTIFICATION_WINDOW_FETCH_CAP, 'desc')` so
  the cached batch is the **newest** `cap` events above the floor (presented ascending), with the partial
  oldest (floor) block already dropped by the shared function.
- Rewrite `applySinceBlockFilter` for **whole-block delivery**:
  - `filtered = filterEventsAfter(batch.events, sinceBlock)` (unchanged strict `>`).
  - Pack complete blocks from the oldest undelivered block forward until adding the next whole block would
    exceed `limit`, but ALWAYS include at least the oldest undelivered block in full (so a single block with
    more than `limit` events is delivered atomically rather than split). `latest_block` is the last delivered
    block, now guaranteed whole.
  - `has_more = filtered.length > delivered.length`. Do NOT OR-in `batch.has_more`: under newest-first,
    `batch.has_more` means OLDER events exist below the batch floor, which a forward cursor cannot re-fetch and
    which the digest covers. OR-ing it would re-introduce a permanent `has_more: true` park for cursors behind
    the floor.
  - Empty-filter case unchanged: `latest_block` echoes `sinceBlock`, `has_more: false`.
- Update the `applySinceBlockFilter` docblock: describe newest-first whole-block delivery and the
  "client always advances to `latest_block`, no rewind" contract. Anchor on behavioral semantics, not the
  removed rewind, not line numbers / task slugs / SHAs. The authoritative client-facing statement is the
  `has_more` bullet in `agents/docs/api-contracts/notifications.md` (updated 2026-06-09); keep the comment
  consistent with it. **This supersedes the docblock that `backend-notifications-route-comment-stale-rewind`
  (currently in `review/`) re-wrote to describe the rewind; the rewind is being removed, not re-described.**

### 3. Tests (`backend/tests/routes/notifications-window-cursor.test.ts` + real-path companion)

Update the existing mocked-pool canaries (they currently pin the ASC cap-decoupled-from-limit and
`has_more`-via-`batch.has_more` behaviors) to the new contract, and add:

- **Single oversized block drains (no stall).** A single block with more than `limit` events for the account:
  assert the response delivers the whole block (length may exceed `limit`), `latest_block` is that block, and a
  follow-up poll at the advanced cursor returns the next blocks (cursor advanced past it).
- **>CAP newest-first (no starvation).** A window with more than `cap` events: assert the newest events are
  delivered to a caught-up cursor (not an empty batch), and the cursor advances.
- **Cap-boundary block dropped deterministically.** With the `id` tie-breaker and partial-block drop, the
  batch never ends mid-block; assert no event of a cap-truncated block is delivered and the cursor never
  advances past a partially-delivered block.
- **`has_more` semantics.** `filtered.length > delivered.length` true; the below-floor case does not force
  `has_more: true` forever.
- Tighten the existing `lastNotificationParams[...] >= 500` cap assertion to import the exported constant and
  assert equality (the minor item flagged in the PARKED re-review of
  `backend-notifications-cache-key-since-block-miss`).
- Mocked-pool carve-out: keep the test header's carve-out justification current per CLAUDE.md "Running Tests"
  (acknowledge `MOCK_VERIFY_SIGNATURE` under clause (a); the clause-(c) real-path companion is
  `notifications.test.ts` against real HAF).

### 4. Deploy ordering (hand to user at ship time)

Ship **backend-first or atomically; never frontend-first.** Backend-first is backward-compatible with the
current rewinding SPA (the old client just does one redundant boundary re-fetch, dedup-absorbed) and already
fixes the stall on its own. Frontend-first (new no-rewind JS against an old splitting backend) causes silent
permanent loss on every limit-boundary-split block. Because the SPA bundle is served from `backend/public`, the
safe shape is one deploy that swaps both artifacts and restarts the backend so new JS is only ever served by the
new backend. The paired UI task is `ui-notifications-drop-rewind-and-block-cap`.

## Acceptance

- `fetchNotificationsFromHaf` carries the `id` tie-breaker and a `direction` param, drops the partial boundary
  block on cap-hit, and returns ascending events for both directions.
- The route fetches newest-first; `applySinceBlockFilter` delivers whole blocks and advances cursors with no
  stall on the single-oversized-block case and no starvation on the >CAP case.
- `has_more` is `filtered.length > delivered.length` (not OR-ing `batch.has_more`).
- All four regression cases above pass; the cap assertion asserts equality on the exported constant.
- Docblock and comment anchors clean (behavioral, no rewind description, no line numbers / slugs / SHAs).
- `npm run typecheck` + `npm run lint` clean; `notifications.test.ts` + `notifications-window-cursor.test.ts`
  green.

## Residual (documented, accepted; do not "fix")

After this change the only case the integer-cursor design cannot deliver atomically is a single Hive block
whose recipient-relevant events cannot be wholly contained within one `cap`-event window: either (a) one block
has more than `cap` (1,000) events, or (b) the block sits at the cap-truncation boundary. The partial-block
drop turns this into graceful deferral (the block surfaces once the window floor slides enough to contain it),
not a silent skip. Reachability at accredited single-instance beta scale is effectively nil (the only amplifier,
citation-array fan-out, is capped by the paper-existence INNER JOIN at the victim's real paper count). Cheap
interim knob if per-account per-block volume ever grows: raise `NOTIFICATION_WINDOW_FETCH_CAP` (the SQL `LIMIT`
bounds rows returned, not rows scanned, so the cost is payload/heap, not query time, under the LIMIT-independent
30s statement timeout). Complete fix if it ever becomes reachable: composite cursor + intra-block paging
(rejected now for the contract-break + fetch-architecture cost above).

## Cross-references

- `backend/src/notification-queries.ts` (`fetchNotificationsFromHaf`, `filterEventsAfter`,
  `NOTIFICATION_WINDOW_FETCH_CAP`, `computeNotificationWindowFloor`).
- `backend/src/routes/notifications.ts` (`applySinceBlockFilter`).
- `backend/src/digest.ts` — the other consumer; `backend-notifications-digest-window-cursor` consumes the
  `fetchNotificationsFromHaf(..., 'asc')` signature this task adds. Land that after this signature change or
  coordinate the shared edit.
- `agents/docs/api-contracts/notifications.md` (`has_more` / `latest_block` / window bullets, updated
  2026-06-09 to this contract).
- `agents/docs/solutions/architecture-patterns/cursor-agnostic-cache-must-dominate-result-set-2026-06-05.md`.
- `agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md`
  Rule 2 (the `id` tie-breaker convention).
- Paired UI task: `ui-notifications-drop-rewind-and-block-cap`.

---

## Architect re-review (2026-06-09) — HELD PENDING FIXES

`/ce-code-review` fan-out (correctness + adversarial + security on Opus; performance,
api-contract, reliability, testing, maintainability, project-standards,
kieran-typescript on Sonnet; learnings-researcher) on commit `3591fb46`. Verification
green: typecheck + lint clean, 21/21 tests pass. Implementation matches the settled
decision and both governing solution docs; the op_id tie-breaker, cross-account
isolation, SQL-injection surface, and cache-sharing were all probed and refuted as
risks. Four items block archive:

1. **capHit false-positive boundary-block drop (P2, correctness/Opus).** `capHit =
   result.rows.length >= cap` with a plain `LIMIT cap` fires at *exactly* cap even when
   no truncation occurred, dropping a genuinely-complete boundary block. Under 'desc'
   (SPA) the dropped block is the oldest of the newest-cap set; a forward floor-slide
   never re-includes it (it ages out), so a far-behind non-digest client permanently
   loses that block from the bell feed — a silent skip, not the "graceful deferral" the
   Residual section claims for the 'desc' case. Fix: fetch `cap + 1` (bind $3 = cap + 1)
   and set `capHit = result.rows.length > cap`; the (cap+1)th row's existence is the
   genuine truncation signal. Truncate events back to cap before the sort/boundary-drop.
   Net: an exactly-cap fully-contained batch drops nothing; only a real >cap truncation
   drops the partial boundary block. Update the "Residual (documented, accepted)" section
   so its recovery wording is accurate for newest-first (the dropped oldest block is NOT
   recovered by a forward floor-slide for the SPA; recovery applies only when the
   in-window count later falls below the cap, or via the digest for enrolled users).

2. **Test mock carve-out clause placement (P2, testing + project-standards) — unmet
   acceptance criterion.** The MOCK_VERIFY_SIGNATURE acknowledgment sits under carve-out
   clause (b) in the notifications-window-cursor.test.ts header; CLAUDE.md "Running Tests"
   and this task's own Spec §3 require it under clause (a). Move the bypass acknowledgment
   (cryptographic verification is bypassed + why the focus permits it) into clause (a);
   clause (b) keeps only the positive constraint (auth-focused tests run real verify).

3. **Digest direction='asc' not pinned (P2; five reviewers).** No test asserts the 4th arg
   passed to fetchNotificationsFromHaf from digest.ts. A silent flip to 'desc' would drain
   newest-first and skip in-between events for long-offline users with zero failing tests.
   In digest-window-cursor.test.ts, destructure all four args of the captured call and
   assert direction === 'asc'.

4. **Single-block-exceeds-cap empty-batch deferral untested (P2).** The documented residual
   (all cap rows from one block → boundary-drop empties the batch → events:[], latest_block
   echoes since_block, has_more:false at the route) has no test. Add a mocked-pool case in
   notifications-window-cursor.test.ts pinning it, encoding the behavior as corrected by
   item 1.

Triaged-and-dismissed (do NOT action): the maintainability/readability nits (boundary-end
naming, capHit-empty-branch comment, post-fetch sort comment) — optional polish, dismissed.
The adversarial "digest cascade re-armed" P1 — pre-existing and correctly deferred to
backend-notifications-digest-window-cursor, NOT worsened here.

Architect-side actions taken alongside this hold (not implementer work):
api-contracts/notifications.md `limit` row wording corrected; the digest-window-cursor task
moved blocked→pending now that this commit's shared-function change has landed.

When items 1-4 land, `git mv` this file back to tasks/review/; re-review scopes to the
commits since this hold.

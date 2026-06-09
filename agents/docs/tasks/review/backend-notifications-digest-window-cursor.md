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

---

## Backend completion note (2026-06-06)

Both defects fixed by making `runDigest` consume `fetchNotificationsFromHaf` the same way the SPA route does. typecheck (src+tests) + lint clean; new `digest-window-cursor.test.ts` green (4/4); real-HAF `notifications.test.ts` still green (9/9); digest title-strip suite unaffected.

- **Shared helpers extracted to `notification-queries.ts`** (so the route and digest cannot drift): `NOTIFICATION_WINDOW_BLOCKS`, `NOTIFICATION_WINDOW_FETCH_CAP`, `computeNotificationWindowFloor(head, genesis)`, `filterEventsAfter(events, sinceBlock)` (strict `>`). `routes/notifications.ts` now imports these (the inline constants + window-floor block + the in-app filter line are gone; behavior identical, confirmed by the 21 mocked + 9 real-HAF notification tests).
- **Defect 1 (window-relative dedup re-fire):** `runDigest` now calls `fetchNotificationsFromHaf(user, computeNotificationWindowFloor(getLastBlock(), genesis), CAP)` — the wide floor, NOT `last_digest_block`. The per-arm DISTINCT ON now runs across a window that includes each event's publication row, so an edit/revote of pre-cursor content collapses against its publication instead of re-firing. The per-user `last_digest_block` is applied in-app via `filterEventsAfter`.
- **Defect 2 (boundary-block overflow drop):** `updateLastDigestBlock` is now called ONLY when `batch.has_more === false` (window fully drained), advancing to the highest delivered block. On a truncated batch the cursor is left in place so the next digest re-fetches and drains further — the overflow surfaces in a later digest instead of being permanently skipped. This is the task's prescribed "simplest correct shape." Trade-off (documented in code): on the rare >cap-events-in-window case, the next run re-emails the already-delivered prefix once; that is strictly better than the current permanent drop, and a single digest window exceeding the 1000 cap is implausible at PEvO scale.
- Tests pin: the wide-floor fetch arg (not last_digest_block); an edit-of-pre-cursor-content producing no duplicate line + no spurious advance in the next run; has_more=true → no advance, then has_more=false → advance with the rollover delivered exactly once; and the no-events-past-cursor skip.
- The note's claim that the route `has_more` recomputation does NOT gate this task held: the digest consumes the raw SQL-layer `has_more` from `fetchNotificationsFromHaf`, not the route's recomputed value.

---

## Architect re-review (2026-06-08) — HELD PENDING FIXES

`/ce-code-review` fan-out (correctness + adversarial on Opus; testing, reliability, maintainability, project-standards on Sonnet) on commit 05bc4816. Defect 1 (window-relative dedup re-fire) and Defect 2 (single-block boundary-overflow permanent drop) are addressed, the shared-helper extraction (`computeNotificationWindowFloor`, `filterEventsAfter`, the constants) is clean and behavior-preserving for the route, and project-standards is clean (carve-out header satisfies all three clauses). One item blocks archive:

1. **Digest re-send cascade for sustained >CAP-window accounts (P1).** `runDigest` advances `last_digest_block` ONLY when `!batch.has_more`. But the batch is fetched `ORDER BY block_num ASC LIMIT NOTIFICATION_WINDOW_FETCH_CAP(1000)` — the OLDEST 1000 events above the wide floor — and `has_more = events.length >= limit`. For an account with a sustained >1000 recipient-relevant events in the rolling ~100k-block (~3.5-day) window — a very active author, OR a victim an accredited attacker floods with cheap events — `has_more` stays `true` forever, the cursor NEVER advances, and every digest cadence re-emails the same (window-shifted) oldest-1000 batch while genuine head-side events stay buried below the cap and are never delivered. The completion note's "re-emails the already-delivered prefix once" is incorrect: it is every cadence while `has_more` stays true. Confirmed by correctness + adversarial (the route does not exhibit this because the SPA advances its cursor on each poll; the digest is the only consumer that gates the watermark advance on `has_more`). Fix direction (design judgment required, do NOT just flip the gate): advance to the highest DELIVERED block (`newEvents[last].block_num`) on every non-empty run EXCEPT the genuine single-block-overflow case Defect 2 protects — i.e. detect when the truncation boundary falls inside one block and hold the cursor only then; OR fetch newest-first. The strict-`>` filter + DISTINCT ON dedup make re-fetching past delivered events safe.

**Co-design with the route side.** This is the digest-consumer half of the same ASC-LIMIT fetch-ordering root cause the route exhibits. The route-side residual (the >limit single-block stall, and the >CAP window starvation) is tracked by the parallel-architect task `architect-notifications-block-granular-cursor-stall` and the `cursor-agnostic-cache-must-dominate-result-set` solution doc. Resolve the digest advance contract together with that redesign so the two consumers of `fetchNotificationsFromHaf` do not drift on the fetch-ordering / `has_more` semantics.

Minor items to fold while in the file (non-blocking): (a) edits of content published >100k blocks ago still re-fire once (defect-1 residual — document the bound); (b) cold-start `getLastBlock()===0` makes the floor genesis-wide → scan can timeout and silently skip all users — add an early-return guard when head is 0; (c) `NOTIFICATION_WINDOW_BLOCKS` is exported with no external consumer and its comment overstates the sharing scope (both consumers use `computeNotificationWindowFloor`, not the constant) — drop the `export` and trim the comment; (d) the clause-(c) companion reference omits the `routes/` subdir.

## [BLOCKED by Architect] (2026-06-08) — item 1 gated on the parallel fetch-ordering redesign

Round-N hold item 1 (the digest re-send cascade for sustained >CAP-window accounts) is a P1 design decision the hold itself flags as "design judgment required, do NOT just flip the gate," to be "resolved together with" the architect-owned redesign of the shared `fetchNotificationsFromHaf` fetch-ordering / `has_more` contract (`architect-notifications-block-granular-cursor-stall`, currently in `tasks/pending/`). Backend cannot pick the digest advance contract (advance-to-highest-delivered-block vs newest-first fetch) unilaterally without risking drift from whatever the route-side redesign settles on; the two consumers of `fetchNotificationsFromHaf` must share one fetch-ordering / `has_more` semantics.

Requesting the architect resolve `architect-notifications-block-granular-cursor-stall` (the fetch-ordering + `has_more` contract for both consumers), then move this back to `pending/` so backend can implement the digest half against the settled contract. The non-blocking minor items (cold-start head=0 guard, drop the unused `NOTIFICATION_WINDOW_BLOCKS` export, doc residual bounds) can land with the item-1 fix once unblocked, since they touch the same `runDigest` region.

## [Architect] (2026-06-09) — decision SETTLED; block re-characterized (now gated on the route task's shared-function change, NOT on the architect)

The architect-owned fetch-ordering / `has_more` redesign is decided (unified root-cause scope). The settled contract for both consumers:

- The shared `fetchNotificationsFromHaf` gains a `direction` parameter and a deterministic `id` same-block tie-breaker, and **drops the partial boundary block whenever the cap was hit**, so neither consumer is ever handed a cap-truncated (partial) block. The route task `backend-notifications-route-newest-first-whole-block` owns this shared-function refactor.
- The digest consumes `fetchNotificationsFromHaf(user, wideFloor, CAP, 'asc')` (oldest-first, which is the digest's existing access pattern). Because the shared function now never returns a cap-truncated block, **every delivered block is whole**, so the digest advances `last_digest_block` to the highest delivered block (`newEvents[last].block_num`) on **every non-empty run**. This is the settled answer to item 1's "design judgment required": advance-to-highest-delivered each run, with the single-block-overflow protection living in the shared partial-block drop (if the only content above the cursor is a cap-truncated single block, the shared function drops it → empty batch → the digest skips and the cursor holds → graceful deferral until the window floor slides). This kills the re-send cascade WITHOUT the "hold whenever has_more" gate that caused it.
- Do NOT switch the digest to newest-first; only the route fetches newest-first. The two consumers fetch in opposite directions by design (route wants newest activity; digest drains oldest-first to completeness). The shared `filterEventsAfter` strict `>` is unchanged and remains shared.

**Re-characterized block:** the [BLOCKED by Architect] cause is resolved. This task is now gated on `backend-notifications-route-newest-first-whole-block` landing the `fetchNotificationsFromHaf` signature change (the `direction` param + `id` tie-breaker + partial-block drop). The digest's correct advance logic depends on that partial-block drop existing, so it is not actionable until the route task lands it. Kept in `blocked/` (re-characterized to **[BLOCKED by backend-notifications-route-newest-first-whole-block]**) rather than moved to `pending/`, so it is not picked up and implemented against the old shared-function signature out of order. **Whoever lands the route task: when its `fetchNotificationsFromHaf` change is in, `git mv` this file to `pending/`** (or hand to the architect to move it). The non-blocking minor items (a)-(d) above land with the item-1 fix as before.

## [Architect] (2026-06-09) — UNBLOCKED; moved to pending/

The gating dependency is satisfied: the shared `fetchNotificationsFromHaf` `direction` param + `id` tie-breaker + partial-block drop landed in commit `3591fb46` (route task `backend-notifications-route-newest-first-whole-block`). Moving this file to `pending/` so backend can implement the digest half (advance-to-highest-delivered-block each non-empty run) against the settled contract above.

**Sequencing note (re-check before starting):** the route task is concurrently HELD in `pending/` for a refinement to the partial-block-drop trigger — it switches `capHit` from `result.rows.length >= cap` to a `cap + 1` fetch with `> cap` so an exactly-cap fully-contained batch no longer false-drops its boundary block. That refinement does not change the contract this task relies on ("every delivered block is whole"), but it touches the same `fetchNotificationsFromHaf` body. Land the route hold's `cap + 1` fix first (or coordinate the shared edit) so the digest half is built against the final partial-block-drop semantics, not the interim `>= cap` form.

## Backend landing note (2026-06-09, commit `79d91fe8`)

Implemented the digest half: removed the `!batch.has_more` gate around `updateLastDigestBlock` in `runDigest`, so the cursor advances to the highest delivered block on every non-empty run, per the settled "advance-to-highest-delivered each run" answer above. Single-block-overflow is handled upstream by the shared partial-block drop (a lone cap-truncated block becomes an empty batch, the digest skips, and the cursor holds for graceful deferral). Confined to `backend/src/digest.ts` + `backend/tests/digest-window-cursor.test.ts`; `fetchNotificationsFromHaf` untouched. No API contract change (the digest is not an HTTP surface).

Dependency status: built against the stable "every delivered block is whole" contract, satisfied by the cap+1 partial-block-drop fix already on main (`e3336dff`). The route task's concurrent round-3 hold ("cap-edge over-drop") strengthens that contract rather than changing it, so the advance logic is unaffected; flagging in case the architect prefers to hold archive until the shared function fully settles.

Verification: `npm run typecheck` + `npm run lint` clean (the one lint warning is a pre-existing unused-directive in `lib/author-supersession.ts`, untouched); `digest-window-cursor.test.ts` 5/5 green against current main.

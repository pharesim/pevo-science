# BACKEND-NOTIFICATIONS-CACHE-KEY-SINCE-BLOCK-MISS — every SPA poll is a cache miss; 9-arm UNION ALL runs on every poll

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #8 high severity, performance)
**Priority:** P1 (the catch-block in the route already acknowledges the 9-arm UNION ALL can hit the 30s statement_timeout — and it runs on essentially every poll today)

## Problem

[routes/notifications.ts:33-36](backend/src/routes/notifications.ts#L33-L36) builds the cache key as:

```
notifications:${account}:${sinceBlock}:${limit}
```

The SPA advances `sinceBlock` on every poll, so each poll is a unique key and misses. Block-watcher's `clearVolatile()` also flushes every ~3s. The 9-arm UNION ALL (which the catch-block acknowledges can hit the 30s `statement_timeout`) runs on essentially every poll for every client.

## Goal

Make notification reads cache-shareable across polls and across SPA tabs so one HAF computation serves a window of clients/requests.

### Suggested approach

1. Drop `sinceBlock` from the cache key — key on `notifications:${account}:${limit}`.
2. Compute the underlying query relative to a fixed account-relative window (e.g. `chainHead - 100_000` or just `0` if cheap).
3. Pass `stable: true` to `hafCache` with a short explicit TTL (e.g. 60s) so block-watcher does NOT wipe it on every tick.
4. Filter `events.filter(e => e.block_num > sinceBlock)` in-app at the route layer before responding.

All tabs and the next 60s of polls then share one HAF computation.

## Acceptance

- Multiple polls within the TTL window for the same `(account, limit)` hit cache after the first.
- A poll's response correctly returns only events with `block_num > sinceBlock` (in-app filter pinned by test).
- TTL of 60s confirmed not wiped by block-watcher tick (block-watcher does not clear keys flagged `stable: true`).
- The 30s `statement_timeout` catch-block path is exercised much less often in practice — pin via a load-shape test or load-shape note (not a hard assertion).
- Existing notification semantics unchanged from the SPA's perspective (same event types, same order, same payload shape).
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- The dedup fix (#7) cuts notification volume per poll; this fix cuts query frequency. They compound — land both.
- The cursor-boundary fix (#9) interacts with the in-app filter: when this lands, ensure the SPA's polling loop and the in-app filter agree on `sinceBlock` semantics (`>` vs `>=`).
- Keep Redis key prefix `${config.appTag}:` discipline (no change here, but worth re-checking).

## Cross-references

- [backend/src/routes/notifications.ts](backend/src/routes/notifications.ts) lines 33-36 (cache key construction).
- [backend/src/cache.ts](backend/src/cache.ts) — `hafCache`, `stable` flag semantics.
- [backend/src/block-watcher.ts](backend/src/block-watcher.ts) — `clearVolatile()` behavior.
- HAF-query review run `w274tijk0` rank #8.

## Backend completion note (2026-06-05)

Implemented inline against HEAD (the worktree fan-out forked from a 112-commit-stale base; see session report). Landed in commit `bbd5e480`. Matches the suggested approach: the cache key dropped `since_block` (now `notifications:${account}:${limit}`), the batch is computed against a fixed window floor (`chain head - 100_000`, clamped to genesis, falling back to the genesis floor when the block-watcher has not ticked yet, e.g. fresh boot or tests), cached `stable: true` with a 60s TTL, and the poll's `since_block` is re-applied in-app via `applySinceBlockFilter`, which also recomputes `latest_block`/`has_more` over the filtered subset so forward pagination stays consistent. Tests in `notifications.test.ts` pin the in-app `> since_block` filter, the above-head empty-batch cursor floor, and window-sharing across two polls with different cursors. typecheck + lint clean; `notifications.test.ts` green against real HAF.

[TODO Architect] Optional contract clarification (`notifications.md`): with the fixed window, a fresh client polling `since_block=0` now sees events only within the last ~100k blocks (about 3.5 days), not from genesis. The existing "use 0 to get the most recent events" note roughly covers this; flagging in case the contract should state the window bound explicitly. Not a breaking change for the forward-poll case.

---

## Architect re-review (2026-06-05) — HELD PENDING FIXES

`/ce-code-review` fan-out (correctness, security, adversarial, reliability, api-contract, performance, testing, maintainability, project-standards, kieran-typescript) on commit `bbd5e480`. Cache mechanics verified clean: appTag prefix applied inside QueryCache, stable keys survive clearVolatile, errors are not negatively cached, cross-account isolation holds (key account = authenticated principal = SQL recipient param; limit clamped before keying). Three items block archive:

1. **Window-batch starvation (P1).** The cached batch holds the OLDEST `limit` events above the window floor (`ORDER BY block_num ASC LIMIT`), and `applySinceBlockFilter` can only subtract from it. A caught-up cursor strips the whole batch while newer events sit beyond the LIMIT cut, undeliverable until older events age out of the 100k window. Any account accruing more than `limit` events per window gets a silently frozen feed; also constructible by an accredited attacker spamming cheap events at a victim. Fix shape (triaged): decouple the internal fetch LIMIT from the response limit — fetch the window batch with a larger internal cap (around 500-1000), apply the cursor filter in-app, then slice to `limit` for the response. One HAF query per refill; the cache win is preserved.

2. **`has_more` recomputation (P1, couple to item 1).** `applySinceBlockFilter` computes `has_more` as `events.length >= batch.events.length && batch.has_more`, which forces `false` whenever the cursor filter removes any event. Define `has_more` relative to the client's cursor over the internally-capped batch: true when undelivered in-window events beyond the sliced response exist. Pin with a partial-filter regression test (capped batch, cursor mid-window, assert `has_more=true`) plus the all-filtered case. The frontend boundary-rewind consumer (`ui-notifications-block-cursor-boundary-rewind`, currently in `blocked/`) builds on this value — when this item lands, move that ui task from `blocked/` to `pending/`.

3. **Cache-behavior pins (P2).** (a) The window-sharing test asserts only response equality across two cursors; it stays green if the cache key regresses to re-include since_block. Add a call-count pin (mocked-pool canary: second poll with a different cursor triggers zero additional notification-query calls). (b) Nothing pins `stable: true` surviving clearVolatile or the 60s TTL; add a clearVolatile-survival canary (populate, clearVolatile(), re-poll, assert no second fetch).

Optional (non-blocking, while in the file): treat a not-yet-ticked block-watcher (head 0) as window-unavailable (serve an uncached empty batch) instead of computing a genesis floor. Exposure is roughly one event-loop tick at boot, but the guard is two lines in code this hold rewrites anyway.

Recorded as ACCEPTED behavior (do not "fix"): clients offline past the ~100k-block window lose the gap for the bell feed (digest covers it via its own cursor); accounts with no in-window events keep `latest_block = since_block` (cursor parks until an event lands). The `[TODO Architect]` contract divergences are handled architect-side: `notifications.md` updated alongside this hold.

---

## Backend re-review signal (2026-06-06, round 2)

All three hold items landed in `routes/notifications.ts` + a new mocked-pool canary file. typecheck (src+tests) + lint clean; new `notifications-window-cursor.test.ts` green (8/8); real-HAF `notifications.test.ts` green (9/9, behavior-compatible).

1. **Window-batch starvation.** Added `NOTIFICATION_WINDOW_FETCH_CAP = 1000` and decoupled it from the response `limit`: the cached window batch is now fetched at the cap, and `applySinceBlockFilter` applies the cursor filter then `.slice(0, limit)` for the response (oldest-first forward pagination). A caught-up cursor now surfaces newer in-window events instead of stripping a `limit`-sized batch. One HAF query per refill; the cache win is preserved. Pinned: `fetches the window batch with the internal cap as LIMIT, not the response limit` (asserts the `$3` LIMIT param ≥ 500, decoupled from response limit) and `surfaces newer in-window events past a caught-up cursor`.

2. **`has_more` recomputation.** Redefined as `filtered.length > events.length || batch.has_more` — true when the cursor filter left more than `limit` undelivered in-window events, or the internal fetch hit its cap. Replaces the old `events.length >= batch.events.length && batch.has_more` that forced `false` on any cursor removal. Pinned: partial-filter mid-window cursor → `has_more=true`; all-filtered → `has_more=false`, `latest_block` parks at `since_block`; fits-in-limit → `has_more=false`; cap-hit-but-slice-fits → `has_more=true` via the `batch.has_more` clause.
   - **[Flag for architect] ui-task unblock:** the hold says to move `ui-notifications-block-cursor-boundary-rewind` from `blocked/` to `pending/` once this item lands. The `commit-msg` zone-audit hook restricts backend to its own task slug, so I cannot move a `ui-*` task file. Item 2 is landed — please move that ui task to `pending/` during re-review (or hand to the ui agent).

3. **Cache-behavior pins (new file `tests/routes/notifications-window-cursor.test.ts`).** (a) Call-count canary: a second poll with a different cursor (same account, limit) triggers zero additional notification-query calls (mocked-pool counter; a key-regression to re-include since_block, or a dropped cache, flips it to 2). (b) clearVolatile-survival canary: populate, `hafCache.clearVolatile()`, re-poll → still one notification-query call (the `stable: true` entry survives the block tick). Carve-out header documents the three mocked helpers (`getPool` for the controlled batch + call count, `getRedis`→null for the deterministic in-memory cache path, `getGenesisBlock`→0 to neutralize the tests/setup.ts genesis warm-up that would otherwise clamp the low-block fixtures forward); clause-(b) auth companion is `auth.test.ts`, clause-(c) real-path companion is `notifications.test.ts`.

**Optional head-0 guard: NOT taken.** The hold's optional suggestion (serve an uncached empty batch when the block-watcher head is 0) conflicts with the test-reachable path: `getLastBlock()` has no test setter and returns 0 in mocked-pool tests, so both the existing `notifications-arm-sql-shape.test.ts` (which relies on head 0 reaching the query) and the new window-cursor canaries depend on the head-0 → genesis-floor path to exercise the route. The guard would also need a block-watcher test seam to keep those suites reachable. Given it is explicitly non-blocking and the exposure is ~one event-loop tick at boot, I left it out rather than add a production test seam.

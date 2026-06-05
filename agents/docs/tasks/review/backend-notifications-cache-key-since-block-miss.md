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

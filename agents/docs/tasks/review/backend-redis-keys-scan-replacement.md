# BACKEND-REDIS-KEYS-SCAN-REPLACEMENT — three sites use blocking `redis.keys(pattern)` on the single-threaded Redis server

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #21 medium severity, performance)
**Priority:** P2 (gratuitous stall on web-request paths; small at PEvO scale but easy fix)

## Problem

Three sites call `redis.keys(pattern)` which scans the entire Redis keyspace under Redis's single-threaded server:

- [reputation-batch.ts:130-136](backend/src/reputation-batch.ts#L130-L136) — `clearStagingKeys`.
- [reputation-batch.ts:146-155](backend/src/reputation-batch.ts#L146-L155) — `clearInProgressSentinels`.
- [reputation.ts:231](backend/src/reputation.ts#L231) — `getBatchReputationMap`.

Cleanup helpers run at boot AND at the top of every hourly batch run; `getBatchReputationMap` runs every cycle plus on any `/api/stats` consumer. At PEvO scale the latency hit is small, but it's a gratuitous stall on web-request paths.

## Goal

Replace blocking `KEYS` with iterative `SCAN` (for cleanup helpers) and a maintained set (for `getBatchReputationMap`).

### Suggested approach

- **Cleanup helpers (`clearStagingKeys`, `clearInProgressSentinels`):** replace with iterative `SCAN` (COUNT ~500/batch). Same semantics, no full keyspace stall.
- **`getBatchReputationMap`:** maintain a Redis Set `${appTag}:reputation:batch:members` updated alongside each batch write (SADD inside the Lua swap, SREM on removal). Read via `SMEMBERS + MGET` — bounds enumeration by accredited-user count rather than full keyspace.

## Acceptance

- All three sites no longer use `KEYS`.
- Cleanup helpers' observable behavior unchanged (same keys deleted, same Redis state after run).
- `getBatchReputationMap` returns the same shape; pin via test that adding/removing a batch entry SADD/SREMs the members set inside the Lua swap (atomicity preserved).
- Redis key prefix `${config.appTag}:` discipline maintained on the new `members` set.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Modify the Lua script (`CYCLE_SWAP`) to add SADD/SREM inside the atomic swap. Related to #32 (CYCLE_SWAP via evalScript registry) — if both land together, the Lua change folds cleanly.
- Independent of #22 (`pipeline.exec()` error check).

## Cross-references

- [backend/src/reputation-batch.ts](backend/src/reputation-batch.ts) lines 130-136, 146-155.
- [backend/src/reputation.ts](backend/src/reputation.ts) line 231.
- HAF-query review run `w274tijk0` rank #21.

---

## Backend completion note (2026-06-06)

All three `redis.keys()` sites removed. typecheck (src+tests) + lint clean.

- **`scanAllKeys(redis, pattern, count=500)`** added to `reputation.ts` — an iterative `SCAN` cursor loop (non-blocking). `clearStagingKeys` and `clearInProgressSentinels` now call it instead of `redis.keys(...)`; same observable cleanup (collect then `DEL`).
- **`getBatchReputationMap`** now enumerates via `SMEMBERS ${REDIS_KEY_BATCH_MEMBERS}` + `MGET`, bounding enumeration by the member count rather than the whole keyspace. On an empty index (genuinely empty batch OR a pre-members-set deployment whose prod keys predate the index) it falls back ONCE to a non-blocking `scanAllKeys(${BATCH_KEY_PREFIX}*)` (staging-filtered) and backfills the set via `SADD`, then takes the `SMEMBERS` fast path thereafter. Same return shape.
- **Members-set key:** `REDIS_KEY_BATCH_MEMBERS = ${appTag}:reputation:batch_members`. Deliberately OUTSIDE `BATCH_KEY_PREFIX` (note `batch_members`, not `batch:members`) for two reasons the task's literal `:batch:members` suggestion would hit: (1) a Hive account literally named `members` owns prod key `${BATCH_KEY_PREFIX}members`, which would collide String-vs-Set (WRONGTYPE) with the index; (2) it stays out of any residual `${BATCH_KEY_PREFIX}*` glob. Same sibling-key discipline as `reputation:cycle:last` / `reputation:lock` / `reputation:in_progress:`.
- **`CYCLE_SWAP` Lua** now SADDs each renamed prod key into the members set inside the same atomic execution (KEYS layout `[...staging, sentinel, members-set]`; `reputation-batch.ts` passes `REDIS_KEY_BATCH_MEMBERS` as the final KEY). Atomicity matters: a crash between the swap and a TS-side SADD would leave the index missing the cycle's users until the next backfill — doing the SADD inside the Lua closes that. **SADD-only:** there is no prod-key removal path, so SREM never fires; a stale member whose prod key was dropped is `MGET`-null-skipped on read (preserving the prior `KEYS`-glob semantics, which also returned stale prod keys). The Lua also documents the single-instance assumption (RENAME across keys is CROSSSLOT under Cluster; the batch is single-instance per `project_single_instance_only`).
- **Tests:** the `CYCLE_SWAP` evalScript test (`redis-scripts.test.ts`) and the direct-eval test (`reputation-batch-internals.test.ts`) updated for the new KEYS layout and now assert the renamed prod keys are `SISMEMBER` of the members set (the SADD-inside-swap atomicity pin the acceptance asks for). A new `getBatchReputationMap` test pins the `SMEMBERS`-bounded read (an un-indexed prod key is invisible). The cleanup-helper tests now exercise the SCAN path. `reputation-prefix.test.ts`'s direct-seed reader test registers its seeded prod key in the index (production never produces a prod key without a members entry; its sibling `runBatchComputation` test populates the global index first, so the empty-set backfill is not available to it). The self-healing backfill itself is not unit-pinned — deterministically forcing an empty global index races the `maxWorkers=2` runner — but its logic is exercised by any empty-set read.

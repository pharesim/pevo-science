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

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

## Architect re-review (2026-06-06) — HELD PENDING FIXES (4 items)

`/ce-code-review` (correctness + adversarial on Opus; performance, reliability, testing, maintainability, project-standards on Sonnet; ce-agent-native-reviewer skipped per PEvO) on commit f90d7088. The core migration is verified CORRECT: Lua indexing (nKeys/sentinel/members) exact, gsub produces post-rename paths, evalScript re-hashes the changed script text so deploy-time SHA skew is impossible, the SCAN-vs-RENAME backfill race self-heals via set union with the Lua's own SADD, no production redis.keys() call survives, batch_members cannot collide with account-derived prod keys, and the /api/stats topology reads a 5-minute cache so the backfill is never per-request. Four items hold.

### Items held (must fix before archive)

1. (P1, maintainability + project-standards, corroborated) The CYCLE_SWAP docblock in `redis-scripts.ts` cites an agent-memory filename ("memory `project_single_instance_only`"). Memory filenames are coordination artifacts invisible to fork readers and rot on memory reorganization — same class as task-slug citations. Replace with the plain invariant, e.g. "PEvO is single-instance by design; RENAME across keys is a CROSSSLOT error under Redis Cluster, which this deployment does not use." (The codebase precedent is plain prose, e.g. signup-activation-lock and redis.ts.)
2. (P2, correctness + reliability, corroborated) Seed writers bypass the members index: `seedAccreditationBonus` and `backfillAccreditationSeeds` write prod keys outside the Lua, so once the index is non-empty (steady state) a freshly-accredited seed-only user is invisible to `getBatchReputationMap` until the next cycle swap — a regression vs the old KEYS-glob read. Fix: SADD the prod key into REDIS_KEY_BATCH_MEMBERS when the seed SET NX succeeds (returns OK) in `seedAccreditationBonus`; queue `pipeline.sadd(...)` alongside each `pipeline.set(...)` in `backfillAccreditationSeeds`; and SREM after the DEL in `invalidateOnRevocation` so revoked stale members stop accumulating. While editing the backfill pipeline, inspect its `exec()` per-command tuples and log-and-skip on error (same idiom as the staging guard; the current unchecked exec is the same defect class at lower blast radius).
3. (P2, testing + project-standards, corroborated) The empty-index backfill path is unpinned and no follow-up was filed — clause (c) requires one or the other. Add a deterministic test: empty the members set under a test-unique namespace (or via a test seam for the members-set key) to dodge the maxWorkers=2 race, seed a prod key, assert the first `getBatchReputationMap` call returns the user (backfill fired and SADD'd), and the second call takes the SMEMBERS fast path. Fold two sibling pins into the same describe block while there: stale-member MGET-null skip (member present, prod key absent — user silently absent, no throw) and staging-contamination skip (staging-prefixed key SADD'd into the set never surfaces as a user). If the namespace isolation genuinely cannot be made deterministic, file the follow-up task instead and say so in this file.
4. (P3, adversarial) Add a cheap arity guard at the top of CYCLE_SWAP_LUA before any write — e.g. `if #KEYS < 2 then return redis.error_reply('CYCLE_SWAP requires staging keys plus sentinel and members-set KEYS') end` — so a future caller passing the pre-members 2-part layout fails fast instead of WRONGTYPE-aborting mid-loop with partial RENAMEs already committed.

### Items dismissed at triage (no action)

- MGET/SMEMBERS chunking at large cardinality, backfill thundering herd, WRONGTYPE-via-manual-SET on the members key, rollback-window index staleness: theoretical-only at single-instance PEvO scale, or self-healing within one cycle.
- SADD-only (no SREM) as designed: item 2 adds the one SREM site that exists (revocation); no other removal path.
- Pre-existing task-slug citations in reputation docblocks/test headers: already tracked by the blocked backend-haf-query-comment-anchor-sweep task.

### On final archive (architect)

When this task archives clean, judge whether the index writer-completeness rule clears the `/ce-compound` bar: an index maintained only inside the swap path drifts the moment any other writer creates or deletes the indexed keys (exactly what item 2's seed writers did); every writer of an indexed key must maintain the index, or the read path must tolerate AND eventually heal the divergence. Invoke `/ce-compound` if the re-review confirms the fix shape.

### Re-review signal

When the four items land, `git mv` this file back to `tasks/review/`. The mv is the re-review signal; the next review scopes to the fix commits only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Backend re-review signal (2026-06-08, commit on main)

All four held items landed:

1. (P1) The CYCLE_SWAP docblock in `redis-scripts.ts` no longer cites the agent-memory filename. Replaced with the plain invariant: "PEvO is single-instance by design and does not run Redis Cluster, so the members-set key being a separate KEY raises no cross-slot concern here."
2. (P2) Seed writers now maintain the members index, closing the steady-state invisibility regression:
   - `seedAccreditationBonus` SADDs the prod key into the index only when the NX SET returns `'OK'` (a no-op SET means a real cycle value already exists, already a member from the swap).
   - `invalidateOnRevocation` SREMs the prod key after the DEL, so revoked members stop accumulating.
   - `backfillAccreditationSeeds` queues `pipeline.sadd(...)` alongside each `pipeline.set(...)` (SADD idempotent), and its `pipeline.exec()` now inspects the per-command tuples and log-and-skips on error (the same defect class as the staging guard, lower blast radius), surfacing the first failed command's message.
3. (P2) Added a deterministic empty-index backfill describe in `reputation-batch-internals.test.ts`. The index is repointed onto a test-unique key (`TEST_MEMBERS_KEY`, OUTSIDE `BATCH_KEY_PREFIX` so the backfill SCAN never enumerates it) via a new gated `reputation` `__test_seams.setBatchMembersKey`, dodging the maxWorkers race on the shared production members set. Three pins: (a) empty index → SCAN-backfill SADDs the prod key → first read returns the user, second read takes the SMEMBERS fast path; (b) stale member whose prod key is absent → MGET-null skip, no throw; (c) staging-prefixed key in the index → never surfaces. The seam export is guarded by `no-restricted-imports` in `eslint.config.mjs` (verified the rule fires against a probe import).
   - **In-scope determinism fix (surfaced):** the pre-existing `getBatchReputationMap staging-key filter` test relied on the backfill firing (empty production members set) and so collided with `reputation-batch-sql-failure` under the concurrent runner (its CYCLE_SWAP SADD left the shared index non-empty, skipping the backfill — the exact maxWorkers race this hold names). Repointed that test onto the same isolated members key. `internals + sql-failure` run together now passes 15/15 (was 1 failed before this fix). This is a fix to a flakiness caused by the members-index migration this task owns, kept in scope per the green-suite preference.
4. (P3) Added the arity guard at the top of `CYCLE_SWAP_LUA` (`if #KEYS < 2 then return redis.error_reply(...) end`) before any RENAME, plus a pin in `redis-scripts.test.ts` asserting a <2-KEYS call rejects with the guard message.

`npm run typecheck` + `npm run lint` clean. Green in isolation: `reputation-batch-internals` (12), `reputation-batch-sql-failure` (3), `redis-scripts` (8), `reputation-prefix` (2), `stats-profile-parity` (5), `accreditation-idempotency` (19), `wot-retract-cascaderevocation` (8); and `internals + sql-failure` together (15).

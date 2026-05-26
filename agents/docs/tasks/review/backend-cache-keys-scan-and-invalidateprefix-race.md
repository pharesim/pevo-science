# Replace blocking `redis.keys()` in QueryCache with SCAN + close the `invalidatePrefix` mid-SCAN epoch window

**Owner:** Backend Agent
**Created:** 2026-05-26 (architect, from `/ce-code-review` triage of `backend-cache-single-flight-coalescing` round-3 — both items pre-existing, split out so they do not block that task's archive)
**Priority:** P3

## Problem

Two pre-existing reliability/perf issues in `backend/src/cache.ts` `QueryCache`, surfaced (but not introduced) during the per-tier-epoch review. Both are theoretical at PEvO's current single-instance + small-keyspace scale; this task records them so the fix is not lost and lands when a maintainer is next in the file.

### 1. Blocking `redis.keys()` on the hot path

`clearVolatile()` and `clear()` enumerate the keyspace with `redis.keys(this.prefix + '*')`. `KEYS` is O(N) over the whole Redis keyspace and blocks the server for the duration. `clearVolatile()` is the worst case: it runs on **every new Hive block (~3s)** via the block-watcher, so the blocking scan fires continuously. `clear()` has the same shape but runs rarely.

The non-blocking `SCAN` pattern is already implemented correctly in the same file at `invalidatePrefix()` (cursor loop, `COUNT 200`, batched `del`). The fix is to reuse that pattern.

- **Cross-corroborated by** performance (conf 75) + reliability (conf 75) during the round-3 review.
- Per `reference_haf_indexes_cannot_be_modified` this is unrelated to HAF; it is a Redis-client call shape fully under PEvO control.

### 2. `invalidatePrefix()` bumps the epoch(s) before the multi-round SCAN completes

`invalidatePrefix()` bumps `volatileEpoch`/`stableEpoch` once at the top, then runs a multi-round `SCAN` loop to find and delete matching keys. Because the bump happens before the loop finishes, a `getOrSet` fetcher that **starts during the loop** (after the bump, before its key's SCAN batch deletes it) captures the already-advanced epochs as its baseline, passes the epoch gate on resolution, and can write a pre-invalidation snapshot to a key the loop has not yet deleted.

`invalidate()` and `clear()` do not have this window — their deletes are single-shot, not a multi-round async loop. `invalidatePrefix()` is the only method whose delete phase is multi-step.

- **Flagged by** reliability (conf 75) during the round-3 review.
- The window is narrow and self-heals on the next fetch after the loop completes; it is a correctness edge, not an outage.

## Goal

1. Replace `redis.keys(...)` in `clearVolatile()` and `clear()` with the non-blocking `SCAN` cursor loop already used by `invalidatePrefix()` (same `COUNT`/batch-`del` shape). Preserve the existing in-memory-fallback path and the `stableKeys`-membership filter in `clearVolatile()`.
2. Close the `invalidatePrefix()` mid-SCAN window. Options to weigh at implementation time: (a) bump the epoch(s) **after** the SCAN loop completes the deletes (mirrors the "bump-before-delete" rationale but applied to the loop as a whole — verify this does not open a different window for fetchers that started *before* the bump); or (b) snapshot-and-re-check; or (c) accept and document the window if the fix cost outweighs the narrow benefit at single-instance scale. The implementer should reason through both windows (fetchers started before vs during the loop) and pick the shape that closes the one this task names without re-opening the other.

## Acceptance

- `clearVolatile()` and `clear()` no longer call `redis.keys()`; they use the `SCAN` cursor loop. The `stableKeys` filter in `clearVolatile()` still retains stable entries.
- A unit/integration test pins that `clearVolatile()`/`clear()` issue `SCAN` (not `KEYS`) — e.g. assert against a mock-redis spy, or behavioral coverage that the volatile flush still removes only non-stable entries.
- The `invalidatePrefix()` mid-SCAN window is either closed (with a test exercising a fetcher that starts during the loop and asserting its post-loop value is not stale) or explicitly documented as accepted with rationale.
- `npx tsc --noEmit` clean; targeted `tests/lib/cache.test.ts` stays green.
- Comments anchor on stable symbols (no task slugs, round numbers, line numbers, or SHAs).

## Out of scope

- The per-tier epoch design itself (settled in `backend-cache-single-flight-coalescing`).
- `getOrSetSWR`/`revalidate`/`registerPeriodicRefresh.reload` epoch gaps (tracked in `backend-cache-single-flight-coalescing-swr-cold-path`).

## Cross-references

- `backend/src/cache.ts` — `clearVolatile()`, `clear()` (`KEYS` sites); `invalidatePrefix()` (the canonical `SCAN` pattern to copy + the mid-loop window).
- `project_single_instance_only` — bounds the blast radius of both issues; the fix is hygiene, not a scaling necessity.

---

## Backend implementation signal (2026-05-26)

Both items landed in `backend/src/cache.ts` plus a new mocked-redis test file. Ready for review.

### Item 1 — `redis.keys()` → non-blocking SCAN

- Extracted the SCAN cursor loop (the pattern previously inlined in `invalidatePrefix()`) into a private `scanAndDeleteKeys(redis, suffix, shouldDelete?)` helper: SCAN `COUNT 200`, collect, batched `del` (`CHUNK 200`). An optional `shouldDelete(unprefixedKey)` predicate filters candidates.
- `clear()` and `clearVolatile()` now call the helper instead of `redis.keys(this.prefix + '*')`. `clearVolatile()` passes `(k) => !this.stableKeys.has(k)` so the stable-key retention filter is preserved through the migration. `invalidatePrefix()` also routes through the helper (de-duplicates the loop; single SCAN implementation).
- The in-memory fallback paths (`memStore.clear()`, the non-stable `memStore` loop, the `keyPrefix` `memStore` loop) are unchanged.

### Item 2 — `invalidatePrefix()` mid-SCAN epoch window (and the new window item 1 introduces in `clear`/`clearVolatile`)

Converting `clear()`/`clearVolatile()` to a multi-round SCAN loop (item 1) gives them the same mid-loop window `invalidatePrefix()` had — the task's "single-shot" framing of `clear()` was true only pre-item-1. Chosen fix: **bump the tier's epoch(s) both BEFORE and AFTER the sweep** for all three multi-round-delete methods; `invalidate()` stays a single before-bump (it is genuinely single-shot — one `del`).

Reasoning through both windows (the task asked for this): the architect's option (a) "bump only after the loop" reopens the before-window — a fetcher that started before the call, resolving mid-loop after its key was deleted, would re-cache stale data because the epoch hasn't advanced yet. Keeping the before-bump (round-2/round-3 contract) AND adding an after-bump closes the named during-loop window without reopening the before-window. The residual (a fetcher registered during the loop that also resolves during it) writes fresh data, because epoch capture happens at fetcher registration, which is after the before-bump, i.e. after the caller's data mutation — so its `fn()` reads post-mutation state. `clearVolatile()` bumps only `volatileEpoch` before+after (never `stableEpoch`, preserving the per-tier `stable: true` contract from `backend-cache-single-flight-coalescing`). Class-level docblock gained a "Single-shot vs multi-round deletes" paragraph; each method comment anchors on the before/after rationale (no slugs/lines/SHAs).

### Tests — `backend/tests/lib/cache-invalidation.test.ts` (new, mocked-redis)

Mocks `getRedis()` (permitted shared-helper per the test-mock carve-out; header documents clauses (a)/(b)/(c)). The behavioral risk classes (stable retention through `clearVolatile`; in-flight write suppression) are covered real-path by `tests/lib/cache.test.ts`; this file adds the command-shape and mid-loop-timing pins a real client can't express.

- `clear()` and `clearVolatile()` issue SCAN and NOT `KEYS` (spy assertions are direct `KEYS` detectors); `clearVolatile()` retains the stable key, deletes the volatile one.
- `invalidatePrefix()` suppresses the write of a fetcher registered during the SCAN loop and resolving after it. **Mutation-kill:** removing the after-bump flips this spec RED (the two SCAN-not-KEYS specs stay green); reverted.

### Verification

- `npm run typecheck` from `backend/`: clean.
- `npm run lint` from `backend/`: clean for all changed files.
- `tests/lib/cache-invalidation.test.ts` 3/3; `tests/lib/cache.test.ts` 8/8 (single-flight specs re-run against real Redis, now exercising the SCAN path in `clearVolatile`); `tests/cache.test.ts` 10/10 (direct `QueryCache` regression). No cache regression.
- Test-run note: run the real-Redis cache specs against the live redis container IP (the repo `.env` `REDIS_URL` is stale) per root CLAUDE.md "Running Tests".

### Carry-forward for the architect (archive-time)

The "multi-round SCAN delete must bracket the sweep with before+after epoch bumps" insight is adjacent to the per-tier-epoch learning the round-4 hold on `backend-cache-single-flight-coalescing` already flagged for `/ce-compound` at archive. Suggest folding both into the same cache-invalidation learning refresh rather than a separate entry.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

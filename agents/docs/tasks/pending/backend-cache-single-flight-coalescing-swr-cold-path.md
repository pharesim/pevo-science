# BACKEND-CACHE-SINGLE-FLIGHT-COALESCING-SWR-COLD-PATH — Extend single-flight coalescing AND epoch-guard to `QueryCache.getOrSetSWR` cold-path, `revalidate`, and `registerPeriodicRefresh.reload`

**Owner:** Backend Agent
**Created:** 2026-05-20 (architect, cross-reviewer-flagged during `/ce-code-review` of `backend-cache-single-flight-coalescing` round-1 commit `623bee26`)
**Scope widened:** 2026-05-21 (architect, `/ce-code-review` of parent task's round-2 commit `d6e23014` surfaced two additional sibling paths with the same invalidation-during-flight race — `revalidate` and `registerPeriodicRefresh.reload`. Three reviewer personas corroborated.)
**Priority:** P2 (was P3 — widened scope upgraded severity because the same race class the parent task closed in `getOrSet` is still alive in 3 sibling production paths, not just 1)

## Problem

This task covers TWO related gaps in the `QueryCache` class:

### Gap A — Single-flight coalescing (the original scope)

`backend-cache-single-flight-coalescing` round-1 added a `Map<prefixedKey, Promise<T|null>>` in-process single-flight layer to `QueryCache.getOrSet`. Concurrent same-key cache misses now share ONE fetcher invocation. The sibling method `QueryCache.getOrSetSWR` (stale-while-revalidate) was NOT touched by that task.

`getOrSetSWR` has a cold-path (both fresh and stale keys absent — true cold start, post-`invalidatePrefix`, post-`clearVolatile`, or post-`clear`) that falls through to `await fn()` with NO in-flight guard. N concurrent callers all reach the cold path and all spawn independent fetcher invocations — the same amplification pattern that `getOrSet` now closes.

The existing `revalidating` Set in `getOrSetSWR` guards ONLY the background refresh path (stale-warm); it does not guard the synchronous cold-path.

### Gap B — Epoch-guard invalidation-during-flight race (added 2026-05-21)

The parent task's round-2 commit added an `epoch` counter mechanism to close an invalidation-during-flight race in `getOrSet`'s success path: invalidate*/clear* methods bump `this.epoch` BEFORE their delete; `getOrSet` captures the epoch at fetcher start and skips the `this.set` write on resolution if the epoch has advanced (the snapshot is stale). The fix is correctly applied at `getOrSet`.

Three OTHER paths in the same file have the same `await fn() → await this.set(...)` shape with NO epoch capture or check:

1. **`getOrSetSWR` cold-path** — same code path Gap A covers; the epoch-guard absence is in the success branch that writes to the cache on first-fetch.
2. **`revalidate`** — the private background-refresh helper called from `getOrSetSWR`'s stale-warm path. Performs `await fn()` then unconditionally `await this.set(key, ...)` and `await this.set(staleKey, ...)`. If `invalidate`, `invalidatePrefix`, `clearVolatile`, or `clear` fires while a background revalidation is in flight, the revalidation writes its pre-invalidation snapshot back into the cache after the invalidation cleared it. The `staleKey` write is especially load-bearing because the stale key is what callers see for the next `staleMs` window.
3. **`registerPeriodicRefresh.reload`** — the closure that periodic refreshes (e.g., reputation-cycle warm-keep) use to re-populate the cache. Performs `await fn()` then unconditionally `await this.set(key, ...)` with no epoch comparison. A periodic reload firing between an `invalidate` and the next demand-driven read silently re-populates the cleared key with the pre-invalidation snapshot.

All three sites have the same fix pattern: capture `this.epoch` at the start of the fetcher block, gate the success-path `this.set` write(s) on `capturedEpoch === this.epoch`.

### Why this matters

The class-level docblock added by round-1 of the parent task says: *"Single-flight coalescing: getOrSet deduplicates concurrent same-key fetcher invocations..."* and then frames the coalescing layer as a property of the class. A reader will reasonably expect `getOrSetSWR` to behave the same way. The docblock raises an expectation that the cold-path doesn't currently deliver. The round-2 docblock additions extend that scope-honesty problem: the "Invalidation-during-flight" paragraph is scoped to `getOrSet` but a reader could reasonably expect the epoch guard to cover the SWR path too.

### Exposure

SWR callers hit the cold-path after `invalidatePrefix` or `clearVolatile` runs (block-change cache clears in PEvO's reputation cycle, claim mutations, paper edits), or on first cold start. The N-concurrent-callers-against-cold-key burst pattern is real under PEvO's caching workload. The invalidation-during-flight race on SWR's `revalidate` path is reachable on every paper edit / claim accept / vote operation against any cached key with a stale-warm window. `registerPeriodicRefresh.reload` is reachable on every periodic-refresh tick (frequency depends on the registered interval).

## Goal

Close BOTH Gap A (single-flight coalescing) AND Gap B (epoch-guard invalidation-during-flight race) across all 3 unguarded sibling paths in `QueryCache`: `getOrSetSWR` cold-path, `revalidate`, and `registerPeriodicRefresh.reload`. After this change, single-flight coalescing covers `getOrSet` + `getOrSetSWR` cold-path, and the epoch-guard covers all 4 success-path `this.set` write sites (`getOrSet`, `getOrSetSWR` cold-path, `revalidate` both writes, `registerPeriodicRefresh.reload`).

The two methods `getOrSet` and `getOrSetSWR` can share the same `this.inflight` Map (keys are fully prefixed and unique per cache instance). The epoch-guard pattern (capture `this.epoch` at fetcher start; gate `this.set` on `capturedEpoch === this.epoch`) extends mechanically to all 3 sites.

If the parent task's round-3 fix lands the **separate volatile/stable epoch counters** (per the parent's round-3 hold item 1), this task adapts to the per-tier shape: capture both counters at fetcher start, gate on both for non-stable writes and on stableEpoch only for stable writes.

## Acceptance

### 1. `getOrSetSWR` cold-path: single-flight + epoch-guard

`backend/src/cache.ts` `getOrSetSWR` method:
- On cold-path (both fresh and stale `get` return undefined), check `this.inflight.get(inflightKey)` before invoking `fn()`. If present, `return await` that promise.
- If absent, create a self-cleaning promise wrapping `fn()`, store in `this.inflight`, await it, capture the epoch BEFORE the await, gate the success-path `this.set` write(s) on `capturedEpoch === this.epoch` (or the per-tier counters if the parent's round-3 fix landed that shape), and delete the in-flight slot in `finally`. Mirror the `getOrSet` shape.

### 2. `revalidate` (private SWR background-refresh helper): epoch-guard

The `revalidate` method calls `this.set(key, ...)` and `this.set(staleKey, ...)` unconditionally on resolution. Capture `this.epoch` (or both counters per the parent's round-3 shape) at fetcher start; gate BOTH `this.set` calls on epoch match. The `staleKey` write should be gated on the same condition since callers served from the staleKey for the next `staleMs` window must not see a re-cached pre-invalidation snapshot.

### 3. `registerPeriodicRefresh.reload` closure: epoch-guard

The `reload` closure called by the periodic-refresh interval performs `await fn()` then unconditionally `await this.set(key, ...)`. Capture the epoch (or per-tier counters) at the START of the reload closure (before `await fn()`); gate the `this.set` write on epoch match. Document in the closure's JSDoc that a `clear`/`clearVolatile`/`invalidate` fired during a periodic-refresh tick will leave the cache cold until the next demand-driven cache-fill.

### 4. Coordination with the stale-warm `revalidating` guard

The existing `revalidating` Set is for the background-refresh path (stale data present + TTL expired → return stale immediately + refresh in background). The new cold-path single-flight uses `this.inflight` (the same Map as `getOrSet`). These two coordination primitives serve different paths and do NOT need to be merged — keep them separate, document the distinction in the `getOrSetSWR` JSDoc.

### 5. Round-3 fix from the parent task lands first

This task depends on `backend-cache-single-flight-coalescing` round-3 landing the per-tier-counter fix (hold item 1 in the parent's round-3 hold block — `clearVolatile` + stable-key bleedthrough). The per-tier counter shape, once settled, is what this task extends to the SWR/revalidate/reload paths. Sequencing: do NOT start this task until the parent's round-3 fix is archived.

### 6. Tests

`backend/tests/lib/cache.test.ts` — add specs in new describe blocks:

**`'QueryCache.getOrSetSWR — single-flight coalescing on cold-path'`** (Gap A coverage):
- **Coalesce N concurrent cold-path misses → 1 fetcher invocation.** Mirror the `getOrSet` cold-path coalesce spec.
- **Null resolution clears the in-flight slot.** Next wave's fetcher invokes fresh.
- **Throw clears the in-flight slot.** Next call retries with a fresh fetcher.
- **Stale-warm path is unaffected.** Existing stale-warm + revalidating-Set behavior continues to work; the new cold-path coalescing does not interfere. 2-step test: warm cache + expire TTL + concurrent calls → all receive stale data + ONE background refresh fires (via existing `revalidating` Set).

**`'QueryCache — invalidation-during-flight prevents stale recache on SWR / revalidate / periodic-refresh'`** (Gap B coverage, 3 specs):
- **`getOrSetSWR` cold-path: invalidate during in-flight prevents pre-invalidation snapshot from being cached.** Mirror the round-2 unit spec on `getOrSet`. Mutation-kill: remove the epoch-guard from `getOrSetSWR` cold-path → flips RED.
- **`revalidate`: invalidate during background-refresh prevents stale snapshot from being re-cached.** Pattern: warm cache + expire TTL → call `getOrSetSWR` (triggers background `revalidate`) → mid-revalidate, fire `invalidate(key)` → assert `cache.get(key)` returns undefined post-revalidate-resolution. Mutation-kill: remove the epoch-guard from `revalidate` → flips RED.
- **`registerPeriodicRefresh.reload`: invalidate between refresh ticks does not allow the reload's cache-write to undo the flush.** Pattern: register a periodic refresh on a fast interval → during a reload firing, run `invalidate(key)` → assert `cache.get(key)` returns undefined post-reload. Mutation-kill: remove the epoch-guard from `reload` → flips RED.

### 7. Verification

`npm run typecheck` clean. `npm run lint` clean for this change. Scoped vitest on `tests/lib/cache.test.ts` passes (new specs + the existing `getOrSet` single-flight specs unaffected). Existing `getOrSetSWR` callers (reputation, WoT vouch, stats — any cache instance using SWR) continue to pass their integration tests.

### 8. Docblock update

Class-level docblock and `getOrSet` + `getOrSetSWR` JSDoc clarify that single-flight coalescing applies to both methods (per-method language). The "Invalidation-during-flight" paragraph is updated to enumerate all 4 guarded `this.set` sites (`getOrSet`, `getOrSetSWR` cold-path, both `revalidate` writes, `registerPeriodicRefresh.reload`). Honest framing on the TOCTOU degradation under Redis backend per the parent task's round-2 hold item 2 applies equally to `getOrSetSWR`.

## Out of scope

- Refactoring `getOrSet` and `getOrSetSWR` to share a private `_singleFlightFetch` helper. Architect dismisses extraction as YAGNI per project bias; the two methods have similar but distinct path-of-action and the duplication is intentional isolation.
- Touching `this.set` semantics — the skip-on-null rule and the epoch-counter invalidation-race protection from the parent task's round-2 fix apply uniformly.
- Background-refresh coalescing improvements. The existing `revalidating` Set already deduplicates background refreshes; no change needed.

## Cross-references

- `backend/src/cache.ts` — `getOrSetSWR` at lines ~131-153 (the cold-path) and the new `this.inflight` Map shared with `getOrSet`.
- `backend-cache-single-flight-coalescing` round-1 (commit `623bee26`) — established the `inflight` Map pattern on `getOrSet`.
- `backend-cache-single-flight-coalescing` round-2 hold — epoch-counter invalidation-race fix; this task depends on that landing first.
- `agents/docs/solutions/conventions/caching-wrapper-discriminated-union-poisoning-2026-05-11.md` — sibling caching convention.
- Originating review: `/ce-code-review` round-1 of the parent task, cross-corroborated by correctness + performance + reliability + maintainability + learnings-researcher (anchor 75).

[BLOCKED by Architect] 2026-05-21 — Acceptance #5 explicitly requires the parent task `backend-cache-single-flight-coalescing` round-3 fix to be **archived** before this task starts. Parent's round-2 fix landed at commit `d6e23014` (epoch counter, TOCTOU docblock, citation) but architect re-review on 2026-05-21 found a round-3 hold item: `clearVolatile` bumps the class-wide epoch and blocks in-flight stable-key writes — defeating the `stable: true` contract. The prescribed fix is **separate volatile and stable epoch counters**. THIS task's scope was widened at the same re-review to enumerate 3 unguarded sibling paths (Gap B above) that need the same epoch-guard pattern; the per-tier-counter shape, once settled, is what this task extends to those paths. Unblock once architect archives the parent's round-3. Moving to `blocked/` per `feedback_held_task_blocked_on_architect.md` — held tasks whose resolution depends on architect input go to `blocked/`, not `pending/`.

[UNBLOCKED by Architect] 2026-05-27 — Parent `backend-cache-single-flight-coalescing` archived 2026-05-26 (round-4 clean): the per-tier `volatileEpoch`/`stableEpoch` split (Acceptance #5's prerequisite) landed in round-3 and was test-pinned in round-4. The final per-tier counter shape is now settled, so this task can extend it to the `getOrSetSWR` cold-path, `revalidate`, and `registerPeriodicRefresh.reload` sites. Moving back to `pending/` for backend pickup. No coordination conflict: this task is `cache.ts`-scoped, disjoint from the in-flight `papers.ts` author-identity work.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

# BACKEND-CACHE-SINGLE-FLIGHT-COALESCING-SWR-COLD-PATH — Extend single-flight coalescing to `QueryCache.getOrSetSWR` cold-path

**Owner:** Backend Agent
**Created:** 2026-05-20 (architect, cross-reviewer-flagged during `/ce-code-review` of `backend-cache-single-flight-coalescing` round-1 commit `623bee26`)
**Priority:** P3 (performance — same concurrency amplifier as the parent task closes for `getOrSet`, but on the SWR cold-path)

## Problem

`backend-cache-single-flight-coalescing` round-1 added a `Map<prefixedKey, Promise<T|null>>` in-process single-flight layer to `QueryCache.getOrSet`. Concurrent same-key cache misses now share ONE fetcher invocation. The sibling method `QueryCache.getOrSetSWR` (stale-while-revalidate) was NOT touched by that task.

`getOrSetSWR` has a cold-path (both fresh and stale keys absent — true cold start, post-`invalidatePrefix`, post-`clearVolatile`, or post-`clear`) that falls through to `await fn()` with NO in-flight guard. N concurrent callers all reach the cold path and all spawn independent fetcher invocations — the same amplification pattern that `getOrSet` now closes.

The existing `revalidating` Set in `getOrSetSWR` guards ONLY the background refresh path (stale-warm); it does not guard the synchronous cold-path.

### Why this matters

The class-level docblock added by round-1 of the parent task says: *"Single-flight coalescing: getOrSet deduplicates concurrent same-key fetcher invocations..."* and then frames the coalescing layer as a property of the class. A reader will reasonably expect `getOrSetSWR` to behave the same way. The docblock raises an expectation that the cold-path doesn't currently deliver.

### Exposure

SWR callers hit the cold-path after `invalidatePrefix` or `clearVolatile` runs (block-change cache clears in PEvO's reputation cycle, claim mutations, paper edits), or on first cold start. The N-concurrent-callers-against-cold-key burst pattern is real under PEvO's caching workload.

## Goal

Extend the single-flight `inflight` Map pattern from `getOrSet` to `getOrSetSWR`'s cold-path. After this change, both `getOrSet` and `getOrSetSWR` deliver on the class-level coalescing promise. The two methods can share the same `this.inflight` Map (keys are fully prefixed and unique per cache instance).

## Acceptance

### 1. `getOrSetSWR` cold-path uses `this.inflight`

`backend/src/cache.ts` `getOrSetSWR` method:
- On cold-path (both fresh and stale `get` return undefined), check `this.inflight.get(inflightKey)` before invoking `fn()`. If present, `return await` that promise.
- If absent, create a self-cleaning promise wrapping `fn()`, store in `this.inflight`, await it, write to cache on non-null, delete the in-flight slot in `finally`. Mirror the `getOrSet` shape.

### 2. Coordination with the stale-warm `revalidating` guard

The existing `revalidating` Set is for the background-refresh path (stale data present + TTL expired → return stale immediately + refresh in background). The new cold-path single-flight uses `this.inflight` (the same Map as `getOrSet`). These two coordination primitives serve different paths and do NOT need to be merged — keep them separate, document the distinction in the `getOrSetSWR` JSDoc.

### 3. Round-2 fix from the parent task lands first

This task depends on `backend-cache-single-flight-coalescing` round-2 landing the epoch-counter invalidation-race fix (hold item 1 in the parent's round-2 hold block). Once the epoch counter is in place, this task's cold-path single-flight inherits it for free: the same `capturedEpoch !== this.epoch` skip-on-resolution check applies. Sequencing: do NOT start this task until the parent's round-2 fix is archived.

### 4. Tests

`backend/tests/lib/cache.test.ts` — add 4 new specs in a new describe block `'QueryCache.getOrSetSWR — single-flight coalescing on cold-path'`:
- **Coalesce N concurrent cold-path misses → 1 fetcher invocation.** Mirror the `getOrSet` cold-path coalesce spec. Fetcher invoked exactly once; all N awaiters receive the same value.
- **Null resolution clears the in-flight slot.** Mirror the `getOrSet` null-skip spec. Next wave's fetcher invokes fresh.
- **Throw clears the in-flight slot.** Next call retries with a fresh fetcher.
- **Stale-warm path is unaffected.** Existing stale-warm + revalidating-Set behavior continues to work; the new cold-path coalescing does not interfere. Use a 2-step test: warm cache + expire TTL + concurrent calls → all receive stale data + ONE background refresh fires (via existing `revalidating` Set).

### 5. Verification

`npm run typecheck` clean. `npm run lint` clean for this change. Scoped vitest on `tests/lib/cache.test.ts` passes (4 new specs + the existing `getOrSet` single-flight specs unaffected). Existing `getOrSetSWR` callers (reputation, WoT vouch, stats — any cache instance using SWR) continue to pass their integration tests.

### 6. Docblock update

Class-level docblock and both `getOrSet` + `getOrSetSWR` JSDoc clarify that single-flight coalescing applies to BOTH methods (per-method language). Honest framing on the TOCTOU degradation under Redis backend per the parent task's round-2 hold item 2 should apply equally to `getOrSetSWR`.

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

[BLOCKED by Architect] 2026-05-21 — Acceptance #3 explicitly requires the parent task `backend-cache-single-flight-coalescing` round-2 fix to be **archived** before this task starts. Parent's round-2 fix is in code (commit `d6e23014` — epoch counter, TOCTOU docblock, citation) and the parent task file is sitting in `agents/docs/tasks/review/backend-cache-single-flight-coalescing.md` awaiting architect re-review and archive. Unblock once architect archives the parent (or, if architect re-review finds round-3 holds, when the parent ultimately archives). Moving to `blocked/` per `feedback_held_task_blocked_on_architect.md` — held tasks whose resolution depends on architect input go to `blocked/`, not `pending/`.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

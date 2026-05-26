---
title: "Single-flight coalescing amplifies cache invalidation race; capture an epoch and skip the write on invalidation between fetcher-start and resolve"
date: 2026-05-20
last_refreshed: 2026-05-26
category: conventions
module: backend/src/cache.ts
problem_type: convention
component: caching
severity: high
applies_when:
  - "Adding in-process single-flight (promise coalescing) to any cache method that already exposes `invalidate*`/`clear*` mutation paths"
  - "Extending the existing `inflight` Map pattern from `QueryCache.getOrSet` to a sibling method (e.g., `QueryCache.getOrSetSWR` cold-path)"
  - "Reviewing a cache primitive where coalesced fetchers can outlive a flush call issued after they were initiated"
  - "Any cache instance with `stable: true` entries (long TTL) where a stale post-invalidation write would persist for minutes-to-hours"
tags:
  - caching
  - single-flight
  - coalescing
  - invalidation
  - race-condition
  - epoch-counter
  - per-tier-epoch
  - scan-multi-round-delete
  - QueryCache
---

# Single-flight coalescing amplifies cache invalidation race; capture an epoch and skip the write on invalidation between fetcher-start and resolve

## Context

`QueryCache.getOrSet` in `backend/src/cache.ts` gained in-process single-flight coalescing in commit `623bee26` (parent task `backend-cache-single-flight-coalescing` round-1): concurrent same-key cache misses now share ONE fetcher invocation via a `Map<prefixedKey, Promise<T|null>>` (`this.inflight`). This correctly closes the per-request DoS amplifier where N concurrent readers each fired their own walker. /ce-code-review's adversarial pass surfaced that the win comes with a hidden cost: coalescing AMPLIFIES the invalidate-during-fetch race rather than reducing it. Pre-fix the race was per-fetcher (bounded — at most one fetcher's snapshot could race an invalidate); post-fix the race is per-key-wave (one stale write outlives many readers for the full TTL). No discipline existed for skipping the cache write when an invalidation fires between fetcher-start and fetcher-resolve. This entry codifies that discipline as a convention so future single-flight additions (e.g., the pending `backend-cache-single-flight-coalescing-swr-cold-path` extension to `getOrSetSWR`) carry the guard.

The epoch primitive evolved twice after round-1, and the current HEAD shape is what this entry now documents:

1. **A single shared `epoch` was split into per-tier counters `volatileEpoch` and `stableEpoch`.** A shared counter let `clearVolatile()` — which fires on every ~3s Hive block tick and deletes ONLY non-stable entries — suppress the cache write of an in-flight STABLE fetcher (e.g., `reputation_weights`, `disciplines`) that captured the epoch before the tick. That defeated the `stable: true` contract: under any concurrency, stable entries went cold on every block. The fix is a counter per tier; the `getOrSet` gate keys a stable entry on `stableEpoch` only and a non-stable entry on both.
2. **Single-shot deletes and multi-round SCAN-loop deletes need different bump shapes.** When `clear()`/`clearVolatile()`/`invalidatePrefix()` switched from a blocking `redis.keys()` to a non-blocking SCAN cursor loop (task `backend-cache-keys-scan-and-invalidateprefix-race`), their delete phase became non-atomic — multiple awaits. A fetcher that registers DURING the loop captures the post-before-bump epoch and would pass its gate on resolution. So those three methods bump their tier's epoch(s) BOTH before AND after the sweep. `invalidate(key)` is a genuine single-shot (`one del`) and keeps a single before-bump.

## Guidance

Any `QueryCache` method that introduces single-flight coalescing MUST capture the invalidation epoch(s) at fetcher-start and skip `this.set` if the relevant counter changed by the time the fetcher resolves. The resolved value is still returned to all coalesced callers; only the cache backfill is suppressed. The next reader after the skipped write is a cache miss and triggers a fresh fetcher that captures the post-invalidation epoch.

Two design rules harden the basic guard:

- **Per-tier counters, not one.** Use `volatileEpoch` and `stableEpoch`. A stable-tier in-flight fetcher gates on `stableEpoch` only; a non-stable fetcher gates on both. This is what lets `clearVolatile()` (which never deletes stable entries) avoid suppressing in-flight stable writes on every block tick.
- **Bracket multi-round deletes before AND after; single-shot deletes only before.** A delete that spans multiple awaits (a SCAN cursor loop) opens a mid-loop registration window — a fetcher that registers after the before-bump captures the already-advanced epoch and would pass its gate. The after-bump advances past that captured value. A single-command delete (`invalidate(key)`, one `del`) has no such window and needs only a before-bump.

```typescript
export class QueryCache {
  private inflight = new Map<string, Promise<unknown>>();
  // Per-tier invalidation epochs. clearVolatile() (3s block tick) deletes
  // only non-stable entries, so it bumps ONLY volatileEpoch; bumping
  // stableEpoch there would suppress in-flight STABLE writes and break the
  // `stable: true` contract.
  private volatileEpoch = 0;
  private stableEpoch = 0;

  // Single-shot delete: one `del`, no mid-flight window -> bump once, before.
  async invalidate(key: string): Promise<void> {
    this.volatileEpoch++;  // targets a specific key regardless of tier,
    this.stableEpoch++;    // so bump BOTH before deleting.
    this.memStore.delete(key);
    // ... single Redis del ...
  }

  // Multi-round SCAN-loop deletes: bump the tier's epoch(s) BEFORE and AFTER
  // the sweep. Before suppresses fetchers started before the call; after
  // suppresses fetchers registered DURING the loop that resolve after it.
  async invalidatePrefix(keyPrefix: string): Promise<void> {
    this.volatileEpoch++; this.stableEpoch++;          // before
    await this.scanAndDeleteKeys(redis, keyPrefix);    // multi-round
    this.volatileEpoch++; this.stableEpoch++;          // after
  }

  async clearVolatile(): Promise<void> {
    this.volatileEpoch++;                                       // before (volatile only)
    await this.scanAndDeleteKeys(redis, '', (k) => !this.stableKeys.has(k));
    this.volatileEpoch++;                                       // after (volatile only)
  }

  async clear(): Promise<void> {
    this.volatileEpoch++; this.stableEpoch++;          // before
    await this.scanAndDeleteKeys(redis, '');           // multi-round
    this.volatileEpoch++; this.stableEpoch++;          // after
  }

  async getOrSet<T>(
    key: string,
    fn: () => Promise<T>,
    ttlMs?: number,
    stable = false,
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    const inflightKey = this.prefix + key;
    const existing = this.inflight.get(inflightKey) as Promise<T> | undefined;
    if (existing !== undefined) return existing;

    // Capture BOTH epochs BEFORE registering the promise.
    const capturedVolatileEpoch = this.volatileEpoch;
    const capturedStableEpoch = this.stableEpoch;

    const promise = (async (): Promise<T> => {
      try {
        const data = await fn();
        // Stable entry: only stableEpoch must be unchanged (a concurrent
        // clearVolatile() bumps only volatileEpoch and never deletes stable
        // entries, so it must not suppress this write). Non-stable: both.
        const notInvalidated = stable
          ? capturedStableEpoch === this.stableEpoch
          : capturedVolatileEpoch === this.volatileEpoch &&
            capturedStableEpoch === this.stableEpoch;
        if (data !== null && data !== undefined && notInvalidated) {
          await this.set(key, data, ttlMs, stable);
        }
        return data;
      } finally {
        this.inflight.delete(inflightKey);
      }
    })();

    this.inflight.set(inflightKey, promise);
    return promise;
  }
}
```

Both the `inflight.set` registration AND the `capturedVolatileEpoch`/`capturedStableEpoch` snapshots must execute synchronously in the outer frame BEFORE any `await` yields the event loop. Two callers that both reach `inflight.get → undefined` synchronously (no `await` between the get and the set) can race-cleanly on the `inflight.set` slot; the same applies to the epoch captures.

**Residual window (accepted at single-instance scale).** The before+after bracket closes the two windows it names — fetchers that started before the call, and fetchers registered during the loop that resolve after it. It does NOT close the case where a fetcher both registers AND resolves entirely inside the SCAN loop, before the after-bump. That requires `fn()` (a slow HAF query) to start and finish inside a 1–2-round sub-millisecond local Redis SCAN loop — effectively unreachable at PEvO's single-instance, small-keyspace scale, and self-healing on the next fetch. The method comments correctly do NOT claim this case is closed; do not add a third bump to chase it.

## Why This Matters

Without the epoch guard, the stale-write window is not bounded by the number of concurrent readers; it is bounded by the TTL of the key. For `stable: true` entries (paper detail: 30-minute TTL; claim accept/revoke: 2-minute TTL) a single coalesced fetch that races an invalidation causes every subsequent cache hit to serve stale data until the TTL expires. That is materially worse than the pre-coalescing shape, where at most one fetcher could race the invalidation and later-arriving readers each fired their own fetchers that post-dated the invalidation.

Concrete production exposure without the guard:

- A user edits a paper. `backend/src/routes/papers.ts` invalidates the paperDetailKey with `stable: true`. Concurrent readers who triggered the coalesced fetch before the edit landed receive the old version and cache it for up to 30 minutes. Other users see a version of the paper that no longer exists on-chain.
- A claim is accepted or revoked. `backend/src/routes/claims.ts` invalidates with `stable: true` (2-minute TTL). Coalesced readers cache the pre-action state for up to 2 minutes, during which claim-gated actions misbehave.

Following this convention ensures single-flight coalescing delivers its load-reduction benefit without trading correctness for performance.

## When to Apply

- Whenever single-flight coalescing (an `inflight` Map or equivalent) is added or extended to any `QueryCache` method.
- Specifically when extending single-flight coalescing to `QueryCache.getOrSetSWR`'s cold path: the epoch-counter check must be included in that extension, not deferred. The pending task `backend-cache-single-flight-coalescing-swr-cold-path` carries this requirement.
- The rule is: "Any cache method that adds single-flight coalescing must also skip the `cache.set` write on invalidation between fetcher-start and fetcher-resolve."
- Does NOT apply to cache methods without single-flight coalescing. The original per-fetcher race (bounded) is acceptable for standalone-fetcher paths; the amplification only kicks in once N callers share one fetcher.
- When converting a single-shot delete to a multi-round SCAN-loop delete (or adding any new multi-round invalidation method), bump the tier's epoch(s) both before AND after the sweep — a before-only bump reopens the mid-loop registration window.
- Applies only within the in-process boundary. PEvO is single-instance forever, so the in-process per-tier `volatileEpoch`/`stableEpoch` counters are the correct primitive. A horizontal-scale deployment would need cross-process epoch coordination (e.g., Redis pubsub), but that scenario is out of scope.

## Examples

**Before** (single-flight added without epoch guard; amplified stale-write race):

```typescript
async getOrSet<T>(key: string, fn: () => Promise<T>, ttlMs?: number, stable = false): Promise<T> {
  const cached = await this.get<T>(key);
  if (cached !== undefined) return cached;

  const inflightKey = this.prefix + key;
  const existing = this.inflight.get(inflightKey) as Promise<T> | undefined;
  if (existing !== undefined) return existing;

  const promise = (async (): Promise<T> => {
    try {
      const data = await fn();
      // BUG: no epoch check. If invalidate() fired while fn() ran,
      // this write overwrites the cleared entry with a stale snapshot.
      // All N coalesced readers get the stale value for the full TTL.
      if (data !== null && data !== undefined) {
        await this.set(key, data, ttlMs, stable);
      }
      return data;
    } finally {
      this.inflight.delete(inflightKey);
    }
  })();

  this.inflight.set(inflightKey, promise);
  return promise;
}
```

**After** (per-tier epoch guard; stale write suppressed, callers still receive the resolved value):

```typescript
private volatileEpoch = 0;
private stableEpoch = 0;

async invalidate(key: string): Promise<void> {
  this.volatileEpoch++;
  this.stableEpoch++;
  this.memStore.delete(key);
  // ... single Redis del ...
}

async getOrSet<T>(key: string, fn: () => Promise<T>, ttlMs?: number, stable = false): Promise<T> {
  const cached = await this.get<T>(key);
  if (cached !== undefined) return cached;

  const inflightKey = this.prefix + key;
  const existing = this.inflight.get(inflightKey) as Promise<T> | undefined;
  if (existing !== undefined) return existing;

  const capturedVolatileEpoch = this.volatileEpoch;
  const capturedStableEpoch = this.stableEpoch;

  const promise = (async (): Promise<T> => {
    try {
      const data = await fn();
      const notInvalidated = stable
        ? capturedStableEpoch === this.stableEpoch
        : capturedVolatileEpoch === this.volatileEpoch &&
          capturedStableEpoch === this.stableEpoch;
      if (data !== null && data !== undefined && notInvalidated) {
        await this.set(key, data, ttlMs, stable);
      }
      return data;
    } finally {
      this.inflight.delete(inflightKey);
    }
  })();

  this.inflight.set(inflightKey, promise);
  return promise;
}
```

Outcome of the fix: when a paper edit invalidates `paperDetailKey` while a coalesced fetch is in flight, the fetcher resolves and returns data to its N callers, but writes nothing to the cache. The next reader is a cache miss, fires a fresh fetcher that captures the new epoch, and writes the post-edit snapshot. The stale window drops from up to 30 minutes (full TTL) to zero cache-hit reads after the invalidation. Critically, the converse must ALSO hold: a `clearVolatile()` block tick (which bumps only `volatileEpoch`) must NOT suppress an in-flight STABLE fetcher's write — otherwise stable entries go cold every 3 seconds under load. The per-tier split is what delivers both directions; pin all four tier×operation combinations with mutation-kill specs (a dropped counter bump or a mis-wired gate conjunct must turn a spec RED).

## Related

- [[caching-wrapper-discriminated-union-poisoning-2026-05-11]] — sibling convention covering the cache-poisoning-by-write failure class in the same `QueryCache.getOrSet` primitive. Together the two docs bracket "what goes wrong on cache write" (writes wrong value vs writes pre-invalidation snapshot).
- [[per-request-memo-catch-block-negative-cache-contract-2026-05-06]] — per-request memoization counterpart: same amplification-under-degradation framing but at the within-request layer rather than the cross-request TTL layer. The three docs together form the caching-discipline triad for PEvO.
- [[read-then-write-races-on-haf-backed-routes-2026-05-15]] — HAF-lag read-then-write race family. Shares the "invalidation window" concept and the principle that cache writes must not re-anchor stale state after an explicit flush.
- [[synchronous-flag-before-await-idempotency-guard-2026-05-16]] — structural parallel: the `inflight.set` registration AND the `capturedEpoch` snapshot must execute synchronously before the fetcher `await` to be race-free.
- [[concurrency-wire-shape-assertions-mutation-blind-under-microtask-fifo-2026-05-19]] — test-design guidance: the `inflight` Map and `epoch` counter are shared singletons; pin the invalidation-during-flight invariant by reference-equality + spy anchoring, not by outcome-count assertions alone.

---
title: "Single-flight coalescing amplifies cache invalidation race; capture an epoch and skip the write on invalidation between fetcher-start and resolve"
date: 2026-05-20
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
  - QueryCache
---

# Single-flight coalescing amplifies cache invalidation race; capture an epoch and skip the write on invalidation between fetcher-start and resolve

## Context

`QueryCache.getOrSet` in `backend/src/cache.ts` gained in-process single-flight coalescing in commit `623bee26` (parent task `backend-cache-single-flight-coalescing` round-1): concurrent same-key cache misses now share ONE fetcher invocation via a `Map<prefixedKey, Promise<T|null>>` (`this.inflight`). This correctly closes the per-request DoS amplifier where N concurrent readers each fired their own walker. /ce-code-review's adversarial pass surfaced that the win comes with a hidden cost: coalescing AMPLIFIES the invalidate-during-fetch race rather than reducing it. Pre-fix the race was per-fetcher (bounded — at most one fetcher's snapshot could race an invalidate); post-fix the race is per-key-wave (one stale write outlives many readers for the full TTL). No discipline existed for skipping the cache write when an invalidation fires between fetcher-start and fetcher-resolve. This entry codifies that discipline as a convention so future single-flight additions (e.g., the pending `backend-cache-single-flight-coalescing-swr-cold-path` extension to `getOrSetSWR`) carry the guard.

## Guidance

Any `QueryCache` method that introduces single-flight coalescing MUST also capture the invalidation epoch at fetcher-start and skip `this.set` if the epoch changes by the time the fetcher resolves. The resolved value is still returned to all coalesced callers; only the cache backfill is suppressed. The next reader after the skipped write is a cache miss and triggers a fresh fetcher that captures the post-invalidation epoch.

```typescript
export class QueryCache {
  private inflight = new Map<string, Promise<unknown>>();
  private epoch = 0;  // bumps on every invalidation

  invalidate(key: string): void {
    this.epoch++;  // bump first, then clear storage
    this.memStore.delete(key);
    // ... existing Redis del logic ...
  }

  invalidatePrefix(prefix: string): void {
    this.epoch++;
    // ... existing prefix-scan logic ...
  }

  clearVolatile(): void {
    this.epoch++;
    // ... existing volatile-clear logic ...
  }

  clear(): void {
    this.epoch++;
    // ... existing full-clear logic ...
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

    const capturedEpoch = this.epoch;  // capture BEFORE registering promise

    const promise = (async (): Promise<T> => {
      try {
        const data = await fn();
        // Skip the cache write if an invalidation fired during the fetch.
        // Callers still receive `data`; only the backfill is suppressed.
        if (data !== null && data !== undefined && capturedEpoch === this.epoch) {
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

Both the `inflight.set` registration AND the `capturedEpoch = this.epoch` snapshot must execute synchronously in the outer frame BEFORE any `await` yields the event loop. Two callers that both reach `inflight.get → undefined` synchronously (no `await` between the get and the set) can race-cleanly on the `inflight.set` slot; the same applies to the epoch capture.

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
- Applies only within the in-process boundary. PEvO is single-instance forever, so the in-process `epoch` counter is the correct primitive. A horizontal-scale deployment would need cross-process epoch coordination (e.g., Redis pubsub), but that scenario is out of scope.

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

**After** (epoch guard; stale write suppressed, callers still receive the resolved value):

```typescript
private epoch = 0;

invalidate(key: string): void {
  this.epoch++;
  this.memStore.delete(key);
  // ... Redis del ...
}

async getOrSet<T>(key: string, fn: () => Promise<T>, ttlMs?: number, stable = false): Promise<T> {
  const cached = await this.get<T>(key);
  if (cached !== undefined) return cached;

  const inflightKey = this.prefix + key;
  const existing = this.inflight.get(inflightKey) as Promise<T> | undefined;
  if (existing !== undefined) return existing;

  const capturedEpoch = this.epoch;

  const promise = (async (): Promise<T> => {
    try {
      const data = await fn();
      if (data !== null && data !== undefined && capturedEpoch === this.epoch) {
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

Outcome of the fix: when a paper edit invalidates `paperDetailKey` while a coalesced fetch is in flight, the fetcher resolves and returns data to its N callers, but writes nothing to the cache. The next reader is a cache miss, fires a fresh fetcher that captures the new epoch, and writes the post-edit snapshot. The stale window drops from up to 30 minutes (full TTL) to zero cache-hit reads after the invalidation.

## Related

- [[caching-wrapper-discriminated-union-poisoning-2026-05-11]] — sibling convention covering the cache-poisoning-by-write failure class in the same `QueryCache.getOrSet` primitive. Together the two docs bracket "what goes wrong on cache write" (writes wrong value vs writes pre-invalidation snapshot).
- [[per-request-memo-catch-block-negative-cache-contract-2026-05-06]] — per-request memoization counterpart: same amplification-under-degradation framing but at the within-request layer rather than the cross-request TTL layer. The three docs together form the caching-discipline triad for PEvO.
- [[read-then-write-races-on-haf-backed-routes-2026-05-15]] — HAF-lag read-then-write race family. Shares the "invalidation window" concept and the principle that cache writes must not re-anchor stale state after an explicit flush.
- [[synchronous-flag-before-await-idempotency-guard-2026-05-16]] — structural parallel: the `inflight.set` registration AND the `capturedEpoch` snapshot must execute synchronously before the fetcher `await` to be race-free.
- [[concurrency-wire-shape-assertions-mutation-blind-under-microtask-fifo-2026-05-19]] — test-design guidance: the `inflight` Map and `epoch` counter are shared singletons; pin the invalidation-during-flight invariant by reference-equality + spy anchoring, not by outcome-count assertions alone.

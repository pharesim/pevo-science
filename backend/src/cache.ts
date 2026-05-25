/**
 * TTL cache with optional Redis backend.
 * Falls back to in-memory Map when Redis is not available.
 *
 * Single-flight coalescing: `getOrSet` deduplicates concurrent same-key
 * fetcher invocations via an in-process `Map<prefixedKey, Promise<T|null>>`.
 * On cache miss, the first caller's fetcher runs once; concurrent callers
 * for the same key await that same promise. Null resolutions are NOT
 * cached (honoring the existing skip-on-null rule) AND the in-flight slot
 * is cleared so the next wave gets a fresh chance. The in-flight slot is
 * also cleared on fetcher rejection so a transient failure does not poison
 * subsequent retries. Independent of Redis: the coalescing layer is an
 * in-process coordination primitive and works whether the cache backend is
 * Redis or the in-memory fallback.
 *
 * Coalescing strength: this primitive eliminates duplicate fetcher
 * invocations within an event-loop tick (concurrent callers that arrive
 * at `getOrSet` synchronously, before any `await` resolves). Under the
 * Redis backend, the `await this.get(key)` probe is an async network
 * roundtrip (~1-5ms); two callers can both miss, both find the in-flight
 * map empty (neither has reached `this.inflight.set` yet), and both
 * create fetcher promises. The second `inflight.set` overwrites the
 * first; both fetchers run to completion. Net effect: coalescing is
 * complete for within-tick concurrency, and *reduces* duplication for
 * concurrent cache-miss probes under the Redis backend (one fetcher
 * runs instead of N). Correctness is preserved in both regimes.
 *
 * Invalidation-during-flight: an in-flight fetcher that started BEFORE
 * an `invalidate*` / `clear*` call must not silently re-cache its
 * pre-invalidation snapshot on resolution. Two per-tier epoch counters
 * — `volatileEpoch` and `stableEpoch` — track invalidations by the tier
 * they actually flush. `clearVolatile()` (the 3s block-watcher tick)
 * deletes only non-stable entries, so it bumps ONLY `volatileEpoch`;
 * stable entries it never touches must keep their in-flight writes.
 * `clear()` flushes everything, so it bumps BOTH. `invalidate(key)` and
 * `invalidatePrefix(prefix)` target specific keys regardless of
 * stable-ness, so they bump BOTH. `getOrSet` captures both counters at
 * fetcher start; on resolution it gates its cache-write on the counter(s)
 * relevant to the entry's tier: a non-stable entry requires BOTH counters
 * unchanged, a stable entry requires only `stableEpoch` unchanged (a
 * concurrent `clearVolatile()` advancing `volatileEpoch` must not suppress
 * the stable write). In-flight callers still receive the resolved value
 * (the request that triggered the fetcher gets data), but the cache stays
 * cold for the affected tier so the next caller picks up fresh
 * post-invalidation data.
 */
import { getRedis } from './redis.js';
import { config } from './config.js';
import { logger } from './logger.js';

interface MemoryCacheEntry<T> {
  data: T;
  expiresAt: number;
  stable: boolean;
}

export class QueryCache {
  private memStore = new Map<string, MemoryCacheEntry<unknown>>();
  private stableKeys = new Set<string>();
  // Single-flight: in-flight fetcher promises keyed by the prefixed cache
  // key (`${config.appTag}:cache:<routeKey>`). See class-level docblock.
  private inflight = new Map<string, Promise<unknown>>();
  // Per-tier invalidation epochs. `volatileEpoch` is bumped by every
  // method that flushes non-stable entries (`clearVolatile`, plus
  // `clear`/`invalidate`/`invalidatePrefix` which can target either tier).
  // `stableEpoch` is bumped only by methods that flush stable entries
  // (`clear`/`invalidate`/`invalidatePrefix` — NOT `clearVolatile`, which
  // never deletes stable entries). `getOrSet` captures both at fetcher
  // start and gates its cache-write on the counter(s) for the entry's
  // tier. See class-level docblock.
  private volatileEpoch = 0;
  private stableEpoch = 0;
  private defaultTtlMs: number;
  private prefix: string;

  constructor(defaultTtlMs = 30_000, prefix = 'cache:') {
    this.defaultTtlMs = defaultTtlMs;
    this.prefix = `${config.appTag}:${prefix}`;

    const interval = setInterval(() => this.evictMemory(), 60_000);
    interval.unref();
  }

  async get<T>(key: string): Promise<T | undefined> {
    const redis = getRedis();
    if (redis) {
      try {
        const val = await redis.get(this.prefix + key);
        if (val) return JSON.parse(val) as T;
        return undefined;
      } catch (err) {
        logger.debug({ err, key }, 'Redis cache get failed, falling back to memory');
      }
    }
    const entry = this.memStore.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.memStore.delete(key);
      return undefined;
    }
    return entry.data as T;
  }

  async set<T>(key: string, data: T, ttlMs?: number, stable = false): Promise<void> {
    const ttl = ttlMs ?? this.defaultTtlMs;
    if (stable) this.stableKeys.add(key);
    const redis = getRedis();
    if (redis) {
      try {
        await redis.set(this.prefix + key, JSON.stringify(data), 'PX', ttl);
        return;
      } catch (err) {
        logger.debug({ err, key }, 'Redis cache set failed, falling back to memory');
      }
    }
    this.memStore.set(key, { data, expiresAt: Date.now() + ttl, stable });
  }

  /**
   * Get or compute a cached value.
   *
   * Single-flight: concurrent callers for the same `key` that arrive
   * synchronously (same event-loop tick) share ONE fetcher invocation.
   * The first miss creates a promise, stores it in `this.inflight`,
   * awaits it, writes the result to the cache (if non-null and the
   * epoch hasn't advanced), and clears the in-flight slot. Subsequent
   * concurrent callers find the existing promise and await it directly.
   * Null resolutions are not cached AND clear the in-flight slot so the
   * next wave retries fresh. Rejections also clear the slot to avoid
   * poisoning subsequent attempts.
   *
   * Under the Redis backend, the `await this.get(key)` probe is async;
   * two callers can race past the in-flight check during cache-miss
   * probes and both create fetchers. Coalescing is complete within a
   * tick and reduces (does not eliminate) duplication during the
   * Redis-probe window. See class-level docblock.
   *
   * Invalidation-during-flight: the per-tier epochs captured at fetcher
   * start are compared on resolution. A non-stable entry skips its
   * cache-write if EITHER `volatileEpoch` or `stableEpoch` advanced; a
   * stable entry skips only if `stableEpoch` advanced (so a concurrent
   * `clearVolatile()` block tick, which bumps only `volatileEpoch`, does
   * not suppress a stable write the volatile flush never touched). See
   * class-level docblock.
   *
   * @param stable - If true, this entry survives block-change cache clears (use for slow-changing data like reputation, WoT threshold, stats).
   */
  async getOrSet<T>(key: string, fn: () => Promise<T>, ttlMs?: number, stable = false): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    // Single-flight: if another caller is already fetching this key,
    // await their promise instead of starting a duplicate fetch.
    const inflightKey = this.prefix + key;
    const existing = this.inflight.get(inflightKey) as Promise<T> | undefined;
    if (existing !== undefined) {
      return existing;
    }

    // Capture both per-tier epochs at fetcher start. On resolution the
    // cache-write is gated on the counter(s) for this entry's tier:
    //   - stable entry: only `stableEpoch` must be unchanged (a
    //     concurrent `clearVolatile()` bumps only `volatileEpoch` and
    //     never deletes stable entries, so it must not suppress this
    //     write).
    //   - non-stable entry: BOTH counters must be unchanged.
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
        // Clear the slot in ALL terminal states (success, null-resolution,
        // rejection) so the next wave is not stuck on a stale promise:
        //   - null-resolution: matches the skip-cache-on-null rule above,
        //     so a recovery wave can retry the fetcher.
        //   - rejection: a transient failure must not poison subsequent
        //     callers.
        //   - success (non-null): future callers will hit the cache and
        //     never look at this map, so cleanup is for memory hygiene.
        this.inflight.delete(inflightKey);
      }
    })();
    this.inflight.set(inflightKey, promise);
    return promise;
  }

  /**
   * Stale-while-revalidate: returns stale data instantly when fresh cache
   * expires, while triggering a background refresh.
   */
  async getOrSetSWR<T>(
    key: string,
    fn: () => Promise<T>,
    ttlMs?: number,
    staleMs = 300_000,
    stable = false,
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    const staleKey = `swr:${key}`;
    const stale = await this.get<T>(staleKey);
    if (stale !== undefined) {
      void this.revalidate(key, staleKey, fn, ttlMs, staleMs, stable);
      return stale;
    }

    const data = await fn();
    if (data !== null && data !== undefined) {
      await this.set(key, data, ttlMs, stable);
      await this.set(staleKey, data, staleMs, stable);
    }
    return data;
  }

  private revalidating = new Set<string>();

  private async revalidate<T>(
    key: string,
    staleKey: string,
    fn: () => Promise<T>,
    ttlMs?: number,
    staleMs?: number,
    stable?: boolean,
  ): Promise<void> {
    if (this.revalidating.has(key)) return;
    this.revalidating.add(key);
    try {
      const data = await fn();
      if (data !== null && data !== undefined) {
        await this.set(key, data, ttlMs, stable);
        await this.set(staleKey, data, staleMs, stable);
      }
    } catch (err) {
      logger.debug({ err, key }, 'SWR revalidation failed');
    } finally {
      this.revalidating.delete(key);
    }
  }

  async invalidate(key: string): Promise<void> {
    // Bump BOTH epochs BEFORE the actual delete: `invalidate(key)`
    // targets a specific key regardless of its tier, so an in-flight
    // fetcher for that key in either tier must skip its cache-write.
    // Ordering matters: a fetcher resolving with a pre-bump captured
    // epoch but writing after the bump-and-delete would otherwise undo
    // the flush silently.
    this.volatileEpoch++;
    this.stableEpoch++;
    const redis = getRedis();
    if (redis) {
      try { await redis.del(this.prefix + key); } catch (err) { logger.debug({ err, key }, 'Redis cache invalidate failed'); }
    }
    this.memStore.delete(key);

    // If a periodic refresh is registered, trigger a background reload
    const entry = this.periodicEntries.get(key);
    if (entry) {
      entry.reload().catch((err) => logger.debug({ err, key }, 'Background reload after invalidate failed'));
    }
  }

  /**
   * Invalidate every cache key whose unprefixed name starts with `keyPrefix`.
   * Uses Redis SCAN (non-blocking) when Redis is the backend; falls back to
   * an in-memory prefix scan otherwise. Use for invalidating versioned key
   * families (e.g. `paper-detail:author:permlink:v*`) where a single
   * `invalidate(key)` call only flushes one specific key.
   *
   * Note: matched keys are passed through `del` in batches; SCAN cursors a
   * non-blocking iteration so this is safe to call with broad prefixes.
   */
  async invalidatePrefix(keyPrefix: string): Promise<void> {
    // Bump BOTH epochs first so in-flight fetchers under this prefix in
    // either tier skip their cache-writes on resolution (see `invalidate`
    // for ordering rationale and class-level docblock).
    this.volatileEpoch++;
    this.stableEpoch++;
    const fullPrefix = this.prefix + keyPrefix;
    const redis = getRedis();
    if (redis) {
      try {
        let cursor = '0';
        const matched: string[] = [];
        do {
          const [next, batch] = await redis.scan(cursor, 'MATCH', fullPrefix + '*', 'COUNT', 200);
          cursor = next;
          matched.push(...batch);
        } while (cursor !== '0');
        if (matched.length > 0) {
          // Batch deletes to keep DEL command size reasonable.
          const CHUNK = 200;
          for (let i = 0; i < matched.length; i += CHUNK) {
            await redis.del(...matched.slice(i, i + CHUNK));
          }
        }
      } catch (err) {
        logger.debug({ err, keyPrefix }, 'Redis cache invalidatePrefix failed');
      }
    }
    // In-memory mirror: drop every entry whose key starts with `keyPrefix`.
    // (memStore keys are unprefixed.)
    for (const key of Array.from(this.memStore.keys())) {
      if (key.startsWith(keyPrefix)) {
        this.memStore.delete(key);
      }
    }
  }

  private periodicEntries = new Map<string, { reload: () => Promise<void> }>();

  /**
   * Register a key for periodic background refresh.
   * Loads immediately (returns a promise for the initial load),
   * then reloads every `intervalMs` in the background.
   * Calling `invalidate(key)` also triggers an immediate background reload.
   */
  async registerPeriodicRefresh<T>(key: string, fn: () => Promise<T>, intervalMs: number, stable = true): Promise<void> {
    const reload = async () => {
      try {
        const data = await fn();
        if (data !== null && data !== undefined) {
          await this.set(key, data, intervalMs * 2, stable);
        }
      } catch (err) {
        logger.warn({ err, key }, 'Periodic cache refresh failed');
      }
    };

    this.periodicEntries.set(key, { reload });

    // Initial load (awaited so callers can block on it)
    await reload();

    // Periodic refresh
    const timer = setInterval(reload, intervalMs);
    timer.unref();
  }

  /** Clear ALL entries including stable ones. */
  async clear(): Promise<void> {
    // Bump BOTH epochs first: `clear()` flushes every tier, so in-flight
    // fetchers for stable AND non-stable entries must skip their
    // cache-writes on resolution (see `invalidate` for ordering rationale).
    this.volatileEpoch++;
    this.stableEpoch++;
    const redis = getRedis();
    if (redis) {
      try {
        const keys = await redis.keys(this.prefix + '*');
        if (keys.length > 0) await redis.del(...keys);
      } catch (err) { logger.debug({ err }, 'Redis cache clear failed'); }
    }
    this.memStore.clear();
    this.stableKeys.clear();
  }

  /** Clear only volatile (non-stable) entries. Called on new block. */
  async clearVolatile(): Promise<void> {
    // Bump ONLY `volatileEpoch` first: this method deletes only non-stable
    // entries, so an in-flight fetcher for a STABLE key (whose entry is
    // never touched here) must still be allowed to write on resolution.
    // Bumping `stableEpoch` here would suppress stable writes on every 3s
    // block-watcher tick, defeating the `stable: true` contract under load
    // (see `invalidate` for ordering rationale).
    this.volatileEpoch++;
    const redis = getRedis();
    if (redis) {
      try {
        const keys = await redis.keys(this.prefix + '*');
        const toDelete = keys.filter((k) => !this.stableKeys.has(k.slice(this.prefix.length)));
        if (toDelete.length > 0) await redis.del(...toDelete);
      } catch (err) { logger.debug({ err }, 'Redis cache clearVolatile failed'); }
    }
    for (const [key, entry] of this.memStore) {
      if (!entry.stable) this.memStore.delete(key);
    }
  }

  get size(): number {
    return this.memStore.size;
  }

  private evictMemory(): void {
    const now = Date.now();
    for (const [key, entry] of this.memStore) {
      if (now > entry.expiresAt) this.memStore.delete(key);
    }
  }
}

/** Shared cache instance for HAF queries. 30s default TTL. */
export const hafCache = new QueryCache(30_000);

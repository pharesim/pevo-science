/**
 * TTL cache with optional Redis backend.
 * Falls back to in-memory Map when Redis is not available.
 *
 * Single-flight coalescing: `getOrSet` and the `getOrSetSWR` cold-path
 * deduplicate concurrent same-key fetcher invocations via a SHARED in-process
 * `Map<string, Promise<unknown>>` (`this.inflight`); each method casts the
 * retrieved promise to its local `T` on lookup. The two methods use DISTINCT
 * in-flight keys for the same logical cache key — `getOrSet` keys on the
 * prefixed cache key, the `getOrSetSWR` cold-path prefixes a `swr-cold:`
 * segment — so a key used by both methods never coalesces ACROSS them (which
 * would let an SWR caller await a `getOrSet` promise that never writes the
 * stale key, silently disabling stale-while-revalidate); concurrent
 * cold-misses WITHIN a method still share one fetcher. On cache miss (for
 * SWR, when both the fresh and stale keys are absent), the first caller's
 * fetcher runs once; concurrent callers for the same key await that same
 * promise. Null resolutions are NOT cached (honoring the existing skip-on-null
 * rule) AND the in-flight slot is cleared so the next wave gets a fresh
 * chance. The in-flight slot is also cleared on fetcher rejection so a
 * transient failure does not poison subsequent retries. The SWR stale-warm
 * path (stale present, fresh expired) is a SEPARATE concern deduplicated by
 * the `revalidating` Set, not `this.inflight`: it returns stale immediately
 * and fires at most one background `revalidate`. Independent of Redis: the
 * coalescing layer is an in-process coordination primitive and works whether
 * the cache backend is Redis or the in-memory fallback.
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
 * runs instead of N). Correctness is preserved in both regimes. The same
 * TOCTOU window applies to the `getOrSetSWR` cold-path, which has TWO async
 * probes (fresh `key` then `staleKey`) before the in-flight check — a
 * marginally wider window, same correctness guarantee.
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
 * stable-ness, so they bump BOTH. All four success-path `this.set` write
 * sites capture both counters at fetcher start and gate their cache-write on
 * the counter(s) relevant to the entry's tier: `getOrSet`, the `getOrSetSWR`
 * cold-path (both the `key` and `staleKey` writes), the `revalidate`
 * background-refresh helper (both writes), and the `registerPeriodicRefresh`
 * reload closure. A non-stable entry requires BOTH counters unchanged; a
 * stable entry requires only `stableEpoch` unchanged (a concurrent
 * `clearVolatile()` advancing `volatileEpoch` must not suppress the stable
 * write). In-flight callers still receive the resolved value
 * (the request that triggered the fetcher gets data), but the cache stays
 * cold for the affected tier so the next caller picks up fresh
 * post-invalidation data.
 *
 * Single-shot vs multi-round deletes: `invalidate(key)` deletes one key in
 * a single command, so one bump (before the delete) suffices — there is no
 * window during which a fetcher can register against the post-bump epoch.
 * `clear()`, `clearVolatile()`, and `invalidatePrefix()` delete via a
 * non-blocking SCAN cursor loop spanning multiple awaits; a fetcher that
 * registers DURING that loop captures the post-before-bump epoch and would
 * pass its gate on resolution. These three bump their tier's epoch(s) both
 * BEFORE and AFTER the sweep: the before-bump suppresses fetchers that
 * started before the call (even if they resolve mid-loop after their key
 * was deleted), and the after-bump suppresses fetchers registered during
 * the loop that resolve after it completes.
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
  // never deletes stable entries). All four success-path write sites —
  // `getOrSet`, the `getOrSetSWR` cold-path, the `revalidate` helper, and the
  // `registerPeriodicRefresh` reload closure — capture both at fetcher start
  // and gate their cache-write on the counter(s) for the entry's tier. See
  // class-level docblock.
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
   *
   * Single-flight: the COLD-path (both the fresh `key` and the `staleKey`
   * absent — true cold start, post-`invalidatePrefix`, post-`clearVolatile`,
   * or post-`clear`) shares the same `this.inflight` map as `getOrSet`, so N
   * concurrent cold-path callers for the same key run ONE fetcher and all
   * await it. The stale-warm path (stale present, fresh expired) is a SEPARATE
   * concern guarded by the `revalidating` Set: it returns stale immediately
   * and fires at most one background `revalidate`. The two primitives serve
   * different paths and are intentionally NOT merged — `this.inflight`
   * deduplicates synchronous cold-misses, `revalidating` deduplicates
   * background refreshes.
   *
   * Invalidation-during-flight: the cold-path fetcher captures both per-tier
   * epochs at start and gates BOTH the `key` and `staleKey` writes on the
   * counter(s) for the entry's tier, identically to `getOrSet`. See the
   * class-level docblock.
   *
   * @param stable - If true, this entry survives block-change cache clears.
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

    // Cold-path single-flight: coalesce concurrent cold-misses on the shared
    // in-flight map. The key carries a `swr-cold:` segment so it can NEVER
    // collide with a `getOrSet` in-flight slot for the same logical cache key:
    // the two methods are independently generic and write different things
    // (`getOrSet` writes only the fresh key; this cold-path writes the fresh
    // key AND the stale key), so an SWR caller coalescing onto a `getOrSet`
    // promise would silently skip the stale-key write and disable
    // stale-while-revalidate. Distinct in-flight keys make that collision
    // impossible by construction; concurrent cold-misses within this method
    // still share one fetcher (same namespaced key).
    const inflightKey = `${this.prefix}swr-cold:${key}`;
    const existing = this.inflight.get(inflightKey) as Promise<T> | undefined;
    if (existing !== undefined) {
      return existing;
    }

    // Capture both per-tier epochs at fetcher start; gate the cold-path writes
    // (key + staleKey) on the counter(s) for this entry's tier, mirroring
    // `getOrSet`. The caller still receives the resolved value; only the
    // cache-write is suppressed when an invalidation fired mid-flight.
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
          await this.set(staleKey, data, staleMs, stable);
        }
        return data;
      } finally {
        this.inflight.delete(inflightKey);
      }
    })();
    this.inflight.set(inflightKey, promise);
    return promise;
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
    // Capture both per-tier epochs before the background fetch; gate BOTH the
    // `key` and `staleKey` re-cache writes so an invalidate*/clear* that fires
    // mid-revalidation is not silently undone by writing back the
    // pre-invalidation snapshot. The `staleKey` write is gated on the same
    // condition because callers served from the stale key for the next
    // `staleMs` window must not see a re-cached pre-invalidation snapshot.
    const capturedVolatileEpoch = this.volatileEpoch;
    const capturedStableEpoch = this.stableEpoch;
    try {
      const data = await fn();
      const notInvalidated = stable
        ? capturedStableEpoch === this.stableEpoch
        : capturedVolatileEpoch === this.volatileEpoch &&
          capturedStableEpoch === this.stableEpoch;
      if (data !== null && data !== undefined && notInvalidated) {
        await this.set(key, data, ttlMs, stable);
        await this.set(staleKey, data, staleMs, stable);
      }
    } catch (err) {
      logger.debug({ err, key }, 'SWR revalidation failed');
    } finally {
      this.revalidating.delete(key);
    }
  }

  /**
   * Non-blocking keyspace sweep: enumerate every Redis key matching
   * `${this.prefix}${suffix}*` via a SCAN cursor loop (COUNT 200), then
   * delete the matches in batched DELs. Replaces the O(N) blocking `KEYS`
   * command, which stalls the whole Redis server for the duration of the
   * scan — especially costly in `clearVolatile()`, which fires on every
   * ~3s block tick. `shouldDelete`, when supplied, filters candidates by
   * their unprefixed key name (used by `clearVolatile()` to retain stable
   * entries); when omitted, every match is deleted.
   */
  private async scanAndDeleteKeys(
    redis: NonNullable<ReturnType<typeof getRedis>>,
    suffix: string,
    shouldDelete?: (unprefixedKey: string) => boolean,
  ): Promise<void> {
    let cursor = '0';
    const toDelete: string[] = [];
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', this.prefix + suffix + '*', 'COUNT', 200);
      cursor = next;
      for (const fullKey of batch) {
        if (!shouldDelete || shouldDelete(fullKey.slice(this.prefix.length))) {
          toDelete.push(fullKey);
        }
      }
    } while (cursor !== '0');
    if (toDelete.length > 0) {
      const CHUNK = 200;
      for (let i = 0; i < toDelete.length; i += CHUNK) {
        await redis.del(...toDelete.slice(i, i + CHUNK));
      }
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
    // Bump BOTH epochs before AND after the sweep. Before: in-flight
    // fetchers under this prefix in either tier that started before this
    // call must skip their cache-writes on resolution (see `invalidate`
    // for ordering rationale). After: the Redis delete is a multi-round
    // SCAN loop, so a fetcher registered DURING the loop captures the
    // post-before-bump epoch and would otherwise pass its gate on
    // resolution; the after-bump advances the epoch past that captured
    // value so the mid-loop fetcher's write is suppressed too. Keeping the
    // before-bump (rather than only bumping after) means a fetcher that
    // started before this call is still suppressed even if it resolves
    // mid-loop after its key was deleted. See class-level docblock.
    this.volatileEpoch++;
    this.stableEpoch++;
    const redis = getRedis();
    if (redis) {
      try {
        await this.scanAndDeleteKeys(redis, keyPrefix);
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
    this.volatileEpoch++;
    this.stableEpoch++;
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
      // Capture both per-tier epochs at the START of the reload (before the
      // fetch) and gate the cache-write on the counter(s) for this entry's
      // tier. A clear/clearVolatile/invalidate firing during a periodic-refresh
      // tick must not be undone by re-populating the cleared key with the
      // pre-invalidation snapshot; when it fires, the key stays cold until the
      // next demand-driven cache-fill (or the next reload tick). Periodic
      // refreshes default to `stable: true`, so a `clearVolatile()` block tick
      // (which bumps only `volatileEpoch`) does not suppress the reload write.
      const capturedVolatileEpoch = this.volatileEpoch;
      const capturedStableEpoch = this.stableEpoch;
      try {
        const data = await fn();
        const notInvalidated = stable
          ? capturedStableEpoch === this.stableEpoch
          : capturedVolatileEpoch === this.volatileEpoch &&
            capturedStableEpoch === this.stableEpoch;
        if (data !== null && data !== undefined && notInvalidated) {
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
    // Bump BOTH epochs before AND after the sweep. Before: `clear()`
    // flushes every tier, so in-flight fetchers for stable AND non-stable
    // entries that started before this call must skip their cache-writes
    // (see `invalidate` for ordering rationale). After: the Redis delete is
    // now a multi-round SCAN loop, so a fetcher registered DURING the loop
    // must also be suppressed (see `invalidatePrefix` and the class-level
    // docblock for the multi-round before/after bracket).
    this.volatileEpoch++;
    this.stableEpoch++;
    const redis = getRedis();
    if (redis) {
      try {
        await this.scanAndDeleteKeys(redis, '');
      } catch (err) { logger.debug({ err }, 'Redis cache clear failed'); }
    }
    this.memStore.clear();
    this.stableKeys.clear();
    this.volatileEpoch++;
    this.stableEpoch++;
  }

  /** Clear only volatile (non-stable) entries. Called on new block. */
  async clearVolatile(): Promise<void> {
    // Bump ONLY `volatileEpoch`, before AND after the sweep. This method
    // deletes only non-stable entries, so an in-flight fetcher for a STABLE
    // key (whose entry is never touched here) must still be allowed to
    // write on resolution — bumping `stableEpoch` would suppress stable
    // writes on every ~3s block-watcher tick, defeating the `stable: true`
    // contract under load. Before-bump suppresses non-stable fetchers that
    // started before this call; after-bump suppresses non-stable fetchers
    // registered DURING the multi-round SCAN loop (see `invalidatePrefix`
    // and the class-level docblock for the bracket; `invalidate` for the
    // bump-before ordering).
    this.volatileEpoch++;
    const redis = getRedis();
    if (redis) {
      try {
        await this.scanAndDeleteKeys(redis, '', (k) => !this.stableKeys.has(k));
      } catch (err) { logger.debug({ err }, 'Redis cache clearVolatile failed'); }
    }
    for (const [key, entry] of this.memStore) {
      if (!entry.stable) this.memStore.delete(key);
    }
    this.volatileEpoch++;
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

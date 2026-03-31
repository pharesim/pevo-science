/**
 * TTL cache with optional Redis backend.
 * Falls back to in-memory Map when Redis is not available.
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
  private defaultTtlMs: number;
  private prefix: string;

  constructor(defaultTtlMs = 30_000, prefix = `${config.appTag}:cache:`) {
    this.defaultTtlMs = defaultTtlMs;
    this.prefix = prefix;

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
   * @param stable - If true, this entry survives block-change cache clears (use for slow-changing data like reputation, WoT threshold, stats).
   */
  async getOrSet<T>(key: string, fn: () => Promise<T>, ttlMs?: number, stable = false): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    const data = await fn();
    if (data !== null && data !== undefined) {
      await this.set(key, data, ttlMs, stable);
    }
    return data;
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
      this.revalidate(key, staleKey, fn, ttlMs, staleMs, stable);
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
    const redis = getRedis();
    if (redis) {
      try { await redis.del(this.prefix + key); } catch (err) { logger.debug({ err, key }, 'Redis cache invalidate failed'); }
    }
    this.memStore.delete(key);
  }

  /** Clear ALL entries including stable ones. */
  async clear(): Promise<void> {
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

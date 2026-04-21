import { getRedis } from '../../src/redis.js';
import { config } from '../../src/config.js';

/**
 * Clear rate-limit Redis keys by limiter name prefix.
 *
 * Ready-wait rationale: `getRedis()` returns a client instance before its
 * `connect()` promise resolves, so `isRedisAvailable()` / `redis.status` can
 * transiently be non-`'ready'` during `beforeAll` / `beforeEach`. An older
 * `if (isRedisAvailable())` guard silently no-ops in that window, leaving the
 * rate-limit keys intact and causing the next request to hit 429 — a silent
 * trap for anyone copying the older shape. Poll up to ~1s (20 x 50ms) for the
 * client to reach `'ready'`, then fall through silently if it never does
 * (real Redis-unavailable environment, where the in-memory limiter is in use
 * and this helper cannot reset it anyway — that reset would require a
 * dedicated export from `rateLimit.ts`).
 *
 * Key shape: `${config.appTag}:rl:${name}:*` — must match `rateLimit.ts`.
 */
export async function clearRateLimitKeys(names: string[]): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  for (let i = 0; i < 20 && redis.status !== 'ready'; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (redis.status !== 'ready') return;
  for (const name of names) {
    const keys = await redis.keys(`${config.appTag}:rl:${name}:*`).catch(() => [] as string[]);
    if (keys.length > 0) await redis.del(...keys).catch(() => {});
  }
}

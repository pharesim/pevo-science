/**
 * Global test setup — runs before/after all test files.
 *
 * Flushes stale Redis rate-limit and cache keys so previous test runs
 * don't cause spurious 429s or cache hits.
 * Closes the HAF database pool after tests complete to prevent
 * open handles from keeping the process alive.
 */

import { beforeAll, afterAll } from 'vitest';
import { closeHafPool } from '../src/db.js';
import { getRedis, disconnectRedis } from '../src/redis.js';
import { config } from '../src/config.js';

beforeAll(async () => {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.ping(); // ensure connected
      const rlKeys = await redis.keys(`${config.appTag}:rl:*`);
      const cacheKeys = await redis.keys(`${config.appTag}:cache:*`);
      const allKeys = [...rlKeys, ...cacheKeys];
      if (allKeys.length > 0) await redis.del(...allKeys);
    } catch {
      // Redis not available — tests will use in-memory fallback
    }
  }
});

afterAll(async () => {
  await closeHafPool();
  await disconnectRedis();
});

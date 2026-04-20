/**
 * Global test setup — runs before/after all test files.
 *
 * Flushes every Redis key under this deployment's appTag prefix so previous
 * runs don't cause spurious 429s, cache hits, or stale tokens.
 * Closes the HAF database pool after tests complete to prevent
 * open handles from keeping the process alive.
 */

import { beforeAll, afterAll } from 'vitest';
import { closeHafPool, getPool, isHafAvailable } from '../src/db.js';
import { getRedis, disconnectRedis } from '../src/redis.js';
import { getGenesisBlock } from '../src/hafsql.js';
import { config } from '../src/config.js';

beforeAll(async () => {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.ping();
      const keys = await redis.keys(`${config.appTag}:*`);
      if (keys.length > 0) await redis.del(...keys);
    } catch {
      // Redis not available — tests will use in-memory fallback
    }
  }

  // Warm the PEvO genesis-block cache. Production does this at boot in
  // src/index.ts; createApp() alone does not. Without it every HAF CTE
  // filters `block_num >= 0`, forcing full-history scans that blow the 30s
  // statement timeout on tables like operation_custom_json_view.
  if (isHafAvailable()) {
    const pool = getPool();
    if (pool) {
      try { await getGenesisBlock(pool); } catch { /* HAF unavailable — individual tests will see the failure */ }
    }
  }
});

afterAll(async () => {
  await closeHafPool();
  await disconnectRedis();
});

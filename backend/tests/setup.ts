/**
 * Global test setup — runs before/after all test files.
 *
 * Flushes every Redis key under this deployment's appTag prefix so previous
 * runs don't cause spurious 429s, cache hits, or stale tokens.
 * Closes the HAF database pool after tests complete to prevent
 * open handles from keeping the process alive.
 */

import { beforeAll, afterAll } from 'vitest';
import { closeHafPool, getPool, isHafConfigured } from '../src/db.js';
import { getRedis, disconnectRedis } from '../src/redis.js';
import { getGenesisBlock } from '../src/hafsql.js';
import { config } from '../src/config.js';
import { loadAllScripts } from '../src/lib/redis-scripts.js';

beforeAll(async () => {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.ping();
      const keys = await redis.keys(`${config.appTag}:*`);
      if (keys.length > 0) await redis.del(...keys);
      // The production `ready` handler fires `loadAllScripts` async without
      // awaiting; tests that mock `evalsha`/`eval` need a warm SHA cache by
      // assertion time, so block on it here.
      await loadAllScripts(redis);
    } catch {
      // Redis not available — tests will use in-memory fallback
    }
  }

  // Warm the PEvO genesis-block cache. Production does this at boot in
  // src/index.ts; createApp() alone does not. Without it every HAF CTE
  // filters `block_num >= 0`, forcing full-history scans that blow the 30s
  // statement timeout on tables like operation_custom_json_view.
  if (isHafConfigured()) {
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

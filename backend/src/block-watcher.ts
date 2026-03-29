/**
 * Block watcher — polls HAF for the latest block number and
 * invalidates the query cache when a new block is detected.
 *
 * Hive produces blocks every 3 seconds. We poll every 3 seconds
 * and clear stale cache entries on new blocks. When no new block
 * is found, we back off to 6 seconds to reduce DB load.
 */
import { getPool } from './db.js';
import { hafCache } from './cache.js';
import { logger } from './logger.js';
import { T } from './hafsql.js';

let lastBlock = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

const BASE_INTERVAL_MS = 3_000;
const BACKOFF_INTERVAL_MS = 6_000;
let currentIntervalMs = BASE_INTERVAL_MS;

async function checkBlock(): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    const result = await pool.query(
      `SELECT block_num FROM ${T.blocks} ORDER BY block_num DESC LIMIT 1`,
    );
    const currentBlock = result.rows[0]?.block_num ?? 0;

    if (currentBlock > lastBlock) {
      if (lastBlock > 0) {
        // New block(s) arrived — clear cache
        await hafCache.clearVolatile();
        logger.debug({ lastBlock, currentBlock }, 'Volatile cache invalidated on new block');
      }
      lastBlock = currentBlock;
      currentIntervalMs = BASE_INTERVAL_MS;
    } else {
      // No new block — back off
      currentIntervalMs = BACKOFF_INTERVAL_MS;
    }
  } catch (err) {
    logger.warn({ err }, 'Block watcher poll failed');
    currentIntervalMs = BACKOFF_INTERVAL_MS;
  }

  scheduleNext();
}

function scheduleNext(): void {
  if (timer === null) return; // stopped
  timer = setTimeout(checkBlock, currentIntervalMs);
  timer.unref();
}

export function startBlockWatcher(): void {
  if (timer) return;
  // Use a non-null sentinel so scheduleNext knows we're running
  timer = setTimeout(checkBlock, 0);
  timer.unref();
  logger.info({ intervalMs: BASE_INTERVAL_MS, backoffMs: BACKOFF_INTERVAL_MS }, 'Block watcher started');
}

export function stopBlockWatcher(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export function getLastBlock(): number {
  return lastBlock;
}

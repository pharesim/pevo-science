/**
 * Deterministic cycle-based batch reputation computation.
 *
 * Reputation is computed per block-based cycle (default 28,800 blocks, ~1 day).
 * Each cycle uses the previous cycle's scores as voter weights (no convergence
 * iterations). Results are stored in Redis at `reputation:batch:{username}`
 * (no TTL, overwritten each cycle).
 *
 * Cycle N covers blocks [genesis + N * cycle_blocks, genesis + (N+1) * cycle_blocks).
 */

import { getPool, isHafAvailable } from './db.js';
import { getRedis } from './redis.js';
import { logger } from './logger.js';
import { computeReputationBatch, getActiveAccounts, getReputationWeights } from './reputation.js';
import { getCachedGenesisBlock, T } from './hafsql.js';

const DEFAULT_CHECK_INTERVAL_MS = 60 * 60_000; // 1 hour
const DEFAULT_MAX_DURATION_MS = 30 * 60_000; // 30 minutes

const REDIS_KEY_LAST_CYCLE = 'reputation:cycle:last';

let batchTimer: ReturnType<typeof setInterval> | null = null;
let batchRunning = false;

/**
 * Get the current head block from HAF.
 */
async function getHeadBlock(): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  const result = await pool.query(`SELECT MAX(block_num) AS head FROM ${T.blocks}`, []);
  return Number(result.rows[0]?.head ?? 0);
}

/**
 * Run batch computation, catching up from the last computed cycle to the current one.
 */
export async function runBatchComputation(maxDurationMs = DEFAULT_MAX_DURATION_MS): Promise<void> {
  if (batchRunning) {
    logger.warn('Batch reputation computation already in progress, skipping');
    return;
  }

  batchRunning = true;
  const startTime = Date.now();

  try {
    if (!isHafAvailable()) {
      logger.warn('HAF unavailable, skipping batch reputation computation');
      return;
    }

    const redis = getRedis();
    if (!redis) {
      logger.warn('Redis unavailable, skipping batch reputation computation');
      return;
    }

    const weights = await getReputationWeights();
    const cycleBlocks = weights.cycle_blocks;
    const genesisBlock = getCachedGenesisBlock();
    if (genesisBlock === 0) {
      logger.warn('Genesis block not yet discovered, skipping batch reputation computation');
      return;
    }

    const headBlock = await getHeadBlock();
    if (headBlock === 0) {
      logger.warn('Could not determine head block, skipping batch reputation computation');
      return;
    }

    const currentCycle = Math.floor((headBlock - genesisBlock) / cycleBlocks);
    if (currentCycle < 0) {
      logger.info('Head block is before genesis, nothing to compute');
      return;
    }

    // Read last computed cycle from Redis
    const lastCycleStr = await redis.get(REDIS_KEY_LAST_CYCLE);
    const lastComputedCycle = lastCycleStr !== null ? Number(lastCycleStr) : -1;

    if (lastComputedCycle >= currentCycle) {
      logger.debug({ currentCycle, lastComputedCycle }, 'Batch reputation: already up to date');
      return;
    }

    const startCycle = lastComputedCycle + 1;
    const totalCycles = currentCycle - startCycle + 1;
    logger.info({ startCycle, currentCycle, totalCycles, genesisBlock, cycleBlocks }, 'Batch reputation: computing cycles');

    // Load previous cycle's scores (or empty for bootstrap)
    let prevScores: Record<string, number> = {};
    if (startCycle > 0) {
      // Read existing batch scores from Redis as prev scores
      const keys = await redis.keys('reputation:batch:*');
      if (keys.length > 0) {
        const values = await redis.mget(keys);
        for (let i = 0; i < keys.length; i++) {
          const username = keys[i].replace('reputation:batch:', '');
          if (values[i] !== null) {
            const score = Number(values[i]);
            if (!isNaN(score)) prevScores[username] = score;
          }
        }
      }
    }

    // Process each cycle sequentially
    for (let cycle = startCycle; cycle <= currentCycle; cycle++) {
      if (Date.now() - startTime >= maxDurationMs) {
        logger.warn({ cycle, currentCycle }, 'Batch reputation: time cap reached, stopping');
        break;
      }

      const cycleStart = Date.now();
      const cycleEndBlock = genesisBlock + (cycle + 1) * cycleBlocks;

      const activeAccounts = await getActiveAccounts();
      if (activeAccounts.size === 0) {
        logger.info({ cycle }, 'No active users found, skipping cycle');
        await redis.set(REDIS_KEY_LAST_CYCLE, String(cycle));
        continue;
      }

      const users = [...activeAccounts];
      logger.info({
        cycle,
        totalCycles,
        userCount: users.length,
        cycleEndBlock,
      }, `Computing cycle ${cycle} of ${currentCycle}`);

      // Single query computes all users at once
      const batchResults = await computeReputationBatch(users, prevScores, cycleEndBlock);

      const newScores = new Map<string, number>();
      for (const [username, result] of batchResults) {
        newScores.set(username, result.score);
      }
      const timeCapped = Date.now() - startTime >= maxDurationMs;

      // Store this cycle's scores in Redis
      const pipeline = redis.pipeline();
      for (const [username, score] of newScores) {
        pipeline.set(`reputation:batch:${username}`, String(score));
      }
      pipeline.set(REDIS_KEY_LAST_CYCLE, String(cycle));
      await pipeline.exec();

      // Use this cycle's scores as prev scores for the next cycle
      prevScores = Object.fromEntries(newScores);

      logger.info({
        cycle,
        usersComputed: newScores.size,
        durationMs: Date.now() - cycleStart,
        timeCapped,
      }, 'Batch reputation cycle complete');

      if (timeCapped) break;
    }

    logger.info({
      totalDurationMs: Date.now() - startTime,
    }, 'Batch reputation computation complete');
  } catch (err) {
    logger.error({ err }, 'Batch reputation computation failed');
  } finally {
    batchRunning = false;
  }
}

/**
 * Start the periodic batch computation job.
 * Runs immediately on startup, then checks for new cycles on a regular interval.
 */
export function startBatchReputation(intervalMs = DEFAULT_CHECK_INTERVAL_MS): void {
  if (batchTimer) return;

  // Run first batch after a short delay to let the app fully initialize
  setTimeout(() => {
    runBatchComputation().catch((err) => {
      logger.error({ err }, 'Initial batch reputation computation failed');
    });
  }, 10_000);

  batchTimer = setInterval(() => {
    runBatchComputation().catch((err) => {
      logger.error({ err }, 'Periodic batch reputation computation failed');
    });
  }, intervalMs);
  batchTimer.unref();

  logger.info({ intervalMs }, 'Batch reputation job scheduled');
}

/**
 * Stop the periodic batch computation job.
 */
export function stopBatchReputation(): void {
  if (batchTimer) {
    clearInterval(batchTimer);
    batchTimer = null;
    logger.info('Batch reputation job stopped');
  }
}

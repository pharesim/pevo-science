/**
 * Deterministic cycle-based batch reputation computation.
 *
 * Reputation is computed per block-based cycle (default 28,800 blocks, ~1 day).
 * Each cycle uses the previous cycle's scores as voter weights (no convergence
 * iterations). Results are stored in Redis at
 * `${appTag}:reputation:batch:{username}` (no TTL) as JSON-encoded
 * `ReputationScore` ({score, breakdown}).
 *
 * Atomic cycle swap: each cycle stages its values under
 * `${appTag}:reputation:batch:staging:{username}`, then a single Lua script
 * RENAMEs every staging key into its production counterpart and bumps
 * `${appTag}:reputation:cycle:last`. Readers see either the full new cycle
 * or none of it.
 *
 * Cycle N covers blocks [genesis + N * cycle_blocks, genesis + (N+1) * cycle_blocks).
 */

import type Redis from 'ioredis';
import { getPool, isHafAvailable } from './db.js';
import { getRedis } from './redis.js';
import { config } from './config.js';
import { logger } from './logger.js';
import {
  BATCH_KEY_PREFIX,
  computeReputationBatch,
  getReputationWeights,
  parseBatchValue,
} from './reputation.js';
import { getAllAccreditedAccounts } from './accreditation.js';
import { getCachedGenesisBlock, T } from './hafsql.js';

const DEFAULT_CHECK_INTERVAL_MS = 60 * 60_000; // 1 hour
const DEFAULT_MAX_DURATION_MS = 30 * 60_000; // 30 minutes

const REDIS_KEY_LAST_CYCLE = `${config.appTag}:reputation:cycle:last`;
const REDIS_KEY_STAGING_PREFIX = `${config.appTag}:reputation:batch:staging:`;

let batchTimer: ReturnType<typeof setInterval> | null = null;
let batchRunning = false;

/**
 * Lua script for the atomic cycle swap. Runs server-side under Redis's
 * single-threaded execution model, so other clients see either the entire
 * new cycle or none of it.
 *
 * KEYS[1..N] = staging key paths
 * ARGV[1]    = new cycle number (string)
 * ARGV[2]    = cycle:last key path
 */
const CYCLE_SWAP_LUA = `
for i = 1, #KEYS do
  local staging = KEYS[i]
  local prod = string.gsub(staging, ':batch:staging:', ':batch:')
  redis.call('RENAME', staging, prod)
end
redis.call('SET', ARGV[2], ARGV[1])
return #KEYS
`;

async function getHeadBlock(): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  const result = await pool.query(`SELECT MAX(block_num) AS head FROM ${T.blocks}`, []);
  return Number(result.rows[0]?.head ?? 0);
}

/**
 * Drop any staging keys left over from a crashed prior run. Safe to call at
 * any time — staging keys are write-only intermediates, never read by
 * production code paths.
 */
async function clearStagingKeys(redis: Redis): Promise<void> {
  const stale = await redis.keys(`${REDIS_KEY_STAGING_PREFIX}*`);
  if (stale.length > 0) {
    await redis.del(...stale);
    logger.info({ count: stale.length }, 'Cleared abandoned reputation staging keys');
  }
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

    // Crash-recovery: a prior run may have crashed mid-cycle, leaving staging
    // keys behind. They are write-only intermediates, so dropping them is safe.
    await clearStagingKeys(redis);

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

    // Load previous cycle's scores (or empty for bootstrap). Filter out any
    // staging keys defensively — clearStagingKeys above already DEL'd them,
    // but the bare `:batch:*` glob would catch them if they reappeared.
    let prevScores: Record<string, number> = {};
    if (startCycle > 0) {
      const allKeys = await redis.keys(`${BATCH_KEY_PREFIX}*`);
      const prodKeys = allKeys.filter((k) => !k.startsWith(REDIS_KEY_STAGING_PREFIX));
      if (prodKeys.length > 0) {
        const values = await redis.mget(prodKeys);
        for (let i = 0; i < prodKeys.length; i++) {
          const username = prodKeys[i].replace(BATCH_KEY_PREFIX, '');
          const parsed = parseBatchValue(values[i]);
          if (parsed) prevScores[username] = parsed.score;
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

      // Score every currently-accredited account. Per the Standard, non-
      // accredited users have score 0, so there's no point computing them.
      // The "active authors" subset (gates the activity-based voter-weight
      // bonus) is rebuilt independently inside the SQL `active_authors` CTE.
      const scoredUsers = await getAllAccreditedAccounts();
      if (scoredUsers.size === 0) {
        logger.info({ cycle }, 'No accredited users found, skipping cycle');
        await redis.set(REDIS_KEY_LAST_CYCLE, String(cycle));
        continue;
      }

      const users = [...scoredUsers];
      logger.info({
        cycle,
        totalCycles,
        userCount: users.length,
        cycleEndBlock,
      }, `Computing cycle ${cycle} of ${currentCycle}`);

      // Single query computes all users at once
      const batchResults = await computeReputationBatch(users, prevScores, cycleEndBlock);

      const timeCapped = Date.now() - startTime >= maxDurationMs;

      // Stage this cycle's full {score, breakdown} payload, then atomically
      // swap into production via Lua so readers never see a half-applied cycle.
      const stagingKeys: string[] = [];
      const pipeline = redis.pipeline();
      for (const [username, result] of batchResults) {
        const stagingPath = `${REDIS_KEY_STAGING_PREFIX}${username}`;
        pipeline.set(stagingPath, JSON.stringify(result));
        stagingKeys.push(stagingPath);
      }
      await pipeline.exec();

      await redis.eval(
        CYCLE_SWAP_LUA,
        stagingKeys.length,
        ...stagingKeys,
        String(cycle),
        REDIS_KEY_LAST_CYCLE,
      );

      // Use this cycle's scores as prev scores for the next cycle (score-only
      // for the SQL `prev_scores` jsonb parameter).
      prevScores = {};
      for (const [username, result] of batchResults) {
        prevScores[username] = result.score;
      }

      logger.info({
        cycle,
        usersComputed: batchResults.size,
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

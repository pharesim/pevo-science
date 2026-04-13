/**
 * Nightly batch reputation computation (R4).
 *
 * Computes reputation for all active PEvO users with 2-3 convergence
 * iterations for voter weight resolution. Stores results in Redis
 * at `reputation:batch:{username}` (no TTL, overwritten each run).
 */

import { getPool, isHafAvailable } from './db.js';
import { getRedis } from './redis.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { getAllAccreditedAccounts, getAccreditedSet } from './accreditation.js';
import { getUserStatsFromHaf, getUserStatsFromHiveApi, computeReputation, getBatchReputationMap, getActiveAccounts } from './reputation.js';
import { T } from './hafsql.js';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60_000; // 24 hours
const CONVERGENCE_ITERATIONS = 3;

let batchTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Get all usernames that have published or reviewed on PEvO.
 */
async function getActiveUsers(): Promise<string[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT DISTINCT c.author
       FROM ${T.comments} c
       WHERE c.json_metadata ->> 'app' LIKE $1
         AND (c.json_metadata -> $2 ->> 'type') IN ('paper', 'review')`,
      [`${config.appTag}/%`, config.appTag],
    );
    return result.rows.map((r: { author: string }) => r.author);
  } catch (err) {
    logger.error({ err }, 'Failed to query active users for batch reputation');
    return [];
  }
}

/**
 * Run one full batch computation cycle with convergence iterations.
 */
export async function runBatchComputation(): Promise<void> {
  const startTime = Date.now();
  logger.info('Starting batch reputation computation');

  const redis = getRedis();
  if (!redis) {
    logger.warn('Redis unavailable — skipping batch reputation computation');
    return;
  }

  const users = await getActiveUsers();
  if (users.length === 0) {
    logger.info('No active users found — batch computation skipped');
    return;
  }

  const accreditedSet = await getAllAccreditedAccounts();
  const activeAccounts = await getActiveAccounts();
  logger.info({ userCount: users.length, accreditedCount: accreditedSet.size, activeCount: activeAccounts.size }, 'Batch reputation: users loaded');

  // Convergence loop: each iteration uses the previous iteration's scores as voter weights
  let reputationMap = await getBatchReputationMap();

  for (let iteration = 0; iteration < CONVERGENCE_ITERATIONS; iteration++) {
    const iterStart = Date.now();
    const newScores = new Map<string, number>();

    for (const username of users) {
      try {
        const isAccredited = accreditedSet.has(username);
        let stats = isHafAvailable() ? await getUserStatsFromHaf(username) : null;
        if (!stats) stats = await getUserStatsFromHiveApi(username);

        const result = await computeReputation(stats, isAccredited, undefined, reputationMap, activeAccounts);
        newScores.set(username, result.score);
      } catch (err) {
        logger.warn({ err, username }, 'Batch reputation: failed for user, skipping');
      }
    }

    // Store this iteration's scores in Redis
    const pipeline = redis.pipeline();
    for (const [username, score] of newScores) {
      pipeline.set(`reputation:batch:${username}`, String(score));
    }
    await pipeline.exec();

    // Use this iteration's scores as voter weights for the next iteration
    reputationMap = newScores;

    logger.info({
      iteration: iteration + 1,
      usersComputed: newScores.size,
      durationMs: Date.now() - iterStart,
    }, 'Batch reputation iteration complete');
  }

  logger.info({
    totalUsers: users.length,
    totalDurationMs: Date.now() - startTime,
    iterations: CONVERGENCE_ITERATIONS,
  }, 'Batch reputation computation complete');
}

/**
 * Start the periodic batch computation job.
 * Runs immediately on startup, then on the configured interval.
 */
export function startBatchReputation(intervalMs = DEFAULT_INTERVAL_MS): void {
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

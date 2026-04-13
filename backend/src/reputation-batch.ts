/**
 * Nightly batch reputation computation (R4).
 *
 * Computes reputation for all active PEvO users with 2-3 convergence
 * iterations for voter weight resolution. Stores results in Redis
 * at `reputation:batch:{username}` (no TTL, overwritten each run).
 */

import { isHafAvailable } from './db.js';
import { getRedis } from './redis.js';
import { logger } from './logger.js';
import { getAllAccreditedAccounts, getAccreditedSet } from './accreditation.js';
import { getUserStatsFromHaf, getUserStatsFromHiveApi, computeReputation, getBatchReputationMap, getActiveAccounts } from './reputation.js';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60_000; // 24 hours
const CONVERGENCE_ITERATIONS = 3;
const DEFAULT_MAX_DURATION_MS = 30 * 60_000; // 30 minutes
const DEFAULT_CONCURRENCY = 5;
const SLOW_HAF_THRESHOLD_MS = 5_000; // per-user rolling avg threshold

let batchTimer: ReturnType<typeof setInterval> | null = null;
let batchRunning = false;

/**
 * Run one full batch computation cycle with convergence iterations.
 */
export async function runBatchComputation(maxDurationMs = DEFAULT_MAX_DURATION_MS): Promise<void> {
  if (batchRunning) {
    logger.warn('Batch reputation computation already in progress — skipping');
    return;
  }

  batchRunning = true;
  const startTime = Date.now();
  logger.info('Starting batch reputation computation');

  try {
    const redis = getRedis();
    if (!redis) {
      logger.warn('Redis unavailable — skipping batch reputation computation');
      return;
    }

    const activeAccounts = await getActiveAccounts();
    if (activeAccounts.size === 0) {
      logger.info('No active users found — batch computation skipped');
      return;
    }

    const users = [...activeAccounts];
    const accreditedSet = await getAllAccreditedAccounts();
    logger.info({ userCount: users.length, accreditedCount: accreditedSet.size }, 'Batch reputation: users loaded');

    // Convergence loop: each iteration uses the previous iteration's scores as voter weights
    let reputationMap = await getBatchReputationMap();
    let timeCapped = false;

    for (let iteration = 0; iteration < CONVERGENCE_ITERATIONS; iteration++) {
      if (!isHafAvailable()) {
        logger.warn({ iteration: iteration + 1 }, 'Batch reputation: HAF unavailable — skipping iteration');
        continue;
      }

      const iterStart = Date.now();
      const newScores = new Map<string, number>();
      let concurrency = DEFAULT_CONCURRENCY;
      let totalUserMs = 0;
      let usersProcessed = 0;

      for (let i = 0; i < users.length; i += concurrency) {
        // Time cap check
        if (Date.now() - startTime >= maxDurationMs) {
          logger.warn({
            iteration: iteration + 1,
            usersComputed: newScores.size,
            usersSkipped: users.length - i,
          }, 'Batch reputation: time cap reached — writing partial results');
          timeCapped = true;
          break;
        }

        const chunk = users.slice(i, i + concurrency);
        const chunkResults = await Promise.all(
          chunk.map(async (username) => {
            const userStart = Date.now();
            try {
              const isAccredited = accreditedSet.has(username);
              let stats = isHafAvailable() ? await getUserStatsFromHaf(username) : null;
              if (!stats) stats = await getUserStatsFromHiveApi(username);

              const result = await computeReputation(stats, isAccredited, undefined, reputationMap, activeAccounts);
              return { username, score: result.score, durationMs: Date.now() - userStart };
            } catch (err) {
              logger.warn({ err, username }, 'Batch reputation: failed for user, skipping');
              return { username, score: null, durationMs: Date.now() - userStart };
            }
          }),
        );

        for (const { username, score, durationMs } of chunkResults) {
          if (score !== null) {
            newScores.set(username, score);
          }
          totalUserMs += durationMs;
          usersProcessed++;
        }

        // Slow HAF degradation: reduce concurrency if rolling avg exceeds threshold
        if (usersProcessed > 0) {
          const avgMs = totalUserMs / usersProcessed;
          if (avgMs > SLOW_HAF_THRESHOLD_MS && concurrency > 1) {
            logger.warn({ avgMs: Math.round(avgMs), previousConcurrency: concurrency }, 'Batch reputation: slow HAF detected — reducing concurrency to 1');
            concurrency = 1;
          }
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

      if (timeCapped) break;
    }

    logger.info({
      totalUsers: users.length,
      totalDurationMs: Date.now() - startTime,
      iterations: CONVERGENCE_ITERATIONS,
      timeCapped,
    }, 'Batch reputation computation complete');
  } finally {
    batchRunning = false;
  }
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

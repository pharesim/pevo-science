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

import crypto from 'node:crypto';
import type Redis from 'ioredis';
import { getPool, isHafConfigured } from './db.js';
import { getRedis } from './redis.js';
import { config } from './config.js';
import { logger } from './logger.js';
import {
  REDIS_KEY_STAGING_PREFIX,
  STAGING_SEGMENT,
  batchMapToScoreRecord,
  computeReputationBatch,
  getBatchReputationMap,
  getReputationWeights,
} from './reputation.js';
// The staging prefix derives from `BATCH_KEY_PREFIX` (the canonical prod
// prefix `${appTag}:reputation:batch:`) in reputation.ts and is re-imported
// here so the Lua substring math, the TS-side writer, AND the reader filter
// in `getBatchReputationMap` all reference one source of truth — the
// staging-vs-prod swap cannot drift across the three.
import { getAllAccreditedAccounts } from './accreditation.js';
import { getCachedGenesisBlock, T } from './hafsql.js';
import { CYCLE_SWAP_LUA, evalScript } from './lib/redis-scripts.js';

const DEFAULT_CHECK_INTERVAL_MS = 60 * 60_000; // 1 hour
const DEFAULT_MAX_DURATION_MS = 30 * 60_000; // 30 minutes

const REDIS_KEY_LAST_CYCLE = `${config.appTag}:reputation:cycle:last`;
/**
 * In-progress sentinel: written by the orchestrator immediately before a
 * cycle's atomic Lua swap and deleted INSIDE the same Lua. If Redis (or the
 * orchestrator) crashes between the SET and the Lua, this sentinel survives
 * to the next startup and signals that a prior run crashed mid-swap. The
 * recovery action is: log a loud operator alert and DEL the sentinel so the
 * next batch run recomputes from `cycle:last` to current. Per
 * BACKEND-REPUTATION-SSOT round-1 hold #17.
 *
 * Lives OUTSIDE BATCH_KEY_PREFIX so it cannot collide with a user-keyed
 * entry under getBatchReputationMap's prefix glob (a sibling of
 * `${appTag}:reputation:cycle:last`).
 */
const REDIS_KEY_IN_PROGRESS_PREFIX = `${config.appTag}:reputation:in_progress:`;
/**
 * Multi-instance lock key. Lives OUTSIDE BATCH_KEY_PREFIX so it cannot
 * collide with a user-keyed batch entry under getBatchReputationMap's
 * `${BATCH_KEY_PREFIX}*` glob (a sibling of `${appTag}:reputation:cycle:last`).
 */
const REDIS_KEY_BATCH_LOCK = `${config.appTag}:reputation:lock`;
/**
 * TTL for the multi-instance batch lock. Matches `DEFAULT_MAX_DURATION_MS`
 * (30 min) so a process killed mid-cycle releases its claim within the
 * same window the in-process time cap enforces. A larger TTL would block
 * the next scheduled run; a smaller TTL would expire while a legitimate
 * cycle is still running and let a sibling instance start a parallel cycle.
 */
const BATCH_LOCK_TTL_SECONDS = Math.floor(DEFAULT_MAX_DURATION_MS / 1000);

let batchTimer: ReturnType<typeof setInterval> | null = null;
let batchRunning = false;

/**
 * Staging/prod substring pair passed as ARGV to the registry's `CYCLE_SWAP`
 * Lua script. The body lives in `lib/redis-scripts.ts` (dispatched via
 * `evalScript`), but the substrings stay here because they're a reputation-
 * batch concern — `:batch:staging:` and `:batch:` derive from
 * `BATCH_KEY_PREFIX` / `STAGING_SEGMENT` in `reputation.ts`, not from any
 * registry-level convention. Keeping them at the caller avoids inverting
 * the layering (the registry would otherwise have to know about reputation
 * key shapes).
 *
 * Lua's `string.gsub` first arg is a pattern, where `%` and other characters
 * are special. Our prefixes have no special pattern chars, but the
 * derivation stays explicit so a future change to prefix structure cannot
 * silently introduce a pattern char.
 */
const CYCLE_SWAP_STAGING_SUBSTRING = `:batch:${STAGING_SEGMENT}`;
const CYCLE_SWAP_PROD_SUBSTRING = ':batch:';

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
 * Drop any in-progress sentinels left over from a crash mid-swap. Their
 * presence at startup signals that the prior run set the sentinel but did
 * not reach the Lua's DEL — the cycle never atomically committed, prod
 * keys were not RENAMEd, and `cycle:last` was not advanced. Recovery is
 * the next batch run starting from the same `cycle:last` value. Logged as
 * an error so operators see the crash; cleanup itself is safe.
 */
async function clearInProgressSentinels(redis: Redis): Promise<void> {
  const stale = await redis.keys(`${REDIS_KEY_IN_PROGRESS_PREFIX}*`);
  if (stale.length > 0) {
    await redis.del(...stale);
    logger.error(
      { count: stale.length, keys: stale },
      'Reputation batch crashed mid-swap on prior run — sentinels cleared, recomputing from cycle:last',
    );
  }
}

/**
 * Run both abandoned-state cleanups (staging keys + in-progress sentinels)
 * unconditionally at process startup. Independent of the batch schedule,
 * the HAF-up gate, and the multi-instance lock — a HAF outage at boot or a
 * sibling instance holding the lock must NOT delay crash detection, or a
 * mid-swap crash on the prior run goes unannounced for an entire outage.
 *
 * Idempotent and Redis-only (no HAF, no pool); safe to fire from the
 * non-awaited Promise.all warmup in index.ts. Per BACKEND-REPUTATION-SSOT
 * round-2 hold #2.
 */
export async function repairAbandonedBatchState(): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    logger.warn('Redis unavailable, skipping reputation batch state repair');
    return;
  }
  // Pre-swap crash recovery: staging keys exist but the Lua swap never ran.
  await clearStagingKeys(redis);
  // Mid-swap crash recovery: sentinel was SET but the Lua's DEL never executed.
  await clearInProgressSentinels(redis);
}

/**
 * Run batch computation, catching up from the last computed cycle to the current one.
 *
 * Multi-instance safety: gates the body on a Redis SET NX EX 1800 lock so two
 * backend instances cannot run cycles concurrently. The lock token is a
 * per-call `crypto.randomUUID()` and the release path is a Lua compare-token
 * DEL — a naive `redis.del(lockKey)` could release a sibling's lock after
 * this caller's TTL elapsed. The in-process `batchRunning` flag survives as a
 * fast-path skip for repeated calls in the same process; the Redis lock is
 * the source of truth for cross-instance safety. Per BACKEND-REPUTATION-SSOT
 * round-1 hold #10.
 */
export async function runBatchComputation(maxDurationMs = DEFAULT_MAX_DURATION_MS): Promise<void> {
  if (batchRunning) {
    logger.warn('Batch reputation computation already in progress, skipping');
    return;
  }

  batchRunning = true;
  const startTime = Date.now();
  const redisInit = getRedis();
  let lockToken: string | null = null;

  try {
    if (!isHafConfigured()) {
      logger.warn('HAF unavailable, skipping batch reputation computation');
      return;
    }

    const redis = redisInit;
    if (!redis) {
      logger.warn('Redis unavailable, skipping batch reputation computation');
      return;
    }

    // Multi-instance lock. SET NX EX returns 'OK' on acquire, null on
    // contention. A sibling instance running its own cycle keeps the lock
    // until its TTL or its compare-token DEL releases it; this caller skips.
    const token = crypto.randomUUID();
    const acquired = await redis.set(REDIS_KEY_BATCH_LOCK, token, 'EX', BATCH_LOCK_TTL_SECONDS, 'NX');
    if (acquired !== 'OK') {
      logger.info({ key: REDIS_KEY_BATCH_LOCK }, 'Batch reputation lock held by sibling instance, skipping');
      return;
    }
    lockToken = token;

    // Crash-recovery: a prior run may have crashed mid-cycle, leaving staging
    // keys behind. They are write-only intermediates, so dropping them is safe.
    // The in-progress sentinel surfaces the louder failure mode (crash between
    // sentinel-SET and atomic-Lua) so operators see the event in logs.
    //
    // The repairAbandonedBatchState() startup hook runs the same two
    // helpers unconditionally at process boot (see index.ts) so a HAF
    // outage or lock-contended start does not delay crash detection.
    // Pre-swap crash recovery: staging keys exist but the Lua swap never ran.
    await clearStagingKeys(redis);
    // Mid-swap crash recovery: sentinel was SET but the Lua's DEL never executed.
    await clearInProgressSentinels(redis);

    const weights = await getReputationWeights();
    const cycleBlocks = weights.cycle_blocks;
    if (!Number.isFinite(cycleBlocks) || cycleBlocks <= 0) {
      // Defense-in-depth against a corrupted update_weights custom_json that
      // sets cycle_blocks to 0 or negative. With cycle_blocks === 0,
      // Math.floor((head - genesis) / 0) === Infinity and the catch-up loop
      // iterates forever bounded only by the wall-clock time cap (BACKEND-
      // REPUTATION-SSOT round-1 hold #26). Bail loudly so an operator can
      // patch the weights.
      logger.error({ cycleBlocks }, 'Reputation weights cycle_blocks must be > 0; skipping batch computation');
      return;
    }
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

    // Load previous cycle's scores (or empty for bootstrap). The shared
    // helper does the staging-key filter, MGET, and parseBatchValue dance
    // exactly once across the codebase — see BACKEND-REPUTATION-SSOT
    // round-1 hold #11. Forgetting to share this path is how the prior
    // hand-rolled loop drifted from the reader (parseBatchValue shape,
    // staging-key filter, prefix construction).
    let prevScores: Record<string, number> = {};
    if (startCycle > 0) {
      prevScores = batchMapToScoreRecord(await getBatchReputationMap());
    }

    // Process each cycle sequentially
    for (let cycle = startCycle; cycle <= currentCycle; cycle++) {
      if (Date.now() - startTime >= maxDurationMs) {
        logger.warn({ cycle, currentCycle }, 'Batch reputation: time cap reached, stopping');
        break;
      }

      const cycleStart = Date.now();
      const cycleEndBlock = genesisBlock + (cycle + 1) * cycleBlocks;

      // Only score fully-elapsed cycles. `currentCycle` is
      // floor((head - genesis) / cycle_blocks), which is the IN-PROGRESS
      // cycle: its cycleEndBlock is strictly greater than the current head.
      // Scoring it resolves every block-relative arm (`cycle_ref`, the decay
      // age) against a block that does not exist yet, collapsing papers /
      // reviews / citations to zero, and then freezes that mis-scored
      // snapshot as the next cycle's prev_scores. Break rather than continue:
      // every later cycle has a strictly larger end block, so none qualify.
      if (cycleEndBlock > headBlock) {
        logger.info({ cycle, cycleEndBlock, headBlock }, 'Cycle not fully elapsed; stopping before scoring it');
        break;
      }

      // Score every currently-accredited account. Per the Standard, non-
      // accredited users have score 0, so there's no point computing them.
      // The "active authors" subset (gates the activity-based voter-weight
      // bonus) is rebuilt independently inside the SQL `active_authors` CTE.
      //
      // Per BACKEND-REPUTATION-SSOT round-1 hold #9: getAllAccreditedAccounts
      // re-throws on HAF query failure, so an empty set here is always a
      // legitimate "no accredited users yet" state (early bootstrap, dev env
      // with HAF connected but no attestations). Failures bubble to the outer
      // catch and bail without advancing cycle:last. Advancing over a
      // legitimate empty cycle is correct: there is nothing to score, no
      // votes from accredited users to weight, and the next cycle's
      // prev_scores remains empty until accreditations land on chain.
      const scoredUsers = await getAllAccreditedAccounts();
      if (scoredUsers.size === 0) {
        logger.info({ cycle }, 'No accredited users; advancing cycle with no-op');
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

      // Belt-and-suspenders: a non-empty user list always yields one scored
      // row per user (the totals CTE CROSS JOINs every target_user), so an
      // empty result for a non-empty list is never a real cycle.
      // computeReputationBatch now throws on SQL failure (handled by the outer
      // catch), but guard the empty path too so a future regression that
      // resurrects empty-on-error cannot silently advance cycle:last and wipe
      // the next cycle's voter weights. Break rather than advance.
      if (batchResults.size === 0 && users.length > 0) {
        logger.error({ cycle, userCount: users.length }, 'Batch returned no scores for a non-empty user list; bailing without advancing cycle:last');
        break;
      }

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

      // Crash-mid-Lua sentinel: written BEFORE the atomic swap, DEL'd inside
      // the Lua. A surviving sentinel on the next startup means the swap
      // never executed (clearInProgressSentinels surfaces the alert).
      const sentinelKey = `${REDIS_KEY_IN_PROGRESS_PREFIX}${cycle}`;
      await redis.set(sentinelKey, String(cycle));

      await evalScript(
        redis,
        'CYCLE_SWAP',
        [...stagingKeys, sentinelKey],
        [String(cycle), REDIS_KEY_LAST_CYCLE, CYCLE_SWAP_STAGING_SUBSTRING, CYCLE_SWAP_PROD_SUBSTRING],
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
    if (lockToken && redisInit) {
      try {
        await evalScript(
          redisInit,
          'RELEASE_LOCK_IF_TOKEN_MATCHES',
          [REDIS_KEY_BATCH_LOCK],
          [lockToken],
        );
      } catch (releaseErr) {
        // Lock auto-expires at TTL even if release fails; the next run is
        // delayed at most BATCH_LOCK_TTL_SECONDS.
        logger.warn({ err: releaseErr, key: REDIS_KEY_BATCH_LOCK }, 'Batch lock release failed');
      }
    }
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

/**
 * Test seams: module-private constants and helpers exposed for unit-level
 * tests of the atomic-swap primitive, the in-progress sentinel recovery, and
 * the staging-key cleanup helper. Production code must not import these.
 *
 * Per BACKEND-REPUTATION-SSOT round-1 hold #14/#15/#17: the atomic Lua swap
 * IS the load-bearing atomicity primitive; the in-progress sentinel IS the
 * crash-detection contract; clearStagingKeys IS the recovery contract.
 * Each gets a direct test, not just transitive coverage via runBatchComputation.
 */
export const __test_seams = {
  CYCLE_SWAP_LUA,
  CYCLE_SWAP_STAGING_SUBSTRING,
  CYCLE_SWAP_PROD_SUBSTRING,
  REDIS_KEY_STAGING_PREFIX,
  REDIS_KEY_LAST_CYCLE,
  REDIS_KEY_IN_PROGRESS_PREFIX,
  REDIS_KEY_BATCH_LOCK,
  clearStagingKeys,
  clearInProgressSentinels,
};

/**
 * Regression: a SQL failure inside computeReputationBatch must NOT be
 * mistaken for a successful empty cycle.
 *
 * computeReputationBatch previously caught its own SQL errors and returned an
 * empty Map. The batch orchestrator could not tell that empty Map apart from a
 * legitimately empty cycle, so on any HAF transient it advanced cycle:last
 * permanently and wiped the next cycle's voter weights (the in-process
 * prevScores reset to {}, dropping every voter to the bootstrap 1.0 weight).
 *
 * The fix re-throws from computeReputationBatch (the outer try/catch in
 * runBatchComputation bails without advancing) and adds a belt-and-suspenders
 * guard in the loop: an empty result for a non-empty user list breaks rather
 * than advancing. Arm 1 pins the failure-does-not-advance behavior. Arm 2 pins
 * that the legitimately-empty-accredited path is untouched: it never reaches
 * the scoring step (so the belt-and-suspenders never engages), the elapsed
 * empty cycle advances per the documented no-op-advance contract, and the
 * in-progress cycle still stops.
 *
 * Carve-out (per root CLAUDE.md "Running Tests" clauses a/b/c):
 *  (a) Real path impractical: provoking a real HAF SQL failure mid-cycle on a
 *      controlled cycle geometry requires both corrupting the live query and
 *      pinning head/genesis/cycle_blocks, which cannot be reproduced against
 *      live infra (the head advances every ~3s). getHeadBlock reads the shared
 *      pool; getReputationWeights / getCachedGenesisBlock / getAllAccredited-
 *      Accounts read cycle config and the accredited corpus; all are stubbed,
 *      and computeReputationBatch is stubbed to inject the failure / observe
 *      the call decision.
 *  (b) No auth/permission middleware is in scope. runBatchComputation is a
 *      scheduler internal; verifyHiveSignature does not run and is not mocked.
 *  (c) Real-path companions: reputation-lifecycle.test.ts runs
 *      computeReputationBatch against real HAF, and reputation-batch-
 *      internals.test.ts exercises the atomic swap and crash-recovery against
 *      real Redis. The risk class pinned HERE is the loop's cycle:last advance
 *      decision under a failed / empty cycle, which neither companion covers.
 *      Redis stays real so cycle:last and prod batch keys are observed live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getPoolMock } = vi.hoisted(() => ({ getPoolMock: vi.fn() }));

vi.mock('../../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/db.js')>('../../src/db.js');
  return { ...actual, getPool: getPoolMock, isHafConfigured: () => getPoolMock() !== null };
});

const reputationModule = await import('../../src/reputation.js');
const reputationBatchModule = await import('../../src/reputation-batch.js');
const accreditationModule = await import('../../src/accreditation.js');
const hafsqlModule = await import('../../src/hafsql.js');
const { getRedis } = await import('../../src/redis.js');
const { batchKey } = reputationModule;
const { runBatchComputation, __test_seams } = reputationBatchModule;
const { DEFAULT_REPUTATION_WEIGHTS } = await import('../../src/types/index.js');

const TEST_USER = 'pevo-sql-failure-active';

const GENESIS = 1_000_000;
const CYCLE_BLOCKS = 100;

function stubCycleConfig(headBlock: number): void {
  // getHeadBlock() is the only live pool consumer once the helpers below are
  // stubbed; return the controlled head for its MAX(block_num) read.
  getPoolMock.mockReturnValue({ query: async () => ({ rows: [{ head: headBlock }] }) });
  vi.spyOn(reputationModule, 'getReputationWeights').mockResolvedValue({
    ...DEFAULT_REPUTATION_WEIGHTS,
    cycle_blocks: CYCLE_BLOCKS,
  });
  vi.spyOn(hafsqlModule, 'getCachedGenesisBlock').mockReturnValue(GENESIS);
}

async function clearKeys() {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(__test_seams.REDIS_KEY_BATCH_LOCK);
  await redis.del(batchKey(TEST_USER));
  await redis.del(`${__test_seams.REDIS_KEY_STAGING_PREFIX}${TEST_USER}`);
  const sentinels = await redis.keys(`${__test_seams.REDIS_KEY_IN_PROGRESS_PREFIX}*`);
  if (sentinels.length > 0) await redis.del(...sentinels);
}

beforeEach(clearKeys);
afterEach(async () => {
  vi.restoreAllMocks();
  getPoolMock.mockReset();
  await clearKeys();
});

// retry on the runBatchComputation tests: the global config runs files
// 2-at-a-time, so a sibling real-Redis file holding the batch lock (or its
// setup flush) can make a single attempt skip. Matches the sibling internals
// test's retry budget for the same lock/flush contention.
describe('reputation batch: a SQL failure does not advance cycle:last', () => {
  it('bails without advancing cycle:last or wiping prod scores when computeReputationBatch throws', { retry: 5 }, async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');

    // head - genesis = 2.5 * cycle_blocks -> currentCycle 2; cycle:last "0" ->
    // startCycle 1 (so prevScores is loaded from prod). Cycle 1 is fully
    // elapsed and reaches the scoring step, where the injected failure fires.
    const HEAD = GENESIS + Math.floor(CYCLE_BLOCKS * 2.5); // 1_000_250
    stubCycleConfig(HEAD);
    vi.spyOn(accreditationModule, 'getAllAccreditedAccounts').mockResolvedValue(new Set([TEST_USER]));

    // Seed a prior cycle's prod score so prevScores has something to load; the
    // failed run must leave it intact (its source for the next cycle's voter
    // weights).
    const seeded = JSON.stringify({ score: 33, breakdown: { papers: 20, reviews: 8, citations: 0, accreditation: 5 } });
    await redis.set(batchKey(TEST_USER), seeded);

    const computeSpy = vi
      .spyOn(reputationModule, 'computeReputationBatch')
      .mockRejectedValue(new Error('injected HAF transient'));

    const priorCycle = await redis.get(__test_seams.REDIS_KEY_LAST_CYCLE);
    await redis.set(__test_seams.REDIS_KEY_LAST_CYCLE, '0');

    try {
      // runBatchComputation handles the throw internally (outer catch); it does
      // not re-throw to the caller.
      await expect(runBatchComputation(60_000)).resolves.toBeUndefined();

      // The scoring step was reached and failed.
      expect(computeSpy).toHaveBeenCalledTimes(1);
      // cycle:last did NOT advance off the pre-set value.
      expect(await redis.get(__test_seams.REDIS_KEY_LAST_CYCLE)).toBe('0');
      // prevScores' source (the prod batch key) was not overwritten / wiped.
      expect(await redis.get(batchKey(TEST_USER))).toBe(seeded);
      // No in-progress sentinel leaked (the throw fired before the sentinel SET).
      expect(await redis.keys(`${__test_seams.REDIS_KEY_IN_PROGRESS_PREFIX}*`)).toEqual([]);
    } finally {
      if (priorCycle !== null) {
        await redis.set(__test_seams.REDIS_KEY_LAST_CYCLE, priorCycle);
      } else {
        await redis.del(__test_seams.REDIS_KEY_LAST_CYCLE);
      }
    }
  });
});

describe('reputation batch: an empty accredited set completes cleanly', () => {
  it('never reaches scoring (belt-and-suspenders does not engage) and advances only the elapsed empty cycle', { retry: 5 }, async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');

    // head - genesis = 1.5 * cycle_blocks -> currentCycle 1. Cycle 0 is a
    // fully-elapsed empty cycle (advances per the documented no-op-advance);
    // cycle 1 is in progress (stopped by the elapsed-cycle guard).
    const HEAD = GENESIS + Math.floor(CYCLE_BLOCKS * 1.5); // 1_000_150
    stubCycleConfig(HEAD);
    vi.spyOn(accreditationModule, 'getAllAccreditedAccounts').mockResolvedValue(new Set());

    // Pinned NOT-called: the empty accredited set short-circuits before the
    // scoring step, so the belt-and-suspenders empty-result guard is never
    // evaluated for this path.
    const computeSpy = vi.spyOn(reputationModule, 'computeReputationBatch');

    const priorCycle = await redis.get(__test_seams.REDIS_KEY_LAST_CYCLE);
    await redis.del(__test_seams.REDIS_KEY_LAST_CYCLE);

    try {
      await expect(runBatchComputation(60_000)).resolves.toBeUndefined();

      expect(computeSpy).not.toHaveBeenCalled();
      // The elapsed empty cycle 0 advanced (documented legitimate-empty-cycle
      // behavior); the in-progress cycle 1 did not. cycle:last lands at 0.
      expect(await redis.get(__test_seams.REDIS_KEY_LAST_CYCLE)).toBe('0');
    } finally {
      if (priorCycle !== null) {
        await redis.set(__test_seams.REDIS_KEY_LAST_CYCLE, priorCycle);
      } else {
        await redis.del(__test_seams.REDIS_KEY_LAST_CYCLE);
      }
    }
  });
});

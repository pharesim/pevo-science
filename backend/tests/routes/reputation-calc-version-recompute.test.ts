/**
 * Calc-version auto-recompute for the batch reputation loop.
 *
 * `runBatchComputation` is a forward-only catch-up loop: it computes only cycles
 * newer than `reputation:cycle:last`, so a corrected scoring calc never
 * retroactively re-scores finalized cycles. The calc-version stamp
 * (`reputation:calc:version`) closes that footgun: when the running code's
 * fingerprint (`computeCalcVersion` = explicit CALC_VERSION + sanitized-weights
 * hash) differs from the stored one, the loop forces a full replay from cycle 0.
 *
 * These cases pin: a changed version triggers the full replay, an unchanged one
 * does NOT (no every-run replay), a partial/crashed replay leaves the version
 * unstamped and converges on retry, and a failed cycle never advances
 * `cycle:last` nor stamps the version (the must-not-advance invariant holds).
 *
 * Carve-out (per root CLAUDE.md "Running Tests" clauses a/b/c):
 *  (a) Real path impractical: the cases require pinning (genesis, cycle_blocks,
 *      head) geometry, a known stored calc-version, and deterministic per-cycle
 *      scoring/failure all at once. The live HAF head advances every ~3s and the
 *      genesis/weights are fixed, so this state cannot be reproduced against live
 *      infra. `getHeadBlock` (pool MAX(block_num)), `getReputationWeights`,
 *      `getCachedGenesisBlock`, `getAllAccreditedAccounts`, and
 *      `computeReputationBatch` are stubbed to controlled values; Redis stays
 *      REAL so `cycle:last`, the atomic staging->prod swap, AND the new
 *      `calc:version` stamp run end-to-end.
 *  (b) No auth/permission middleware is in scope. `runBatchComputation` is a
 *      scheduler internal; `verifyHiveSignature` does not run on it and is not
 *      mocked.
 *  (c) Real-path companions: `reputation-lifecycle.test.ts` runs
 *      `computeReputationBatch` against real HAF for an elapsed cycle, and
 *      `reputation-batch-internals.test.ts` exercises the atomic Lua swap and
 *      crash-recovery against real Redis. The risk class pinned HERE is the
 *      calc-version recompute TRIGGER and the persist-only-on-durable-catch-up
 *      gating, which neither companion covers.
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
const { batchKey, computeCalcVersion } = reputationModule;
const { runBatchComputation, __test_seams } = reputationBatchModule;
const { DEFAULT_REPUTATION_WEIGHTS } = await import('../../src/types/index.js');

const TEST_USER = 'pevo-calc-version-recompute-user';

// Controlled cycle geometry: cycles 0,1,2 fully elapsed; cycle 3 in-progress.
// currentCycle = floor((HEAD - GENESIS) / CYCLE_BLOCKS) = floor(350/100) = 3.
const GENESIS = 2_000_000;
const CYCLE_BLOCKS = 100;
const HEAD = GENESIS + 350;
const TEST_WEIGHTS = { ...DEFAULT_REPUTATION_WEIGHTS, cycle_blocks: CYCLE_BLOCKS };
const CURRENT_VERSION = computeCalcVersion(TEST_WEIGHTS);
const cycleEnd = (n: number) => GENESIS + (n + 1) * CYCLE_BLOCKS; // cycle 0 -> 2_000_100

function scoreRow() {
  return new Map([[TEST_USER, { score: 50, breakdown: { papers: 30, reviews: 10, citations: 5, accreditation: 5 } }]]);
}

// getHeadBlock() is the only live pool consumer once the helpers are stubbed;
// return the controlled head for its MAX(block_num) read (direct + via connect()
// for the statement-timeout-scoped path).
function installStubs(computeImpl: (users: string[], prev: Record<string, number>, end: number) => Promise<Map<string, { score: number; breakdown: Record<string, number> }>>) {
  getPoolMock.mockReturnValue({
    query: async () => ({ rows: [{ head: HEAD }] }),
    connect: async () => ({ query: async () => ({ rows: [{ head: HEAD }] }), release: () => undefined }),
  });
  vi.spyOn(reputationModule, 'getReputationWeights').mockResolvedValue(TEST_WEIGHTS);
  vi.spyOn(hafsqlModule, 'getCachedGenesisBlock').mockReturnValue(GENESIS);
  vi.spyOn(accreditationModule, 'getAllAccreditedAccounts').mockResolvedValue(new Set([TEST_USER]));
  return vi.spyOn(reputationModule, 'computeReputationBatch').mockImplementation(computeImpl as never);
}

async function clearKeys() {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(__test_seams.REDIS_KEY_BATCH_LOCK);
  await redis.del(__test_seams.REDIS_KEY_LAST_CYCLE);
  await redis.del(__test_seams.REDIS_KEY_CALC_VERSION);
  await redis.del(batchKey(TEST_USER));
  await redis.del(`${__test_seams.REDIS_KEY_STAGING_PREFIX}${TEST_USER}`);
  const sentinels = await redis.keys(`${__test_seams.REDIS_KEY_IN_PROGRESS_PREFIX}*`);
  if (sentinels.length > 0) await redis.del(...sentinels);
}

// Snapshot/restore the shared cursor + version keys so sibling suites are not
// perturbed by these tests writing real Redis.
let priorCycle: string | null = null;
let priorVersion: string | null = null;

beforeEach(async () => {
  const redis = getRedis();
  if (redis) {
    priorCycle = await redis.get(__test_seams.REDIS_KEY_LAST_CYCLE);
    priorVersion = await redis.get(__test_seams.REDIS_KEY_CALC_VERSION);
  }
  await clearKeys();
});

afterEach(async () => {
  vi.restoreAllMocks();
  getPoolMock.mockReset();
  await clearKeys();
  const redis = getRedis();
  if (redis) {
    if (priorCycle !== null) await redis.set(__test_seams.REDIS_KEY_LAST_CYCLE, priorCycle);
    if (priorVersion !== null) await redis.set(__test_seams.REDIS_KEY_CALC_VERSION, priorVersion);
  }
});

describe('reputation calc-version: auto-recompute on change', () => {
  // retry: the global config runs files 2-at-a-time; a sibling real-Redis file
  // holding the batch lock (or its setup flush) can make a single
  // runBatchComputation attempt skip. Match the sibling internals test's budget.
  it('a changed calc-version forces a full replay from cycle 0 and stamps the new version', { retry: 5 }, async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');

    // Already "caught up" to cycle 2 under a STALE version: a forward-only loop
    // would compute nothing (cycle:last=2, in-progress cycle 3 breaks).
    await redis.set(__test_seams.REDIS_KEY_LAST_CYCLE, '2');
    await redis.set(__test_seams.REDIS_KEY_CALC_VERSION, 'stale-version');

    const computeSpy = installStubs(async () => scoreRow());

    await runBatchComputation(60_000);

    // Full replay: cycles 0,1,2 recomputed (3 calls) despite cycle:last=2.
    expect(computeSpy).toHaveBeenCalledTimes(3);
    expect(computeSpy.mock.calls.map((c) => c[2])).toEqual([cycleEnd(0), cycleEnd(1), cycleEnd(2)]);
    // Every cycle gets the run's single weights snapshot (4th arg), so a regression
    // reverting to a per-cycle getReputationWeights() (reopening the mid-run
    // WEIGHTS_TTL-swap race) is caught.
    expect(computeSpy.mock.calls.map((c) => c[3])).toEqual([TEST_WEIGHTS, TEST_WEIGHTS, TEST_WEIGHTS]);
    // cycle:last lands at the last fully-elapsed cycle (2); the new version is stamped.
    expect(await redis.get(__test_seams.REDIS_KEY_LAST_CYCLE)).toBe('2');
    expect(await redis.get(__test_seams.REDIS_KEY_CALC_VERSION)).toBe(CURRENT_VERSION);
  });

  it('an unchanged calc-version does NOT trigger a recompute (no every-run replay)', { retry: 5 }, async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');

    // Caught up to cycle 2 under the CURRENT version: nothing to do.
    await redis.set(__test_seams.REDIS_KEY_LAST_CYCLE, '2');
    await redis.set(__test_seams.REDIS_KEY_CALC_VERSION, CURRENT_VERSION);

    const computeSpy = installStubs(async () => scoreRow());

    await runBatchComputation(60_000);

    // No reset: startCycle = 3 (the in-progress cycle) breaks immediately.
    expect(computeSpy).not.toHaveBeenCalled();
    expect(await redis.get(__test_seams.REDIS_KEY_LAST_CYCLE)).toBe('2');
    expect(await redis.get(__test_seams.REDIS_KEY_CALC_VERSION)).toBe(CURRENT_VERSION);
  });

  it('a crash mid-replay leaves the version unstamped and converges on retry', { retry: 5 }, async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');

    await redis.set(__test_seams.REDIS_KEY_CALC_VERSION, 'stale-version');

    // Run 1: cycle 0 succeeds (swaps cycle:last -> 0), cycle 1 throws (simulated
    // mid-cycle crash). The throw aborts the loop before the version stamp.
    let crashOnCycle1 = true;
    const computeSpy = installStubs(async (_u, _p, end) => {
      if (crashOnCycle1 && end === cycleEnd(1)) throw new Error('simulated crash mid-cycle');
      return scoreRow();
    });

    await runBatchComputation(60_000);

    // Partial: cycle 0 landed, cycle 1 crashed; the version is NOT stamped.
    expect(await redis.get(__test_seams.REDIS_KEY_LAST_CYCLE)).toBe('0');
    expect(await redis.get(__test_seams.REDIS_KEY_CALC_VERSION)).toBe('stale-version');

    // Run 2: no crash. Version still stale -> replays from 0 and converges.
    crashOnCycle1 = false;
    computeSpy.mockClear();
    await runBatchComputation(60_000);

    expect(computeSpy.mock.calls.map((c) => c[2])).toEqual([cycleEnd(0), cycleEnd(1), cycleEnd(2)]);
    expect(await redis.get(__test_seams.REDIS_KEY_LAST_CYCLE)).toBe('2');
    expect(await redis.get(__test_seams.REDIS_KEY_CALC_VERSION)).toBe(CURRENT_VERSION);
  });

  it('a failed cycle does not advance cycle:last nor stamp the version (must-not-advance holds)', { retry: 5 }, async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');

    await redis.set(__test_seams.REDIS_KEY_CALC_VERSION, 'stale-version');

    // Cycle 0 succeeds (cycle:last -> 0); cycle 1 returns an EMPTY map for a
    // non-empty user list, tripping the belt-and-suspenders bail that breaks
    // WITHOUT advancing cycle:last.
    const computeSpy = installStubs(async (_u, _p, end) => {
      if (end === cycleEnd(1)) return new Map();
      return scoreRow();
    });

    await runBatchComputation(60_000);

    // cycle:last stayed at 0 (cycle 1's failure did NOT advance it to 1), and
    // the version is NOT stamped because the replay never reached fully-elapsed.
    expect(computeSpy.mock.calls.map((c) => c[2])).toEqual([cycleEnd(0), cycleEnd(1)]);
    expect(await redis.get(__test_seams.REDIS_KEY_LAST_CYCLE)).toBe('0');
    expect(await redis.get(__test_seams.REDIS_KEY_CALC_VERSION)).toBe('stale-version');
  });
});

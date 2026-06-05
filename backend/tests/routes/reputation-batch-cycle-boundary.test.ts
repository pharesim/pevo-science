/**
 * Cycle-boundary regression for the batch reputation loop.
 *
 * Two compounding bugs previously collapsed every cycle to
 * `accreditation_bonus` only and then froze that mis-scored snapshot:
 *
 *  1. The loop scored the IN-PROGRESS cycle (`currentCycle =
 *     floor((head - genesis) / cycle_blocks)`), whose cycleEndBlock is
 *     strictly greater than the current head.
 *  2. `cycle_ref` matched the cycle's end block with an exact `= $6 - 1`,
 *     which returns zero rows for an in-progress end block, so every
 *     `CROSS JOIN cycle_ref` arm (papers / reviews / citations) collapsed to
 *     NULL.
 *
 * Arm 1 pins the loop fix: with `head - genesis = cycle_blocks * 1.5`, the
 * fully-elapsed cycle 0 is scored and the in-progress cycle 1 is NOT.
 * Arm 2 pins the `cycle_ref` fix at the SQL level: the emitted query resolves
 * the latest block at or before the cycle end (`<= ... ORDER BY DESC LIMIT 1`),
 * never the fragile exact match.
 *
 * Carve-out (per root CLAUDE.md "Running Tests" clauses a/b/c):
 *  (a) Real path impractical: forcing `head - genesis = cycle_blocks * 1.5`
 *      deterministically requires pinning all three of head, genesis, and
 *      cycle_blocks at once. The real HAF head advances every ~3s and the
 *      real genesis/cycle_blocks are fixed, so the exact 1.5-cycle ratio
 *      cannot be reproduced against live infra. `getHeadBlock` reads
 *      `MAX(block_num)` from the shared pool, and `getReputationWeights` /
 *      `getCachedGenesisBlock` / `getAllAccreditedAccounts` read cycle config
 *      and the accredited corpus, so all four are stubbed to controlled
 *      values; `computeReputationBatch` is stubbed (Arm 1) so the assertion
 *      observes the loop's call decision, not real HAF scoring.
 *  (b) No auth/permission middleware is in scope. `runBatchComputation` is a
 *      scheduler internal and `computeReputationBatch` is a batch helper;
 *      `verifyHiveSignature` does not run on either path and is not mocked.
 *  (c) Real-path companions: `reputation-lifecycle.test.ts`'s idempotency arm
 *      runs `computeReputationBatch` against real HAF for an elapsed cycle,
 *      and `reputation-batch-internals.test.ts` exercises the atomic Lua swap
 *      and crash-recovery against real Redis. The risk class pinned HERE is
 *      the loop's cycle-boundary decision and the `cycle_ref` block lookup,
 *      which neither companion covers. Redis stays real in Arm 1 so the
 *      staging -> prod swap and `cycle:last` advance run end-to-end.
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

const TEST_USER = 'pevo-cycle-boundary-active';

// Capturing pool for the SQL-shape arm: records every emitted SQL and returns
// empty rowsets, exactly as the approve-signer-gate cycle SQL-shape canary.
const cannedResult = { rows: [] as Array<Record<string, unknown>>, rowCount: 0 };
const capturedSqls: string[] = [];
function capture(sql: string): Promise<typeof cannedResult> {
  capturedSqls.push(sql);
  return Promise.resolve(cannedResult);
}
const capturingPool = {
  query: (sql: string, _params?: unknown[]) => capture(sql),
  connect: async () => ({ query: (sql: string, _params?: unknown[]) => capture(sql), release: () => undefined }),
};

async function clearBoundaryKeys() {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(__test_seams.REDIS_KEY_BATCH_LOCK);
  await redis.del(batchKey(TEST_USER));
  await redis.del(`${__test_seams.REDIS_KEY_STAGING_PREFIX}${TEST_USER}`);
  const sentinels = await redis.keys(`${__test_seams.REDIS_KEY_IN_PROGRESS_PREFIX}*`);
  if (sentinels.length > 0) await redis.del(...sentinels);
}

afterEach(() => {
  vi.restoreAllMocks();
  getPoolMock.mockReset();
  capturedSqls.length = 0;
});

describe('reputation batch: only fully-elapsed cycles are scored', () => {
  beforeEach(clearBoundaryKeys);
  afterEach(clearBoundaryKeys);

  // retry: the global config runs files 2-at-a-time; a sibling real-Redis
  // file holding the batch lock (or its setup flush) can make a single
  // runBatchComputation attempt skip. Match the sibling internals test's
  // retry budget for the same lock/flush contention.
  it('scores the elapsed cycle 0 and stops before the in-progress cycle 1 when head - genesis = cycle_blocks * 1.5', { retry: 5 }, async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');

    // Controlled cycle geometry: cycle 0 ends at genesis + cycle_blocks
    // (<= head, fully elapsed); cycle 1 ends at genesis + 2*cycle_blocks
    // (> head, in progress). currentCycle = floor(1.5) = 1.
    const GENESIS = 1_000_000;
    const CYCLE_BLOCKS = 100;
    const HEAD = GENESIS + Math.floor(CYCLE_BLOCKS * 1.5); // 1_000_150
    const CYCLE0_END = GENESIS + CYCLE_BLOCKS; // 1_000_100

    // getHeadBlock() is the only live pool consumer once the helpers below
    // are stubbed; return the controlled head for its MAX(block_num) read.
    getPoolMock.mockReturnValue({ query: async () => ({ rows: [{ head: HEAD }] }) });

    vi.spyOn(reputationModule, 'getReputationWeights').mockResolvedValue({
      ...DEFAULT_REPUTATION_WEIGHTS,
      cycle_blocks: CYCLE_BLOCKS,
    });
    vi.spyOn(hafsqlModule, 'getCachedGenesisBlock').mockReturnValue(GENESIS);
    vi.spyOn(accreditationModule, 'getAllAccreditedAccounts').mockResolvedValue(new Set([TEST_USER]));

    // Stub the per-cycle SQL scoring so the assertion observes the loop's
    // call decision. Non-zero breakdown proves cycle 0 flowed through the
    // staging -> Lua swap -> prod path end-to-end.
    const computeSpy = vi
      .spyOn(reputationModule, 'computeReputationBatch')
      .mockResolvedValue(
        new Map([[TEST_USER, { score: 87, breakdown: { papers: 30, reviews: 40, citations: 12, accreditation: 5 } }]]),
      );

    // Fresh start: no prior cycle computed -> startCycle = 0. Save/restore
    // cycle:last so sibling suites are not perturbed.
    const priorCycle = await redis.get(__test_seams.REDIS_KEY_LAST_CYCLE);
    await redis.del(__test_seams.REDIS_KEY_LAST_CYCLE);

    try {
      await runBatchComputation(60_000);

      // Cycle 0 scored exactly once; cycle 1 never reached the SQL.
      expect(computeSpy).toHaveBeenCalledTimes(1);
      // The single call scored cycle 0's end block, not the in-progress one.
      expect(computeSpy.mock.calls[0][2]).toBe(CYCLE0_END);

      // cycle:last advanced to exactly 0 — the in-progress cycle 1 did not
      // advance it (the off-by-one would have left it at 1).
      expect(await redis.get(__test_seams.REDIS_KEY_LAST_CYCLE)).toBe('0');

      // Cycle 0's full {score, breakdown} reached prod via the atomic swap.
      const prod = await redis.get(batchKey(TEST_USER));
      expect(prod).not.toBeNull();
      const parsed = JSON.parse(prod as string) as { breakdown: { papers: number; reviews: number; citations: number } };
      expect(parsed.breakdown.papers).toBeGreaterThan(0);
      expect(parsed.breakdown.reviews).toBeGreaterThan(0);
      expect(parsed.breakdown.citations).toBeGreaterThan(0);
    } finally {
      if (priorCycle !== null) {
        await redis.set(__test_seams.REDIS_KEY_LAST_CYCLE, priorCycle);
      } else {
        await redis.del(__test_seams.REDIS_KEY_LAST_CYCLE);
      }
    }
  });
});

describe('reputation cycle cycle_ref — resolves latest block at or before the cycle end', () => {
  it('emits `<= $6 - 1 ORDER BY block_num DESC LIMIT 1`, never the fragile exact `= $6 - 1`', async () => {
    getPoolMock.mockReturnValue(capturingPool as unknown as ReturnType<typeof getPoolMock>);

    // cycleEndBlock + prevScores provided so the run stays on the inline
    // cycle query (skips the head-block and prev-score reads).
    await reputationModule.computeReputationBatch(['some-target-user'], {}, 12_345);

    const cycleSql = capturedSqls.find((s) => s.includes('cycle_ref'));
    expect(cycleSql, 'computeReputationBatch must emit the cycle_ref CTE').toBeDefined();

    // An exact `= $6 - 1` returns zero rows for an in-progress cycle end and
    // collapses every CROSS JOIN cycle_ref arm to NULL. The defense-in-depth
    // form degrades to "score against the latest block" instead.
    expect(cycleSql!).toMatch(/b\.block_num <= \$6 - 1/);
    expect(cycleSql!).toMatch(/ORDER BY b\.block_num DESC/);
    // Pin LIMIT 1 to the cycle_ref ORDER BY: dropping only LIMIT 1 (keeping
    // <= and ORDER BY ... DESC) would return every block at or before the
    // cycle end, turning each CROSS JOIN cycle_ref arm into a Cartesian
    // product that silently corrupts every score.
    expect(cycleSql!).toMatch(/ORDER BY b\.block_num DESC\s+LIMIT 1/);
    expect(cycleSql!).not.toMatch(/b\.block_num = \$6 - 1/);
  });
});

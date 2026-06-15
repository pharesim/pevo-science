/**
 * Unit-level tests for reputation batch internals: atomic Lua RENAME swap,
 * staging-key crash recovery, and the in-progress sentinel.
 *
 * Per BACKEND-REPUTATION-SSOT round-1 hold #14/#15/#17:
 * - #14 clearStagingKeys is the crash-recovery contract for the atomic Lua
 *   swap. Validated directly here rather than only transitively via
 *   runBatchComputation, so a future refactor that drops the staging-key
 *   sweep is caught at the unit level.
 * - #15 the CYCLE_SWAP_LUA atomicity primitive renames every staging key
 *   into its prod counterpart, advances cycle:last, and DELs the in-progress
 *   sentinel in one atomic Redis script. Tested via direct redis.eval to
 *   prove the script's invariants without depending on HAF or the
 *   surrounding orchestrator.
 * - #17 the in-progress sentinel survives a crash between sentinel-SET and
 *   the atomic Lua, so clearInProgressSentinels surfaces an operator alert
 *   on the next startup. Tested by pre-seeding sentinel keys and asserting
 *   the helper DELs them with a loud log.
 *
 * These tests run against real Redis (no mocked database pools per root
 * CLAUDE.md "Running Tests"). They isolate themselves by writing to scoped
 * test usernames and clearing those keys in afterEach.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRedis } from '../../src/redis.js';
import { logger } from '../../src/logger.js';
import { batchKey, BATCH_KEY_PREFIX, REDIS_KEY_STAGING_PREFIX, getBatchReputationMap, seedAccreditationBonus, invalidateOnRevocation, __test_seams as reputationSeams } from '../../src/reputation.js';
import { __test_seams } from '../../src/reputation-batch.js';

const TEST_USERS = ['pevo-batch-internals-alice', 'pevo-batch-internals-bob'];

// A members-index key OUTSIDE BATCH_KEY_PREFIX (so the backfill SCAN of
// `${BATCH_KEY_PREFIX}*` never enumerates it) and unique to this file, so tests
// that exercise the empty-index backfill path can isolate the members set from
// sibling files racing the shared production index under the concurrent runner.
// Routed in via the reputation __test_seams override.
const TEST_MEMBERS_KEY = BATCH_KEY_PREFIX.replace(/batch:$/, 'test_backfill_members');

async function cleanup() {
  const redis = getRedis();
  if (!redis) return;
  for (const u of TEST_USERS) {
    await redis.del(batchKey(u));
    await redis.del(`${__test_seams.REDIS_KEY_STAGING_PREFIX}${u}`);
    // The CYCLE_SWAP Lua SADDs each renamed prod key into the members set;
    // SREM the test users so the index doesn't leak into other suites' reads.
    await redis.srem(__test_seams.REDIS_KEY_BATCH_MEMBERS, batchKey(u));
  }
  // Sweep any in_progress sentinel left behind by this test file alone.
  const sentinels = await redis.keys(`${__test_seams.REDIS_KEY_IN_PROGRESS_PREFIX}*`);
  if (sentinels.length > 0) await redis.del(...sentinels);
  // Drop the isolated members index and restore the production members-set key,
  // so a test that repointed the index can't leak the override into the next.
  await redis.del(TEST_MEMBERS_KEY);
  reputationSeams.setBatchMembersKey(null);
  // Don't touch REDIS_KEY_LAST_CYCLE — other suites may rely on it.
}

describe('reputation-batch internals: staging-prefix invariant', () => {
  // Locks the single-source-of-truth derivation from BACKEND-REPUTATION-SSOT
  // round-2 hold #7. The staging prefix MUST be a sub-namespace under the
  // prod batch prefix: a divergence would let staging keys leak into the
  // reader filter in `getBatchReputationMap` (which excludes by
  // `startsWith(REDIS_KEY_STAGING_PREFIX)`) and produce in-flight values in
  // the read path. The test-seams export must agree with the canonical
  // reputation.ts export, since both back the reader and writer respectively.
  it('REDIS_KEY_STAGING_PREFIX is a sub-namespace under BATCH_KEY_PREFIX', () => {
    expect(REDIS_KEY_STAGING_PREFIX.startsWith(BATCH_KEY_PREFIX)).toBe(true);
    expect(__test_seams.REDIS_KEY_STAGING_PREFIX).toBe(REDIS_KEY_STAGING_PREFIX);
  });
});

describe('reputation-batch internals: clearStagingKeys', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('DELs every staging key under the prefix', async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');

    const key1 = `${__test_seams.REDIS_KEY_STAGING_PREFIX}${TEST_USERS[0]}`;
    const key2 = `${__test_seams.REDIS_KEY_STAGING_PREFIX}${TEST_USERS[1]}`;
    await redis.set(key1, '{"score":1}');
    await redis.set(key2, '{"score":2}');

    expect(await redis.exists(key1, key2)).toBe(2);

    await __test_seams.clearStagingKeys(redis);

    expect(await redis.exists(key1, key2)).toBe(0);
  });

  it('is a no-op when no staging keys exist', async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');

    // Should not throw, should not log "Cleared abandoned" with count > 0.
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as unknown as void);
    try {
      await __test_seams.clearStagingKeys(redis);
      const calls = infoSpy.mock.calls.filter(([arg]) => {
        return typeof arg === 'object' && arg !== null && 'count' in (arg as object);
      });
      // The count==0 branch in clearStagingKeys explicitly skips the info log.
      expect(calls).toHaveLength(0);
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe('reputation-batch internals: atomic Lua RENAME swap', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('renames every staging key, sets cycle:last, DELs the sentinel', async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');

    const stagingA = `${__test_seams.REDIS_KEY_STAGING_PREFIX}${TEST_USERS[0]}`;
    const stagingB = `${__test_seams.REDIS_KEY_STAGING_PREFIX}${TEST_USERS[1]}`;
    const prodA = batchKey(TEST_USERS[0]);
    const prodB = batchKey(TEST_USERS[1]);

    const valA = JSON.stringify({ score: 11, breakdown: { papers: 6, reviews: 0, citations: 0, accreditation: 5 } });
    const valB = JSON.stringify({ score: 17, breakdown: { papers: 10, reviews: 2, citations: 0, accreditation: 5 } });
    await redis.set(stagingA, valA);
    await redis.set(stagingB, valB);

    // Snapshot existing cycle:last so we can restore it after the test.
    const lastCyclePrior = await redis.get(__test_seams.REDIS_KEY_LAST_CYCLE);

    const sentinelKey = `${__test_seams.REDIS_KEY_IN_PROGRESS_PREFIX}9999`;
    await redis.set(sentinelKey, '9999');

    try {
      // KEYS layout: [...staging, sentinel, members-set] (stagingKeys.length + 2).
      const stagingKeys = [stagingA, stagingB];
      await redis.eval(
        __test_seams.CYCLE_SWAP_LUA,
        stagingKeys.length + 2,
        ...stagingKeys,
        sentinelKey,
        __test_seams.REDIS_KEY_BATCH_MEMBERS,
        '9999',
        __test_seams.REDIS_KEY_LAST_CYCLE,
        __test_seams.CYCLE_SWAP_STAGING_SUBSTRING,
        __test_seams.CYCLE_SWAP_PROD_SUBSTRING,
      );

      // Staging keys are gone.
      expect(await redis.exists(stagingA, stagingB)).toBe(0);
      // Prod keys present with the same JSON values.
      expect(await redis.get(prodA)).toBe(valA);
      expect(await redis.get(prodB)).toBe(valB);
      // Both renamed prod keys SADD'd into the members set inside the swap.
      expect(await redis.sismember(__test_seams.REDIS_KEY_BATCH_MEMBERS, prodA)).toBe(1);
      expect(await redis.sismember(__test_seams.REDIS_KEY_BATCH_MEMBERS, prodB)).toBe(1);
      // cycle:last advanced.
      expect(await redis.get(__test_seams.REDIS_KEY_LAST_CYCLE)).toBe('9999');
      // Sentinel is gone (atomic-swap proof — Lua's final DEL fired).
      expect(await redis.exists(sentinelKey)).toBe(0);
    } finally {
      // Restore prior cycle:last state so other tests aren't perturbed.
      if (lastCyclePrior !== null) {
        await redis.set(__test_seams.REDIS_KEY_LAST_CYCLE, lastCyclePrior);
      } else {
        await redis.del(__test_seams.REDIS_KEY_LAST_CYCLE);
      }
    }
  });
});

describe('reputation-batch internals: getBatchReputationMap members-set read', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('enumerates prod scores via the members set (SMEMBERS + MGET), not a keyspace KEYS glob', async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');

    // Seed one prod batch key and register it in the members index exactly as
    // the CYCLE_SWAP Lua would. getBatchReputationMap must surface it via the
    // SMEMBERS fast path. A second prod key that is NOT in the members set must
    // NOT appear (proving the read is bounded by the index, not a keyspace glob)
    // — unless the whole index is empty and the backfill scan engages, which the
    // first key's membership prevents here.
    const indexed = batchKey(TEST_USERS[0]);
    const unindexed = batchKey(TEST_USERS[1]);
    const indexedVal = JSON.stringify({ score: 42, breakdown: { papers: 30, reviews: 7, citations: 0, accreditation: 5 } });
    await redis.set(indexed, indexedVal);
    await redis.set(unindexed, JSON.stringify({ score: 99, breakdown: { papers: 0, reviews: 0, citations: 0, accreditation: 99 } }));
    await redis.sadd(__test_seams.REDIS_KEY_BATCH_MEMBERS, indexed);

    const map = await getBatchReputationMap();
    expect(map.get(TEST_USERS[0])?.score).toBe(42);
    // The un-indexed prod key is invisible to the SMEMBERS-bounded read.
    expect(map.has(TEST_USERS[1])).toBe(false);
  });
});

describe('reputation-batch internals: in-progress sentinel recovery', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('clearInProgressSentinels DELs survivors and emits a loud error log', async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');

    const sentinel1 = `${__test_seams.REDIS_KEY_IN_PROGRESS_PREFIX}42`;
    const sentinel2 = `${__test_seams.REDIS_KEY_IN_PROGRESS_PREFIX}43`;
    await redis.set(sentinel1, '42');
    await redis.set(sentinel2, '43');

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
    try {
      await __test_seams.clearInProgressSentinels(redis);

      // Both sentinels DEL'd.
      expect(await redis.exists(sentinel1, sentinel2)).toBe(0);
      // Loud error log fired with both keys named.
      const errCalls = errorSpy.mock.calls.filter(([ctx]) => {
        return typeof ctx === 'object' && ctx !== null && 'count' in (ctx as object);
      });
      expect(errCalls).toHaveLength(1);
      const [logCtx, msg] = errCalls[0] as [{ count: number; keys: string[] }, string];
      expect(logCtx.count).toBe(2);
      expect(new Set(logCtx.keys)).toEqual(new Set([sentinel1, sentinel2]));
      expect(msg).toMatch(/crashed mid-swap/);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('is silent when no sentinels exist', async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
    try {
      await __test_seams.clearInProgressSentinels(redis);
      const errCalls = errorSpy.mock.calls.filter(([ctx]) => {
        return typeof ctx === 'object' && ctx !== null && 'count' in (ctx as object);
      });
      expect(errCalls).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('reputation-batch internals: getBatchReputationMap staging-key filter', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('returns prod entries and ignores staging entries for the same user', async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');

    // Isolate the members index onto a test-unique key so the empty-index
    // backfill SCAN (which this assertion depends on, to surface the prod key
    // and filter the staging key) fires deterministically instead of racing a
    // sibling file's CYCLE_SWAP SADD into the shared production members set.
    reputationSeams.setBatchMembersKey(TEST_MEMBERS_KEY);

    // Seed: prod entry for alice with score 50, staging entry for alice with
    // score 999 (the "in-flight" value a reader must NOT observe).
    const prodKey = batchKey(TEST_USERS[0]);
    const stagingKey = `${__test_seams.REDIS_KEY_STAGING_PREFIX}${TEST_USERS[0]}`;
    await redis.set(prodKey, JSON.stringify({ score: 50, breakdown: { papers: 45, reviews: 0, citations: 0, accreditation: 5 } }));
    await redis.set(stagingKey, JSON.stringify({ score: 999, breakdown: { papers: 994, reviews: 0, citations: 0, accreditation: 5 } }));

    // Dynamic-import after seeding so the staging-prefix filter inside
    // getBatchReputationMap evaluates against the live BATCH_KEY_PREFIX. Use
    // BATCH_KEY_PREFIX import to drop a TS-side reference and assert keys
    // align even if the prefix shape ever migrates.
    expect(prodKey.startsWith(BATCH_KEY_PREFIX)).toBe(true);
    expect(stagingKey.startsWith(BATCH_KEY_PREFIX)).toBe(true);

    const { getBatchReputationMap } = await import('../../src/reputation.js');
    const map = await getBatchReputationMap();

    // Only the prod value should be observable. Staging value (999) MUST NOT
    // surface to readers.
    expect(map.get(TEST_USERS[0])?.score).toBe(50);
    // Map keys are bare usernames — no staging-prefix leakage either.
    expect([...map.keys()]).not.toContain(`staging:${TEST_USERS[0]}`);
  });
});

describe('reputation-batch internals: getBatchReputationMap empty-index backfill', () => {
  // The members index is repointed onto TEST_MEMBERS_KEY (cleanup DELs it and
  // restores the production key), so the empty-set backfill path is exercised
  // deterministically — the shared production members set is written by sibling
  // files under the concurrent runner and would race non-empty between the
  // cleanup DEL and the SMEMBERS read, skipping the backfill under test.
  const BACKFILL_USER = 'pevo-batch-backfill-carol';

  async function backfillCleanup() {
    await cleanup();
    const redis = getRedis();
    if (!redis) return;
    await redis.del(batchKey(BACKFILL_USER));
    await redis.del(`${REDIS_KEY_STAGING_PREFIX}${BACKFILL_USER}`);
  }

  beforeEach(backfillCleanup);
  afterEach(backfillCleanup);

  it('SCAN-backfills an empty members index, SADDs the prod key, then takes the SMEMBERS fast path', async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');
    reputationSeams.setBatchMembersKey(TEST_MEMBERS_KEY);
    await redis.set(batchKey(BACKFILL_USER), JSON.stringify({ score: 42, breakdown: { papers: 20, reviews: 10, citations: 7, accreditation: 5 } }));

    // First read: SMEMBERS(TEST_MEMBERS_KEY) is empty -> SCAN finds the prod key
    // -> SADD into the index -> returns it. Robust to sibling prod keys the SCAN
    // may surface: only our user is asserted.
    const first = await getBatchReputationMap();
    expect(first.get(BACKFILL_USER)?.score).toBe(42);
    // The backfill registered the prod key in the (now non-empty) index.
    expect(await redis.sismember(TEST_MEMBERS_KEY, batchKey(BACKFILL_USER))).toBe(1);

    // Second read takes the SMEMBERS fast path (index non-empty) and still
    // returns the user.
    const second = await getBatchReputationMap();
    expect(second.get(BACKFILL_USER)?.score).toBe(42);
  });

  it('skips a stale member whose prod key is absent (MGET-null) without throwing', async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');
    reputationSeams.setBatchMembersKey(TEST_MEMBERS_KEY);
    // Index references a prod key that no longer exists (e.g. a revoked user the
    // SREM raced, or a dropped cycle key). MGET returns null; the reader skips it
    // rather than throwing or surfacing a zero-score ghost.
    await redis.sadd(TEST_MEMBERS_KEY, batchKey(BACKFILL_USER));
    const map = await getBatchReputationMap();
    expect(map.has(BACKFILL_USER)).toBe(false);
  });

  it('never surfaces a staging-prefixed key that contaminated the index', async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');
    reputationSeams.setBatchMembersKey(TEST_MEMBERS_KEY);
    // A staging key SADD'd into the index must be filtered (the reader excludes
    // by REDIS_KEY_STAGING_PREFIX), never surfaced as a `staging:<name>` user.
    const stagingKey = `${REDIS_KEY_STAGING_PREFIX}${BACKFILL_USER}`;
    await redis.set(stagingKey, JSON.stringify({ score: 999, breakdown: { papers: 999, reviews: 0, citations: 0, accreditation: 0 } }));
    await redis.sadd(TEST_MEMBERS_KEY, stagingKey);
    const map = await getBatchReputationMap();
    expect([...map.keys()].some((k) => k.includes('staging'))).toBe(false);
    expect(map.has(BACKFILL_USER)).toBe(false);
  });
});

describe('reputation-batch internals: prev_scores rehydration uses batchMapToScoreRecord (round-2 hold #5)', () => {
  // Per BACKEND-REPUTATION-SSOT round-2 hold #5: round-1 hold #11 required
  // `runBatchComputation` to source prev_scores via
  // `batchMapToScoreRecord(await getBatchReputationMap())` instead of a
  // hand-rolled keys/filter/mget/parse loop. The fix landed at
  // reputation-batch.ts:290 but no test exercises the default-param path —
  // a revert to a hand-rolled loop produced the same {username: score}
  // shape via different code and was invisible.
  //
  // Carve-out clause-(a): the production triggers for this branch
  // (startCycle > 0 with a populated Redis map AND a real HAF head block
  // > genesis + cycle_blocks) require coordinating the periodic batch
  // scheduler. Driving it deterministically per-test requires mocking the
  // top-of-function early returns AND short-circuiting computeReputationBatch
  // so the cycle loop returns quickly. The mutation pinned is structural
  // (helper usage vs. hand-rolled), not behavioral.
  //
  // Real-path companion: stats-profile-parity.test.ts third + fourth arms
  // exercise getBatchReputationMap + the reader pipeline against real
  // Redis, covering the {username: score} shape behaviorally — a
  // hand-rolled loop that produces the wrong shape would surface there.
  // This test pins the structural usage so a refactor revert is caught.
  it('runBatchComputation invokes batchMapToScoreRecord on the default-param path', { retry: 5, timeout: 30_000 }, async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');
    // Seed a prior cycle's prod entry so `prevScores` rehydration has
    // something to fold. The spy assertion only requires that the helper
    // is invoked; it does not depend on the rehydrated shape.
    const seededUser = TEST_USERS[0];
    const seededValue = JSON.stringify({
      score: 12,
      breakdown: { papers: 7, reviews: 0, citations: 0, accreditation: 5 },
    });
    await redis.set(batchKey(seededUser), seededValue);

    const reputationModule = await import('../../src/reputation.js');
    const reputationBatchModule = await import('../../src/reputation-batch.js');
    const accreditationModule = await import('../../src/accreditation.js');

    // Force startCycle > 0 so prev-scores rehydration fires. Save and
    // restore cycle:last so other tests aren't perturbed.
    const priorCycle = await redis.get(__test_seams.REDIS_KEY_LAST_CYCLE);
    await redis.set(__test_seams.REDIS_KEY_LAST_CYCLE, '0');
    // Make this run immune to the cross-file-shared calc:version key: intercept
    // ONLY the calc:version read and return the fingerprint runBatchComputation
    // computes for the live weights, so calcVersionChanged is false and
    // startCycle stays 1 (the prev-scores resume path this test pins). Without
    // this, a concurrent sibling writing calc:version mid-run would force a
    // replay from cycle 0 and skip the batchMapToScoreRecord call. The spy
    // delegates every other key to the real client, and the run never WRITES
    // calc:version (calcVersionChanged is false), so it cannot leak the stamp.
    const matchingVersion = reputationModule.computeCalcVersion(await reputationModule.getReputationWeights());
    const realGet = redis.get.bind(redis);
    const calcVersionGetSpy = vi
      .spyOn(redis, 'get')
      .mockImplementation(((key: string) =>
        key === __test_seams.REDIS_KEY_CALC_VERSION ? Promise.resolve(matchingVersion) : realGet(key)) as never);

    const batchMapSpy = vi.spyOn(reputationModule, 'batchMapToScoreRecord');
    // Short-circuit the SQL so the cycle loop doesn't burn the budget.
    const computeSpy = vi.spyOn(reputationModule, 'computeReputationBatch').mockResolvedValue(new Map());
    // Pin a small accredited set so the batch has someone to score (or
    // exits early at scoredUsers.size === 0 with cycle advance, which
    // still passes through the prev-scores load if startCycle > 0).
    const accSpy = vi.spyOn(accreditationModule, 'getAllAccreditedAccounts').mockResolvedValue(new Set([seededUser]));

    try {
      await reputationBatchModule.runBatchComputation(5_000);
      // Helper invocation pinned — a hand-rolled loop replacing the call
      // would leave the spy at zero calls.
      expect(batchMapSpy).toHaveBeenCalled();
      const firstCallArg = batchMapSpy.mock.calls[0]?.[0];
      // Argument is the Map<string, ReputationScore> returned by
      // getBatchReputationMap(); guard it has the expected interface.
      expect(firstCallArg).toBeInstanceOf(Map);
    } finally {
      calcVersionGetSpy.mockRestore();
      batchMapSpy.mockRestore();
      computeSpy.mockRestore();
      accSpy.mockRestore();
      if (priorCycle !== null) {
        await redis.set(__test_seams.REDIS_KEY_LAST_CYCLE, priorCycle);
      } else {
        await redis.del(__test_seams.REDIS_KEY_LAST_CYCLE);
      }
      await redis.del(batchKey(seededUser));
    }
  });
});

describe('reputation-batch internals: members-index write paths (seed SADD / revoke SREM)', () => {
  // seedAccreditationBonus must SADD the prod key into the members index and
  // invalidateOnRevocation must SREM it, so getBatchReputationMap's SMEMBERS read
  // sees a freshly-seeded user and stops seeing a revoked one. A revert of either
  // index-maintenance line turns these red. The index is repointed onto
  // TEST_MEMBERS_KEY (cleanup DELs it + restores the production key) so the
  // assertions don't race a sibling file's SADD to the shared production members set.
  const WRITE_USER = 'pevo-batch-write-path-dave';

  async function writePathCleanup() {
    const redis = getRedis();
    if (!redis) return;
    await redis.del(batchKey(WRITE_USER));
    await redis.del(TEST_MEMBERS_KEY);
    reputationSeams.setBatchMembersKey(null);
  }
  beforeEach(writePathCleanup);
  afterEach(writePathCleanup);

  it('seedAccreditationBonus SADDs the prod key into the members index on a fresh seed', async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');
    reputationSeams.setBatchMembersKey(TEST_MEMBERS_KEY);

    await seedAccreditationBonus(WRITE_USER);

    expect(await redis.exists(batchKey(WRITE_USER))).toBe(1);
    expect(await redis.sismember(TEST_MEMBERS_KEY, batchKey(WRITE_USER))).toBe(1);
  });

  it('seedAccreditationBonus re-indexes an already-present prod key (unconditional SADD closes the orphan window)', async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');
    reputationSeams.setBatchMembersKey(TEST_MEMBERS_KEY);

    // Orphan window: the prod key already exists (e.g. a prior crash wrote the SET
    // but died before its separate SADD) but is NOT in the members index. A retry's
    // NX SET no-ops; the SADD must still run unconditionally — a form gated on the
    // NX result would skip it here and leave the user invisible to the SMEMBERS read.
    await redis.set(batchKey(WRITE_USER), JSON.stringify({ score: 1, breakdown: { papers: 0, reviews: 0, citations: 0, accreditation: 1 } }));
    expect(await redis.sismember(TEST_MEMBERS_KEY, batchKey(WRITE_USER))).toBe(0);

    await seedAccreditationBonus(WRITE_USER);

    expect(await redis.sismember(TEST_MEMBERS_KEY, batchKey(WRITE_USER))).toBe(1);
  });

  it('invalidateOnRevocation SREMs the prod key from the members index', async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');
    reputationSeams.setBatchMembersKey(TEST_MEMBERS_KEY);

    await seedAccreditationBonus(WRITE_USER);
    expect(await redis.sismember(TEST_MEMBERS_KEY, batchKey(WRITE_USER))).toBe(1);

    await invalidateOnRevocation(WRITE_USER);

    expect(await redis.exists(batchKey(WRITE_USER))).toBe(0);
    expect(await redis.sismember(TEST_MEMBERS_KEY, batchKey(WRITE_USER))).toBe(0);
  });
});

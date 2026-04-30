/**
 * Accreditation lifecycle + batch idempotency tests.
 *
 * Covers the acceptance criteria from
 * backend-reputation-single-source-of-truth.md scope #7:
 *
 * 1. Fresh accreditation seeds the bonus immediately, without waiting for
 *    a cycle boundary. Exercises seedAccreditationBonus() directly because
 *    the broadcast itself can't be reproduced in test (no chain).
 * 2. Revocation drops the entry to 0 immediately. Exercises
 *    invalidateOnRevocation() directly for the same reason.
 * 3. computeReputationBatch is deterministic — re-running with identical
 *    inputs produces a byte-identical result map. Catches non-deterministic
 *    SQL (missing ORDER BY, unstable DISTINCT, FP reordering).
 *
 * Mock carve-out (per root CLAUDE.md "Running Tests" carve-out clauses
 * a/b/c): the `seedAccreditationBonus — permanent vs transient error
 * discrimination` describe block at the bottom of this file uses
 * `vi.spyOn(redis, 'set')`, `vi.spyOn(logger, 'warn')`, and
 * `vi.spyOn(redisModule, 'getRedis')` to drive the cascade fn into its
 * permanent / transient / null-Redis branches deterministically.
 *
 * (a) Real path that's impractical: the production triggers for the
 *     permanent branch (TypeError thrown by `provisionalScore` on a
 *     malformed `weights.accreditation_bonus`, SyntaxError on a corrupted
 *     upstream weights JSON document) require corrupting real HAF /
 *     real Redis state, which (i) bleeds across the suite's shared Redis
 *     fixture and (ii) couples a class-based discrimination test to a
 *     specific upstream data shape. Likewise the null-Redis branch can't
 *     be exercised against the real fixture without tearing down the
 *     shared connection mid-suite.
 * (b) Why these mocks are justified: the discrimination is class-based
 *     (`isPermanentSeedError` matches `TypeError | SyntaxError |
 *     RangeError`), so any error of the right class surfaces the same
 *     branch — the test only needs a deterministic source of that error
 *     class. `verifyHiveSignature` and other middleware are NOT mocked
 *     (these are unit-level specs against the function directly, not
 *     route specs). `vi.spyOn(redisModule, 'getRedis')` is the same
 *     namespace-import + spy pattern round-1 established for
 *     `appDbModule.getAppPool` in `tests/routes/orcid.test.ts`.
 * (c) Real-Redis sibling coverage: the rest of this file (lifecycle
 *     seed-on-grant, invalidate-on-revocation, batch idempotency) runs
 *     against real Redis + real HAF and exercises `seedAccreditationBonus`
 *     end-to-end on the happy path. The carve-out covers only the
 *     error-class branches the happy path can't reach.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as redisModule from '../../src/redis.js';
import { getRedis } from '../../src/redis.js';
import { logger } from '../../src/logger.js';
import {
  batchKey,
  computeReputationBatch,
  getReputationScore,
  invalidateOnRevocation,
  seedAccreditationBonus,
} from '../../src/reputation.js';
import { DEFAULT_REPUTATION_WEIGHTS } from '../../src/types/index.js';
import { isHafAvailable } from '../../src/db.js';
import { getAllAccreditedAccounts } from '../../src/accreditation.js';
import { getCachedGenesisBlock } from '../../src/hafsql.js';

const TEST_USER = 'pevo-lifecycle-test-user';

describe('accreditation lifecycle: seed on grant', () => {
  beforeEach(async () => {
    const redis = getRedis();
    if (redis) await redis.del(batchKey(TEST_USER));
  });

  it('seedAccreditationBonus writes the provisional entry', async () => {
    const redis = getRedis();
    if (!redis) return;

    await seedAccreditationBonus(TEST_USER);

    const raw = await redis.get(batchKey(TEST_USER));
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.score).toBe(DEFAULT_REPUTATION_WEIGHTS.accreditation_bonus);
    expect(parsed.breakdown.papers).toBe(0);
    expect(parsed.breakdown.reviews).toBe(0);
    expect(parsed.breakdown.citations).toBe(0);
    expect(parsed.breakdown.accreditation).toBe(DEFAULT_REPUTATION_WEIGHTS.accreditation_bonus);
  });

  it('getReputationScore returns the bonus immediately, without a cycle', async () => {
    const redis = getRedis();
    if (!redis) return;

    await seedAccreditationBonus(TEST_USER);
    const rep = await getReputationScore(TEST_USER);

    expect(rep.score).toBe(DEFAULT_REPUTATION_WEIGHTS.accreditation_bonus);
    expect(rep.breakdown.accreditation).toBe(DEFAULT_REPUTATION_WEIGHTS.accreditation_bonus);
  });

  it('SET NX semantics: never clobbers a real cycle-computed score', async () => {
    const redis = getRedis();
    if (!redis) return;

    const real = {
      score: 87.5,
      breakdown: { papers: 30, reviews: 40, citations: 12.5, accreditation: 5 },
    };
    await redis.set(batchKey(TEST_USER), JSON.stringify(real));

    await seedAccreditationBonus(TEST_USER);

    const after = await getReputationScore(TEST_USER);
    expect(after.score).toBe(87.5);
    expect(after.breakdown.papers).toBe(30);
  });
});

describe('accreditation lifecycle: invalidate on revocation', () => {
  beforeEach(async () => {
    const redis = getRedis();
    if (redis) await redis.del(batchKey(TEST_USER));
  });

  it('invalidateOnRevocation deletes the entry', async () => {
    const redis = getRedis();
    if (!redis) return;

    const stale = {
      score: 42,
      breakdown: { papers: 10, reviews: 20, citations: 7, accreditation: 5 },
    };
    await redis.set(batchKey(TEST_USER), JSON.stringify(stale));

    await invalidateOnRevocation(TEST_USER);

    const raw = await redis.get(batchKey(TEST_USER));
    expect(raw).toBeNull();
  });

  it('getReputationScore returns 0 immediately after revocation, without a cycle', async () => {
    const redis = getRedis();
    if (!redis) return;

    const stale = {
      score: 42,
      breakdown: { papers: 10, reviews: 20, citations: 7, accreditation: 5 },
    };
    await redis.set(batchKey(TEST_USER), JSON.stringify(stale));

    await invalidateOnRevocation(TEST_USER);

    const rep = await getReputationScore(TEST_USER);
    expect(rep.score).toBe(0);
    expect(rep.breakdown).toEqual({ papers: 0, reviews: 0, citations: 0, accreditation: 0 });
  });
});

describe('computeReputationBatch idempotency', () => {
  it('two runs with identical inputs produce a byte-identical result map', { timeout: 90_000 }, async () => {
    if (!isHafAvailable()) return;

    const accredited = await getAllAccreditedAccounts();
    if (accredited.size === 0) return; // No corpus — skip

    const users = [...accredited].slice(0, 5);
    const genesis = getCachedGenesisBlock();
    if (genesis === 0) return;

    // Use a fixed cycleEndBlock (genesis + 1 day at 3s blocks) so head-block
    // drift between the two runs cannot perturb the result.
    const cycleEndBlock = genesis + 28_800;
    const prevScores = {};

    const run1 = await computeReputationBatch(users, prevScores, cycleEndBlock);
    const run2 = await computeReputationBatch(users, prevScores, cycleEndBlock);

    const obj1 = Object.fromEntries(run1);
    const obj2 = Object.fromEntries(run2);
    expect(JSON.stringify(obj2)).toBe(JSON.stringify(obj1));
  });
});

// BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS — `seedAccreditationBonus`
// re-throws on permanent (operator-actionable) error classes so the orcid
// post-broadcast cascade wrap surfaces 502 POST_BROADCAST_FAILED with
// `failed_step:'reputation_seed'`. Transient errors (Redis-side blips) stay
// swallowed because the next batch cycle re-derives provisional scores from
// chain state regardless. The discrimination is class-based (TypeError /
// SyntaxError / RangeError signal data-shape regressions in the upstream
// weights or scoring code, which the next cycle will NOT self-heal).
describe('seedAccreditationBonus — permanent vs transient error discrimination', () => {
  const RETHROW_USER = 'pevo-cascade-rethrow-test-user';

  beforeEach(async () => {
    const redis = getRedis();
    if (redis) await redis.del(batchKey(RETHROW_USER));
  });

  it('re-throws permanent errors (TypeError) so post-broadcast discrimination surfaces 502', async () => {
    const redis = getRedis();
    if (!redis) return; // Redis required to exercise the try/catch path.

    // Synthesize a permanent error from `redis.set` — the actual production
    // source is more typically a TypeError thrown inside
    // `provisionalScore(weights.accreditation_bonus)` when getReputationWeights
    // returns malformed data, but the discrimination is class-based, so any
    // TypeError surfaces the same branch. Pinning it via redis.set keeps the
    // test deterministic without depending on a corrupted weights document.
    const permanentErr = new TypeError("Cannot read property 'accreditation_bonus' of null");
    const setSpy = vi.spyOn(redis, 'set').mockRejectedValueOnce(permanentErr);

    try {
      await expect(seedAccreditationBonus(RETHROW_USER)).rejects.toBe(permanentErr);
    } finally {
      setSpy.mockRestore();
    }
  });

  it('re-throws permanent errors (SyntaxError)', async () => {
    const redis = getRedis();
    if (!redis) return;
    const permanentErr = new SyntaxError('Unexpected token in JSON at position 0');
    const setSpy = vi.spyOn(redis, 'set').mockRejectedValueOnce(permanentErr);
    try {
      await expect(seedAccreditationBonus(RETHROW_USER)).rejects.toBe(permanentErr);
    } finally {
      setSpy.mockRestore();
    }
  });

  it('swallows transient errors (generic Error) — next batch cycle re-derives', async () => {
    const redis = getRedis();
    if (!redis) return;
    const transientErr = new Error('Connection is closed');
    const setSpy = vi.spyOn(redis, 'set').mockRejectedValueOnce(transientErr);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);

    try {
      await expect(seedAccreditationBonus(RETHROW_USER)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: transientErr, username: RETHROW_USER }),
        'Failed to seed accreditation bonus',
      );
    } finally {
      warnSpy.mockRestore();
      setSpy.mockRestore();
    }
  });

  it('returns silently when Redis is unavailable (transient — next cycle re-derives)', async () => {
    // Spec is intentionally conservative: a Redis outage at the time of an
    // accredit broadcast should NOT surface 502 POST_BROADCAST_FAILED to the
    // user, because the next batch cycle reconstructs the provisional score
    // from chain state. Re-throwing on null-Redis would couple the user-
    // visible accredit envelope to ephemeral Redis health, which is the
    // wrong contract per the task spec ("transient errors stay swallowed
    // because next batch cycle re-derives anyway").
    //
    // The shared-Redis fixture is up in the documented test topology, so we
    // flip `getRedis()` to null via `vi.spyOn(redisModule, 'getRedis')`
    // (same namespace-import + spy pattern round-1 established for
    // `appDbModule.getAppPool`). Asserts: silent return (no throw), no
    // Redis call, no log line — the function's `if (!redis) return` guard
    // is the only branch reached.
    const redis = getRedis();
    if (!redis) return; // No real Redis to spy on; nothing to assert.

    const getRedisSpy = vi.spyOn(redisModule, 'getRedis').mockReturnValueOnce(null);
    const setSpy = vi.spyOn(redis, 'set');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);

    try {
      await expect(seedAccreditationBonus(RETHROW_USER)).resolves.toBeUndefined();
      expect(getRedisSpy).toHaveBeenCalledTimes(1);
      expect(setSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      setSpy.mockRestore();
      getRedisSpy.mockRestore();
    }
  });
});


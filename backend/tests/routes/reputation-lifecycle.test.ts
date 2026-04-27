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
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getRedis } from '../../src/redis.js';
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


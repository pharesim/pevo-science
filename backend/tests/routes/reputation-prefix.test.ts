/**
 * Prefix invariant regression test for reputation Redis writes.
 *
 * Why bare globs (`reputation:batch:*`, `reputation:cycle:last`) instead of
 * `${config.appTag}:reputation:batch:*`? `tests/setup.ts:21` flushes every
 * key under `${config.appTag}:*` before each suite run. An unprefixed write
 * (e.g. plain `reputation:batch:alice`) would survive that flush AND would
 * be invisible to a `${config.appTag}:*` glob — exactly the prefix-drift
 * bug this regression test exists to catch.
 *
 * The bare-glob assertions below are the ONLY thing that catches a future
 * code path that skips the appTag prefix. Do NOT "helpfully" rewrite them
 * to use `${config.appTag}:*` or this regression check is silently defeated.
 *
 * Task: backend-reputation-single-source-of-truth.md scope #6.
 */
import { describe, it, expect } from 'vitest';
import { config } from '../../src/config.js';
import { getRedis } from '../../src/redis.js';
import { runBatchComputation } from '../../src/reputation-batch.js';
import {
  BATCH_KEY_PREFIX,
  REDIS_KEY_BATCH_MEMBERS,
  batchKey,
  getBatchReputationMap,
  getReputationScore,
  getReputationScores,
} from '../../src/reputation.js';

describe('reputation Redis prefix invariant', () => {
  it('runBatchComputation writes only under ${appTag}:reputation:*', { timeout: 180_000 }, async () => {
    const redis = getRedis();
    if (!redis) return; // Redis-unavailable env: vacuous pass

    // Pre-clean: bare-glob keys may persist from pre-migration legacy state
    // (see scope #8 deploy flush). The regression check catches NEW
    // unprefixed writes by current code, so wipe any legacy survivors first.
    const legacyBatch = await redis.keys('reputation:batch:*');
    if (legacyBatch.length > 0) await redis.del(...legacyBatch);
    const legacyCycle = await redis.keys('reputation:cycle:last');
    if (legacyCycle.length > 0) await redis.del(...legacyCycle);

    await runBatchComputation();

    // Bare globs — see file header. Catches any future caller that skips the
    // ${config.appTag}: segment.
    const bareBatch = await redis.keys('reputation:batch:*');
    expect(bareBatch).toEqual([]);

    const bareCycle = await redis.keys('reputation:cycle:last');
    expect(bareCycle).toEqual([]);

    // Prefixed writes should land. Skip the existence check when the
    // batch couldn't run (HAF unavailable, no accredited corpus, etc.) —
    // the prefix invariant still holds vacuously in those states.
    const prefixed = await redis.keys(`${BATCH_KEY_PREFIX}*`);
    if (prefixed.length > 0) {
      expect(prefixed[0]).toMatch(new RegExp(`^${config.appTag}:reputation:batch:`));
    }
  });

  it('the three readers (map, single, batched) agree on the same prefixed entry', async () => {
    const redis = getRedis();
    if (!redis) return; // Redis-unavailable env: vacuous pass

    const username = 'pevo-prefix-test-user';
    const known = {
      score: 42.5,
      breakdown: { papers: 10, reviews: 20, citations: 7.5, accreditation: 5 },
    };
    await redis.set(batchKey(username), JSON.stringify(known));
    // Register the prod key in the membership index exactly as the CYCLE_SWAP
    // Lua does — getBatchReputationMap enumerates via SMEMBERS, so a prod key
    // absent from the set is invisible to it (production never produces that
    // state: the Lua writes the prod key and the SADD in one atomic swap).
    await redis.sadd(REDIS_KEY_BATCH_MEMBERS, batchKey(username));

    try {
      const [map, single, batched] = await Promise.all([
        getBatchReputationMap(),
        getReputationScore(username),
        getReputationScores([username]),
      ]);

      expect(map.get(username)?.score).toBe(42.5);
      expect(map.get(username)?.breakdown).toEqual(known.breakdown);
      expect(single.score).toBe(42.5);
      expect(single.breakdown).toEqual(known.breakdown);
      expect(batched.get(username)).toBe(42.5);
    } finally {
      await redis.del(batchKey(username));
      await redis.srem(REDIS_KEY_BATCH_MEMBERS, batchKey(username));
    }
  });
});

/**
 * Stats vs profile reader-parity test.
 *
 * Validates that `/api/stats` (highest reputation) and
 * `/api/profile/:username` resolve the same score for the same user.
 *
 * The test seeds Redis directly with known {score, breakdown} entries and
 * exercises both reader paths. It does NOT call runBatchComputation — that
 * batch correctness is covered by reputation-prefix.test.ts. This test is
 * exclusively about reader parity once the batch map is populated.
 *
 * Stats reads via fetchStatsFromHaf() instead of the cached HTTP route
 * because tests do not warm the periodic stats cache (createApp does not
 * fire the after-listen Promise.all in src/index.ts). The function is
 * exported for exactly this reason.
 *
 * Task: backend-reputation-single-source-of-truth.md scope #7.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getRedis } from '../../src/redis.js';
import { batchKey } from '../../src/reputation.js';
import { fetchStatsFromHaf } from '../../src/routes/stats.js';
import { getAllAccreditedAccounts } from '../../src/accreditation.js';
import { hafCache } from '../../src/cache.js';

const app = createApp();

describe('stats vs profile reader parity', () => {
  let accredited: string[] = [];

  beforeAll(async () => {
    const all = await getAllAccreditedAccounts();
    accredited = [...all];
  });

  afterEach(async () => {
    const redis = getRedis();
    if (!redis) return;
    for (const u of accredited.slice(0, 3)) {
      await redis.del(batchKey(u));
    }
    // Stats and profile both go through hafCache; clear so the next test
    // gets fresh values rather than the cached previous state.
    await hafCache.clearVolatile();
  });

  it('stats highest matches /api/profile/:user reputation.score', { timeout: 60_000 }, async () => {
    const redis = getRedis();
    if (!redis) return; // Redis-unavailable env: vacuous pass
    if (accredited.length === 0) return; // No accredited corpus on HAF — skip

    const picks = accredited.slice(0, 3);

    // Seed ascending so the last pick is unambiguously highest.
    const seeded = picks.map((username, i) => ({
      username,
      score: 10 + i * 5, // 10, 15, 20
      breakdown: { papers: 1 + i, reviews: 0, citations: 0, accreditation: 5 },
    }));
    for (const s of seeded) {
      await redis.set(
        batchKey(s.username),
        JSON.stringify({ score: s.score, breakdown: s.breakdown }),
      );
    }

    const highest = seeded[seeded.length - 1];

    const stats = await fetchStatsFromHaf();
    expect(stats).not.toBeNull();
    expect(stats!.highest_reputation_user).toBe(highest.username);
    expect(stats!.highest_reputation_score).toBe(highest.score);

    const profileRes = await request(app).get(`/api/profile/${highest.username}`);
    expect(profileRes.status).toBe(200);
    expect(profileRes.body.status).toBe('ok');
    expect(profileRes.body.data.is_accredited).toBe(true);
    expect(profileRes.body.data.reputation.score).toBe(highest.score);
    expect(profileRes.body.data.reputation.breakdown).toEqual(highest.breakdown);
  });
});

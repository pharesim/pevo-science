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
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getRedis } from '../../src/redis.js';
import { batchKey } from '../../src/reputation.js';
import { __test_seams as batchSeams } from '../../src/reputation-batch.js';
import { fetchStatsFromHaf } from '../../src/routes/stats.js';
import { getAllAccreditedAccounts } from '../../src/accreditation.js';
import { hafCache } from '../../src/cache.js';
import type Redis from 'ioredis';

/**
 * Acquire the batch lock so concurrent runBatchComputation in another worker
 * (e.g., reputation-prefix.test.ts) cannot RENAME a staged value over our
 * seeded entry mid-test. Returns the token + a release fn, or null if a
 * batch run is currently holding it (test should ctx.skip).
 *
 * The reputation-batch module uses SET NX EX 1800 for the same key; we use
 * the same shape so either side observes the lock.
 */
async function acquireBatchLockOrNull(redis: Redis): Promise<{ release: () => Promise<void> } | null> {
  const token = crypto.randomUUID();
  const ok = await redis.set(batchSeams.REDIS_KEY_BATCH_LOCK, token, 'EX', 60, 'NX');
  if (ok !== 'OK') return null;
  return {
    release: async () => {
      const stored = await redis.get(batchSeams.REDIS_KEY_BATCH_LOCK);
      if (stored === token) await redis.del(batchSeams.REDIS_KEY_BATCH_LOCK);
    },
  };
}

/**
 * Retry helper for HAF queries that can return null on transient ECONNRESET
 * during concurrent vitest workers (each worker has its own pg pool, but HAF
 * itself is a shared resource — a sibling worker's heavy reputation batch can
 * trigger a pool-side reset that surfaces as a single null response). Retries
 * up to 3 times with 1-second backoff before giving up.
 */
async function fetchStatsWithRetry(): Promise<Awaited<ReturnType<typeof fetchStatsFromHaf>>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await fetchStatsFromHaf();
    if (result !== null) return result;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

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

  it('stats highest matches /api/profile/:user reputation.score', { timeout: 60_000 }, async (ctx) => {
    const redis = getRedis();
    if (!redis) return ctx.skip(true, 'Redis unavailable');
    if (accredited.length === 0) return ctx.skip(true, 'No accredited corpus on HAF');

    // Same lock-or-skip pattern as the third arm — concurrent batch can RENAME
    // staged values over our seeded entries AND saturates HAF causing stats
    // SQL to time out. Skip when contended.
    const lock = await acquireBatchLockOrNull(redis);
    if (!lock) return ctx.skip(true, 'Concurrent batch run holds the lock');

    try {
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

      const stats = await fetchStatsWithRetry();
      expect(stats).not.toBeNull();
      expect(stats!.highest_reputation_user).toBe(highest.username);
      expect(stats!.highest_reputation_score).toBe(highest.score);

      const profileRes = await request(app).get(`/api/profile/${highest.username}`);
      expect(profileRes.status).toBe(200);
      expect(profileRes.body.status).toBe('ok');
      expect(profileRes.body.data.is_accredited).toBe(true);
      expect(profileRes.body.data.reputation.score).toBe(highest.score);
      expect(profileRes.body.data.reputation.breakdown).toEqual(highest.breakdown);
    } finally {
      await lock.release();
    }
  });

  it(
    'highest_reputation_user is null when no accredited user has a strictly positive score',
    { timeout: 60_000 },
    async (ctx) => {
      // Per BACKEND-REPUTATION-SSOT round-1 hold #20: a regression that flipped
      // the > to >=, initialized highest_reputation_score to -1, or otherwise
      // mishandled the "fresh Redis, no cycle yet" state must be caught here.
      // The parity test above only seeds positive scores so cannot.
      const redis = getRedis();
      if (!redis) return ctx.skip(true, 'Redis unavailable');
      if (accredited.length === 0) return ctx.skip(true, 'No accredited corpus on HAF');

      const lock = await acquireBatchLockOrNull(redis);
      if (!lock) return ctx.skip(true, 'Concurrent batch run holds the lock');

      try {
        const picks = accredited.slice(0, Math.min(3, accredited.length));
        // Seed every pick with score 0 — accredited per chain, but no
        // computed reputation yet (provisional accreditation_bonus is the only
        // "no real cycle" shape that ever lands; here we hand-wire a strict
        // 0 to verify the guard).
        for (const username of picks) {
          await redis.set(
            batchKey(username),
            JSON.stringify({ score: 0, breakdown: { papers: 0, reviews: 0, citations: 0, accreditation: 0 } }),
          );
        }
        // Clear stats hafCache so the next call recomputes from the seeded state.
        await hafCache.clearVolatile();

        const stats = await fetchStatsWithRetry();
        expect(stats).not.toBeNull();
        expect(stats!.highest_reputation_user).toBeNull();
        expect(stats!.highest_reputation_score).toBe(0);
      } finally {
        await lock.release();
      }
    },
  );

  it(
    'paper-list author_reputation matches seeded score (parity third arm)',
    { timeout: 60_000, retry: 3 },
    async (ctx) => {
      // Per BACKEND-REPUTATION-SSOT round-1 hold #21: parity guarantees that
      // every reader displaying a reputation value resolves to the same
      // ${appTag}:reputation:batch:${user} entry. The original parity test
      // covered stats↔profile; this third arm closes the paper-list arm
      // (papers.ts:372-376 enrichment).
      const redis = getRedis();
      if (!redis) return ctx.skip(true, 'Redis unavailable');

      // Acquire the batch lock so a concurrent runBatchComputation in another
      // vitest worker (e.g., reputation-prefix.test.ts) cannot RENAME a
      // staged value over our seeded entry mid-test. Skip if the lock is
      // already held — the parity invariant is exercised by the batch's own
      // outputs in that case.
      const lock = await acquireBatchLockOrNull(redis);
      if (!lock) return ctx.skip(true, 'Concurrent batch run holds the lock');

      try {
        // Fetch a real paper from the live HAF corpus to discover an accredited
        // author with a paper visible to /api/papers. This avoids hand-rolling
        // a fixture that drifts from production filters.
        const listRes = await request(app).get('/api/papers?limit=10');
        expect(listRes.status).toBe(200);
        const rows = listRes.body?.data ?? [];
        const accreditedRow = rows.find((r: { is_accredited?: boolean; author?: string }) => r.is_accredited && r.author);
        if (!accreditedRow) {
          return ctx.skip(true, 'No accredited paper authors visible to /api/papers');
        }

        const seededAuthor = accreditedRow.author as string;
        const seededValue = {
          score: 33,
          breakdown: { papers: 23, reviews: 5, citations: 0, accreditation: 5 },
        };

        const priorRaw = await redis.get(batchKey(seededAuthor));
        try {
          await redis.set(batchKey(seededAuthor), JSON.stringify(seededValue));

          // Concurrency self-check: a sibling worker that already passed the
          // acquireBatchLock guard (different batch implementation, drift
          // from the lock contract, etc.) could still write between the SET
          // and the read. Verify the SET stuck before proceeding; skip
          // rather than fail flakily.
          const verify = await redis.get(batchKey(seededAuthor));
          if (verify !== JSON.stringify(seededValue)) {
            return ctx.skip(true, 'Concurrent writer overwrote seeded value');
          }
          await hafCache.clearVolatile();

          const refetch = await request(app).get('/api/papers?limit=10');
          expect(refetch.status).toBe(200);
          const refetchRows = refetch.body?.data ?? [];
          const seeded = refetchRows.find((r: { author?: string }) => r.author === seededAuthor);
          expect(seeded).toBeDefined();
          expect(seeded.is_accredited).toBe(true);
          expect(seeded.author_reputation).toBe(33);
        } finally {
          if (priorRaw !== null) {
            await redis.set(batchKey(seededAuthor), priorRaw);
          } else {
            await redis.del(batchKey(seededAuthor));
          }
        }
      } finally {
        await lock.release();
      }
    },
  );

  it(
    'stats ignores chain-revoked users with stale prod entries (chain pre-check)',
    { timeout: 60_000 },
    async (ctx) => {
      // Per BACKEND-REPUTATION-SSOT round-1 hold #3: stats must intersect the
      // batch map with chain accreditation before picking max. A non-accredited
      // username with a positive batch score (the "stale prod entry for
      // chain-revoked user" leak class) MUST NOT surface as
      // highest_reputation_user.
      const redis = getRedis();
      if (!redis) return ctx.skip(true, 'Redis unavailable');
      if (accredited.length === 0) return ctx.skip(true, 'No accredited corpus on HAF');

      const lock = await acquireBatchLockOrNull(redis);
      if (!lock) return ctx.skip(true, 'Concurrent batch run holds the lock');

      const realUser = accredited[0];
      const ghostUser = 'pevo-ghost-reputation-leak';

      try {
        // Seed an accredited user with a moderate score, plus a fake
        // non-accredited user with a higher score. The non-accredited user is
        // intentionally outside getAllAccreditedAccounts(): the chain pre-check
        // in stats must drop them from the max calculation.
        await redis.set(
          batchKey(realUser),
          JSON.stringify({ score: 12, breakdown: { papers: 7, reviews: 0, citations: 0, accreditation: 5 } }),
        );
        await redis.set(
          batchKey(ghostUser),
          JSON.stringify({ score: 99, breakdown: { papers: 94, reviews: 0, citations: 0, accreditation: 5 } }),
        );

        await hafCache.clearVolatile();
        const stats = await fetchStatsWithRetry();
        expect(stats).not.toBeNull();
        expect(stats!.highest_reputation_user).toBe(realUser);
        expect(stats!.highest_reputation_score).toBe(12);
      } finally {
        await redis.del(batchKey(ghostUser));
        await lock.release();
      }
    },
  );
});

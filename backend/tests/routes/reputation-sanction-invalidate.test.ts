/**
 * P2 coverage: a sanctioned / de-accredited account's reputation collapses to
 * zero. `invalidateOnRevocation` — wired into POST /api/admin/accreditation/sanction
 * after a successful broadcast — DELs the prod batch key and SREMs the member,
 * so `getReputationScore` falls through to the zero score and the members index
 * stays bounded by the live accredited set. (The reputation batch's per-cycle
 * prune is the backstop for op-less WoT threshold drops, which have no handler
 * to invalidate on.)
 *
 * Uses real Redis (no mocked client); vacuous pass when Redis is unavailable.
 */
import { describe, it, expect } from 'vitest';
import { getRedis } from '../../src/redis.js';
import {
  batchKey,
  REDIS_KEY_BATCH_MEMBERS,
  getReputationScore,
  invalidateOnRevocation,
} from '../../src/reputation.js';

describe('reputation invalidate-on-sanction', () => {
  it('collapses a member score to ZERO and prunes the member on invalidateOnRevocation', async () => {
    const redis = getRedis();
    if (!redis) return; // Redis-unavailable env: vacuous pass

    const account = 'sanctioned-rep-fixture-user';
    // Seed a non-zero batch score + members-index entry (as a completed cycle would).
    await redis.set(
      batchKey(account),
      JSON.stringify({ score: 42, breakdown: { papers: 30, reviews: 5, citations: 5, accreditation: 2 } }),
    );
    await redis.sadd(REDIS_KEY_BATCH_MEMBERS, batchKey(account));

    const before = await getReputationScore(account);
    expect(before.score).toBe(42);

    // The sanction handler calls this after a successful broadcast.
    await invalidateOnRevocation(account);

    const after = await getReputationScore(account);
    expect(after.score).toBe(0);
    expect(after.breakdown).toEqual({ papers: 0, reviews: 0, citations: 0, accreditation: 0 });

    // Member pruned from the index, so it is not MGET-rehydrated into the map.
    const members = await redis.smembers(REDIS_KEY_BATCH_MEMBERS);
    expect(members).not.toContain(batchKey(account));

    // Defensive cleanup (tests/setup.ts also flushes the appTag namespace).
    await redis.del(batchKey(account));
  });
});

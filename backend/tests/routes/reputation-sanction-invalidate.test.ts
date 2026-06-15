/**
 * P2 coverage: a sanctioned / de-accredited account's reputation collapses to
 * zero. `invalidateOnRevocation` — wired into POST /api/admin/accreditation/sanction
 * after a successful broadcast — DELs the prod batch key and SREMs the member,
 * so `getReputationScore` falls through to the zero score and the members index
 * stays bounded by the live accredited set. (The reputation batch's per-cycle
 * prune is the backstop for op-less WoT threshold drops, which have no handler
 * to invalidate on.)
 *
 * Most specs use real Redis (no mocked client; vacuous pass when Redis is
 * unavailable). The single "per-command error" prune spec is the exception
 * (carve-out: deterministic edge-case + observability spy): a per-command DEL
 * failure cannot be induced on real Redis (DEL succeeds on any key/type), so it
 * passes a FAKE client whose prune pipeline `exec()` returns an SREM-ok/DEL-fail
 * tuple, and spies on the logger to assert the partial-apply is surfaced. The
 * real-Redis prune spec above it covers the integrated path; no auth/permission
 * middleware is involved here.
 */
import { describe, it, expect, vi } from 'vitest';
import { getRedis } from '../../src/redis.js';
import {
  batchKey,
  REDIS_KEY_BATCH_MEMBERS,
  getReputationScore,
  invalidateOnRevocation,
} from '../../src/reputation.js';
import { __test_seams as batchSeams } from '../../src/reputation-batch.js';
import { logger } from '../../src/logger.js';

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

describe('reputation batch per-cycle prune', () => {
  it('removes a de-accredited member and its score key while the still-accredited member survives', async () => {
    const redis = getRedis();
    if (!redis) return; // Redis-unavailable env: vacuous pass

    // Test-unique members key: the prune does a blanket "remove every member
    // NOT in the live set", so it must not run against the shared production
    // index (that would nuke a sibling file's members under the concurrent
    // runner). Lives under the appTag namespace so tests/setup.ts flushes it.
    const membersKey = `${REDIS_KEY_BATCH_MEMBERS}:prune-test`;
    const live = 'prune-test-accredited-user';
    const stale = 'prune-test-deaccredited-user';

    // Seed both as a completed cycle would: a non-zero prod score key plus a
    // FULL-batchKey entry in the members index (the Lua SADDs the post-RENAME
    // prod path, not the bare username).
    await redis.set(batchKey(live), JSON.stringify({ score: 10, breakdown: { papers: 10, reviews: 0, citations: 0, accreditation: 0 } }));
    await redis.set(batchKey(stale), JSON.stringify({ score: 99, breakdown: { papers: 99, reviews: 0, citations: 0, accreditation: 0 } }));
    await redis.sadd(membersKey, batchKey(live), batchKey(stale));

    // The live accredited set holds BARE usernames; only `live` is still in it.
    // The fix maps it UP through batchKey before the set-difference, so the
    // full-key members compare correctly and the stale full key is DEL'd
    // directly (no double-prefix). The pre-fix code classed BOTH members stale
    // (bare-vs-full mismatch) and DEL'd batchKey(fullKey) (a no-op).
    await batchSeams.pruneDeAccreditedMembers(redis, membersKey, new Set([live]), 1);

    const members = await redis.smembers(membersKey);
    expect(members).toContain(batchKey(live)); // still-accredited survives
    expect(members).not.toContain(batchKey(stale)); // de-accredited pruned

    expect(await redis.exists(batchKey(live))).toBe(1); // score key survives
    expect(await redis.exists(batchKey(stale))).toBe(0); // stale score key removed

    // Cleanup (tests/setup.ts also flushes the appTag namespace).
    await redis.del(batchKey(live), membersKey);
  });

  it('warns (does not silently orphan a score key) when the prune pipeline returns a per-command error', async () => {
    // A per-command DEL failure cannot be induced on real Redis, so drive a fake
    // client whose pipeline exec() returns an SREM-ok/DEL-fail tuple. The prune
    // must inspect the tuple and warn — otherwise the member leaves the index
    // (never re-pruned) while its prod score key survives.
    const exec = vi.fn().mockResolvedValue([
      [null, 1], // SREM ok
      [new Error('DEL failed'), null], // DEL per-command error
    ]);
    const prunePipe = { srem: vi.fn().mockReturnThis(), del: vi.fn().mockReturnThis(), exec };
    const fakeRedis = {
      smembers: vi.fn().mockResolvedValue([batchKey('orphan-fixture-user')]),
      pipeline: vi.fn().mockReturnValue(prunePipe),
    } as unknown as Parameters<typeof batchSeams.pruneDeAccreditedMembers>[0];

    const warnSpy = vi.spyOn(logger, 'warn');
    try {
      // Empty live set => the single member is stale => SREM + DEL pipelined.
      await batchSeams.pruneDeAccreditedMembers(fakeRedis, 'test:prune:partial-failure', new Set<string>(), 7);
      expect(exec).toHaveBeenCalledTimes(1);
      // The partial-failure warn carries `pruned` (the outer-catch warn does not),
      // so a warn with that field is the per-command-error branch firing.
      const warnedPartial = warnSpy.mock.calls.some(
        ([ctx]) => !!ctx && typeof ctx === 'object' && 'pruned' in (ctx as Record<string, unknown>),
      );
      expect(warnedPartial).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

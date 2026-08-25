/**
 * Consent-op single-use survives a Redis client that is mid-flap for the WHOLE
 * consume, not just for one command.
 *
 * The burn reads `isRedisAvailable()` (ioredis `status === 'ready'`) before it
 * touches Redis at all. During a reconnect that predicate is false while
 * `getRedis()` keeps returning the same cached client, so the Redis leg of the
 * burn does not run: the entry was written to BOTH tiers at issuance, the
 * in-memory delete arbitrates the win, the consume returns valid, and the
 * canonical Redis copy is left standing with the remainder of its TTL. Once the
 * client reconnects, the same proof reads back out of Redis and authorizes a
 * SECOND critical action. Because the per-user targets bind only
 * `(action, actor, '')` and never the operation payload, that second consume is
 * not even constrained to the same effect: two different `new_email` values, two
 * upload tokens, two admin grants, under one re-auth act.
 *
 * The defence is a compensating delete guarded on the client's EXISTENCE rather
 * than its readiness, so ioredis queues it offline and flushes it on reconnect.
 * This suite is the mutation-kill for that guard. The sibling tests in
 * `fresh-auth.test.ts` cannot cover it: they simulate a flap by rejecting a
 * single command, which leaves `isRedisAvailable()` true and takes a different
 * branch.
 *
 * Test-mock carve-out (per root CLAUDE.md "Carve-out for deterministic edge-case
 * coverage"):
 *   (a) `isRedisAvailable` is stubbed with a toggle so the not-ready window can
 *       be opened and closed deterministically around a single consume.
 *       Reproducing it for real means killing and restarting the Redis
 *       container mid-call and winning a race against ioredis's reconnect
 *       backoff, which is not something a test can do reliably. `getRedis` is
 *       NOT stubbed: the real client, the real keyspace, and the real TTLs are
 *       used throughout, so the assertion that the canonical entry is gone is a
 *       genuine round-trip and not a property of the mock.
 *   (b) No auth middleware is involved; these are library calls.
 *   (c) Real-path companion: the same risk class, a burn whose Redis leg fails
 *       leaving a replayable canonical copy, is covered against unmocked
 *       availability in `fresh-auth.test.ts` by the rejecting-burn test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { redisReady } = vi.hoisted(() => ({ redisReady: { value: true } }));

vi.mock('../../src/redis.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/redis.js')>();
  return { ...actual, isRedisAvailable: () => redisReady.value };
});

const {
  computeFreshAuthTargetHash,
  consumeFreshAuthToken,
  issueFreshAuthToken,
  _resetFreshAuthMemStoreForTests,
} = await import('../../src/lib/fresh-auth.js');
const { getRedis } = await import('../../src/redis.js');

const TARGET = {
  action: 'author_accept' as const,
  root_author: 'alice',
  root_permlink: 'paper-1',
};
const TARGET_HASH = computeFreshAuthTargetHash(TARGET);

// Resolved at registration time so Redis absence shows up as a skip in the
// runner rather than as an assertion-free pass. The real client is reached
// through the un-stubbed `getRedis`; only the readiness predicate is ours.
const redisPresent = await (async () => {
  const r = getRedis();
  if (!r) return false;
  for (let i = 0; i < 20 && r.status !== 'ready'; i++) {
    await new Promise((res) => setTimeout(res, 50));
  }
  return r.status === 'ready';
})();

beforeEach(() => {
  redisReady.value = true;
  _resetFreshAuthMemStoreForTests();
});

describe('consent-op burn during a Redis reconnect', () => {
  it.skipIf(!redisPresent)('leaves no replayable canonical entry behind', async () => {
    const issued = await issueFreshAuthToken('flap-window', 'password', TARGET);

    // The client is now mid-reconnect for the entire consume: the read falls
    // through to the in-memory backup and the burn's Redis leg is skipped.
    redisReady.value = false;
    const first = await consumeFreshAuthToken(issued.token, 'flap-window', TARGET_HASH);
    expect(first.valid).toBe(true);

    // Reconnected. The canonical copy must be gone; without the compensating
    // delete it would still be there with most of its TTL left, and this second
    // consume would return valid.
    redisReady.value = true;
    const replay = await consumeFreshAuthToken(issued.token, 'flap-window', TARGET_HASH);
    expect(replay.valid).toBe(false);
    if (!replay.valid) {
      expect(replay.reason).toBe('expired');
    }
  });

  it.skipIf(!redisPresent)('still authorizes the first consume, so a flap is not a lockout', async () => {
    // The other half of the contract: the reason the backup tier exists at all
    // is that a user who just re-authenticated must not be told their proof
    // expired because Redis blinked.
    const issued = await issueFreshAuthToken('flap-window-ok', 'orcid', TARGET);
    redisReady.value = false;
    const result = await consumeFreshAuthToken(issued.token, 'flap-window-ok', TARGET_HASH);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.mechanism).toBe('orcid');
    }
  });
});

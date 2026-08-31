/**
 * A consent-op burn whose Redis leg was skipped still removes the canonical key,
 * and removes it WHILE the client is not ready.
 *
 * The burn reads `isRedisAvailable()` (ioredis `status === 'ready'`) before it
 * touches Redis at all. During a reconnect that predicate is false while
 * `getRedis()` keeps returning the same cached client, so the Redis leg of the
 * burn does not run: the entry was written to BOTH tiers at issuance, the
 * in-memory delete arbitrates the win, the consume returns valid, and the
 * canonical Redis copy would be left standing with the remainder of its TTL.
 * A compensating `DEL` is what removes it, and that delete is guarded on the
 * client's EXISTENCE rather than its readiness, so it is issued in exactly the
 * window where a readiness gate would skip it and leave the key behind.
 *
 * That guard shape is this suite's subject, and the `exists === 0` assertion
 * BEFORE any replay is what pins it: deleting the compensating `DEL` leaves the
 * key standing, and re-gating it on `isRedisAvailable()` skips it in this exact
 * window, and both mutations fail here while surviving everywhere else. The
 * sibling tests in `fresh-auth.test.ts` cannot cover the guard shape: they
 * simulate a flap by rejecting a single command, which leaves
 * `isRedisAvailable()` true, so a readiness-gated delete would still run there.
 *
 * What this suite is NOT: the mutation-kill for single-use. Single-use no longer
 * rests on this delete landing — the spent-proof ledger refuses a replay whether
 * or not it ever runs — so the replay assertions below would stay green with the
 * delete removed, and it is `fresh-auth-consent-op-burn-offline-queue.test.ts`
 * that pins the ledger. What removing the delete WOULD do is widen the window in
 * which an orphaned canonical key outlives the process-local ledger entry
 * guarding it, which is the risk this suite exists to hold shut.
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
 *   (c) Real-path companion: the same risk class, a burn whose Redis leg did not
 *       run leaving an orphaned canonical key behind, is covered against
 *       unmocked availability in `fresh-auth.test.ts` by the rejecting-burn
 *       test, which asserts the same key absence after a genuinely rejecting
 *       `GETDEL` with the readiness predicate left real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../../src/config.js';

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
  it.skipIf(!redisPresent)('removes the canonical key while the client is still not ready', async () => {
    const redis = getRedis()!;
    const issued = await issueFreshAuthToken('flap-window', 'password', TARGET);
    const key = `${config.appTag}:fresh_auth:token:${issued.token}`;
    // Positive precondition, not ceremony: the key name is spelled by hand here
    // (the production prefix is module-private), so an `exists === 0` assertion
    // on a misspelled key would pass vacuously. `issueFreshAuthToken` awaits its
    // `SET`, so this is deterministic.
    expect(await redis.exists(key)).toBe(1);

    // The client is now mid-reconnect for the entire consume: the read falls
    // through to the in-memory backup and the burn's Redis leg is skipped.
    redisReady.value = false;
    const first = await consumeFreshAuthToken(issued.token, 'flap-window', TARGET_HASH);
    expect(first.valid).toBe(true);

    // The assertion this suite exists for, taken BEFORE any replay so it
    // attributes the key's removal to the compensating delete rather than to
    // the ledger or to a later presentation's own `GETDEL`. Still under the
    // not-ready window, which is what makes it a kill for the existence-not-
    // readiness guard shape specifically.
    expect(await redis.exists(key)).toBe(0);

    // Reconnected. The replay must be refused; with the key gone this is the
    // read path reporting `expired`, and the ledger refuses it independently.
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

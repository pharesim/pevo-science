/**
 * A consent-op burn whose Redis leg was skipped still removes the canonical key,
 * and removes it inside the window where the burn believed Redis was unavailable.
 *
 * Precision about "unavailable", because it is the whole subject: what this file
 * controls is the `isRedisAvailable()` PREDICATE, not the socket. The client
 * underneath is genuinely connected throughout (the suite refuses to run
 * otherwise), which is exactly what makes the assertion possible — a delete
 * issued in the window where the burn read "not available" still reaches a live
 * server, so its absence from the keyspace is observable immediately rather than
 * after a reconnect.
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
 * BEFORE any replay is what pins it. Two mutations fail against it: deleting the
 * compensating `DEL` leaves the key standing, and re-gating that delete on
 * `isRedisAvailable()` skips it in this exact window. The SECOND is the one only
 * this suite catches. `fresh-auth.test.ts`'s rejecting-burn companion carries the
 * same key-absence assertion and kills the first, but it reaches the branch by
 * rejecting a single command with the predicate left real, so `isRedisAvailable()`
 * is true there and a readiness-gated delete would still run.
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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  FRESH_AUTH_TTL_SECONDS,
  _resetFreshAuthMemStoreForTests,
  _setSpentConsentOpForTests,
  _getSpentConsentOpsSizeForTests,
  _drainSpentConsentOpsForTests,
  _stopCleanupForTests,
  _restartCleanupForTests,
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
  it.skipIf(!redisPresent)('removes the canonical key inside the window where the burn saw Redis as unavailable', async () => {
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
    // the ledger or to a later presentation's own `GETDEL`. Still inside the
    // window where the burn read "not available", which is what makes it a kill
    // for the existence-not-readiness guard shape specifically.
    expect(await redis.exists(key)).toBe(0);

    // Predicate restored. The replay must be refused, and here that is the read
    // path finding nothing: the delete landed, so the ledger entry was retired
    // on the spot and is not what refuses this one.
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

/** The drain's own retirement paths, driven against a REACHABLE client.
 *
 *  The burn only ever stamps a ledger entry a full TTL out, and only during a
 *  genuine outage, so neither the arm that issues the sweep nor the tick that
 *  calls it is reachable from a burn inside a test run: by the time an entry
 *  could expire on its own the client is long gone. Seeding the ledger directly
 *  is what closes that, and this file is where it belongs, because the client
 *  here is genuinely connected and the swept key is therefore observable. */
describe('spent-proof ledger retirement', () => {
  const seedKey = (token: string) => `${config.appTag}:fresh_auth:token:${token}`;

  afterEach(() => {
    vi.useRealTimers();
    // Stop-then-start, not a bare start: the fake-timer case leaves an interval
    // that was created under faked timers and would never fire again, and
    // `_restartCleanupForTests` is a no-op while one is already registered.
    _stopCleanupForTests();
    _restartCleanupForTests();
  });

  it.skipIf(!redisPresent)('sweeps the canonical key when it drops an entry past its deadline', async () => {
    const redis = getRedis()!;
    const token = 'ledger-expiry-sweep-token';
    const key = seedKey(token);
    // A key that is deliberately still alive when its ledger entry retires. In
    // production the entry's deadline dominates the key's, so this pairing only
    // arises through the residuals the burn documents (a re-executed issuing
    // `SET`, or the app clock stepping forward relative to Redis). Recreating it
    // directly is the only way to execute the sweep the drain issues for exactly
    // those cases.
    await redis.set(key, '{}', 'EX', FRESH_AUTH_TTL_SECONDS);
    _setSpentConsentOpForTests(token, Date.now() - 1);
    expect(_getSpentConsentOpsSizeForTests()).toBe(1);

    _drainSpentConsentOpsForTests(Date.now());
    expect(_getSpentConsentOpsSizeForTests()).toBe(0);

    // The delete is fire-and-forget, so the entry drops first and the key
    // follows. Without the sweep the key would sit out the rest of its TTL with
    // no ledger entry left to refuse it, which is the orphan the drain exists to
    // prevent.
    for (let i = 0; i < 40 && (await redis.exists(key)) === 1; i++) {
      await new Promise((res) => setTimeout(res, 25));
    }
    expect(await redis.exists(key)).toBe(0);
  });

  it.skipIf(!redisPresent)('a past-deadline ledger entry still refuses the consume itself', async () => {
    // The membership-only read: `isConsentOpSpent` answers from `.has` alone
    // and never prunes, and this is the consume-path case that makes that
    // load-bearing. The planted state is what a replay finds when the
    // compensating delete never landed and the entry's deadline lapsed before
    // any drain ran: canonical key present, in-memory record absent, ledger
    // entry expired. A prune-on-read variant drops the entry at the check, the
    // same call's own GETDEL then finds the key the deadline said had lapsed,
    // and the spent proof is reported a WIN — so this case is what dies if the
    // predicate ever regains a prune.
    _resetFreshAuthMemStoreForTests();
    const redis = getRedis()!;
    const token = 'ledger-stale-refusal-token';
    const key = seedKey(token);
    await redis.set(
      key,
      JSON.stringify({
        username: 'stale-refusal-user',
        mechanism: 'password',
        issued_at: Date.now() - 60_000,
        kind: 'consent_op',
        target_hash: TARGET_HASH,
      }),
      'EX',
      FRESH_AUTH_TTL_SECONDS,
    );
    _setSpentConsentOpForTests(token, Date.now() - 1);

    // No drain runs first; the consume itself is the subject.
    const replay = await consumeFreshAuthToken(token, 'stale-refusal-user', TARGET_HASH);
    expect(replay.valid).toBe(false);
    if (!replay.valid) {
      expect(replay.reason).toBe('expired');
    }

    // The refused replay retires what it touched: its GETDEL proved the
    // canonical copy gone, which clears both the key and the ledger entry, so
    // the refusal does not leak state it no longer needs.
    expect(_getSpentConsentOpsSizeForTests()).toBe(0);
    expect(await redis.exists(key)).toBe(0);
  });

  it.skipIf(!redisPresent)('retires an expired entry from the periodic cleanup tick', async () => {
    const token = 'ledger-tick-token';
    _setSpentConsentOpForTests(token, Date.now() + 1_000);
    expect(_getSpentConsentOpsSizeForTests()).toBe(1);

    // The tick is the SOLE retirement path for an entry written while the client
    // stayed `ready` (a `commandTimeout` against a stalled server emits no later
    // `ready` transition to sweep on), so its call into the drain has to be
    // pinned. Fake timers are safe here only because the interval is recreated
    // under them and the connection is healthy, so no ioredis reconnect or
    // command timer is pending to be frozen.
    _stopCleanupForTests();
    vi.useFakeTimers();
    _restartCleanupForTests();
    vi.setSystemTime(Date.now() + 400_000);
    vi.advanceTimersByTime(60_000);

    expect(_getSpentConsentOpsSizeForTests()).toBe(0);
  });
});

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

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
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

// The periodic tick also drains the ledger, on a client this file keeps
// genuinely connected. Paused for the whole file so it cannot land inside a
// drain assertion and finish a sweep the code under test skipped — which would
// mask exactly the mutants these cases exist to kill. The tick case below
// re-creates its own interval under fake timers when it needs one.
beforeAll(() => {
  _stopCleanupForTests();
});

afterAll(() => {
  _restartCleanupForTests();
});

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

/** The drain's retirement paths, driven against a REACHABLE client.
 *
 *  The production writer only leaves a ledger entry behind when its
 *  compensating delete could not be confirmed, and with the client here
 *  genuinely ready that delete lands inside the burn itself — so a burn inside
 *  this file can never leave the drain anything to do. Seeding the ledger
 *  directly is what closes that, and this file is where it belongs, because
 *  the client here is genuinely connected and a swept key is therefore
 *  observable. */
describe('spent-proof ledger retirement', () => {
  const seedKey = (token: string) => `${config.appTag}:fresh_auth:token:${token}`;

  const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return predicate();
  };

  afterEach(() => {
    vi.useRealTimers();
    // Stop without restarting: the file-wide pause above is what keeps a real
    // tick out of these assertions, and the fake-timer case leaves behind an
    // interval created under faked timers that would never fire again. The
    // file's `afterAll` puts a live cleaner back.
    _stopCleanupForTests();
  });

  it.skipIf(!redisPresent)('sweeps every entry it holds, retiring each only once its own delete lands', async () => {
    const redis = getRedis()!;
    // Keys that are deliberately still alive while their ledger entries stand:
    // the pairing an unconfirmed compensating delete leaves behind, recreated
    // directly because a burn against this reachable client confirms its
    // delete in-line and leaves nothing over. Two entries rather than one, so
    // a drain that stops after its first entry fails here instead of being
    // sampled around.
    const tokens = ['ledger-sweep-token-a', 'ledger-sweep-token-b'];
    for (const token of tokens) {
      await redis.set(seedKey(token), '{}', 'EX', FRESH_AUTH_TTL_SECONDS);
      _setSpentConsentOpForTests(token);
    }
    expect(_getSpentConsentOpsSizeForTests()).toBe(2);

    _drainSpentConsentOpsForTests();

    // Nothing has retired yet, and this samples it deterministically: the drain
    // only DISPATCHES here, and no `.then()` can run until this synchronous
    // block yields, so a real round-trip cannot beat the assertion. Retiring on
    // dispatch instead of on confirmation empties the ledger by now and fails
    // here. (The consequence of that mutation — a spent proof going unrefused
    // while its key still stands — is pinned in the offline-queue suite, which
    // can make the dispatched delete actually reject.)
    expect(_getSpentConsentOpsSizeForTests()).toBe(2);

    // Then the confirmations land and both entries retire. Without the sweep,
    // each key would sit out the rest of its TTL with no ledger entry left to
    // refuse it, which is the orphan the drain exists to prevent.
    expect(await waitFor(() => _getSpentConsentOpsSizeForTests() === 0, 5_000)).toBe(true);
    for (const token of tokens) {
      expect(await redis.exists(seedKey(token))).toBe(0);
    }
  });

  it.skipIf(!redisPresent)('a ledger entry refuses the consume itself, with the canonical key still readable', async () => {
    // The consume-path kill for the burn's spent-check. The planted state is
    // what a replay finds when the compensating delete never landed: canonical
    // key present, in-memory record absent, ledger entry held. The refusal
    // must come from membership BEFORE the same call's own GETDEL can find the
    // planted key — remove or weaken that gate and the GETDEL wins, reporting
    // the spent proof as a fresh burn. Membership is consulted bare, with no
    // retirement at the read: any retirement here would have to either race
    // the GETDEL two statements later or drop the entry and hand that GETDEL
    // the key, which is why retirement belongs to confirmations only.
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
    _setSpentConsentOpForTests(token);

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

  it.skipIf(!redisPresent)('retires an entry from the periodic cleanup tick', async () => {
    const token = 'ledger-tick-token';
    _setSpentConsentOpForTests(token);
    expect(_getSpentConsentOpsSizeForTests()).toBe(1);

    // For an entry written while the client stayed `ready` (a `commandTimeout`
    // against a stalled server emits no later `ready` transition to sweep on),
    // the tick is the only trigger that sweeps it WITHOUT a further
    // presentation of the proof — a replay's own resolved `GETDEL` would also
    // retire it, but nothing guarantees a replay arrives. So the tick's call
    // into the drain has to be pinned. Fake timers are safe here only because the interval is
    // recreated under them and the connection is healthy, so no ioredis
    // reconnect or command timer is pending to be frozen.
    _stopCleanupForTests();
    vi.useFakeTimers();
    _restartCleanupForTests();
    vi.advanceTimersByTime(60_000);

    // The tick dispatched the delete; the drop waits on its confirmation,
    // which arrives over a real socket — so hand the clock back before
    // polling for it.
    vi.useRealTimers();
    expect(await waitFor(() => _getSpentConsentOpsSizeForTests() === 0, 5_000)).toBe(true);
  });
});

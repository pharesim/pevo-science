/**
 * A consent-op burn survives a Redis outage that outlives ioredis's offline
 * queue, not just one that fits inside it.
 *
 * The burn's compensating `DEL` — the one issued when the Redis leg was skipped
 * because the client was mid-flap and the in-memory tier arbitrated the win —
 * is queued offline rather than sent. ioredis rejects that entire queue with
 * `MaxRetriesPerRequestError` once its reconnect count reaches
 * `maxRetriesPerRequest`, which on the production backoff curve
 * (`redisRetryStrategy`, 200ms linear) lands about two seconds into an outage.
 * An ordinary Redis restart comfortably outlasts that, so the delete is flushed
 * unsent, the canonical copy keeps the rest of its 5-minute TTL, and a proof
 * that has ALREADY authorized one critical action reads back out of Redis and
 * authorizes a second. The per-user targets bind `(action, actor, '')` and never
 * the operation payload, so the second use is not constrained to the same effect
 * as the first.
 *
 * The defence under test is the spent-proof ledger: the burn records the proof
 * as spent BEFORE attempting the delete, and clears the record only on a
 * confirmed delete, so single-use no longer rests on a command that may never
 * flush. Three properties are pinned here:
 *
 *   1. The replay is refused even though the compensating delete was flushed
 *      unsent, while the first consume during the outage still succeeds —
 *      because the whole reason the in-memory tier exists is that a user who
 *      just re-authenticated must not be told their proof expired because Redis
 *      blinked.
 *   2. The ledger entry's deadline is stamped from BURN time plus a full TTL,
 *      not from the proof's own expiry. The canonical key's `EX` starts when
 *      Redis executes the issuing `SET`, which is strictly later than the
 *      instant the issuer snapshotted as the proof's expiry, so a ledger keyed
 *      on that snapshot retires while the key it guards is still readable. The
 *      real gap is sub-millisecond dispatch latency; the case below widens it to
 *      an observable 1.5s by planting a short-lived in-memory record, and also
 *      reads the stamp directly so the assertion does not depend on wall clock.
 *   3. The drain retires the ledger entry, and sweeps the orphaned canonical
 *      key, on the client's next `ready` transition rather than waiting out a
 *      periodic tick — with no replay attempted, so the sweep is attributable to
 *      the reconnect arm alone.
 *
 * Why this is not the sibling suite: the sibling
 * (`fresh-auth-redis-unavailable-burn.test.ts`) toggles a stubbed
 * `isRedisAvailable()` while the underlying connection stays `'ready'`
 * throughout, so its queued delete always flushes on the very next tick and the
 * rejection path is never reached. Here the connection is genuinely severed.
 *
 * Test-mock carve-out (per root CLAUDE.md "Carve-out for deterministic edge-case
 * coverage"):
 *   (a) `getRedis` is redirected to a client this file owns, and
 *       `isRedisAvailable` is re-implemented as production implements it
 *       (`status === 'ready'`) against that client. Neither is a stub of the
 *       behaviour under test: the client is a real ioredis instance carrying the
 *       production `maxRetriesPerRequest` / `commandTimeout` / `retryStrategy`,
 *       all three imported from `src/redis.js` rather than restated, pointed at
 *       the real Redis through a local TCP proxy this file can genuinely sever.
 *       Readiness is therefore driven by a real socket, and the queue rejection
 *       is ioredis's own. The redirection exists only because the module
 *       singleton in `src/redis.js` is wired to the real host at import time and
 *       cannot be severed without taking the rest of the run's Redis down with
 *       it. Scope of the imports, stated narrowly: they keep the retry budget,
 *       command timeout and backoff curve tracking production, but the
 *       assertions are on outcomes (validity, key presence, refusal reason), not
 *       on which rejection class fires. `sendCommand` starts the command timeout
 *       before a command is queued, so raising the retry budget far enough would
 *       flip the scenario from an offline-queue rejection to a plain command
 *       timeout with every assertion still green.
 *
 *       Two further deliberate deviations. The replay leg runs against a second,
 *       direct-to-Redis client rather than a restored proxy: restarting the
 *       proxy fires the `ready` transition whose drain sweeps the orphan first,
 *       which would move the refusal from the ledger to the read path and void
 *       the mutation-kill. And the periodic cleanup is paused for the file, so
 *       the drain's timer arm cannot land mid-assertion on a slow worker.
 *   (b) No auth middleware is involved; these are library calls.
 *   (c) Real-path companion: the orphaned-canonical-key risk class is also
 *       covered against the unmocked module singleton by the rejecting-burn test
 *       in `fresh-auth.test.ts`, which asserts the key's absence after a
 *       genuinely rejecting `GETDEL` with the readiness predicate left real.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import net from 'node:net';
import Redis from 'ioredis';
import { config } from '../../src/config.js';

const { state } = vi.hoisted(() => ({
  state: { client: null as import('ioredis').Redis | null },
}));

vi.mock('../../src/redis.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/redis.js')>();
  return {
    ...actual,
    getRedis: () => state.client,
    // Production's predicate verbatim, applied to the proxied client.
    isRedisAvailable: () => state.client !== null && state.client.status === 'ready',
  };
});

const { redisRetryStrategy, REDIS_COMMAND_TIMEOUT_MS, REDIS_MAX_RETRIES_PER_REQUEST } =
  await import('../../src/redis.js');
const {
  computeFreshAuthTargetHash,
  consumeFreshAuthToken,
  issueFreshAuthToken,
  _resetFreshAuthMemStoreForTests,
  _setMemStoreEntryForTests,
  _stopCleanupForTests,
  _restartCleanupForTests,
  _drainSpentConsentOpsForTests,
  _getSpentConsentOpsSizeForTests,
  _getSpentConsentOpExpiryForTests,
} = await import('../../src/lib/fresh-auth.js');

const TARGET = {
  action: 'author_accept' as const,
  root_author: 'alice',
  root_permlink: 'paper-1',
};
const TARGET_HASH = computeFreshAuthTargetHash(TARGET);

const upstream = config.redisUrl ? new URL(config.redisUrl) : null;

/** A severable stand-in for the Redis endpoint. Stopping it destroys every live
 *  socket AND refuses new connections, which is what an ordinary server restart
 *  looks like to ioredis: repeated `ECONNREFUSED` reconnects, and the offline
 *  queue rejected once the retry budget is spent. */
class SeverableProxy {
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  readonly port: number;

  constructor(port: number, private readonly host: string, private readonly upstreamPort: number) {
    this.port = port;
  }

  static async create(host: string, upstreamPort: number): Promise<SeverableProxy> {
    const probe = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const proxy = new SeverableProxy(port, host, upstreamPort);
    await proxy.start();
    return proxy;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = net.createServer((downstream) => {
      const up = net.connect(this.upstreamPort, this.host);
      this.sockets.add(downstream);
      this.sockets.add(up);
      const drop = (s: net.Socket) => { this.sockets.delete(s); s.destroy(); };
      downstream.on('error', () => drop(downstream));
      up.on('error', () => drop(up));
      downstream.on('close', () => drop(up));
      up.on('close', () => drop(downstream));
      downstream.pipe(up);
      up.pipe(downstream);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => resolve());
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

let proxy: SeverableProxy | null = null;
/** The proxied client, held separately from `state.client` so a test can swap
 *  what `getRedis()` returns and the fixtures can still put it back. */
let proxied: import('ioredis').Redis | null = null;
/** A direct-to-Redis client that never goes through the proxy. Two jobs: it
 *  observes the canonical key DURING an outage, which is evidence no severed
 *  client could produce, and it stands in as `getRedis()`'s answer for a replay
 *  that must not be preceded by a `ready` transition. */
let observer: import('ioredis').Redis | null = null;

// Resolved before registration so an unreachable Redis shows up as a skip in the
// runner rather than as an assertion-free pass.
const redisPresent = await (async () => {
  if (!upstream) return false;
  try {
    const password = upstream.password ? decodeURIComponent(upstream.password) : undefined;
    proxy = await SeverableProxy.create(upstream.hostname, Number(upstream.port || 6379));
    const client = new Redis({
      host: '127.0.0.1',
      port: proxy.port,
      password,
      // The production options that make this test meaningful, imported rather
      // than restated so a change to the reconnect curve or the retry budget
      // re-tunes the scenario instead of leaving a stale copy behind.
      maxRetriesPerRequest: REDIS_MAX_RETRIES_PER_REQUEST,
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
      retryStrategy: redisRetryStrategy,
      lazyConnect: true,
    });
    client.on('error', () => { /* expected while severed */ });
    proxied = client;
    state.client = client;
    await client.connect().catch(() => { /* readiness is polled below */ });
    if (!(await waitFor(() => client.status === 'ready', 5_000))) return false;

    observer = new Redis({
      host: upstream.hostname,
      port: Number(upstream.port || 6379),
      password,
      lazyConnect: true,
    });
    observer.on('error', () => { /* observation only; failures surface as assertion failures */ });
    await observer.connect().catch(() => { /* readiness is polled below */ });
    return await waitFor(() => observer!.status === 'ready', 5_000);
  } catch {
    return false;
  }
})();

beforeAll(() => {
  // The periodic cleanup tick also drains the ledger. Pausing it for the file
  // leaves the `ready` transition as the only automatic drain, which is what
  // makes the drain assertions below attributable, and keeps a slow worker from
  // landing a tick in the middle of one.
  _stopCleanupForTests();
  _resetFreshAuthMemStoreForTests();
});

beforeEach(() => {
  _resetFreshAuthMemStoreForTests();
});

afterEach(async () => {
  // Restore the fixture whatever the test did to it. Without this, a failure
  // between `proxy.stop()` and the next `proxy.start()` leaves the proxy down
  // for the following test and for the runner's own retries of this one, where
  // issuance would write only the in-memory tier and every key assertion would
  // reject.
  state.client = proxied;
  if (proxy) await proxy.start();
  if (proxied) await waitFor(() => proxied!.status === 'ready', 20_000);
});

afterAll(async () => {
  _restartCleanupForTests();
  state.client = null;
  if (proxied) proxied.disconnect();
  if (observer) observer.disconnect();
  if (proxy) await proxy.stop();
});

describe('consent-op burn across a Redis outage that outlives the offline queue', () => {
  it.skipIf(!redisPresent)('refuses the replay even though the compensating delete never landed, and holds the proof spent past its own expiry', async () => {
    const client = proxied!;
    const issued = await issueFreshAuthToken('offline-queue-burn', 'password', TARGET);
    const key = `${config.appTag}:fresh_auth:token:${issued.token}`;
    expect(await client.exists(key)).toBe(1);

    await proxy!.stop();
    expect(await waitFor(() => client.status !== 'ready', 5_000)).toBe(true);

    // Widen a race that is otherwise unobservable. The issuer snapshots the
    // proof's expiry BEFORE dispatching its `SET ... EX`, so a ledger keyed on
    // that snapshot retires ahead of the canonical key by the dispatch-to-
    // execute latency: real, but sub-millisecond. Replanting the in-memory
    // record with a 1.5s life reproduces the same ordering at a scale the burn's
    // own duration exceeds — the compensating delete is awaited and does not
    // settle until the retry budget is spent, seconds later. Same username,
    // mechanism and target as the issued proof, so the consume below is a
    // genuine first use and not a shape the validator would reject.
    _setMemStoreEntryForTests(
      issued.token,
      {
        username: 'offline-queue-burn',
        mechanism: 'password',
        issued_at: Date.now(),
        kind: 'consent_op',
        target_hash: TARGET_HASH,
      },
      Date.now() + 1_500,
    );

    // Resolves only once the compensating delete has settled — it is awaited
    // inside the burn — so by the time this returns the queue rejection has
    // already happened. Valid, because a flap must not lock out a user who just
    // re-authenticated.
    const first = await consumeFreshAuthToken(issued.token, 'offline-queue-burn', TARGET_HASH);
    expect(first.valid).toBe(true);

    // Observed through the un-severed path, so this is direct evidence that the
    // canonical copy is standing at the moment the burn reported a win. Had the
    // queued delete flushed on reconnect the way the offline queue is often
    // assumed to, it would be gone.
    expect(await observer!.exists(key)).toBe(1);

    // The ledger's deadline is read raw, before any prune. Stamped from burn
    // time it is a full 5-minute TTL out; stamped from the proof's own expiry it
    // would already have lapsed, since the plant above put that 1.5s away and the
    // burn took longer than that to settle.
    const ledgerDeadline = _getSpentConsentOpExpiryForTests(issued.token);
    expect(ledgerDeadline).toBeDefined();
    expect(ledgerDeadline!).toBeGreaterThan(Date.now() + 200_000);

    // Recover by pointing `getRedis()` at the direct client rather than by
    // restarting the proxy. A restart would emit `ready` on the proxied client,
    // whose armed drain sweeps the orphan synchronously — the replay would then
    // be refused by the read path finding nothing, and this would stop being a
    // kill for the ledger. The observer was never armed and is already ready, so
    // it emits no transition.
    state.client = observer;

    const replay = await consumeFreshAuthToken(issued.token, 'offline-queue-burn', TARGET_HASH);
    expect(replay.valid).toBe(false);
    if (!replay.valid) {
      expect(replay.reason).toBe('expired');
    }

    // The refused presentation also cleans up after itself: its `GETDEL` is a
    // confirmed removal, so the orphan does not sit out the rest of its TTL.
    expect(await observer!.exists(key)).toBe(0);
  }, 60_000);

  it.skipIf(!redisPresent)('retires the ledger entry and sweeps the orphan on the next ready transition, with no replay attempted', async () => {
    const client = proxied!;
    const issued = await issueFreshAuthToken('ready-drain', 'password', TARGET);
    const key = `${config.appTag}:fresh_auth:token:${issued.token}`;
    expect(await client.exists(key)).toBe(1);

    await proxy!.stop();
    expect(await waitFor(() => client.status !== 'ready', 5_000)).toBe(true);

    const first = await consumeFreshAuthToken(issued.token, 'ready-drain', TARGET_HASH);
    expect(first.valid).toBe(true);
    // The state the reconnect has to clean up: one held proof, one orphaned key.
    expect(_getSpentConsentOpsSizeForTests()).toBe(1);
    expect(await observer!.exists(key)).toBe(1);

    await proxy!.start();
    expect(await waitFor(() => client.status === 'ready', 20_000)).toBe(true);

    // The ledger size is the load-bearing assertion, not the key's absence: the
    // periodic tick is paused for this file, so the only remaining code that can
    // retire an entry is the drain's own confirmed-delete callback. Key absence
    // alone would also be satisfied by a sibling worker's per-file keyspace
    // flush, which is independent of whether the reconnect arm is wired up at
    // all. No replay is attempted, so nothing else could have swept either.
    expect(await waitFor(() => _getSpentConsentOpsSizeForTests() === 0, 10_000)).toBe(true);
    expect(await observer!.exists(key)).toBe(0);
  }, 60_000);

  it.skipIf(!redisPresent)('drops a ledger entry past its deadline even with no reachable client', async () => {
    const client = proxied!;
    const issued = await issueFreshAuthToken('drain-expiry', 'password', TARGET);

    await proxy!.stop();
    expect(await waitFor(() => client.status !== 'ready', 5_000)).toBe(true);

    const first = await consumeFreshAuthToken(issued.token, 'drain-expiry', TARGET_HASH);
    expect(first.valid).toBe(true);
    expect(_getSpentConsentOpsSizeForTests()).toBe(1);

    // First, the arm that carries the single-use guarantee: a drain pass that
    // finds no reachable client must leave a LIVE entry alone. This is the arm
    // the 60s tick takes for the whole of an outage, and dropping an entry here
    // would retire the refusal while the orphaned key is still readable, which
    // is precisely the replay the ledger exists to close.
    _drainSpentConsentOpsForTests(Date.now());
    expect(_getSpentConsentOpsSizeForTests()).toBe(1);

    // Then the expiry arm, still severed, so the drain holds no reachable
    // client. The entry must be dropped regardless: chaining the drop onto a
    // delete that cannot be issued would leak an entry per burn for the whole of
    // an outage. Driven with a future clock rather than by waiting out a real
    // TTL. Nothing is asserted about the canonical key here, because with no
    // client there is no delete to observe; the sweep this arm issues when a
    // client IS reachable is pinned in `fresh-auth-redis-unavailable-burn.test.ts`.
    _drainSpentConsentOpsForTests(Date.now() + 400_000);
    expect(_getSpentConsentOpsSizeForTests()).toBe(0);
  }, 60_000);
});

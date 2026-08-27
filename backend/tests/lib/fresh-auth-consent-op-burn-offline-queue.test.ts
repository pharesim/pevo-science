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
 * flush. The suite pins BOTH halves of that contract — the replay is refused,
 * and the first consume during the outage still succeeds, because the whole
 * reason the in-memory tier exists is that a user who just re-authenticated must
 * not be told their proof expired because Redis blinked.
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
 *       production `maxRetriesPerRequest` / `commandTimeout` / `retryStrategy`
 *       (imported, not copied), pointed at the real Redis through a local TCP
 *       proxy this file can genuinely sever. Readiness is therefore driven by a
 *       real socket, and the queue rejection is ioredis's own. The redirection
 *       exists only because the module singleton in `src/redis.js` is wired to
 *       the real host at import time and cannot be severed without taking the
 *       rest of the run's Redis down with it.
 *   (b) No auth middleware is involved; these are library calls.
 *   (c) Real-path companion: the burn-leaves-a-replayable-copy risk class is
 *       also covered against the unmocked module singleton by the rejecting-burn
 *       test in `fresh-auth.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

const { redisRetryStrategy } = await import('../../src/redis.js');
const {
  computeFreshAuthTargetHash,
  consumeFreshAuthToken,
  issueFreshAuthToken,
  _resetFreshAuthMemStoreForTests,
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

// Resolved before registration so an unreachable Redis shows up as a skip in the
// runner rather than as an assertion-free pass.
const redisPresent = await (async () => {
  if (!upstream) return false;
  try {
    proxy = await SeverableProxy.create(upstream.hostname, Number(upstream.port || 6379));
    const client = new Redis({
      host: '127.0.0.1',
      port: proxy.port,
      password: upstream.password ? decodeURIComponent(upstream.password) : undefined,
      // The production options that make this test meaningful. Imported rather
      // than restated so a change to the reconnect curve or the retry budget
      // re-tunes the scenario instead of silently invalidating it.
      maxRetriesPerRequest: 3,
      commandTimeout: 5_000,
      retryStrategy: redisRetryStrategy,
      lazyConnect: true,
    });
    client.on('error', () => { /* expected while severed */ });
    state.client = client;
    await client.connect().catch(() => { /* readiness is polled below */ });
    return await waitFor(() => client.status === 'ready', 5_000);
  } catch {
    return false;
  }
})();

beforeAll(() => {
  _resetFreshAuthMemStoreForTests();
});

beforeEach(() => {
  _resetFreshAuthMemStoreForTests();
});

afterAll(async () => {
  const client = state.client;
  state.client = null;
  if (client) client.disconnect();
  if (proxy) await proxy.stop();
});

describe('consent-op burn across a Redis outage that outlives the offline queue', () => {
  it.skipIf(!redisPresent)('refuses the replay even though the compensating delete never landed', async () => {
    const client = state.client!;
    const issued = await issueFreshAuthToken('offline-queue-burn', 'password', TARGET);
    const key = `${config.appTag}:fresh_auth:token:${issued.token}`;
    expect(await client.exists(key)).toBe(1);

    await proxy!.stop();
    expect(await waitFor(() => client.status !== 'ready', 5_000)).toBe(true);

    // Resolves only once the compensating delete has settled — it is awaited
    // inside the burn — so by the time this returns the queue rejection has
    // already happened. Valid, because a flap must not lock out a user who just
    // re-authenticated.
    const first = await consumeFreshAuthToken(issued.token, 'offline-queue-burn', TARGET_HASH);
    expect(first.valid).toBe(true);

    await proxy!.start();
    expect(await waitFor(() => client.status === 'ready', 20_000)).toBe(true);

    // The evidence that the real rejection path ran: had the queued delete
    // flushed on reconnect the way the offline queue is often assumed to, the
    // canonical copy would be gone here. It is not — which is exactly why the
    // replay below must be refused by something other than that delete.
    expect(await client.exists(key)).toBe(1);

    const replay = await consumeFreshAuthToken(issued.token, 'offline-queue-burn', TARGET_HASH);
    expect(replay.valid).toBe(false);
    if (!replay.valid) {
      expect(replay.reason).toBe('expired');
    }

    // The refused presentation also cleans up after itself: its `GETDEL` is a
    // confirmed removal, so the orphan does not sit out the rest of its TTL.
    expect(await client.exists(key)).toBe(0);
  }, 60_000);
});

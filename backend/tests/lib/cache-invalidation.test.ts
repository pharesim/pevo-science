/**
 * Unit specs for `QueryCache`'s Redis invalidation command shape and the
 * multi-round-SCAN invalidation-during-flight window.
 *
 * **Carve-out (per root CLAUDE.md "Running Tests" + the clause-(a)/(c)
 * test-mock carve-out):** these specs mock `getRedis()` (an explicitly
 * permitted shared cache helper) to inject a stateful in-memory fake Redis
 * client. Justification per clause (a): the assertions here are about the
 * *client command shape* (`SCAN` must be issued, `KEYS` must NOT) and about
 * *controllable SCAN-loop timing* (registering an in-flight fetcher partway
 * through the cursor loop). Neither is observable from a real Redis client:
 * a real server does not report back which command family enumerated the
 * keyspace, and real SCAN rounds resolve too fast to interleave a fetcher
 * registration deterministically. Clause (b): no auth middleware is in
 * scope — these are unit-level cache specs. Clause (c): the *behavioral*
 * risk classes these pin (volatile flush retains stable entries; an
 * in-flight fetcher's write is suppressed when its tier was invalidated)
 * are covered against real Redis by the single-flight specs in
 * `backend/tests/lib/cache.test.ts` (notably the `clearVolatile()`/STABLE
 * and `invalidate()`/in-flight specs). This file adds command-shape and
 * mid-loop-timing pins the real-path companion cannot express.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryCache } from '../../src/cache.js';
import { getRedis } from '../../src/redis.js';

vi.mock('../../src/redis.js', () => ({ getRedis: vi.fn() }));

/**
 * Stateful fake Redis: a Map-backed stand-in exposing the subset of
 * commands `QueryCache` uses. `keys` is present so a regression that
 * reintroduces the blocking `KEYS` command is observable via the spy; it
 * returns an empty list (benign) rather than throwing, so the assertion
 * that pins the failure is `keys` was-not-called, not an exception.
 */
function makeFakeRedis() {
  const store = new Map<string, string>();
  const scan = vi.fn(
    async (
      _cursor: string,
      _matchKw: string,
      pattern: string,
      _countKw: string,
      _count: number,
    ): Promise<[string, string[]]> => {
      const literal = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      const matched = [...store.keys()].filter((k) => k.startsWith(literal));
      return ['0', matched];
    },
  );
  const del = vi.fn(async (...keys: string[]): Promise<number> => {
    let removed = 0;
    for (const k of keys) if (store.delete(k)) removed++;
    return removed;
  });
  const get = vi.fn(async (k: string): Promise<string | null> => (store.has(k) ? store.get(k)! : null));
  const set = vi.fn(async (k: string, v: string): Promise<'OK'> => {
    store.set(k, v);
    return 'OK';
  });
  const keys = vi.fn(async (): Promise<string[]> => []);
  return { store, scan, del, get, set, keys, status: 'ready' as const };
}

type FakeRedis = ReturnType<typeof makeFakeRedis>;

function useFakeRedis(): FakeRedis {
  const fake = makeFakeRedis();
  vi.mocked(getRedis).mockReturnValue(fake as unknown as ReturnType<typeof getRedis>);
  return fake;
}

function uniquePrefix(): string {
  return `test:cache-inv:${Date.now()}:${Math.random().toString(36).slice(2)}:`;
}

describe('QueryCache — Redis invalidation command shape (SCAN, not KEYS)', () => {
  beforeEach(() => {
    vi.mocked(getRedis).mockReset();
  });

  it('clear() enumerates the keyspace with SCAN, never the blocking KEYS', async () => {
    const r = useFakeRedis();
    const cache = new QueryCache(30_000, uniquePrefix());
    await cache.set('k1', { a: 1 });
    await cache.set('k2', { a: 2 });

    await cache.clear();

    expect(r.scan).toHaveBeenCalled();
    expect(r.keys).not.toHaveBeenCalled();
    // Every entry was swept.
    expect(await cache.get('k1')).toBeUndefined();
    expect(await cache.get('k2')).toBeUndefined();
  });

  it('clearVolatile() enumerates with SCAN (not KEYS) and deletes only non-stable keys', async () => {
    const r = useFakeRedis();
    const cache = new QueryCache(30_000, uniquePrefix());
    await cache.set('stable-k', { s: 1 }, undefined, true);
    await cache.set('vol-k', { v: 1 }, undefined, false);

    await cache.clearVolatile();

    expect(r.scan).toHaveBeenCalled();
    expect(r.keys).not.toHaveBeenCalled();
    // The stable-key retention filter survives the KEYS -> SCAN migration:
    // the stable entry remains, the volatile entry is gone.
    expect(await cache.get('stable-k')).toEqual({ s: 1 });
    expect(await cache.get('vol-k')).toBeUndefined();
  });
});

describe('QueryCache.invalidatePrefix — multi-round SCAN invalidation-during-flight window', () => {
  beforeEach(() => {
    vi.mocked(getRedis).mockReset();
  });

  it('suppresses the write of a fetcher registered DURING the SCAN loop (after-bump closes the window)', async () => {
    // A fetcher that registers while invalidatePrefix()'s SCAN loop is
    // mid-flight captures the post-before-bump epoch and would, with only
    // a before-bump, pass its gate on resolution and re-cache a value the
    // sweep was meant to invalidate. The after-bump advances the epoch
    // past that captured value so the mid-loop fetcher's write is
    // suppressed.
    //
    // Mutation-kill: removing the after-bump from invalidatePrefix() leaves
    // the captured epoch matching the current epoch, so the gate passes and
    // the fetcher's value is re-cached — flipping the final assertions RED.
    const r = useFakeRedis();
    const cache = new QueryCache(30_000, uniquePrefix());

    let resolveFetcher!: (v: { value: string }) => void;
    const fetcherGate = new Promise<{ value: string }>((res) => {
      resolveFetcher = res;
    });
    let inflight: Promise<{ value: string }> | undefined;

    // On the SCAN round, register an in-flight fetcher for a key under the
    // invalidated prefix. The `await setTimeout(0)` drains the microtask
    // queue so the fetcher's epoch capture (which sits behind getOrSet's
    // internal `await this.get`) settles BEFORE the after-bump fires.
    r.scan.mockImplementationOnce(async () => {
      inflight = cache.getOrSet('paper-detail:1', () => fetcherGate);
      await new Promise((res) => setTimeout(res, 0));
      return ['0', []];
    });

    await cache.invalidatePrefix('paper-detail:');

    // invalidatePrefix() has returned; its after-bump advanced the epoch.
    // Now let the mid-loop fetcher resolve.
    resolveFetcher({ value: 'written-during-invalidation' });
    expect(await inflight).toEqual({ value: 'written-during-invalidation' });

    // The mid-loop fetcher's write was suppressed: nothing under the
    // prefix is cached, and the suppressed value never reached redis.set.
    expect(await cache.get('paper-detail:1')).toBeUndefined();
    expect(r.set).not.toHaveBeenCalledWith(
      expect.stringContaining('paper-detail:1'),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

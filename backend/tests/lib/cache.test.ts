/**
 * Unit specs for `QueryCache.getOrSet` single-flight coalescing.
 *
 * **Carve-out (per root CLAUDE.md "Running Tests"):** these specs exercise
 * the in-process coalescing primitive directly. No Redis or HAF is involved;
 * the unique per-test prefix (`test:cache:<timestamp>:<random>:`) ensures
 * isolation from any concurrently running test that touches Redis under the
 * shared `${config.appTag}:` namespace. Justification per clause (a):
 * exercising "N concurrent callers hit the same key during the same event-
 * loop tick" against a real HAF backend is impractical (it requires precise
 * timing control over downstream pool slots that no real backend offers).
 * Clause (b): no auth middleware in scope — these are unit-level cache
 * specs. Clause (c): the integration canary in
 * `backend/tests/routes/papers-enrichment-parity-gate.test.ts`
 * (`'single-flight: 3 concurrent /enrichment calls collapse to 1 HAF
 * fetcher'`) exercises the same primitive end-to-end through the
 * `/api/papers/:author/:permlink/enrichment` route with a mocked HAF
 * responder, satisfying the real-path companion requirement at the route
 * layer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryCache } from '../../src/cache.js';

describe('QueryCache.getOrSet — single-flight coalescing', () => {
  let cache: QueryCache;

  beforeEach(() => {
    // Unique per-test prefix so Redis (if available in the test env) does
    // not let parallel test files collide on the same key namespace.
    cache = new QueryCache(
      30_000,
      `test:cache-sf:${Date.now()}:${Math.random().toString(36).slice(2)}:`,
    );
  });

  it('coalesces N concurrent misses for the same key into 1 fetcher invocation', async () => {
    // Slow fetcher: resolves after a 50ms tick so concurrent awaiters
    // queue up on the same in-flight promise.
    const fetcher = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { value: 'shared' };
    });

    const results = await Promise.all([
      cache.getOrSet('coalesce-key', fetcher),
      cache.getOrSet('coalesce-key', fetcher),
      cache.getOrSet('coalesce-key', fetcher),
      cache.getOrSet('coalesce-key', fetcher),
      cache.getOrSet('coalesce-key', fetcher),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r).toEqual({ value: 'shared' });
    }
    // Cache populated after the single fetch.
    expect(await cache.get('coalesce-key')).toEqual({ value: 'shared' });
  });

  it('does NOT cache null results AND allows next wave to retry (in-flight slot cleared on null)', async () => {
    // First wave: fetcher returns null → must not poison the cache AND
    // must not leave a stale promise in the in-flight map.
    const firstWaveFetcher = vi.fn().mockResolvedValue(null);

    const wave1 = await Promise.all([
      cache.getOrSet('null-key', firstWaveFetcher),
      cache.getOrSet('null-key', firstWaveFetcher),
      cache.getOrSet('null-key', firstWaveFetcher),
    ]);

    // All three concurrent awaiters saw null AND the fetcher fired once.
    expect(firstWaveFetcher).toHaveBeenCalledTimes(1);
    for (const r of wave1) expect(r).toBeNull();
    // The null result is NOT cached (existing skip-on-null rule).
    expect(await cache.get('null-key')).toBeUndefined();

    // Second wave: a fresh fetcher must be invoked — the first wave's
    // null-resolution must have cleared the in-flight slot.
    const secondWaveFetcher = vi.fn().mockResolvedValue({ value: 'recovered' });
    const wave2 = await cache.getOrSet('null-key', secondWaveFetcher);
    expect(secondWaveFetcher).toHaveBeenCalledTimes(1);
    expect(wave2).toEqual({ value: 'recovered' });
    expect(await cache.get('null-key')).toEqual({ value: 'recovered' });
  });

  it('concurrent requests for DIFFERENT keys do not share an in-flight slot', async () => {
    const fetcherA = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { key: 'A' };
    });
    const fetcherB = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { key: 'B' };
    });

    const [a, b] = await Promise.all([
      cache.getOrSet('key-A', fetcherA),
      cache.getOrSet('key-B', fetcherB),
    ]);

    expect(fetcherA).toHaveBeenCalledTimes(1);
    expect(fetcherB).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ key: 'A' });
    expect(b).toEqual({ key: 'B' });
  });

  it('in-flight map entry is cleared on fetcher throw (next call retries fresh)', async () => {
    // First wave: fetcher throws. All concurrent awaiters see the
    // rejection AND the slot is cleared so a subsequent call retries
    // rather than re-receiving the same poisoned rejected promise.
    const throwingFetcher = vi.fn().mockRejectedValue(new Error('transient HAF outage'));

    const settled = await Promise.allSettled([
      cache.getOrSet('throw-key', throwingFetcher),
      cache.getOrSet('throw-key', throwingFetcher),
      cache.getOrSet('throw-key', throwingFetcher),
    ]);

    expect(throwingFetcher).toHaveBeenCalledTimes(1);
    for (const r of settled) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') {
        expect((r.reason as Error).message).toBe('transient HAF outage');
      }
    }

    // Next call after the rejection: a fresh fetcher must run. If the
    // in-flight slot had retained the rejected promise, this call would
    // either (a) re-throw the cached rejection without invoking the new
    // fetcher, or (b) await a settled rejected promise forever. Neither
    // is acceptable — the slot must be cleared.
    const recoveryFetcher = vi.fn().mockResolvedValue({ value: 'recovered' });
    const result = await cache.getOrSet('throw-key', recoveryFetcher);
    expect(recoveryFetcher).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ value: 'recovered' });
  });
});

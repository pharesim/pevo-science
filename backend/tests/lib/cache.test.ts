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
 * (`'GET /api/papers/:author/:permlink/enrichment — single-flight
 * coalescing canary'`) exercises the same primitive end-to-end through
 * the `/api/papers/:author/:permlink/enrichment` route with a mocked HAF
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

  it('invalidate() during an in-flight fetcher prevents the pre-invalidation snapshot from being cached', async () => {
    // Reproduces the invalidation-during-flight race:
    //   1. A slow fetcher F is started for key K (concurrent readers
    //      coalesce on the in-flight promise).
    //   2. While F is in flight, an `invalidate(K)` runs (e.g. a paper
    //      edit calls `hafCache.invalidate(...)`).
    //   3. F resolves with its pre-invalidation snapshot.
    //   4. Without the epoch guard, F's success path would `set(K, ...)`
    //      and silently undo the flush. With the epoch guard, F's
    //      cache-write is skipped; the cache stays cold; the next
    //      caller picks up fresh post-invalidation data.
    //
    // Mutation-kill: removing the `capturedEpoch === this.epoch` check
    // in `getOrSet` causes this assertion to flip RED (the stale
    // snapshot ends up in the cache).
    const fetcher = vi.fn().mockImplementation(async () => {
      // Slow enough that the invalidate() below runs before this
      // resolves, but short enough that the test stays fast.
      await new Promise((r) => setTimeout(r, 50));
      return { value: 'pre-invalidation-snapshot' };
    });

    // Kick off the in-flight fetcher (do NOT await yet).
    const inflightCall = cache.getOrSet('race-key', fetcher);

    // While the fetcher is in flight, invalidate the key. Use a short
    // delay to ensure the fetcher has started (its inflight entry is
    // registered before the awaited 50ms timeout fires).
    await new Promise((r) => setTimeout(r, 10));
    await cache.invalidate('race-key');

    // Now wait for the fetcher to resolve. The in-flight caller still
    // receives the value (per the epoch-guard semantics: callers get
    // data, cache stays cold).
    const inflightResult = await inflightCall;
    expect(inflightResult).toEqual({ value: 'pre-invalidation-snapshot' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Post-condition: cache is cold. The pre-invalidation snapshot
    // must NOT have been written back. A subsequent reader would
    // therefore miss and fire a fresh fetcher.
    expect(await cache.get('race-key')).toBeUndefined();
  });

  it('clearVolatile() during an in-flight STABLE fetcher does NOT prevent the post-resolution cache write', async () => {
    // The 3s block-watcher calls `clearVolatile()`, which deletes only
    // non-stable entries and bumps ONLY `volatileEpoch`. A stable-key
    // fetcher in flight when that tick fires must STILL write on
    // resolution — its entry was never deleted by the volatile flush.
    //
    // Mutation-kill: collapsing the per-tier counters back to a single
    // shared epoch (so `clearVolatile()` advances the counter the stable
    // gate reads) flips this assertion RED — the stable write is
    // suppressed and `cache.get('stable-key')` returns undefined.
    const fetcher = vi.fn().mockImplementation(async () => {
      // Slow enough that the clearVolatile() below runs before this
      // resolves, but short enough that the test stays fast.
      await new Promise((r) => setTimeout(r, 50));
      return { value: 'stable-value' };
    });

    // Kick off the in-flight STABLE fetcher (do NOT await yet).
    const inflightCall = cache.getOrSet('stable-key', fetcher, undefined, true);

    // While the fetcher is in flight, a block tick clears volatile
    // entries. Short delay so the in-flight slot is registered before
    // the awaited 50ms timeout fires.
    await new Promise((r) => setTimeout(r, 10));
    await cache.clearVolatile();

    // The in-flight caller receives the value.
    const inflightResult = await inflightCall;
    expect(inflightResult).toEqual({ value: 'stable-value' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Post-condition: the stable entry WAS written. `clearVolatile()`
    // never deletes stable entries, so the write must survive.
    expect(await cache.get('stable-key')).toEqual({ value: 'stable-value' });
  });

  it('invalidate() during an in-flight STABLE fetcher suppresses the post-resolution cache write', async () => {
    // Converse of the clearVolatile()/STABLE case: `invalidate(key)`
    // targets a specific key regardless of tier and DELETES it, so it
    // bumps BOTH epochs. A stable-key fetcher in flight when invalidate()
    // fires must NOT write its pre-invalidation snapshot back — the
    // stable gate keys on `stableEpoch`, which invalidate() advanced.
    //
    // Mutation-kill: dropping `this.stableEpoch++` from `invalidate()`
    // leaves the captured stableEpoch matching, so the stable gate passes
    // and the snapshot is re-cached — flipping the final assertion RED.
    const fetcher = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { value: 'stale-stable-snapshot' };
    });

    const inflightCall = cache.getOrSet('stable-invalidate-key', fetcher, undefined, true);

    // Short delay so the in-flight slot is registered before the awaited
    // 50ms timeout fires, then invalidate the stable key mid-flight.
    await new Promise((r) => setTimeout(r, 10));
    await cache.invalidate('stable-invalidate-key');

    // The in-flight caller still receives the value (callers get data;
    // the cache stays cold).
    const inflightResult = await inflightCall;
    expect(inflightResult).toEqual({ value: 'stale-stable-snapshot' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Post-condition: cache is cold. invalidate() bumped stableEpoch, so
    // the stable fetcher's write was suppressed.
    expect(await cache.get('stable-invalidate-key')).toBeUndefined();
  });

  it('clearVolatile() during an in-flight NON-stable fetcher suppresses the post-resolution cache write', async () => {
    // Converse of the clearVolatile()/STABLE case: a NON-stable entry IS
    // deleted by `clearVolatile()`, so its in-flight fetcher must NOT
    // write its pre-flush snapshot back. The non-stable gate keys on BOTH
    // epochs; clearVolatile() advanced `volatileEpoch`, so the write is
    // suppressed.
    //
    // Mutation-kill: dropping the `volatileEpoch` conjunct from the
    // non-stable branch (so it reads only `stableEpoch`, which
    // clearVolatile() leaves untouched) lets the gate pass and the stale
    // snapshot is re-cached — flipping the final assertion RED.
    const fetcher = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { value: 'stale-volatile-snapshot' };
    });

    // Non-stable fetcher (stable defaults to false).
    const inflightCall = cache.getOrSet('volatile-key', fetcher);

    // Short delay so the in-flight slot is registered before the awaited
    // 50ms timeout fires, then a block tick clears volatile entries.
    await new Promise((r) => setTimeout(r, 10));
    await cache.clearVolatile();

    // The in-flight caller still receives the value.
    const inflightResult = await inflightCall;
    expect(inflightResult).toEqual({ value: 'stale-volatile-snapshot' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Post-condition: cache is cold. clearVolatile() bumped volatileEpoch,
    // so the non-stable fetcher's write was suppressed.
    expect(await cache.get('volatile-key')).toBeUndefined();
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

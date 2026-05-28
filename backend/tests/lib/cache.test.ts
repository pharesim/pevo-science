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

describe('QueryCache.getOrSetSWR — single-flight coalescing on cold-path', () => {
  let cache: QueryCache;

  beforeEach(() => {
    cache = new QueryCache(
      30_000,
      `test:cache-swr-sf:${Date.now()}:${Math.random().toString(36).slice(2)}:`,
    );
  });

  it('coalesces N concurrent cold-path misses for the same key into 1 fetcher invocation', async () => {
    // Cold start: both the fresh key and the swr: stale key are absent, so all
    // N concurrent callers reach the cold-path and must share ONE fetcher via
    // the in-flight map (the same map `getOrSet` uses).
    const fetcher = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { value: 'swr-shared' };
    });

    const results = await Promise.all([
      cache.getOrSetSWR('swr-coalesce', fetcher),
      cache.getOrSetSWR('swr-coalesce', fetcher),
      cache.getOrSetSWR('swr-coalesce', fetcher),
      cache.getOrSetSWR('swr-coalesce', fetcher),
      cache.getOrSetSWR('swr-coalesce', fetcher),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(5);
    for (const r of results) expect(r).toEqual({ value: 'swr-shared' });
    // Both the fresh key and the stale key were populated by the single fetch.
    expect(await cache.get('swr-coalesce')).toEqual({ value: 'swr-shared' });
    expect(await cache.get('swr:swr-coalesce')).toEqual({ value: 'swr-shared' });
  });

  it('does NOT cache null cold-path results AND clears the in-flight slot (next wave retries fresh)', async () => {
    const firstWaveFetcher = vi.fn().mockResolvedValue(null);

    const wave1 = await Promise.all([
      cache.getOrSetSWR('swr-null', firstWaveFetcher),
      cache.getOrSetSWR('swr-null', firstWaveFetcher),
      cache.getOrSetSWR('swr-null', firstWaveFetcher),
    ]);

    expect(firstWaveFetcher).toHaveBeenCalledTimes(1);
    for (const r of wave1) expect(r).toBeNull();
    // Neither the fresh key nor the stale key is written on null.
    expect(await cache.get('swr-null')).toBeUndefined();
    expect(await cache.get('swr:swr-null')).toBeUndefined();

    // The in-flight slot was cleared on the null resolution, so a fresh
    // fetcher runs for the next wave.
    const secondWaveFetcher = vi.fn().mockResolvedValue({ value: 'recovered' });
    const wave2 = await cache.getOrSetSWR('swr-null', secondWaveFetcher);
    expect(secondWaveFetcher).toHaveBeenCalledTimes(1);
    expect(wave2).toEqual({ value: 'recovered' });
  });

  it('clears the in-flight slot on a cold-path fetcher throw (next call retries fresh)', async () => {
    const throwingFetcher = vi.fn().mockRejectedValue(new Error('transient HAF outage'));

    const settled = await Promise.allSettled([
      cache.getOrSetSWR('swr-throw', throwingFetcher),
      cache.getOrSetSWR('swr-throw', throwingFetcher),
      cache.getOrSetSWR('swr-throw', throwingFetcher),
    ]);

    expect(throwingFetcher).toHaveBeenCalledTimes(1);
    for (const r of settled) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') {
        expect((r.reason as Error).message).toBe('transient HAF outage');
      }
    }

    const recoveryFetcher = vi.fn().mockResolvedValue({ value: 'recovered' });
    const result = await cache.getOrSetSWR('swr-throw', recoveryFetcher);
    expect(recoveryFetcher).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ value: 'recovered' });
  });

  it('stale-warm path is unaffected: concurrent callers get stale data + ONE background refresh', async () => {
    // Prime with a short fresh TTL and a long stale TTL so the fresh key
    // expires while the stale key survives — the stale-warm regime.
    const primeFetcher = vi.fn().mockResolvedValue({ value: 'v1' });
    await cache.getOrSetSWR('swr-warm', primeFetcher, 25, 300_000);
    expect(primeFetcher).toHaveBeenCalledTimes(1);

    // Let the fresh key expire (the stale key remains).
    await new Promise((r) => setTimeout(r, 80));

    // Concurrent callers in the stale-warm regime take the stale branch (NOT
    // the cold-path single-flight): they return stale immediately and the
    // `revalidating` Set deduplicates the background refresh to ONE fetch.
    const refreshFetcher = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { value: 'v2' };
    });

    const results = await Promise.all([
      cache.getOrSetSWR('swr-warm', refreshFetcher, 25, 300_000),
      cache.getOrSetSWR('swr-warm', refreshFetcher, 25, 300_000),
      cache.getOrSetSWR('swr-warm', refreshFetcher, 25, 300_000),
    ]);

    for (const r of results) expect(r).toEqual({ value: 'v1' });
    expect(refreshFetcher).toHaveBeenCalledTimes(1);
  });
});

describe('QueryCache — invalidation-during-flight prevents stale recache on SWR / revalidate / periodic-refresh', () => {
  let cache: QueryCache;

  beforeEach(() => {
    cache = new QueryCache(
      30_000,
      `test:cache-swr-inval:${Date.now()}:${Math.random().toString(36).slice(2)}:`,
    );
  });

  it('getOrSetSWR cold-path: invalidate() during the in-flight fetcher prevents the pre-invalidation snapshot from being cached', async () => {
    // Mutation-kill: removing the per-tier epoch guard from the getOrSetSWR
    // cold-path lets the pre-invalidation snapshot land in the cache, flipping
    // the post-condition assertions RED.
    const fetcher = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { value: 'pre-invalidation-snapshot' };
    });

    const inflightCall = cache.getOrSetSWR('swr-race', fetcher);
    await new Promise((r) => setTimeout(r, 10));
    await cache.invalidate('swr-race');

    const inflightResult = await inflightCall;
    // The caller still receives the resolved value; only the cache write is
    // suppressed.
    expect(inflightResult).toEqual({ value: 'pre-invalidation-snapshot' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Both the fresh key and the stale key stay cold (the cold-path gates BOTH
    // writes on the same epoch check).
    expect(await cache.get('swr-race')).toBeUndefined();
    expect(await cache.get('swr:swr-race')).toBeUndefined();
  });

  it('revalidate: invalidate() during the background refresh prevents the snapshot from being re-cached', async () => {
    // Mutation-kill: removing the epoch guard from `revalidate` lets the
    // background refresh write its snapshot back into the cache after the
    // invalidate flushed it, flipping the final assertion RED.
    await cache.getOrSetSWR('swr-reval', vi.fn().mockResolvedValue({ value: 'v1' }), 25, 300_000);
    // Expire the fresh key so the next call takes the stale-warm path and
    // triggers a background `revalidate`.
    await new Promise((r) => setTimeout(r, 80));

    const slowRefresh = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { value: 'v2-stale-snapshot' };
    });
    const stale = await cache.getOrSetSWR('swr-reval', slowRefresh, 25, 300_000);
    expect(stale).toEqual({ value: 'v1' });

    // The background revalidate is in flight. Invalidate the key mid-refresh.
    await new Promise((r) => setTimeout(r, 10));
    await cache.invalidate('swr-reval');

    // Let the revalidate resolve.
    await new Promise((r) => setTimeout(r, 80));
    expect(slowRefresh).toHaveBeenCalledTimes(1);

    // The revalidate's write was suppressed by the epoch bump: the fresh key
    // (deleted by invalidate) stays cold rather than being re-populated with
    // the pre-invalidation snapshot.
    expect(await cache.get('swr-reval')).toBeUndefined();

    // Stale-key suppression: `invalidate('swr-reval')` deletes only the fresh
    // key, NOT the `swr:` stale key (invalidate is not a stale-key delete
    // primitive today). So the load-bearing check is that the epoch-suppressed
    // revalidate did NOT overwrite the stale key with its pre-invalidation
    // snapshot: the stale key still holds the pre-revalidate 'v1', not
    // 'v2-stale-snapshot'. A split-gate regression that gated the fresh-key
    // write but left the stale-key write ungated would flip this to
    // 'v2-stale-snapshot'. (The cold-path spec asserts both keys undefined
    // because nothing pre-existed there; here a prior stale value exists, so
    // suppression manifests as the OLD value surviving rather than undefined.)
    expect(await cache.get('swr:swr-reval')).toEqual({ value: 'v1' });
  });

  it('registerPeriodicRefresh.reload: a flush during an in-flight reload suppresses the reload cache-write', async () => {
    // The reload closure captures both epochs at its start and gates its write
    // on them. A flush firing mid-reload must leave the key cold rather than
    // letting the reload re-populate the pre-flush snapshot.
    //
    // `clear()` is used as the flush rather than `invalidate(key)`: invalidate
    // ALSO triggers its own background reload via periodicEntries, which would
    // re-populate the key and mask the suppression under test. `clear()` bumps
    // both per-tier epochs (suppressing the stable reload — periodic refreshes
    // default to stable) without spawning a competing reload, so the guard is
    // exercised in isolation. A long interval keeps the periodic timer from
    // firing a second reload during the test.
    //
    // Mutation-kill: removing the epoch guard from the reload closure lets the
    // in-flight reload write 'periodic-snapshot' after the clear(), flipping
    // the final assertion RED.
    const slowFetcher = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { value: 'periodic-snapshot' };
    });

    // Do NOT await: let the initial reload run in the background so it is
    // in-flight when the flush fires. Interval is long so it never re-fires.
    const regPromise = cache.registerPeriodicRefresh('periodic-key', slowFetcher, 600_000);

    await new Promise((r) => setTimeout(r, 15));
    await cache.clear();

    // The initial reload completes; its write is suppressed by the epoch bump.
    await regPromise;
    expect(slowFetcher).toHaveBeenCalledTimes(1);
    expect(await cache.get('periodic-key')).toBeUndefined();
  });
});

describe('QueryCache — clearVolatile() tier distinction on SWR cold-path / revalidate / periodic-refresh', () => {
  let cache: QueryCache;

  beforeEach(() => {
    cache = new QueryCache(
      30_000,
      `test:cache-swr-tier:${Date.now()}:${Math.random().toString(36).slice(2)}:`,
    );
  });

  // The `clear()` / `invalidate()` invalidation specs above bump BOTH per-tier
  // counters, so they pass whether a guard reads the correct counter or the
  // wrong one. These companions use `clearVolatile()` — which bumps ONLY
  // `volatileEpoch` and deletes only non-stable entries — to distinguish the
  // tier each NEW guarded site reads, mirroring the existing `getOrSet`
  // clearVolatile STABLE / NON-stable specs.

  it('getOrSetSWR cold-path STABLE: clearVolatile() mid-flight does NOT suppress the write (gate reads stableEpoch)', async () => {
    // A STABLE cold-path entry whose fetcher is in flight when a block tick
    // calls clearVolatile() must STILL write on resolution — clearVolatile
    // bumps only volatileEpoch and never deletes stable entries.
    //
    // Mutation-kill: if the cold-path stable gate read volatileEpoch instead
    // of stableEpoch, clearVolatile would suppress the write and both keys
    // would be undefined — flipping these assertions RED.
    const fetcher = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { value: 'stable-swr' };
    });

    const inflightCall = cache.getOrSetSWR('swr-stable', fetcher, undefined, 300_000, true);
    await new Promise((r) => setTimeout(r, 10));
    await cache.clearVolatile();

    expect(await inflightCall).toEqual({ value: 'stable-swr' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Stable gate reads stableEpoch (untouched by clearVolatile), so BOTH the
    // fresh-key and stale-key writes proceed.
    expect(await cache.get('swr-stable')).toEqual({ value: 'stable-swr' });
    expect(await cache.get('swr:swr-stable')).toEqual({ value: 'stable-swr' });
  });

  it('getOrSetSWR cold-path NON-stable: clearVolatile() mid-flight suppresses BOTH writes (gate reads volatileEpoch)', async () => {
    // A NON-stable cold-path entry IS flushed by clearVolatile(), so its
    // in-flight fetcher must NOT write its pre-flush snapshot back.
    //
    // Mutation-kill: dropping the volatileEpoch conjunct from the cold-path
    // non-stable gate (so it reads only stableEpoch, which clearVolatile
    // leaves untouched) lets both writes proceed — flipping these RED.
    const fetcher = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { value: 'volatile-swr' };
    });

    const inflightCall = cache.getOrSetSWR('swr-volatile', fetcher); // non-stable default
    await new Promise((r) => setTimeout(r, 10));
    await cache.clearVolatile();

    expect(await inflightCall).toEqual({ value: 'volatile-swr' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Non-stable gate reads BOTH epochs; clearVolatile bumped volatileEpoch, so
    // both the fresh-key and stale-key writes are suppressed.
    expect(await cache.get('swr-volatile')).toBeUndefined();
    expect(await cache.get('swr:swr-volatile')).toBeUndefined();
  });

  it('revalidate STABLE: clearVolatile() mid-refresh does NOT suppress the re-cache (gate reads stableEpoch)', async () => {
    // Prime a STABLE entry, expire the fresh key, take the stale-warm path to
    // trigger a background revalidate, then fire clearVolatile() mid-refresh.
    // The stable revalidate gate reads stableEpoch (untouched), so the write
    // proceeds.
    //
    // Mutation-kill: if revalidate's stable gate read volatileEpoch,
    // clearVolatile would suppress and the stale key would keep 'v1' — RED.
    await cache.getOrSetSWR('swr-reval-stable', vi.fn().mockResolvedValue({ value: 'v1' }), 25, 300_000, true);
    await new Promise((r) => setTimeout(r, 80));

    const slowRefresh = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { value: 'v2' };
    });
    const stale = await cache.getOrSetSWR('swr-reval-stable', slowRefresh, 25, 300_000, true);
    expect(stale).toEqual({ value: 'v1' });

    await new Promise((r) => setTimeout(r, 10));
    await cache.clearVolatile();

    await new Promise((r) => setTimeout(r, 80));
    expect(slowRefresh).toHaveBeenCalledTimes(1);
    // Stable revalidate write proceeded. The long-lived stale key is the robust
    // witness: the fresh key's 25ms TTL would already have re-expired by now.
    expect(await cache.get('swr:swr-reval-stable')).toEqual({ value: 'v2' });
  });

  it('revalidate NON-stable: clearVolatile() mid-refresh suppresses the re-cache (gate reads volatileEpoch)', async () => {
    // NON-stable converse: clearVolatile() bumps volatileEpoch AND deletes the
    // non-stable stale key, so the suppressed revalidate leaves both keys cold.
    //
    // Mutation-kill: dropping the volatileEpoch conjunct from revalidate's
    // non-stable gate lets the re-cache proceed — flipping these RED.
    await cache.getOrSetSWR('swr-reval-vol', vi.fn().mockResolvedValue({ value: 'v1' }), 25, 300_000);
    await new Promise((r) => setTimeout(r, 80));

    const slowRefresh = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { value: 'v2-stale-snapshot' };
    });
    const stale = await cache.getOrSetSWR('swr-reval-vol', slowRefresh, 25, 300_000);
    expect(stale).toEqual({ value: 'v1' });

    await new Promise((r) => setTimeout(r, 10));
    await cache.clearVolatile();

    await new Promise((r) => setTimeout(r, 80));
    expect(slowRefresh).toHaveBeenCalledTimes(1);
    // clearVolatile bumped volatileEpoch (suppressing the re-cache) AND deleted
    // the non-stable stale key, so both keys end cold.
    expect(await cache.get('swr-reval-vol')).toBeUndefined();
    expect(await cache.get('swr:swr-reval-vol')).toBeUndefined();
  });

  it('registerPeriodicRefresh.reload STABLE: clearVolatile() mid-reload does NOT suppress the write (gate reads stableEpoch)', async () => {
    // Periodic refreshes default to stable:true. A clearVolatile() block tick
    // firing during an in-flight reload must NOT suppress the reload's write —
    // the stable gate reads stableEpoch, which clearVolatile leaves untouched.
    //
    // Mutation-kill: if the reload's stable gate read volatileEpoch,
    // clearVolatile would suppress and the key would be undefined — RED.
    const slowFetcher = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { value: 'periodic-stable' };
    });

    // Do NOT await: let the initial reload run in the background so it is
    // in-flight when the flush fires. Long interval so it never re-fires.
    const regPromise = cache.registerPeriodicRefresh('periodic-stable-key', slowFetcher, 600_000);

    await new Promise((r) => setTimeout(r, 15));
    await cache.clearVolatile();

    await regPromise;
    expect(slowFetcher).toHaveBeenCalledTimes(1);
    // Stable reload gate reads stableEpoch (untouched), so the write proceeds.
    expect(await cache.get('periodic-stable-key')).toEqual({ value: 'periodic-stable' });
  });
});

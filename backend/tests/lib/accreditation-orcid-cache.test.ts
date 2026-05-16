/**
 * Unit canary for `getAccreditedOrcidsByAccount`'s pool-null early-return.
 *
 * **Background (round-2 hold item 2):** when `getPool()` returns null (HAF
 * not yet connected at startup, transient pool drop), the helper used to
 * return an empty result from inside `hafCache.getOrSet(...)`. The cache
 * layer treats empty arrays as cacheable; the degraded result would persist
 * for the full 10-min TTL. If HAF recovered mid-window, the ORCID
 * server-overrides per `agents/docs/ARCHITECTURE.md § 2 "Multi-Author
 * Trust Model"` would be silently suppressed until cache expiry — exactly
 * the moment when spoof detection should re-engage.
 *
 * **Fix invariant pinned here:** when `getPool() === null`, the helper
 * returns an empty Map WITHOUT entering `hafCache.getOrSet`. The next
 * request after HAF connects re-tries the underlying query and populates
 * the cache correctly.
 *
 * **Carve-out (per root CLAUDE.md "Running Tests"):** mocks
 * `getPool()` and `hafCache.getOrSet` to deterministically exercise the
 * `pool === null` branch — real HAF never returns null. Justification per
 * clause (a): pool-null is a startup / transient-outage condition that
 * cannot be triggered against a live HAF connection on demand. Clause (b):
 * no auth middleware in scope (helper-direct unit). Clause (c): the
 * matching real-HAF coverage of the happy path is exercised transitively
 * through `papers-canonical-orcid-resolution.test.ts` and other paper-
 * detail integration tests against live HAF.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getPoolMock, getOrSetSpy } = vi.hoisted(() => ({
  getPoolMock: vi.fn(),
  getOrSetSpy: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  getPool: getPoolMock,
  isHafConfigured: () => getPoolMock() !== null,
  closeHafPool: async () => { /* no-op */ },
}));

vi.mock('../../src/cache.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/cache.js')>('../../src/cache.js');
  return {
    ...actual,
    hafCache: {
      ...actual.hafCache,
      getOrSet: getOrSetSpy,
      clear: actual.hafCache.clear.bind(actual.hafCache),
    },
  };
});

const { getAccreditedOrcidsByAccount } = await import('../../src/accreditation.js');

beforeEach(() => {
  getPoolMock.mockReset();
  getOrSetSpy.mockReset();
});

describe('getAccreditedOrcidsByAccount — pool === null early-return', () => {
  it('returns an empty Map without entering hafCache.getOrSet when getPool() returns null', async () => {
    getPoolMock.mockReturnValue(null);
    const result = await getAccreditedOrcidsByAccount();
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
    // The load-bearing assertion: the empty result is NOT routed through
    // the cache. A cached empty Map would pin spoof-detection blind for
    // 10 minutes after HAF recovers.
    expect(getOrSetSpy).not.toHaveBeenCalled();
  });

  it('enters hafCache.getOrSet when getPool() returns a connected pool', async () => {
    // Sibling assertion to keep the "skip vs. enter" contrast explicit. If
    // the early-return regressed to also skip the cache when pool is
    // live, the productive cache-hit path would silently re-query HAF on
    // every request. This pin catches that regression class.
    getPoolMock.mockReturnValue({ query: vi.fn() });
    getOrSetSpy.mockResolvedValue([]);
    const result = await getAccreditedOrcidsByAccount();
    expect(result).toBeInstanceOf(Map);
    expect(getOrSetSpy).toHaveBeenCalledTimes(1);
  });
});

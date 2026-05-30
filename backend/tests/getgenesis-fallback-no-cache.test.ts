import { describe, it, expect, vi } from 'vitest';

/**
 * Regression for getGenesisBlock's fallback caching bug.
 *
 * Carve-out clause-(a) justification: the bug only manifests on a fresh
 * deployment where NO accreditation exists yet (primary query returns NULL,
 * fallback returns HEAD). The shared real HAF the suite runs against already
 * has accreditations, so the fallback branch is unreachable through the real
 * pool. The function takes its pool as a parameter, so a hand-rolled fake pool
 * exercises the exact branch deterministically. `vi.resetModules()` gives a
 * fresh hafsql module instance whose module-level genesis cache starts null
 * (tests/setup.ts primes the cache in the original instance via the real pool).
 *
 * Carve-out clause-(c): the cached-genesis happy path is exercised end-to-end
 * by every real-HAF query in the suite (they all clamp on getGenesisBlock).
 */
describe('getGenesisBlock fallback does not cache HEAD', () => {
  it('returns HEAD without caching before any accreditation, then caches the real genesis once it lands', async () => {
    vi.resetModules();
    const { getGenesisBlock, getCachedGenesisBlock } = await import('../src/hafsql.js');

    // `phase` flips the primary (MIN accredit block) result: a fresh DB has no
    // accredit op (NULL); once the first accreditation lands it returns 500.
    let phase: 'fresh' | 'accredited' = 'fresh';
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('MIN(cj.block_num)')) {
          return { rows: [{ genesis: phase === 'fresh' ? null : 500 }] };
        }
        return { rows: [{ head: 1000 }] }; // HEAD fallback
      },
    };

    // Phase 1 — fresh DB: returns the HEAD floor but must NOT cache it.
    const first = await getGenesisBlock(pool as never);
    expect(first).toBe(1000);
    expect(getCachedGenesisBlock()).toBe(0); // not cached — the bug cached HEAD here

    // Phase 2 — first accreditation lands: primary now finds the real genesis,
    // which is returned and cached.
    phase = 'accredited';
    const second = await getGenesisBlock(pool as never);
    expect(second).toBe(500);
    expect(getCachedGenesisBlock()).toBe(500);

    // Phase 3 — subsequent calls short-circuit to the cached real genesis even
    // if the primary would transiently return NULL again.
    phase = 'fresh';
    const third = await getGenesisBlock(pool as never);
    expect(third).toBe(500);
  });
});

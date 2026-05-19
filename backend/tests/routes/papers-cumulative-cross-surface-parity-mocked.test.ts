/**
 * Cross-surface cumulative-union parity — deterministic helper canary.
 *
 * Pins the invariant that `resolveChainCumulativeAuthors` reconstructs the
 * union of `pevo.authors[].hive` across all chain posts, even when the head
 * broadcaster drops a chain author from their own `pevo.authors[]`. Because
 * detail / listing / profile surfaces all route through the same helper,
 * this single-helper canary structurally proves the cross-surface parity:
 * any surface that calls the helper with the same inputs gets the same
 * output. Route-level wiring is covered by the real-HAF parity canary in
 * `papers.test.ts` (Cross-surface cumulative-union parity).
 *
 * **Carve-out (CLAUDE.md "Running Tests"):** this test exercises the
 * helper's algorithmic behavior in isolation via the `prebuiltChainPosts`
 * fast-path. Per the carve-out clauses:
 *   (a) Justification: the multi-link chain with head-dropped chain author
 *       is a rare on-chain scenario that cannot be reproduced against the
 *       public HAF DB on demand (requires sequenced custom_json broadcasts
 *       plus a head-edit dropping an author). Exercising the helper
 *       directly is the deterministic way to pin the union construction.
 *   (b) No `verifyHiveSignature` or other auth middleware is in scope — the
 *       helper is a pure function over `{chainPosts, accreditedAccounts,
 *       accreditedOrcids, accreditationOrcidStatus}`.
 *   (c) Real-path companion: the cross-surface parity canary in
 *       `papers.test.ts` exercises the live HAF chain walk + helper +
 *       listing/profile route wiring end-to-end. A regression in the
 *       helper's union algorithm would surface there as a parity mismatch
 *       across detail/listing/profile; this file pins the algorithm
 *       deterministically without depending on corpus state.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resolveChainCumulativeAuthors } from '../../src/routes/papers.js';
import { hafCache } from '../../src/cache.js';

beforeEach(async () => {
  await hafCache.clear();
});

describe('resolveChainCumulativeAuthors — cumulative-union construction', () => {
  it('reconstructs the union when the head broadcaster drops a chain author', async () => {
    // 2-link chain: alice/p1 (root) names alice + bob in pevo.authors[].
    // bob/v2 (head continuation) names only bob — alice is dropped from
    // bob's head metadata. The cumulative union must still surface alice
    // because alice's root self-claim cannot be removed by a later
    // broadcaster's metadata edit.
    const chainPosts = [
      { author: 'alice', permlink: 'p1', pevo: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }] } },
      { author: 'bob', permlink: 'v2', pevo: { type: 'paper', authors: [{ hive: 'bob' }] } },
    ];
    const result = await resolveChainCumulativeAuthors('alice', 'p1', {
      accreditedAccounts: new Set(['alice', 'bob']),
      accreditedOrcids: new Map(),
      accreditationOrcidStatus: new Map(),
      prebuiltChainPosts: chainPosts,
    });
    expect(result).not.toBeNull();
    const hives = (result!.authors as Array<{ hive?: string }>).map((a) => a.hive).sort();
    expect(hives).toEqual(['alice', 'bob']);
    // First-occurrence order preserved: alice (root index 0), bob (root index 1).
    expect((result!.authors[0] as { hive?: string }).hive).toBe('alice');
    expect((result!.authors[1] as { hive?: string }).hive).toBe('bob');
    expect(result!.accredited_authors.sort()).toEqual(['alice', 'bob']);
  });

  it('writes through to the per-root Redis cache so listing/profile see warm reads', async () => {
    // Detail-surface call with prebuiltChainPosts populates the cache; a
    // subsequent listing-shape call (no prebuilt) hitting the same root
    // pair must short-circuit on the cache hit and return the same value.
    const chainPosts = [
      { author: 'alice', permlink: 'p1', pevo: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }] } },
      { author: 'bob', permlink: 'v2', pevo: { type: 'paper', authors: [{ hive: 'bob' }] } },
    ];
    const ctx = {
      accreditedAccounts: new Set(['alice', 'bob']),
      accreditedOrcids: new Map<string, string | null>(),
      accreditationOrcidStatus: new Map<string, { orcid: string | null; status: 'active' | 'revoked' }>(),
    };
    const detailResult = await resolveChainCumulativeAuthors('alice', 'p1', {
      ...ctx,
      prebuiltChainPosts: chainPosts,
    });
    expect(detailResult).not.toBeNull();

    // Read the cache directly to confirm the value landed under the
    // documented key shape.
    const cached = await hafCache.get<{ authors: Array<{ hive?: string }>; accredited_authors: string[] }>(
      'chain-authors:alice:p1',
    );
    expect(cached).toBeDefined();
    const cachedHives = (cached!.authors).map((a) => a.hive).sort();
    expect(cachedHives).toEqual(['alice', 'bob']);
    expect(cached!.accredited_authors.sort()).toEqual(['alice', 'bob']);
  });

  it('accredited_authors omits non-accredited hives from the cumulative union', async () => {
    // alice and bob in the union; only bob is currently accredited. carol
    // appears in a third chain post but is not accredited. accredited_authors
    // is the strict intersection with the active accreditation set.
    const chainPosts = [
      { author: 'alice', permlink: 'p1', pevo: { type: 'paper', authors: [{ hive: 'alice' }] } },
      { author: 'bob', permlink: 'v2', pevo: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }] } },
      { author: 'carol', permlink: 'v3', pevo: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }, { hive: 'carol' }] } },
    ];
    const result = await resolveChainCumulativeAuthors('alice', 'p1', {
      accreditedAccounts: new Set(['bob']),
      accreditedOrcids: new Map(),
      accreditationOrcidStatus: new Map(),
      prebuiltChainPosts: chainPosts,
    });
    expect(result).not.toBeNull();
    expect((result!.authors as Array<{ hive?: string }>).map((a) => a.hive).sort()).toEqual(['alice', 'bob', 'carol']);
    expect(result!.accredited_authors).toEqual(['bob']);
  });
});

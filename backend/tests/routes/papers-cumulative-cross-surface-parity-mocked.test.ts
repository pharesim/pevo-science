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
 * Also pins the author-identity-model behaviors: Hive-less co-author
 * persistence via the composite-key (orcid-else-name) track, the two-track
 * no-merge boundary (a Hive-less credit is never auto-linked to a Hive
 * identity), silent name-supersession (an accredited author's attested name
 * supersedes the broadcaster claim with no discrepancy field), and the
 * name read-time fallback chain (attested → broadcaster → hive → orcid).
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
      accreditedNames: new Map(),
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
      accreditedNames: new Map<string, string>(),
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

    // Warm-path short-circuit: a second call WITHOUT prebuiltChainPosts hits
    // the cache populated above and must return the same value without any
    // HAF roundtrip. A regression that removed the `getOrSet` cache-read
    // would issue an HAF probe (returning `null` since `getPool()` is not
    // mocked in this file), and the assertion would observe a divergent
    // result. Pinning the read-side path is the structural complement to
    // the write-side cache landing asserted above.
    const warmResult = await resolveChainCumulativeAuthors('alice', 'p1', ctx);
    expect(warmResult).not.toBeNull();
    const warmHives = (warmResult!.authors).map((a) => a.hive).sort();
    expect(warmHives).toEqual(['alice', 'bob']);
    expect(warmResult!.accredited_authors.sort()).toEqual(['alice', 'bob']);
  });

  it('returns null on single-link prebuiltChainPosts (no cache poisoning)', async () => {
    // Single-link short-circuit (prebuilt path): when the detail surface
    // passes a 1-link chain, the helper must return null so the caller falls
    // back to its own supersession projection (which preserves bridge-paper
    // `hive: null` carrier entries that the cumulative-union construction
    // intentionally strips). A regression that omitted the chain.length === 1
    // guard from the prebuilt path would write a stripped result to
    // `chain-authors:alice:p1` and a subsequent listing/profile call would
    // serve the stripped shape instead of the head-meta projection — a
    // divergence between cached and live shapes that surfaces as a missing-
    // carrier bug on multi-author single-link papers.
    const singleLinkPosts = [
      { author: 'alice', permlink: 'p1', pevo: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }] } },
    ];
    const ctx = {
      accreditedAccounts: new Set(['alice', 'bob']),
      accreditedOrcids: new Map<string, string | null>(),
      accreditationOrcidStatus: new Map<string, { orcid: string | null; status: 'active' | 'revoked' }>(),
      accreditedNames: new Map<string, string>(),
    };
    const result = await resolveChainCumulativeAuthors('alice', 'p1', {
      ...ctx,
      prebuiltChainPosts: singleLinkPosts,
    });
    expect(result).toBeNull();

    // The load-bearing assertion: no cache entry was written. A regression
    // that wrote the stripped result would observe a defined cache entry
    // here, poisoning the leaf for the full TTL.
    const cached = await hafCache.get('chain-authors:alice:p1');
    expect(cached).toBeUndefined();
  });

  it('per-row Promise.all enrichment isolates a thrown helper from sibling rows', async () => {
    // The listing and profile enrichment loops wrap each helper call in
    // `Promise.all(rows.map(async r => { try { ... } catch (err) { ... } }))`.
    // The architectural guarantee: one row's throw must not abort sibling
    // rows nor surface as a 5xx — the catch absorbs the throw and the
    // erroring row falls back to head-meta. This unit test pins that
    // guarantee at the helper boundary so the route's wrapping has a sound
    // primitive to layer on top.
    //
    // Inputs:
    //   - row 1 (alice/p1): valid prebuiltChainPosts; helper returns the
    //     cumulative-union result.
    //   - row 2 (poisoned/x1): the buildCumulativeAuthorsForChain pipeline
    //     dereferences `post.author` and `post.pevo.authors`; passing a
    //     chainPosts entry whose `pevo` is `null` makes the loop throw on
    //     `post.pevo.authors`. The pre-existing Promise.all + try/catch
    //     pattern absorbs the throw.
    const validChain = [
      { author: 'alice', permlink: 'p1', pevo: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }] } },
      { author: 'bob', permlink: 'v2', pevo: { type: 'paper', authors: [{ hive: 'bob' }] } },
    ];
    const poisonedChain = [
      { author: 'poisoned', permlink: 'x1', pevo: { type: 'paper', authors: [{ hive: 'poisoned' }] } },
      // Second link with `pevo: null as any` throws when the cumulative-union
      // loop reads `post.pevo.authors`.
      { author: 'poisoned-cont', permlink: 'x2', pevo: null as unknown as Record<string, unknown> },
    ];
    const ctx = {
      accreditedAccounts: new Set(['alice', 'bob', 'poisoned']),
      accreditedOrcids: new Map<string, string | null>(),
      accreditationOrcidStatus: new Map<string, { orcid: string | null; status: 'active' | 'revoked' }>(),
      accreditedNames: new Map<string, string>(),
    };

    // Mirror the route's per-row enrichment loop shape verbatim: Promise.all
    // over a map function with try/catch absorbing per-row errors and a
    // chainAuthorsByKey map collecting successes.
    const rows = [
      { author: 'alice', permlink: 'p1', prebuilt: validChain },
      { author: 'poisoned', permlink: 'x1', prebuilt: poisonedChain },
    ];
    const chainAuthorsByKey = new Map<string, NonNullable<Awaited<ReturnType<typeof resolveChainCumulativeAuthors>>>>();
    const errorsByKey = new Map<string, unknown>();
    await Promise.all(
      rows.map(async (r) => {
        const key = `${r.author}/${r.permlink}`;
        try {
          const result = await resolveChainCumulativeAuthors(r.author, r.permlink, {
            ...ctx,
            prebuiltChainPosts: r.prebuilt,
          });
          if (result !== null) chainAuthorsByKey.set(key, result);
        } catch (err) {
          // Mirrors the route's logger.warn fallback; we capture for assertion.
          errorsByKey.set(key, err);
        }
      }),
    );

    // (a) Other rows return their cumulative-union enriched authors.
    expect(chainAuthorsByKey.has('alice/p1')).toBe(true);
    const aliceResult = chainAuthorsByKey.get('alice/p1')!;
    expect(aliceResult.authors.map((a) => a.hive).sort()).toEqual(['alice', 'bob']);

    // (b) The erroring row has no chain-authors entry (the route's fallback
    // path then keeps the head-meta projection at the response site).
    expect(chainAuthorsByKey.has('poisoned/x1')).toBe(false);

    // (c) The throw was absorbed by the per-row catch — Promise.all
    // resolved rather than rejecting. Routes that wrap this pattern in a
    // try/catch around `await Promise.all(...)` would also have caught it,
    // but the per-row catch is the structural guarantee that the listing
    // response stays 200 even when one row's chain walk explodes.
    expect(errorsByKey.has('poisoned/x1')).toBe(true);
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
      accreditedNames: new Map(),
      prebuiltChainPosts: chainPosts,
    });
    expect(result).not.toBeNull();
    expect((result!.authors as Array<{ hive?: string }>).map((a) => a.hive).sort()).toEqual(['alice', 'bob', 'carol']);
    expect(result!.accredited_authors).toEqual(['bob']);
  });

  it('projects multi-link authors[] to the enumerated contract shape, dropping broadcaster-injected keys', async () => {
    // buildCumulativeAuthorsForChain threads the broadcaster's pevo.authors[i]
    // through the cumulative-union dedup, then projects each output entry to
    // exactly the PaperSummary contract fields plus affiliation. Any other key
    // a broadcaster injects (email, url, arbitrary metadata) must NOT survive
    // into authors[] — otherwise multi-link papers return wider author objects
    // than single-link rows (which use the enumerated SQL/JS projection), and
    // the extra keys leak into the per-root cache where consumer-side strips
    // cannot reach them. alice's winning entry (her root self-claim) carries an
    // affiliation plus injected email/url; bob's winning entry (his self-claim
    // continuation) carries neither.
    const chainPosts = [
      {
        author: 'alice',
        permlink: 'p1',
        pevo: {
          type: 'paper',
          authors: [
            { name: 'Alice A', hive: 'alice', affiliation: 'Uni A', email: 'alice@example.com', url: 'https://alice.example' },
            { name: 'Bob B', hive: 'bob', email: 'bob@example.com' },
          ],
        },
      },
      { author: 'bob', permlink: 'v2', pevo: { type: 'paper', authors: [{ name: 'Bob B', hive: 'bob' }] } },
    ];
    const result = await resolveChainCumulativeAuthors('alice', 'p1', {
      accreditedAccounts: new Set(['alice', 'bob']),
      accreditedOrcids: new Map(),
      accreditationOrcidStatus: new Map(),
      accreditedNames: new Map(),
      prebuiltChainPosts: chainPosts,
    });
    expect(result).not.toBeNull();
    const byHive = new Map(result!.authors.map((a) => [a.hive, a] as const));

    // No broadcaster-injected key survives on any entry.
    for (const author of result!.authors) {
      expect(author).not.toHaveProperty('email');
      expect(author).not.toHaveProperty('url');
    }

    // alice carried an affiliation → enumerated set is the contract fields
    // plus affiliation (the detail surface renders it; listing/profile strip).
    expect(Object.keys(byHive.get('alice')!).sort()).toEqual(
      ['affiliation', 'hive', 'name', 'orcid', 'orcid_discrepancy', 'orcid_verified'],
    );
    // bob carried no affiliation → exactly the PaperSummary contract set.
    expect(Object.keys(byHive.get('bob')!).sort()).toEqual(
      ['hive', 'name', 'orcid', 'orcid_discrepancy', 'orcid_verified'],
    );
  });
});

describe('resolveChainCumulativeAuthors — Hive-less co-author persistence (composite-key track)', () => {
  const baseCtx = () => ({
    accreditedAccounts: new Set<string>(['alice', 'bob']),
    accreditedOrcids: new Map<string, string | null>(),
    accreditationOrcidStatus: new Map<string, { orcid: string | null; status: 'active' | 'revoked' }>(),
    accreditedNames: new Map<string, string>(),
  });

  it('carries a Hive-less co-author the head broadcaster dropped on a multi-link paper', async () => {
    // Root names a Hive-keyed author (alice) plus a Hive-less co-author
    // (Carol, no Hive account). The head continuation drops Carol. The
    // cumulative union must still surface Carol — a display-only credit
    // cannot be removed by a later broadcaster's metadata edit, exactly as
    // a Hive-keyed author cannot.
    const chainPosts = [
      { author: 'alice', permlink: 'p1', pevo: { type: 'paper', authors: [{ name: 'Alice', hive: 'alice' }, { name: 'Carol Hiveless', orcid: '0000-0002-1111-2222' }] } },
      { author: 'alice', permlink: 'v2', pevo: { type: 'paper', authors: [{ name: 'Alice', hive: 'alice' }] } },
    ];
    const result = await resolveChainCumulativeAuthors('alice', 'p1', { ...baseCtx(), prebuiltChainPosts: chainPosts });
    expect(result).not.toBeNull();
    const names = result!.authors.map((a) => a.name).sort();
    expect(names).toEqual(['Alice', 'Carol Hiveless']);
    // Carol has no Hive account → not in accredited_authors regardless of
    // the accreditation set.
    expect(result!.accredited_authors).toEqual(['alice']);
  });

  it('dedups a repeated Hive-less co-author on the ORCID track', async () => {
    // Carol (Hive-less, ORCID present) appears in both links. The composite
    // key (normalized orcid) dedups her to a single entry.
    const chainPosts = [
      { author: 'alice', permlink: 'p1', pevo: { type: 'paper', authors: [{ name: 'Alice', hive: 'alice' }, { name: 'Carol', orcid: '0000-0002-1111-2222' }] } },
      { author: 'alice', permlink: 'v2', pevo: { type: 'paper', authors: [{ name: 'Alice', hive: 'alice' }, { name: 'Carol C', orcid: '0000-0002-1111-2222' }] } },
    ];
    const result = await resolveChainCumulativeAuthors('alice', 'p1', { ...baseCtx(), prebuiltChainPosts: chainPosts });
    const hiveless = result!.authors.filter((a) => !a.hive);
    expect(hiveless).toHaveLength(1);
    // Most-recent occurrence wins the entry content.
    expect(hiveless[0].name).toBe('Carol C');
    expect(hiveless[0].orcid).toBe('0000-0002-1111-2222');
  });

  it('dedups a repeated Hive-less co-author on the name track (no ORCID)', async () => {
    const chainPosts = [
      { author: 'alice', permlink: 'p1', pevo: { type: 'paper', authors: [{ name: 'Alice', hive: 'alice' }, { name: 'Dave Hiveless' }] } },
      { author: 'alice', permlink: 'v2', pevo: { type: 'paper', authors: [{ name: 'Alice', hive: 'alice' }, { name: 'dave hiveless' }] } },
    ];
    const result = await resolveChainCumulativeAuthors('alice', 'p1', { ...baseCtx(), prebuiltChainPosts: chainPosts });
    const hiveless = result!.authors.filter((a) => !a.hive);
    // Normalized-name composite key (case-insensitive) collapses the two.
    expect(hiveless).toHaveLength(1);
  });

  it('NEVER merges a Hive-less credit into a Hive-keyed entry for the same human', async () => {
    // Carol appears once with a Hive handle (carol) and once as a Hive-less
    // credit with the same name. Auto-linking by name is forbidden by the
    // trust model — the two stay separate (double-list) until an explicit
    // bridge-author-claim attestation links them.
    const chainPosts = [
      { author: 'alice', permlink: 'p1', pevo: { type: 'paper', authors: [{ name: 'Alice', hive: 'alice' }, { name: 'Carol', hive: 'carol' }] } },
      { author: 'alice', permlink: 'v2', pevo: { type: 'paper', authors: [{ name: 'Alice', hive: 'alice' }, { name: 'Carol' }] } },
    ];
    const result = await resolveChainCumulativeAuthors('alice', 'p1', { ...baseCtx(), prebuiltChainPosts: chainPosts });
    const carolEntries = result!.authors.filter((a) => a.name === 'Carol');
    expect(carolEntries).toHaveLength(2);
    // One Hive-keyed (carol), one Hive-less (no hive) — never merged.
    expect(carolEntries.filter((a) => a.hive === 'carol')).toHaveLength(1);
    expect(carolEntries.filter((a) => !a.hive)).toHaveLength(1);
  });

  it('interleaves Hive-less and Hive-keyed entries by first-occurrence order', async () => {
    const chainPosts = [
      { author: 'alice', permlink: 'p1', pevo: { type: 'paper', authors: [{ name: 'Alice', hive: 'alice' }, { name: 'Zed Hiveless' }] } },
      { author: 'alice', permlink: 'v2', pevo: { type: 'paper', authors: [{ name: 'Alice', hive: 'alice' }, { name: 'Zed Hiveless' }, { name: 'Bob', hive: 'bob' }] } },
    ];
    const result = await resolveChainCumulativeAuthors('alice', 'p1', { ...baseCtx(), prebuiltChainPosts: chainPosts });
    // alice (occ 0), Zed (occ 1, Hive-less), bob (occ 2) — Hive-less takes
    // its slot by first appearance, not after all Hive-keyed entries.
    expect(result!.authors.map((a) => a.name)).toEqual(['Alice', 'Zed Hiveless', 'Bob']);
  });

  it('projects a Hive-less entry to exactly the enumerated key set', async () => {
    const chainPosts = [
      { author: 'alice', permlink: 'p1', pevo: { type: 'paper', authors: [{ name: 'Alice', hive: 'alice' }, { name: 'Carol', orcid: '0000-0002-1111-2222', affiliation: 'Uni C', email: 'leak@example.com' }] } },
      { author: 'alice', permlink: 'v2', pevo: { type: 'paper', authors: [{ name: 'Alice', hive: 'alice' }] } },
    ];
    const result = await resolveChainCumulativeAuthors('alice', 'p1', { ...baseCtx(), prebuiltChainPosts: chainPosts });
    const carol = result!.authors.find((a) => a.name === 'Carol')!;
    // Same enumerated set as a Hive-keyed entry (+ affiliation here), no
    // broadcaster-injected `email`. orcid_verified/discrepancy default to
    // the no-attestation values (a Hive-less credit has no accreditation).
    expect(Object.keys(carol).sort()).toEqual(
      ['affiliation', 'hive', 'name', 'orcid', 'orcid_discrepancy', 'orcid_verified'],
    );
    expect(carol).not.toHaveProperty('email');
    expect(carol.orcid_verified).toBeNull();
    expect(carol.orcid_discrepancy).toBe(false);
  });

  it('drops a fully-empty author entry (no name, hive, or orcid)', async () => {
    const chainPosts = [
      { author: 'alice', permlink: 'p1', pevo: { type: 'paper', authors: [{ name: 'Alice', hive: 'alice' }, { affiliation: 'Ghost Uni' }] } },
      { author: 'alice', permlink: 'v2', pevo: { type: 'paper', authors: [{ name: 'Alice', hive: 'alice' }] } },
    ];
    const result = await resolveChainCumulativeAuthors('alice', 'p1', { ...baseCtx(), prebuiltChainPosts: chainPosts });
    // The affiliation-only entry names no one → dropped by the name guard.
    expect(result!.authors.map((a) => a.name)).toEqual(['Alice']);
  });
});

describe('resolveChainCumulativeAuthors — name-supersession + fallback', () => {
  const ctxWith = (accreditedNames: Map<string, string>) => ({
    accreditedAccounts: new Set<string>(['alice', 'bob']),
    accreditedOrcids: new Map<string, string | null>(),
    accreditationOrcidStatus: new Map<string, { orcid: string | null; status: 'active' | 'revoked' }>(),
    accreditedNames,
  });

  it('silently supersedes an accredited author name with the attested name (no discrepancy field)', async () => {
    // alice is accredited; her attested name is "Alice Anderson". She
    // broadcast "Al". The attested name wins for display, silently — no
    // name_discrepancy/name_verified field, unlike ORCID supersession.
    const chainPosts = [
      { author: 'alice', permlink: 'p1', pevo: { type: 'paper', authors: [{ name: 'Al', hive: 'alice' }, { name: 'Bob', hive: 'bob' }] } },
      { author: 'alice', permlink: 'v2', pevo: { type: 'paper', authors: [{ name: 'Al', hive: 'alice' }] } },
    ];
    const result = await resolveChainCumulativeAuthors('alice', 'p1', {
      ...ctxWith(new Map([['alice', 'Alice Anderson']])),
      prebuiltChainPosts: chainPosts,
    });
    const alice = result!.authors.find((a) => a.hive === 'alice')!;
    expect(alice.name).toBe('Alice Anderson');
    expect(alice).not.toHaveProperty('name_discrepancy');
    expect(alice).not.toHaveProperty('name_verified');
    // bob accredited but no attested name in the map → broadcaster name kept.
    expect(result!.authors.find((a) => a.hive === 'bob')!.name).toBe('Bob');
  });

  it('does not supersede when the attested name is absent (revoked/unaccredited keep broadcaster name)', async () => {
    // carol is NOT in accreditedNames (and not accredited) → her broadcaster
    // name is kept; no supersession.
    const chainPosts = [
      { author: 'alice', permlink: 'p1', pevo: { type: 'paper', authors: [{ name: 'Alice', hive: 'alice' }, { name: 'Carol Claimed', hive: 'carol' }] } },
      { author: 'alice', permlink: 'v2', pevo: { type: 'paper', authors: [{ name: 'Alice', hive: 'alice' }] } },
    ];
    const result = await resolveChainCumulativeAuthors('alice', 'p1', {
      ...ctxWith(new Map([['alice', 'Alice Anderson']])),
      prebuiltChainPosts: chainPosts,
    });
    expect(result!.authors.find((a) => a.hive === 'carol')!.name).toBe('Carol Claimed');
  });

  it('falls back through broadcaster name → hive handle → orcid', async () => {
    const chainPosts = [
      { author: 'alice', permlink: 'p1', pevo: { type: 'paper', authors: [
        { hive: 'bob' },                         // no name, not in name map → hive handle
        { orcid: '0000-0003-4444-5555' },        // Hive-less, no name → orcid
        { name: 'Named Person', hive: 'dave' },  // broadcaster name kept
      ] } },
      { author: 'alice', permlink: 'v2', pevo: { type: 'paper', authors: [{ hive: 'bob' }] } },
    ];
    const result = await resolveChainCumulativeAuthors('alice', 'p1', {
      ...ctxWith(new Map()),
      prebuiltChainPosts: chainPosts,
    });
    const byName = result!.authors.map((a) => a.name).sort();
    expect(byName).toEqual(['0000-0003-4444-5555', 'Named Person', 'bob']);
  });
});

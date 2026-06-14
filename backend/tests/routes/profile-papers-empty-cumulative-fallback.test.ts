/**
 * Empty-cumulative fallback parity canary for GET /api/profile/:username/papers.
 *
 * The listing surface (`fetchPapersFromHaf` row-map) gates its cumulative-union
 * takeover on `chainResult && chainResult.authors.length > 0`, so a non-null
 * but empty cumulative result (`{authors: [], accredited_authors: []}`) falls
 * back to the head-meta projection rather than serving an empty authors list.
 * The profile `/:username/papers` handler must mirror that gate — without the
 * `authors.length > 0` check, profile would serve `authors: []` while listing
 * and detail keep head-meta authors, reopening the cross-surface parity break
 * this surface exists to close.
 *
 * A non-null empty cumulative is reachable on a multi-link chain whose every
 * author entry resolves to nothing renderable (the cumulative-union
 * construction drops entries with no name / hive / orcid, and Hive-less
 * entries never enter `accredited_authors`), so the result is genuinely
 * `{authors: [], accredited_authors: []}` rather than `null`. These tests pin
 * the gate's two outcomes deterministically: empty-cumulative falls back to
 * head-meta; non-empty cumulative takes over.
 *
 * **Carve-out (per CLAUDE.md "Running Tests" carve-out clauses (a)/(b)/(c)):**
 *   (a) Justification: producing the empty-vs-populated takeover discrimination
 *       against real HAF requires a sequenced multi-link continuation chain
 *       whose every author entry is unrenderable — a contrived on-chain shape
 *       that cannot be reproduced against the public testnet on demand. The
 *       shared per-row enrichment helper `enrichRowsWithChainAuthors` (which
 *       walks HAF + Redis per row and applies the `length > 0` takeover gate
 *       internally) is mocked to return the exact per-key map the route's
 *       fallback gate reads — an empty map (no entry, the suppressed-empty
 *       case) versus a populated map (the takeover case) — so the route-level
 *       gate is exercised without depending on corpus state. `getPool()` is
 *       mocked to stage the one profile row plus the accreditation membership
 *       set.
 *   (b) `verifyHiveSignature` is NOT mocked — `/api/profile/:username/papers`
 *       is a public GET; the MOCK_VERIFY_SIGNATURE fixture is not loaded. No
 *       assertion here depends on cryptographic verification behavior.
 *   (c) Real-path companion: the same risk class (cumulative-union enrichment
 *       wiring + head-meta fallback on the profile-papers surface) is covered
 *       integratively by `tests/routes/papers.test.ts` (real-HAF cross-surface
 *       parity canary) and the helper's algorithmic behavior is pinned
 *       deterministically in
 *       `tests/routes/papers-cumulative-cross-surface-parity-mocked.test.ts`.
 *       This file pins the route-level gate the helper-unit tests cannot reach
 *       (the empty-cumulative branch lives in the profile handler, not the
 *       helper).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { hafQueryMock, getPoolMock, enrichRowsWithChainAuthorsMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async (..._args: unknown[]) => ({ rows: [] as unknown[] })),
  getPoolMock: vi.fn(),
  enrichRowsWithChainAuthorsMock: vi.fn(),
}));

vi.mock('../../src/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db.js')>();
  return {
    ...actual,
    getPool: getPoolMock,
    isHafConfigured: () => getPoolMock() !== null,
    closeHafPool: async () => { /* no-op */ },
  };
});

// Mock only the shared per-row enrichment helper export; preserve the rest of
// the chain-cumulative lib module via importOriginal so unrelated symbols stay
// real. The profile handler now calls `enrichRowsWithChainAuthors` (which
// internally calls `resolveChainCumulativeAuthors` via an intra-module ref a
// partial export-mock of that symbol could not intercept), so the mock injects
// at the helper boundary the route actually consumes: it returns the per-key
// `Map<string, ChainCumulativeAuthorsResult>` the route's takeover gate reads —
// an empty map for the fallback case, a populated map for the takeover case.
vi.mock('../../src/lib/chain-cumulative.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/chain-cumulative.js')>();
  return {
    ...actual,
    enrichRowsWithChainAuthors: enrichRowsWithChainAuthorsMock,
  };
});

const { createApp } = await import('../../src/app.js');
const { hafCache } = await import('../../src/cache.js');
const { config } = await import('../../src/config.js');
const app = createApp();

beforeEach(async () => {
  hafQueryMock.mockReset().mockResolvedValue({ rows: [] });
  getPoolMock.mockReset().mockReturnValue({
    query: hafQueryMock,
    connect: async () => ({ query: hafQueryMock, release: () => {} }),
  });
  enrichRowsWithChainAuthorsMock.mockReset();
  await hafCache.clear();
});

/**
 * Build a `user_papers` data row carrying the head-meta `authors[]` of the
 * caller's choosing. Mirrors the columns selected by `fetchUserPapersFromHaf`'s
 * data query.
 */
function userPapersRow(authors: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    author: 'alice',
    permlink: 'p1',
    title: 'Test paper',
    body: 'abstract\n\n---\n\nbody',
    json_metadata: {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors,
      },
    },
    created: '2026-04-01T00:00:00Z',
  };
}

/**
 * Stage the mocked pool so the profile-papers route receives one row with the
 * given head-meta `authors`. The accreditation membership set is pre-seeded
 * into the `accredited_accounts_all` cache so `getAccreditedSet` /
 * `getAllAccreditedAccounts` resolve the accredited head authors without
 * needing the per-helper CTE staged; the remaining accreditation lookups
 * (orcids, ever-orcids, names) feed only the mocked cumulative helper and the
 * head-meta supersession projection, so an empty result is benign.
 */
async function stage(headAuthors: Array<Record<string, unknown>>, accreditedAll: string[]): Promise<void> {
  await hafCache.set('accredited_accounts_all', accreditedAll);
  hafQueryMock.mockImplementation(async (...args: unknown[]) => {
    const sql = args[0] as string;
    if (sql.includes('count(*)') && sql.includes('user_papers')) {
      return { rows: [{ total: 1 }] };
    }
    if (sql.includes('FROM user_papers')) {
      return { rows: [userPapersRow(headAuthors)] };
    }
    return { rows: [] };
  });
}

describe('GET /api/profile/:username/papers — empty-cumulative fallback parity', () => {
  it('falls back to head-meta authors when the cumulative result is non-null but empty', async () => {
    // Head metadata names bob (accredited). The shared enrichment helper's
    // `length > 0` takeover gate suppresses the empty cumulative result (the
    // multi-link-all-unrenderable case), so it returns NO map entry for the
    // row. The profile handler must then route the missing entry back to the
    // head-meta projection, NOT serve an empty authors list.
    await stage([{ name: 'Bob', hive: 'bob' }], ['bob']);
    enrichRowsWithChainAuthorsMock.mockResolvedValue(new Map());

    const res = await request(app).get('/api/profile/alice/papers');
    expect(res.status).toBe(200);
    const paper = res.body.data[0];
    // Head-meta authors survive — the empty cumulative did NOT take over.
    expect(paper.authors).toHaveLength(1);
    expect(paper.authors[0].hive).toBe('bob');
    // accredited_authors falls back to the head-meta intersection, not the
    // helper's empty array.
    expect(paper.accredited_authors).toEqual(['bob']);
  });

  it('takes over with the cumulative result when it carries authors', async () => {
    // Companion: a NON-empty cumulative result must take over so the gate's
    // discrimination is pinned on both sides. The helper surfaces a dropped
    // chain author (carol) the head broadcaster omitted, returning a populated
    // map keyed by `author/permlink`.
    await stage([{ name: 'Bob', hive: 'bob' }], ['bob', 'carol']);
    enrichRowsWithChainAuthorsMock.mockResolvedValue(
      new Map([
        ['alice/p1', {
          authors: [
            { name: 'Bob', hive: 'bob', orcid: null, orcid_verified: null, orcid_discrepancy: false },
            { name: 'Carol', hive: 'carol', orcid: null, orcid_verified: null, orcid_discrepancy: false },
          ],
          accredited_authors: ['bob', 'carol'],
        }],
      ]),
    );

    const res = await request(app).get('/api/profile/alice/papers');
    expect(res.status).toBe(200);
    const paper = res.body.data[0];
    // Cumulative-union takeover: carol is surfaced even though head meta dropped her.
    expect(paper.authors.map((a: { hive?: string }) => a.hive).sort()).toEqual(['bob', 'carol']);
    expect(paper.accredited_authors.sort()).toEqual(['bob', 'carol']);
  });
});

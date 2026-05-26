/**
 * Route-level per-row chain-enrichment failure isolation — integrated handler canary.
 *
 * Drives the REAL `GET /api/papers` (listing) and `GET /api/profile/:username/papers`
 * handlers with a multi-row fixture in which exactly one row's
 * `resolveChainCumulativeAuthors` is forced to throw. Asserts the response stays
 * 200 (not 5xx), the erroring row falls back to its head-meta `authors` /
 * `accredited_authors` (no cumulative-union override), and sibling rows keep
 * their cumulative-union enrichment.
 *
 * This complements the helper-boundary isolation canary in
 * `papers-cumulative-cross-surface-parity-mocked.test.ts`, which pins the
 * `Promise.all` + per-row `try/catch` primitive by re-implementing the loop in
 * the test body. That test cannot observe a refactor that moved the route's
 * `try/catch` OUT of the per-row map (so one row's throw rejects the whole
 * `Promise.all` → 5xx), because its own inline catch absorbs the throw. This
 * file closes that gap by exercising the integrated route — the per-row catch
 * lives inside `fetchPapersFromHaf` / the profile handler, so a regression that
 * relocates it surfaces here as a 5xx or a missing erroring row.
 *
 * **Carve-out (CLAUDE.md "Running Tests"):**
 *   (a) Justification — the listing/profile SQL surface (count CTE, data query,
 *       and the batched reputation / accreditation / vote / ORCID lookups) cannot
 *       be seeded against the public HAF DB to deterministically force ONE row's
 *       chain walk to throw while siblings succeed. The failure-injection point
 *       is the shared per-root cache helper `hafCache.getOrSet` (the outermost
 *       wrapper inside `resolveChainCumulativeAuthors`); a real chain walk
 *       swallows its own SQL failures and returns null rather than throwing, so
 *       a real-HAF path cannot reproduce the throw this isolation guard defends
 *       against. Mocked infra: `getPool()` (shared HAF pool helper) returns a
 *       deterministic multi-row dataset; `hafCache.getOrSet` is spied to reject
 *       for the erroring row's `chain-authors:<author>:<permlink>` key and to
 *       delegate every other key (including the profile response-cache key and
 *       the sibling row's pre-seeded entry) to the real implementation.
 *   (b) Auth-middleware policy — both routes are unauthenticated reads mounted
 *       behind `readLimiter` only; `verifyHiveSignature` is NOT in the request
 *       chain for either, so no auth middleware is mocked or bypassed here. The
 *       focus is downstream response-shape behavior, not cryptographic
 *       verification.
 *   (c) Real-path companion — the cross-surface cumulative-union parity canary
 *       in `papers.test.ts` exercises the live HAF chain walk + helper + route
 *       wiring end-to-end; the helper-boundary canary in
 *       `papers-cumulative-cross-surface-parity-mocked.test.ts` pins the
 *       per-row catch primitive. This file's risk class — "the route relocates
 *       the per-row catch and a single chain-walk throw becomes a page-wide
 *       5xx" — is the integrated complement neither of those covers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async (..._args: any[]) => ({ rows: [] as any[] })),
  getPoolMock: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  getPool: getPoolMock,
  isHafConfigured: () => getPoolMock() !== null,
  closeHafPool: async () => { /* no-op */ },
}));

const { createApp } = await import('../../src/app.js');
const { hafCache } = await import('../../src/cache.js');
const { config } = await import('../../src/config.js');
const app = createApp();

// Multi-author head metadata: an `isPevoPaper`-passing object whose
// `pevo.authors[].hive` drives the head-meta fallback projection. The cumulative
// union (when the helper succeeds) is allowed to be a superset; the head-meta
// fallback is exactly these hives.
function buildPaperMeta(authorHandles: string[]) {
  return {
    app: `${config.appTag}/1.0`,
    [config.appTag]: {
      type: 'paper',
      discipline: 'physics',
      keywords: [],
      authors: authorHandles.map((hive) => ({ hive })),
    },
  };
}

beforeEach(async () => {
  hafQueryMock.mockReset().mockResolvedValue({ rows: [] });
  getPoolMock.mockReset().mockReturnValue({ query: hafQueryMock });
  await hafCache.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/papers — per-row chain-enrichment failure isolation (integrated handler)', () => {
  it('stays 200, erroring row falls back to head-meta, sibling row keeps cumulative-union enrichment', async () => {
    // Two listing rows:
    //   - sibling/enriched: chain walk "succeeds" — we pre-seed its per-root
    //     cache entry with a cumulative-union result that is a SUPERSET of its
    //     head-meta authors (adds `coauthor`, a dropped chain author), so the
    //     response carries the cumulative authors + cumulative accredited_authors.
    //   - erroring/boom: chain walk throws — the helper's `getOrSet` wrapper is
    //     spied to reject for this row's key. The route's per-row catch must
    //     absorb the throw and fall back to this row's head-meta projection.
    const siblingMeta = buildPaperMeta(['sibling']);
    const erroringMeta = buildPaperMeta(['erroring']);

    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('count(*)::int AS total')) {
        return { rows: [{ total: 2 }] };
      }
      if (sql.includes('LEFT(c.body, 300) AS abstract')) {
        return {
          rows: [
            {
              author: 'sibling',
              permlink: 'enriched',
              title: 'Sibling Paper',
              abstract: 'Sibling abstract',
              json_metadata: siblingMeta,
              created: '2026-04-28T00:00:00',
              net_votes: 0,
              review_count: 0,
              citation_count: 0,
              avg_rating: 0,
              authors_with_supersession: [{ hive: 'sibling', name: null, orcid: null }],
              author_reputation: 0,
            },
            {
              author: 'erroring',
              permlink: 'boom',
              title: 'Erroring Paper',
              abstract: 'Erroring abstract',
              json_metadata: erroringMeta,
              created: '2026-04-28T00:00:00',
              net_votes: 0,
              review_count: 0,
              citation_count: 0,
              avg_rating: 0,
              authors_with_supersession: [{ hive: 'erroring', name: null, orcid: null }],
              author_reputation: 0,
            },
          ],
        };
      }
      return { rows: [] };
    });

    // Pre-seed the sibling's per-root cumulative-authors cache so its enrichment
    // resolves from a warm hit (no chain walk). The cumulative union is a
    // superset of the head-meta authors — it carries a dropped chain co-author
    // `coauthor` plus an accredited_authors set distinct from the (empty) live
    // accredited set, so the response can only carry these values via the
    // cumulative path, not the head-meta fallback.
    await hafCache.set('chain-authors:sibling:enriched', {
      authors: [
        { hive: 'sibling', name: null, orcid: null, orcid_verified: false, orcid_discrepancy: false },
        { hive: 'coauthor', name: null, orcid: null, orcid_verified: false, orcid_discrepancy: false },
      ],
      accredited_authors: ['sibling', 'coauthor'],
    });

    // Force the erroring row's chain-enrichment to throw at the helper's
    // outermost wrapper (`hafCache.getOrSet`). Every other key — the profile
    // response cache, the sibling's pre-seeded entry (served from `get`, never
    // reaching `getOrSet`'s fetcher) — delegates to the real implementation.
    const realGetOrSet = hafCache.getOrSet.bind(hafCache);
    vi.spyOn(hafCache, 'getOrSet').mockImplementation((key: string, fn: () => Promise<unknown>, ttlMs?: number, stable?: boolean) => {
      if (key === 'chain-authors:erroring:boom') {
        return Promise.reject(new Error('chain walk exploded'));
      }
      return realGetOrSet(key, fn, ttlMs, stable);
    });

    const res = await request(app).get('/api/papers?accredited_only=false');

    // (1) Response status is 200, not a 5xx — one row's throw did not reject
    // the whole `Promise.all`.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data).toHaveLength(2);

    const bySlug = new Map(res.body.data.map((r: any) => [`${r.author}/${r.permlink}`, r]));

    // (3) Sibling row carries cumulative-union enrichment (the dropped chain
    // co-author `coauthor` and the cumulative accredited_authors set).
    const sibling = bySlug.get('sibling/enriched') as any;
    expect(sibling).toBeDefined();
    expect((sibling.authors as Array<{ hive?: string }>).map((a) => a.hive).sort()).toEqual(['coauthor', 'sibling']);
    expect((sibling.accredited_authors as string[]).slice().sort()).toEqual(['coauthor', 'sibling']);

    // (2) Erroring row is present with its head-meta projection — NOT the
    // cumulative-union override. `authors` falls back to the SQL
    // `authors_with_supersession` field; `accredited_authors` falls back to the
    // head-meta hives intersected with the (empty) live accredited set.
    const erroring = bySlug.get('erroring/boom') as any;
    expect(erroring).toBeDefined();
    expect((erroring.authors as Array<{ hive?: string }>).map((a) => a.hive)).toEqual(['erroring']);
    // No `coauthor` (that only exists on the cumulative path which threw here).
    expect((erroring.authors as Array<{ hive?: string }>).map((a) => a.hive)).not.toContain('coauthor');
    // Live accredited set is empty (no accreditation rows mocked), so the
    // head-meta accredited_authors fallback is empty — it did NOT inherit the
    // cumulative ['sibling','coauthor'] set.
    expect(erroring.accredited_authors).toEqual([]);
  });
});

describe('GET /api/profile/:username/papers — per-row chain-enrichment failure isolation (integrated handler)', () => {
  it('stays 200, erroring row falls back to head-meta, sibling row keeps cumulative-union enrichment', async () => {
    const siblingMeta = buildPaperMeta(['sibling']);
    const erroringMeta = buildPaperMeta(['erroring']);

    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('count(*)::int AS total') && sql.includes('FROM user_papers')) {
        return { rows: [{ total: 2 }] };
      }
      if (sql.includes('FROM user_papers') && sql.includes('ORDER BY')) {
        return {
          rows: [
            {
              author: 'sibling',
              permlink: 'enriched',
              title: 'Sibling Paper',
              body: 'sibling abstract\n\n---\n\nfull text',
              json_metadata: siblingMeta,
              created: '2026-04-28T00:00:00',
              total_rshares: 0,
            },
            {
              author: 'erroring',
              permlink: 'boom',
              title: 'Erroring Paper',
              body: 'erroring abstract\n\n---\n\nfull text',
              json_metadata: erroringMeta,
              created: '2026-04-28T00:00:00',
              total_rshares: 0,
            },
          ],
        };
      }
      return { rows: [] };
    });

    await hafCache.set('chain-authors:sibling:enriched', {
      authors: [
        { hive: 'sibling', name: null, orcid: null, orcid_verified: false, orcid_discrepancy: false },
        { hive: 'coauthor', name: null, orcid: null, orcid_verified: false, orcid_discrepancy: false },
      ],
      accredited_authors: ['sibling', 'coauthor'],
    });

    const realGetOrSet = hafCache.getOrSet.bind(hafCache);
    vi.spyOn(hafCache, 'getOrSet').mockImplementation((key: string, fn: () => Promise<unknown>, ttlMs?: number, stable?: boolean) => {
      if (key === 'chain-authors:erroring:boom') {
        return Promise.reject(new Error('chain walk exploded'));
      }
      return realGetOrSet(key, fn, ttlMs, stable);
    });

    const res = await request(app).get('/api/profile/sibling/papers');

    // (1) 200, not 5xx.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data).toHaveLength(2);

    const bySlug = new Map(res.body.data.map((r: any) => [`${r.author}/${r.permlink}`, r]));

    // (3) Sibling row carries cumulative-union enrichment.
    const sibling = bySlug.get('sibling/enriched') as any;
    expect(sibling).toBeDefined();
    expect((sibling.authors as Array<{ hive?: string }>).map((a) => a.hive).sort()).toEqual(['coauthor', 'sibling']);
    expect((sibling.accredited_authors as string[]).slice().sort()).toEqual(['coauthor', 'sibling']);

    // (2) Erroring row falls back to head-meta authors + head-meta-derived
    // accredited_authors (empty against the empty live accredited set).
    const erroring = bySlug.get('erroring/boom') as any;
    expect(erroring).toBeDefined();
    expect((erroring.authors as Array<{ hive?: string }>).map((a) => a.hive)).toEqual(['erroring']);
    expect((erroring.authors as Array<{ hive?: string }>).map((a) => a.hive)).not.toContain('coauthor');
    expect(erroring.accredited_authors).toEqual([]);
  });
});

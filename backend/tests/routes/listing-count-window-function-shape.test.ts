/**
 * Window-function count+data consolidation canaries for the three listing
 * sites that previously fired a parallel `count(*)` + data query pair:
 *
 *   - GET /api/papers       (`fetchPapersFromHaf` in routes/papers.ts)
 *   - GET /api/search?type=paper  (`searchPapersFromHaf` in routes/search.ts)
 *   - GET /api/search?type=review (`searchReviewsFromHaf` in routes/search.ts)
 *
 * Each site now consolidates total into the data query via the precedent
 * established at `fetchAccreditationsFromHaf`:
 *
 *   SELECT ..., count(*) OVER ()::int AS total
 *   FROM ...
 *   WHERE ...
 *   ORDER BY ... LIMIT $ OFFSET $
 *
 * The route reads total from `dataResult.rows[0]?.total ?? 0`, so the empty-
 * result case (no rows match WHERE) degrades cleanly to 0.
 *
 * Carve-out justification per root CLAUDE.md "Running Tests" → "Carve-out for
 * deterministic edge-case coverage":
 *
 *   (a) Real-path impracticality. The behavior under test is SQL-string
 *       shape (presence of `count(*) OVER ()::int AS total`, absence of a
 *       separate count query) and the route-level total-from-row reading.
 *       Real-HAF tests assert HTTP-level invariants (status, envelope
 *       shape, data-array length) — they cannot observe SQL text or the
 *       per-query count of `pool.query` invocations. A regression that
 *       reintroduced the parallel count query would still pass every
 *       real-HAF spec; this file pins the shape deterministically.
 *
 *       Cryptographic verification is NOT bypassed here — all three routes
 *       are unauthenticated reads with no `verifyHiveSignature` on the
 *       chain. The `MOCK_VERIFY_SIGNATURE` fixture is not used.
 *
 *   (b) Auth middleware. N/A — unauthenticated routes.
 *
 *   (c) Real-path companions. The risk class here is "consolidated count+
 *       data query shape (window function in SELECT, single pool.query
 *       call)". Real-path companions exist at
 *       `backend/tests/routes/papers.test.ts` and
 *       `backend/tests/routes/search.test.ts` for the integrated query
 *       shape (status, envelope, pagination semantics drive `total` to a
 *       non-negative integer matching `meta.total`) — both blocks together
 *       close the contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

beforeEach(async () => {
  hafQueryMock.mockReset().mockResolvedValue({ rows: [] });
  getPoolMock.mockReset().mockReturnValue({ query: hafQueryMock });
  await hafCache.clear();
});

const REVIEWS_BRANCH_SENTINEL = '/* search.reviews.branch */';

describe('GET /api/papers — fetchPapersFromHaf count+data consolidation', () => {
  it('data query emits `count(*) OVER ()::int AS total` and no parallel count query fires', async () => {
    const capturedSqls: string[] = [];
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSqls.push(sql);
      return { rows: [] };
    });
    const res = await request(app).get('/api/papers?limit=1');
    expect(res.status).toBe(200);

    // Discriminator: the listing data query is uniquely identified by the
    // `LEFT(c.body, 300) AS abstract` projection (no other paper-related
    // query carries that fragment).
    const listSqls = capturedSqls.filter((s) => s.includes('LEFT(c.body, 300) AS abstract'));
    // Exactly one data query, no separate count query (the pre-change
    // shape would have produced two queries — a `count(*)::int AS total
    // FROM ${T.comments} c WHERE ${where}` count alongside the data).
    expect(listSqls).toHaveLength(1);
    expect(listSqls[0]).toContain('count(*) OVER ()::int AS total');
    // The pre-change separate count query carried the bare
    // `count(*)::int AS total` projection at the SELECT root, distinct
    // from the window-function form. Pin its absence.
    const separateCountSqls = capturedSqls.filter(
      (s) => /\bcount\(\*\)::int AS total\b/.test(s) && !s.includes('count(*) OVER ()'),
    );
    expect(separateCountSqls).toHaveLength(0);
  });

  it('total degrades to 0 on empty result page (`dataResult.rows[0]?.total ?? 0`)', async () => {
    // No data-query stub → empty rows array → total = undefined ?? 0 = 0.
    const res = await request(app).get('/api/papers?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(0);
    expect(res.body.data).toEqual([]);
  });

  it('total surfaces from `count(*) OVER ()` value carried on the first data row', async () => {
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('LEFT(c.body, 300) AS abstract')) {
        return {
          rows: [{
            author: 'alice',
            permlink: 'p-1',
            title: 'T',
            abstract: 'a',
            json_metadata: {
              app: `${config.appTag}/test`,
              [config.appTag]: { type: 'paper', authors: [{ name: 'Alice', hive: 'alice' }] },
            },
            created: '2026-04-01T00:00:00Z',
            net_votes: 0,
            review_count: 0,
            citation_count: 0,
            avg_rating: 0,
            authors_with_supersession: [],
            author_reputation: 0,
            total: 42,
          }],
        };
      }
      return { rows: [] };
    });
    const res = await request(app).get('/api/papers?limit=1');
    expect(res.status).toBe(200);
    // Window-function total flows through to meta.total.
    expect(res.body.meta.total).toBe(42);
    // The data row itself does not leak the `total` field through — the
    // explicit literal-object construction in the row map only copies
    // the named PaperSummary fields.
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).not.toHaveProperty('total');
  });
});

describe('GET /api/search?type=paper — searchPapersFromHaf count+data consolidation', () => {
  it('data query emits `count(*) OVER ()::int AS total` and no parallel count query fires', async () => {
    const capturedSqls: string[] = [];
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSqls.push(sql);
      return { rows: [] };
    });
    const res = await request(app).get('/api/search?q=physics&type=paper');
    expect(res.status).toBe(200);

    // Discriminator: the papers-search data query is the only papers-search
    // query, and it carries `->> 'type') AS type,` as the first SELECT column.
    const papersSearchSqls = capturedSqls.filter(
      (s) => s.includes("->> 'type') AS type,") && !s.includes(REVIEWS_BRANCH_SENTINEL),
    );
    expect(papersSearchSqls).toHaveLength(1);
    expect(papersSearchSqls[0]).toContain('count(*) OVER ()::int AS total');
    // No pre-change separate count query.
    const separateCountSqls = capturedSqls.filter(
      (s) => /\bcount\(\*\)::int AS total\b/.test(s) && !s.includes('count(*) OVER ()'),
    );
    expect(separateCountSqls).toHaveLength(0);
  });

  it('total degrades to 0 on empty result page', async () => {
    const res = await request(app).get('/api/search?q=physics&type=paper');
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(0);
    expect(res.body.data).toEqual([]);
  });

  it('total surfaces from window-function value on the first data row', async () => {
    hafQueryMock.mockImplementation(async (sql: string) => {
      // Papers-search data query: distinguishable by the `AS type,` SELECT
      // column and the absence of the reviews-branch sentinel.
      if (sql.includes("->> 'type') AS type,") && !sql.includes(REVIEWS_BRANCH_SENTINEL)) {
        return {
          rows: [{
            type: 'paper',
            author: 'alice',
            permlink: 'p-1',
            title: 'Physics Paper',
            snippet: 'snippet',
            created: '2026-04-01T00:00:00Z',
            total: 7,
          }],
        };
      }
      return { rows: [] };
    });
    const res = await request(app).get('/api/search?q=physics&type=paper');
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(7);
    // `total` does not leak through the row mapping.
    expect(res.body.data[0]).not.toHaveProperty('total');
  });
});

describe('GET /api/search?type=review — searchReviewsFromHaf count+data consolidation', () => {
  it('data query emits `count(*) OVER ()::int AS total` and no parallel count query fires', async () => {
    const capturedSqls: string[] = [];
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSqls.push(sql);
      return { rows: [] };
    });
    const res = await request(app).get('/api/search?q=method&type=review');
    expect(res.status).toBe(200);

    // Discriminator: the per-branch sentinel SQL comment.
    const reviewsBranchSqls = capturedSqls.filter((s) => s.includes(REVIEWS_BRANCH_SENTINEL));
    expect(reviewsBranchSqls).toHaveLength(1);
    expect(reviewsBranchSqls[0]).toContain('count(*) OVER ()::int AS total');
    const separateCountSqls = capturedSqls.filter(
      (s) => /\bcount\(\*\)::int AS total\b/.test(s) && !s.includes('count(*) OVER ()'),
    );
    expect(separateCountSqls).toHaveLength(0);
  });

  it('total degrades to 0 on empty result page', async () => {
    const res = await request(app).get('/api/search?q=method&type=review');
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(0);
    expect(res.body.data).toEqual([]);
  });

  it('total surfaces from window-function value on the first data row', async () => {
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes(REVIEWS_BRANCH_SENTINEL)) {
        return {
          rows: [{
            author: 'reviewer',
            permlink: 'r-1',
            snippet: 'reviewer body',
            created: '2026-04-01T00:00:00Z',
            paper_author: 'alice',
            paper_permlink: 'p-1',
            total: 3,
          }],
        };
      }
      return { rows: [] };
    });
    const res = await request(app).get('/api/search?q=method&type=review');
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(3);
    expect(res.body.data[0]).not.toHaveProperty('total');
  });
});


/**
 * BE-SEARCH-PARTIAL-DEGRADATION-ALLSETTLED — deterministic canaries for the
 * `Promise.allSettled` partial-degradation branch in `searchFromHaf`'s
 * `type=all` path.
 *
 * Justification for mocked `getPool()` (per root CLAUDE.md "Carve-out for
 * deterministic edge-case coverage"):
 *
 *   (a) Real path that's impractical: inducing a one-branch HAF failure (e.g.
 *       a `statement_timeout` on only the papers query OR only the reviews
 *       query, with the other branch succeeding) against a real Postgres
 *       requires per-statement timeouts plus a controlled rogue-query
 *       fixture, which the live HAF corpus does not provide. The behavior
 *       under test is the JS-level discrimination between fulfilled and
 *       rejected branches of `Promise.allSettled` and the structured
 *       `search.type_all.partial_degradation` event emission — both live in
 *       the route handler, NOT in the SQL planner. Mocking `pool.query` to
 *       discriminate by SQL substring lets each test exercise exactly one
 *       branch failure and assert the surviving branch flows through with a
 *       warn event.
 *
 *   (b) `verifyHiveSignature` and other auth/permission middleware are NOT
 *       mocked — `/api/search` is an unauthenticated route with no signature
 *       verification on the path. There is no cryptographic verification to
 *       bypass; the carve-out's "auth-focused" exclusion does not apply.
 *
 *   (c) Real-path companion: `backend/tests/routes/search.test.ts` exercises
 *       the integrated `?type=all` path implicitly via the no-type-param
 *       default-type coverage (the route handler treats omitted `?type=` as
 *       `'all'`, so every `/api/search?q=...` happy-path spec without an
 *       explicit `?type=` is exercising the both-branches-succeed merge code
 *       path end-to-end against real HAF — results merge by date, envelope
 *       shape is correct, pagination caps apply, accreditation gate holds).
 *       Risk class covered there: "SQL-shape or accreditation-gate mutation
 *       breaks the integrated query" — orthogonal to this file's "JS-level
 *       allSettled discrimination + structured event emission" risk class.
 *       The two risk classes are independently mutable; each needs its own
 *       pinning test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { hafQueryMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  getPool: () => ({ query: hafQueryMock, connect: () => Promise.reject(new Error('not used')) }),
  isHafConfigured: () => true,
  closeHafPool: async () => {},
}));

vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
}));

vi.mock('../../src/accreditation.js', () => ({
  getAccreditedSet: async (_usernames: string[]) => new Set<string>(),
}));

const { createApp } = await import('../../src/app.js');
const { hafCache } = await import('../../src/cache.js');
const { logger } = await import('../../src/logger.js');
const request = (await import('supertest')).default;

const app = createApp();

// SQL discriminator: `searchReviewsFromHaf` prefixes both of its queries
// (count + data) with a per-branch sentinel SQL comment
// `/* search.reviews.branch */`. The papers branch never emits this
// sentinel. Matching against the sentinel is robust against alias renames
// or JOIN restructuring (the prior ` p ON ` substring was brittle: a
// future rename of alias `p` to `parent`, or the papers branch acquiring
// a coincidental ` p ON ` would silently misroute). The sentinel lives
// in production code at `backend/src/routes/search.ts` inside
// `searchReviewsFromHaf`'s two `pool.query` calls; grep `branchSentinel`
// there to verify.
const REVIEWS_BRANCH_SENTINEL = '/* search.reviews.branch */';
function isReviewsBranchSql(sql: string): boolean {
  return sql.includes(REVIEWS_BRANCH_SENTINEL);
}

interface MockQueryResult {
  rows: Record<string, unknown>[];
}

/**
 * Synthetic surviving-branch row for the reviews branch. Shape matches the
 * dataResult mapping inside `searchReviewsFromHaf` (`author`, `permlink`,
 * `snippet`, `created`, `paper_author`, `paper_permlink`). The route's
 * `type` field is hard-coded to `'review'` by the helper, not derived
 * from the row.
 */
const SYNTHETIC_REVIEW_ROW = {
  author: 'fixture-reviewer',
  permlink: 'fixture-review-1',
  snippet: 'fixture review body',
  created: '2026-05-16T00:00:00Z',
  paper_author: 'fixture-paper-author',
  paper_permlink: 'fixture-paper-1',
};

/**
 * Synthetic surviving-branch row for the papers branch. Shape matches the
 * dataResult mapping inside `searchPapersFromHaf` (`type`, `author`,
 * `permlink`, `title`, `snippet`, `created`). The helper passes the row's
 * `type` through verbatim from the `json_metadata.app_tag_obj.type` SELECT
 * expression; native PEvO papers stamp `paper`.
 */
const SYNTHETIC_PAPER_ROW = {
  type: 'paper',
  author: 'fixture-author',
  permlink: 'fixture-paper-1',
  title: 'fixture paper title',
  snippet: 'fixture paper snippet',
  created: '2026-05-16T00:00:00Z',
};

/**
 * Configure `hafQueryMock` so the papers branch throws and the reviews
 * branch returns ONE synthetic row (count = 1, data = 1 row). The route
 * should return reviews-only results with `data.length === 1` AND emit
 * `search.type_all.partial_degradation` with `branch: 'papers'`. The
 * synthetic-row return pins the surviving-branch data-flow: a regression
 * that swapped `paperResult?.rows ?? []` for an unconditional `[]` (i.e.
 * dropping the merge step) would pass the warn-event assertion but fail
 * the `data.length === 1` assertion.
 */
function mockPapersBranchThrows(): void {
  hafQueryMock.mockImplementation((sql: string): Promise<MockQueryResult> => {
    if (isReviewsBranchSql(sql)) {
      if (/count\(\*\)/.test(sql)) {
        return Promise.resolve({ rows: [{ total: 1 }] });
      }
      return Promise.resolve({ rows: [SYNTHETIC_REVIEW_ROW] });
    }
    // Papers branch: throw a recognizable error class.
    return Promise.reject(new Error('simulated HAF papers-branch failure'));
  });
}

/**
 * Mirror of `mockPapersBranchThrows` for the reviews branch. Reviews
 * throws; papers returns ONE synthetic row.
 */
function mockReviewsBranchThrows(): void {
  hafQueryMock.mockImplementation((sql: string): Promise<MockQueryResult> => {
    if (isReviewsBranchSql(sql)) {
      return Promise.reject(new Error('simulated HAF reviews-branch failure'));
    }
    if (/count\(\*\)/.test(sql)) {
      return Promise.resolve({ rows: [{ total: 1 }] });
    }
    return Promise.resolve({ rows: [SYNTHETIC_PAPER_ROW] });
  });
}

/**
 * Both branches throw — regression guard. Route should still return 200
 * empty (no escape of the throw to the outer handler).
 */
function mockBothBranchesThrow(): void {
  hafQueryMock.mockImplementation((sql: string): Promise<MockQueryResult> =>
    Promise.reject(new Error(`simulated HAF total-failure (${isReviewsBranchSql(sql) ? 'reviews' : 'papers'})`)),
  );
}

describe('GET /api/search?type=all partial degradation (allSettled)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await hafCache.clear();
    hafQueryMock.mockReset();
    warnSpy = vi.spyOn(logger, 'warn');
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('reviews-branch throws → 200 with papers-only results + warn event fires', async () => {
    mockReviewsBranchThrows();
    const res = await request(app).get('/api/search?q=science&type=all');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.data)).toBe(true);
    // Surviving-branch data-flow assertion: the papers branch returned ONE
    // synthetic row, which must flow through `paperResult?.rows ?? []` into
    // the merged `allRows` and out as `res.body.data`. A regression that
    // swapped the merge for an unconditional `[]` would fail here.
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].type).toBe('paper');
    expect(res.body.data[0].author).toBe(SYNTHETIC_PAPER_ROW.author);
    const warnCalls = warnSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event?: string })?.event === 'search.type_all.partial_degradation',
    );
    expect(warnCalls.length).toBe(1);
    const payload = warnCalls[0][0] as { branch: string; errClass: string };
    expect(payload.branch).toBe('reviews');
    expect(payload.errClass).toBe('Error');
  });

  it('papers-branch throws → 200 with reviews-only results + warn event fires', async () => {
    mockPapersBranchThrows();
    const res = await request(app).get('/api/search?q=science&type=all');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.data)).toBe(true);
    // Surviving-branch data-flow assertion (mirror): the reviews branch
    // returned ONE synthetic row; the helper hard-codes `type: 'review'`.
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].type).toBe('review');
    expect(res.body.data[0].author).toBe(SYNTHETIC_REVIEW_ROW.author);
    const warnCalls = warnSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event?: string })?.event === 'search.type_all.partial_degradation',
    );
    expect(warnCalls.length).toBe(1);
    const payload = warnCalls[0][0] as { branch: string; errClass: string };
    expect(payload.branch).toBe('papers');
    expect(payload.errClass).toBe('Error');
  });

  it('both branches throw → 200 empty + two warn events (regression guard for outer-catch collapse)', async () => {
    mockBothBranchesThrow();
    const res = await request(app).get('/api/search?q=science&type=all');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
    // Both branches log their own partial_degradation event. Two events,
    // one per branch, with the branch discriminator set.
    const warnCalls = warnSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event?: string })?.event === 'search.type_all.partial_degradation',
    );
    expect(warnCalls.length).toBe(2);
    const branches = warnCalls.map((c: unknown[]) => (c[0] as { branch: string }).branch).sort();
    expect(branches).toEqual(['papers', 'reviews']);
  });

  // Pin: every user-filter field of the route's `queryParams` warn payload
  // (type, discipline, language, source, includeRetracted, sort). Pagination
  // fields (limit, offset) are present in the production payload but out of
  // scope for this canary — they are pagination internals, not user filters,
  // and a future refactor splitting them out is not the "new filter not
  // threaded" regression class this canary is meant to catch.
  it('warn event payload includes queryParams with the request filters', async () => {
    mockReviewsBranchThrows();
    const res = await request(app)
      .get('/api/search?q=science&type=all&discipline=physics&language=en&sort=date');
    expect(res.status).toBe(200);
    const warnCalls = warnSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event?: string })?.event === 'search.type_all.partial_degradation',
    );
    expect(warnCalls.length).toBe(1);
    const payload = warnCalls[0][0] as {
      queryParams: {
        type: string;
        discipline: string | undefined;
        language: string | undefined;
        source: string | undefined;
        includeRetracted: boolean;
        sort: string;
      };
    };
    expect(payload.queryParams.type).toBe('all');
    expect(payload.queryParams.discipline).toBe('physics');
    expect(payload.queryParams.language).toBe('en');
    expect(payload.queryParams.sort).toBe('date');
    // `?source=` and `?include_retracted=` were omitted from the request:
    // source defaults to undefined, includeRetracted defaults to false.
    // Pinning both closes the "new filter added but not threaded" gap.
    expect(payload.queryParams.source).toBeUndefined();
    expect(payload.queryParams.includeRetracted).toBe(false);
  });
});

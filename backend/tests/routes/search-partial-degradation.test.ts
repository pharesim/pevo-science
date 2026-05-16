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
 *       the integrated `?type=all` path end-to-end against real HAF for the
 *       happy-path case (both branches succeed, results merge by date, the
 *       envelope shape is correct, pagination caps apply, accreditation gate
 *       holds). Risk class covered there: "SQL-shape or accreditation-gate
 *       mutation breaks the integrated query" — orthogonal to this file's
 *       "JS-level allSettled discrimination + structured event emission"
 *       risk class. The two risk classes are independently mutable; each
 *       needs its own pinning test.
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

// SQL discriminator: the reviews branch JOINs a parent comments row aliased
// `p` (`JOIN ${T.comments} p ON ...`); the papers branch never JOINs. The
// substring ` p ON ` is present in every reviews-branch SQL string and
// absent from every papers-branch SQL string at runtime. The discriminator
// is structural (driven by the rendered SQL the route actually executes),
// not a brittle string match against a comment or alias name.
function isReviewsBranchSql(sql: string): boolean {
  return / p ON /.test(sql);
}

interface MockQueryResult {
  rows: Record<string, unknown>[];
}

/**
 * Configure `hafQueryMock` so the papers branch throws and the reviews
 * branch returns empty rows (count + data both empty). The route should
 * return reviews-only results (an empty array, since the mock returns no
 * review rows) AND emit `search.type_all.partial_degradation` with
 * `branch: 'papers'`.
 */
function mockPapersBranchThrows(): void {
  hafQueryMock.mockImplementation((sql: string): Promise<MockQueryResult> => {
    if (isReviewsBranchSql(sql)) {
      // Reviews branch: return empty count + empty rows. The count query
      // fires first and shapes its row as `{ total: 0 }`; the data query
      // returns `rows: []`. Discriminate by checking for `count(*)` in SQL.
      if (/count\(\*\)/.test(sql)) {
        return Promise.resolve({ rows: [{ total: 0 }] });
      }
      return Promise.resolve({ rows: [] });
    }
    // Papers branch: throw a recognizable error class.
    return Promise.reject(new Error('simulated HAF papers-branch failure'));
  });
}

/**
 * Mirror of `mockPapersBranchThrows` for the reviews branch.
 */
function mockReviewsBranchThrows(): void {
  hafQueryMock.mockImplementation((sql: string): Promise<MockQueryResult> => {
    if (isReviewsBranchSql(sql)) {
      return Promise.reject(new Error('simulated HAF reviews-branch failure'));
    }
    if (/count\(\*\)/.test(sql)) {
      return Promise.resolve({ rows: [{ total: 0 }] });
    }
    return Promise.resolve({ rows: [] });
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
    // Papers branch returned empty rows in the mock, so data is empty.
    // The load-bearing assertion is that the request completes (no 500/empty
    // collapse via outer catch) AND the structured warn fires for the
    // failed branch.
    const warnCalls = warnSpy.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === 'search.type_all.partial_degradation',
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
    const warnCalls = warnSpy.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === 'search.type_all.partial_degradation',
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
      (c) => (c[0] as { event?: string })?.event === 'search.type_all.partial_degradation',
    );
    expect(warnCalls.length).toBe(2);
    const branches = warnCalls.map((c) => (c[0] as { branch: string }).branch).sort();
    expect(branches).toEqual(['papers', 'reviews']);
  });

  // Pins the queryParams payload shape on the warn event so future filter
  // additions get visibility in operator dashboards. If a new filter param
  // is added to the route but not threaded into the warn event, this spec
  // fails first.
  it('warn event payload includes queryParams with the request filters', async () => {
    mockReviewsBranchThrows();
    const res = await request(app)
      .get('/api/search?q=science&type=all&discipline=physics&language=en&sort=date');
    expect(res.status).toBe(200);
    const warnCalls = warnSpy.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === 'search.type_all.partial_degradation',
    );
    expect(warnCalls.length).toBe(1);
    const payload = warnCalls[0][0] as {
      queryParams: { type: string; discipline: string | undefined; language: string | undefined; sort: string };
    };
    expect(payload.queryParams.type).toBe('all');
    expect(payload.queryParams.discipline).toBe('physics');
    expect(payload.queryParams.language).toBe('en');
    expect(payload.queryParams.sort).toBe('date');
  });
});

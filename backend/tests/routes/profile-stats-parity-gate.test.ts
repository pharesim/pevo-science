/**
 * Mocked-pool SQL-shape canary for `getProfileStats` user_reviews CTE gates.
 *
 * Per CLAUDE.md "Running Tests" carve-out clauses (a)/(b)/(c):
 *   (a) Real-corpus seeding is impractical: the defended failure modes are
 *       (1) an unaccredited author with valid-rating review-shaped replies
 *       being counted in `review_count` (cross-surface parity gap), and
 *       (2) an accredited reviewer's pevo.review-shaped reply to a non-paper
 *       Hive post being counted (display↔reputation parity gap — reputation
 *       already excludes via the user_reviews CTE that composes
 *       validPevoPaperWhere). The public HAF database cannot be
 *       deterministically seeded with these (author × parent-shape)
 *       combinations at test time.
 *   (b) `verifyHiveSignature` is NOT mocked — the `/api/profile/:username`
 *       route is a public GET (no middleware to short-circuit).
 *   (c) Real-path companion: SQL-shape composition is exercised against real
 *       HAF at sibling review-class SQL sites:
 *         - `paper_reviews` / `user_reviews` CTEs in
 *           `reputation-lifecycle.test.ts`,
 *         - `fetchUserReviewsFromHaf` SQL-shape in
 *           `profile-reviews-accred-gate.test.ts` (mocked) +
 *           `review-parity-invariant.test.ts` (real-HAF & synthetic-VALUES).
 *       A different mutation class at the SAME helper family
 *       (`validPevoPaperWhere`, accreditation-gate predicate) is caught by
 *       those tests, satisfying clause-(c)'s "same risk class covered by a
 *       real-path test elsewhere" requirement. Literal-route real-HAF
 *       coverage for `/api/profile/:user` stats remains a follow-up — the
 *       behavioral spec in `stats-profile-parity.test.ts` already pins
 *       stats↔profile-listing parity at the envelope level.
 *
 * Canaries pinned in this file:
 *   1. The `user_reviews` CTE carries the accreditation gate
 *      `(c.author IN (SELECT account FROM active_accreditations) OR
 *      c.author = $N)`. Reverting silently re-admits unaccredited spam into
 *      the visible `review_count`.
 *   2. The `user_reviews` CTE also carries the parent-paper
 *      `validPevoPaperWhere(source:'all')` gate — pinned via the `'paper'`
 *      and `'bridge_paper'` substrings emitted by the source:'all' arm of
 *      the helper. Reverting silently breaks display↔reputation parity at
 *      the actively-visible `/api/profile/:user` stats surface.
 *
 * Mutation kill: dropping the accreditation gate substring OR dropping the
 * validPevoPaperWhere paper-class substrings from the emitted SQL fails the
 * assertions below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async () => ({ rows: [] })),
  getPoolMock: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  getPool: getPoolMock,
  isHafConfigured: () => getPoolMock() !== null,
  closeHafPool: async () => { /* no-op */ },
}));

// Stub hive client so the route's getAccounts() call resolves with a valid
// account shape (otherwise the route 404s before getProfileStats runs and the
// query mock never observes the stats SQL).
vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: {
      getAccounts: async () => [{ name: 'someuser' }],
    },
  },
}));

// Stub accreditation lookup so the profile route treats the user as
// accredited and proceeds to call getProfileStats (the SUT here).
vi.mock('../../src/accreditation.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/accreditation.js')>('../../src/accreditation.js');
  return {
    ...actual,
    getAccreditedSet: async () => new Set(['someuser']),
    getAllAccreditedAccounts: async () => new Set(['someuser']),
  };
});

// Stub reputation so the parallel branch resolves without touching real SQL.
vi.mock('../../src/reputation.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/reputation.js')>('../../src/reputation.js');
  return {
    ...actual,
    getReputationScore: async () => ({
      score: 0,
      breakdown: { papers: 0, reviews: 0, citations: 0, accreditation: 0 },
    }),
  };
});

const { createApp } = await import('../../src/app.js');
const { hafCache } = await import('../../src/cache.js');
const app = createApp();

// Default mock impl returns a positive accreditation row for the accreditation
// query and empty rows for everything else. Tests below override to capture
// the stats SQL, but must preserve this branch so the route doesn't return the
// unaccredited zero-stats shape (which short-circuits before getProfileStats
// runs and would never surface the stats SQL we need to assert against).
function defaultHafImpl(sql: string) {
  if (sql.includes('cj.custom_id') && sql.includes('json::jsonb')) {
    return {
      rows: [{
        json: JSON.stringify({
          action: 'accredit',
          account: 'someuser',
          name: 'Some User',
          institution: 'Test U',
          field: 'Test Field',
          method: 'email',
          timestamp: '2026-01-01T00:00:00.000Z',
        }),
        event_id: 'evt1',
      }],
    };
  }
  return { rows: [] };
}

beforeEach(async () => {
  hafQueryMock.mockReset().mockImplementation(async (sql: string) => defaultHafImpl(sql));
  getPoolMock.mockReset().mockReturnValue({ query: hafQueryMock });
  await hafCache.clear();
});

describe('GET /api/profile/:username — getProfileStats user_reviews CTE gates', () => {
  const accredGateSubstring = 'IN (SELECT account FROM active_accreditations)';
  const anonOrArmSubstring = 'OR c.author =';
  // validPevoPaperWhere({source:'all'}) emits BOTH the native arm
  // (`'paper'`) and the bridge arm (`'bridge_paper'`).
  const nativePaperSubstring = "= 'paper'";
  const bridgePaperSubstring = "= 'bridge_paper'";

  function profileStatsSql(captured: string[]): string | undefined {
    // The stats query is the one carrying the `user_reviews` CTE.
    return captured.find((s) => s.includes('user_reviews AS'));
  }

  it('user_reviews CTE composes accred-OR-anon gate (mutation-kill)', async () => {
    const capturedSqls: string[] = [];
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSqls.push(sql);
      return defaultHafImpl(sql);
    });
    const res = await request(app).get('/api/profile/someuser');
    expect(res.status).toBe(200);
    const statsSql = profileStatsSql(capturedSqls);
    expect(statsSql, 'getProfileStats SQL not observed').toBeDefined();
    // Round-1 hold #2 risk class on the stats surface: reverting the gate
    // silently re-admits unaccredited review-shaped replies into the
    // visible `review_count`.
    expect(statsSql!).toContain(accredGateSubstring);
    expect(statsSql!).toContain(anonOrArmSubstring);
  });

  it('user_reviews CTE composes validPevoPaperWhere on parent paper (mutation-kill)', async () => {
    // Round-3 hold #1 risk class on the stats surface: reverting silently
    // re-admits review-shaped replies to non-paper Hive parents into
    // `review_count` while reputation correctly excludes them via the
    // sibling user_reviews CTE gate.
    const capturedSqls: string[] = [];
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSqls.push(sql);
      return defaultHafImpl(sql);
    });
    const res = await request(app).get('/api/profile/someuser');
    expect(res.status).toBe(200);
    const statsSql = profileStatsSql(capturedSqls);
    expect(statsSql).toBeDefined();
    expect(statsSql!, 'stats SQL missing native-paper arm').toContain(nativePaperSubstring);
    expect(statsSql!, 'stats SQL missing bridge_paper arm — validPevoPaperWhere source:"all" requires both').toContain(bridgePaperSubstring);
  });
});

/**
 * Mocked-pool coverage for /api/profile/:username/reviews SQL-shape gates.
 *
 * Per CLAUDE.md "Running Tests" carve-out clauses (a)/(b)/(c):
 *   (a) Real-corpus seeding is impractical: the defended failure modes are
 *       an unaccredited Hive account writing valid-rating review-shaped
 *       replies to accredited authors' papers (round-1 hold #2 spam vector),
 *       and an accredited reviewer writing a pevo.review-shaped reply to a
 *       non-paper Hive post (round-3 hold #1 display↔reputation parity
 *       break). The public HAF database cannot be deterministically seeded
 *       with these author × parent-shape combinations at test time.
 *   (b) `verifyHiveSignature` is NOT mocked — the route is a public GET
 *       (no middleware to short-circuit).
 *   (c) Real-path companion: this file is the load-bearing coverage for
 *       `/api/profile/:user/reviews` SQL-shape gates — no real-HAF
 *       integration test exercises that specific route end-to-end. The
 *       carve-out clause-(c) companion is structural: the gate
 *       composition pattern (accred-OR-anon gate + validPevoPaperWhere
 *       parent-paper gate) is exercised against real HAF at sibling
 *       review-class SQL sites (the `user_reviews` CTE in
 *       reputation-lifecycle.test.ts, the paper-detail review list in
 *       papers.test.ts, the review-search arm in search.test.ts). A
 *       different mutation class at the SAME helper/CTE family is caught
 *       by those tests, satisfying clause-(c)'s "same risk class covered
 *       by a real-path test elsewhere" requirement (see
 *       `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`).
 *       Literal-route real-HAF coverage for `/api/profile/:user/reviews`
 *       remains a follow-up.
 *
 * Canaries pinned in this file:
 *   1. Both the count query and the data query carry the accreditation
 *      gate `(c.author IN (SELECT account FROM active_accreditations) OR
 *      c.author = $N)` (round-1 hold #2 fix). Reverting either of the two
 *      composition sites silently re-opens the spam vector.
 *   2. Both queries also carry the parent-paper validPevoPaperWhere gate
 *      (round-3 hold #1 fix) — pinned via the `'paper'` and `'bridge_paper'`
 *      substrings emitted by the `source:'all'` arm of the helper. Reverting
 *      either gate silently breaks display↔reputation parity (reputation
 *      already composes this gate at user_reviews CTE; this site closed the
 *      symmetric display surface).
 *   3. The canonical $N counter pattern (round-2 hold #1 fix) — both
 *      queries reach the gates with consistently-numbered params.
 *   4. Envelope shape: a request for an unaccredited user's reviews
 *      returns `data: []` with `total: 0` when the responder simulates the
 *      gate via the bound author param. NOTE (round-3 hold #6): this test
 *      pins envelope handling on the empty result set, NOT gate enforcement
 *      at the SQL level — the actual gate mutation-kill is the SQL-shape
 *      canary above. Removing the accreditation gate from
 *      `fetchUserReviewsFromHaf` would not change this behavioral test's
 *      outcome because the mock returns empty regardless of what SQL is
 *      emitted.
 *
 * Mutation kill: dropping the accreditation gate substring from either the
 * count or data query, OR dropping the validPevoPaperWhere paper-class
 * substrings from either query, fails the SQL-shape assertions below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
const { buildWith, activeAccreditationsCteBody, authorshipClaimsCteBody } = await import('../../src/hafsql.js');
const app = createApp();

// The reviews handler composes its WITH block from
//   buildWith(1, activeAccreditationsCteBody, (idx) => authorshipClaimsCteBody(idx, { claimer }))
// and binds the per-query params after it via an adaptive paramIdx counter:
//   [...accredCte.params, username, appTag, anonAccount, bridge, limit, offset, ...].
// So the username slot is accredCte.params.length (0-indexed) and the anonAccount
// slot is accredCte.params.length + 2. Derive both from the LIVE builder param
// count rather than a frozen $N table, so a future CTE-shape change shifts the pin
// in step instead of silently re-staling it (the prior fixed params[3]/params[5]
// went tautological when the reviews CTE grew from 2 to 7 params).
const accredParamCount = buildWith(1, activeAccreditationsCteBody, (idx) => authorshipClaimsCteBody(idx, { claimer: 'probe' })).params.length;
const USERNAME_SLOT = accredParamCount;
const ANON_SLOT = accredParamCount + 2;

beforeEach(async () => {
  hafQueryMock.mockReset().mockResolvedValue({ rows: [] });
  getPoolMock.mockReset().mockReturnValue({ query: hafQueryMock });
  await hafCache.clear();
});

describe('GET /api/profile/:username/reviews — SQL-shape gates (accred + parent-paper)', () => {
  const accredGateSubstring = 'IN (SELECT account FROM active_accreditations)';
  // The route's data query also accepts the anon-proxy account in an OR-arm
  // matching the display-side composition (anon reviews surface for the
  // owning anon-mapping user, not as a generic spam channel).
  const anonOrArmSubstring = 'OR c.author =';
  // validPevoPaperWhere({source:'all'}) emits BOTH the native arm
  // (`'paper'`) and the bridge arm (`'bridge_paper'`) joined by OR. Both
  // substrings together pin that this route is using the source:'all' shape
  // (vs source:'native' which would omit `'bridge_paper'`).
  const nativePaperSubstring = "= 'paper'";
  const bridgePaperSubstring = "= 'bridge_paper'";

  it('count query and data query both compose the accred-OR-anon gate (mutation-kill)', async () => {
    const capturedSqls: string[] = [];
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSqls.push(sql);
      // Count query returns total=0; data query returns no rows.
      if (sql.includes('count(*)')) return { rows: [{ total: 0 }] };
      return { rows: [] };
    });
    const res = await request(app).get('/api/profile/unaccredited-spammer/reviews');
    expect(res.status).toBe(200);
    // Both queries must have been emitted (count + data).
    expect(capturedSqls.length).toBeGreaterThanOrEqual(2);
    // Each emitted SQL must compose the gate. Reverting either composition
    // site (count or data) drops the substring from that emit and fires red.
    for (const sql of capturedSqls) {
      expect(sql).toContain(accredGateSubstring);
      expect(sql).toContain(anonOrArmSubstring);
    }
  });

  it('count query and data query both compose validPevoPaperWhere on parent paper (mutation-kill)', async () => {
    // Round-3 hold #1: parent-paper class gate is the load-bearing
    // display↔reputation parity fix. Reverting either site silently
    // re-admits review-shaped replies to non-paper Hive posts (peakd blog
    // posts, non-paper comments) with paper_title='' while reputation
    // correctly excludes them via the sibling user_reviews CTE gate.
    const capturedSqls: string[] = [];
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSqls.push(sql);
      if (sql.includes('count(*)')) return { rows: [{ total: 0 }] };
      return { rows: [] };
    });
    const res = await request(app).get('/api/profile/unaccredited-spammer/reviews');
    expect(res.status).toBe(200);
    expect(capturedSqls.length).toBeGreaterThanOrEqual(2);
    for (const sql of capturedSqls) {
      expect(sql, 'count or data query missing native-paper arm').toContain(nativePaperSubstring);
      expect(sql, 'count or data query missing bridge_paper arm — validPevoPaperWhere source:"all" requires both').toContain(bridgePaperSubstring);
    }
  });

  it('envelope shape: empty data and zero total when responder simulates an unaccredited author', async () => {
    // Round-3 hold #6 accurate scope: this test pins envelope handling on
    // the empty result set, NOT gate enforcement at the SQL level. The
    // mock makes the admission decision in JavaScript by inspecting bound
    // params; removing the accred gate from fetchUserReviewsFromHaf would
    // NOT change this test's outcome because the responder returns empty
    // regardless of what SQL is emitted. The SQL-shape canaries above are
    // the actual gate mutation-kills.
    //
    // The username / anonAccount slots are derived from the live builder param
    // count (USERNAME_SLOT / ANON_SLOT above), so this pin tracks the current
    // buildWith(1, activeAccreditationsCteBody, authorshipClaimsCteBody{claimer})
    // composition. We VALUE-pin the slots (not just typeof) so a positional
    // mis-bind fails red: a shift would land a CTE param / appTag / limit at the
    // username slot, whose value is not the requested username. Capture the bound
    // values in outer-scope arrays and assert in test scope AFTER the request — an
    // expect-throw inside the mock callback would propagate into the route's
    // `try { ... } catch { return null; }` at fetchUserReviewsFromHaf and be
    // swallowed, masking the mutation.
    const REQUESTED_USER = 'unaccredited-spammer';
    const expectedAnon = config.hiveAnonAccount || '';
    const accreditedAuthors = new Set<string>(); // empty: nobody is accredited
    const capturedAuthors: unknown[] = [];
    const capturedAnons: unknown[] = [];
    hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      const rawAuthor = params?.[USERNAME_SLOT];
      const rawAnon = params?.[ANON_SLOT];
      capturedAuthors.push(rawAuthor);
      capturedAnons.push(rawAnon);
      const author = rawAuthor as string;
      const anonAccount = rawAnon as string;
      const admitted = accreditedAuthors.has(author) || (author !== '' && author === anonAccount);
      if (sql.includes('count(*)')) {
        return { rows: [{ total: admitted ? 1 : 0 }] };
      }
      // Data query: empty when not admitted.
      return { rows: admitted ? [{ author, permlink: 'r1', body: '', json_metadata: {}, created: '2026-01-01T00:00:00.000Z', parent_author: 'someone', parent_permlink: 'p', paper_title: '', net_votes: 0 }] : [] };
    });
    const res = await request(app).get(`/api/profile/${REQUESTED_USER}/reviews`);
    // Outer-scope value pins: every emitted query must have bound the requested
    // username at USERNAME_SLOT and the anon account at ANON_SLOT. A positional
    // mis-bind lands a different value there and fails red. Asserting here (not in
    // the mock) bypasses the route's try/catch swallow.
    expect(capturedAuthors.length).toBeGreaterThan(0);
    for (const v of capturedAuthors) expect(v).toBe(REQUESTED_USER);
    for (const v of capturedAnons) expect(v).toBe(expectedAnon);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data).toEqual([]);
    expect(res.body.meta?.total).toBe(0);
  });
});

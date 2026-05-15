/**
 * Mocked-pool SQL-shape canary for `fetchEnrichmentFromHaf` parent-paper gate.
 *
 * Per CLAUDE.md "Running Tests" carve-out clauses (a)/(b)/(c):
 *   (a) Real-corpus seeding is impractical: the defended failure mode is the
 *       enrichment endpoint addressing an arbitrary (author, permlink) pair
 *       that isn't a PEvO paper-class post (peakd blog, non-paper comment).
 *       The route reaches `fetchEnrichmentFromHaf` directly without the
 *       upstream paper-class gate that `fetchPaperFromHaf` provides, so the
 *       JOIN-side `p` row admission must be gated here. Provoking this
 *       deterministically against the real HAF DB requires writing such a
 *       pair plus a review-shaped reply to HAF.
 *   (b) `verifyHiveSignature` is NOT mocked — the route is a public GET.
 *   (c) Real-path companion: SQL-shape composition is exercised against real
 *       HAF at sibling review-class SQL sites via
 *       `review-parity-invariant.test.ts` (real-HAF + synthetic-VALUES) and
 *       `reputation-lifecycle.test.ts`. The same risk class (display-side
 *       parent-paper class admission) is caught by those tests, satisfying
 *       clause-(c). Literal-route real-HAF coverage for `/enrichment` parent
 *       JOIN remains a follow-up.
 *
 * Canary pinned in this file:
 *   1. The reviews sub-query within `fetchEnrichmentFromHaf` carries the
 *      parent-paper `validPevoPaperWhere(source:'all')` gate — pinned via
 *      the `'paper'` and `'bridge_paper'` substrings emitted by the helper.
 *
 * Mutation kill: dropping the validPevoPaperWhere substrings from the
 * enrichment reviews SQL fires the canary red.
 *
 * Note: `fetchEnrichmentFromHaf` may return null in the mocked environment
 * because adjacent sub-queries (`resolveVersionsFromHaf`, accreditation
 * lookups) return empty rows. The reviews query is still emitted inside the
 * `Promise.all` before the null path is taken, so the captured SQL list
 * contains the canary target regardless of the route's eventual response
 * status.
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

const { createApp } = await import('../../src/app.js');
const { hafCache } = await import('../../src/cache.js');
const app = createApp();

beforeEach(async () => {
  hafQueryMock.mockReset().mockResolvedValue({ rows: [] });
  getPoolMock.mockReset().mockReturnValue({
    query: hafQueryMock,
    connect: async () => ({ query: hafQueryMock, release: () => {} }),
  });
  await hafCache.clear();
});

describe('GET /api/papers/:author/:permlink/enrichment — review JOIN parent-paper gate', () => {
  const nativePaperSubstring = "= 'paper'";
  const bridgePaperSubstring = "= 'bridge_paper'";

  it('reviews query composes validPevoPaperWhere on parent paper (mutation-kill)', async () => {
    const capturedSqls: string[] = [];
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSqls.push(sql);
      return { rows: [] };
    });
    // Status may be 200 or 404 in the mocked environment — depends on
    // whether resolveVersionsFromHaf's empty-rows path returns [] cleanly
    // or whether the catch fires. The SUT here is the SQL emit, not the
    // route's response shape.
    await request(app).get('/api/papers/alice/some-paper/enrichment');

    // The enrichment reviews SQL is identified by its review-row payload
    // shape: `c.author, c.permlink, c.body, c.json_metadata, c.created`
    // combined with the inline-correlated `net_votes` subquery. Filter
    // captured SQLs to that pattern.
    const reviewsSqls = capturedSqls.filter(
      (s) => s.includes('AS net_votes') && s.includes('c.parent_author = $1') && s.includes('c.parent_permlink = $2'),
    );
    expect(reviewsSqls.length, 'expected the enrichment reviews SQL to have been emitted').toBeGreaterThanOrEqual(1);
    for (const sql of reviewsSqls) {
      expect(sql, 'enrichment reviews SQL missing native-paper arm').toContain(nativePaperSubstring);
      expect(sql, 'enrichment reviews SQL missing bridge_paper arm — validPevoPaperWhere source:"all" requires both').toContain(bridgePaperSubstring);
    }
  });
});

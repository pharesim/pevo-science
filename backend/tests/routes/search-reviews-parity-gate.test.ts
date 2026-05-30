/**
 * Mocked-pool SQL-shape canary for /api/search?type=review parent-paper gate.
 *
 * Per CLAUDE.md "Running Tests" carve-out clauses (a)/(b)/(c):
 *   (a) Real-corpus seeding is impractical: the defended failure mode is an
 *       accredited reviewer broadcasting a `pevo.review`-shaped reply to a
 *       top-level pevotest-tagged non-paper Hive post. The pre-fix gate
 *       (`p.parent_author = '' AND p.parent_permlink = $appTag`) admits the
 *       row; the post-fix gate (`validPevoPaperWhere(source:'all')` on p)
 *       excludes it. Deterministic real-corpus exercise requires writing
 *       such a record to HAF.
 *   (b) `verifyHiveSignature` is NOT mocked — `/api/search` is a public GET
 *       with no auth middleware to short-circuit.
 *   (c) Real-path companion: SQL-shape composition is exercised against real
 *       HAF at sibling review-class SQL sites:
 *         - `paper_reviews` / `user_reviews` CTEs via
 *           `reputation-lifecycle.test.ts`,
 *         - parent-paper gate composition via `review-parity-invariant.test.ts`
 *           (real-HAF arm + synthetic-VALUES fallback).
 *       The same risk class — display-side admitting rows reputation excludes
 *       — is caught by those real-path tests at sibling composition sites,
 *       satisfying clause-(c). Literal-route real-HAF coverage for
 *       `/api/search?type=review` remains a follow-up.
 *
 * Canary pinned in this file:
 *   1. The review-search SQL carries the parent-paper
 *      `validPevoPaperWhere(source:'all')` gate — pinned via the `'paper'`
 *      and `'bridge_paper'` substrings emitted by the helper. The count and
 *      data fields share one query via `count(*) OVER ()`, so a single SQL
 *      carries the gate.
 *
 * Mutation kill: dropping the validPevoPaperWhere paper-class substrings
 * from the review-search SQL fires the canary red.
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
const app = createApp();

beforeEach(async () => {
  hafQueryMock.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes('count(*)')) return { rows: [{ total: 0 }] };
    return { rows: [] };
  });
  getPoolMock.mockReset().mockReturnValue({ query: hafQueryMock });
  await hafCache.clear();
});

describe('GET /api/search?type=review — parent-paper gate', () => {
  const nativePaperSubstring = "= 'paper'";
  const bridgePaperSubstring = "= 'bridge_paper'";

  it('review-search SQL composes validPevoPaperWhere on parent paper (mutation-kill)', async () => {
    const capturedSqls: string[] = [];
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSqls.push(sql);
      return { rows: [] };
    });
    const res = await request(app).get('/api/search?q=method&type=review');
    expect(res.status).toBe(200);
    // Filter to the review-search SQLs (those carrying `c.parent_author != ''`
    // — the unique review-search predicate). The count+data consolidation via
    // `count(*) OVER ()` collapses these to a single query that carries the
    // gate predicates exactly once.
    const reviewSqls = capturedSqls.filter((s) => s.includes(`c.parent_author != ''`));
    expect(reviewSqls.length, 'expected one consolidated review-search SQL').toBeGreaterThanOrEqual(1);
    for (const sql of reviewSqls) {
      expect(sql, 'review-search SQL missing native-paper arm').toContain(nativePaperSubstring);
      expect(sql, 'review-search SQL missing bridge_paper arm — validPevoPaperWhere source:"all" requires both').toContain(bridgePaperSubstring);
      expect(sql, 'review-search SQL missing window-function consolidation').toMatch(/count\s*\(\s*\*\s*\)\s*OVER\s*\(\s*\)/i);
    }
  });
});

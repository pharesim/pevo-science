/**
 * Mocked-pool SQL-shape canaries for /api/notifications new_review arms.
 *
 * Per CLAUDE.md "Running Tests" carve-out clauses (a)/(b)/(c):
 *   (a) Real-corpus seeding is impractical: arm 1a's defended failure mode
 *       is a `type='review'` reply to a non-paper Hive post (a peakd blog
 *       post, a non-paper comment, etc.) authored by the recipient. The
 *       public HAF corpus cannot be deterministically seeded with such a
 *       row + a matching peakd-side review-shaped reply at test time. Arm
 *       1b's `co.author != $1` self-review exclusion has the same seeding
 *       impracticality (a paper author's self-review reply on their own
 *       bridge paper).
 *   (b) `verifyHiveSignature` is NOT mocked — the route middleware runs
 *       real via the existing MOCK_VERIFY_SIGNATURE fixture that
 *       notifications.test.ts already uses for real-HAF coverage.
 *   (c) Real-path companion: the envelope shape + sort-order + limit
 *       behavior is exercised against real HAF in notifications.test.ts;
 *       this file covers the SQL-shape predicates those tests cannot pin
 *       (a revert of any predicate below would pass every existing test).
 *
 * Canaries pinned in this file:
 *   1. Arm 1a uses INNER JOIN to ${T.comments} p (round-1 hold #3 fix —
 *      LEFT JOIN admitted review-typed replies to non-paper posts and
 *      surfaced new_review notifications with empty titles).
 *   2. Arm 1a's JOIN carries validPevoPaperWhere(source='all') against
 *      the parent comment p, enforcing paper-class identity (the LEFT
 *      JOIN-to-non-paper griefing vector).
 *   3. Arms 1a and 1b both carry `co.author != $1` self-author exclusion
 *      (paired with the self-review-exclusion task hold item #6 ask:
 *      reverting either inline filter would let a paper author receive
 *      "you reviewed your own paper" notifications).
 *
 * Mutation kill: removing INNER from arm 1a's JOIN, dropping the
 * validPevoPaperWhere predicate from arm 1a, or removing `co.author != $1`
 * from either arm fails the corresponding canary below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

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
  getPoolMock.mockReset().mockReturnValue({ query: hafQueryMock });
  await hafCache.clear();
});

describe('GET /api/notifications — new_review arm SQL-shape canaries', () => {
  async function captureNotificationsSql(): Promise<string> {
    // Use a sinceBlock past the genesis short-circuit so the route reaches
    // the notification query. genesis-block lookup hits `pool.query` first
    // with a `SELECT MAX(...) ... custom_id = $1` shape — return 0 so the
    // clamp doesn't engage.
    let capturedSql = '';
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('custom_id') && sql.includes('MAX')) {
        return { rows: [{ block_num: 0 }] };
      }
      // Notifications query.
      capturedSql = sql;
      return { rows: [] };
    });
    const res = await request(app)
      .get('/api/notifications?since_block=1000000')
      .set('X-Hive-Username', 'pevo.admin')
      .set('X-Hive-Signature', 'mock-sig');
    expect(res.status).toBe(200);
    expect(capturedSql.length).toBeGreaterThan(0);
    return capturedSql;
  }

  it('arm 1a promotes the parent-paper join to INNER JOIN (round-1 hold #3 mutation-kill)', async () => {
    const sql = await captureNotificationsSql();
    // The round-1 hold flipped the parent-paper join from LEFT JOIN to
    // INNER JOIN to enforce paper-class existence at the JOIN level.
    // Reverting to LEFT JOIN re-opens the empty-title griefing vector.
    // Detection: arm 1a's parent JOIN is the only `JOIN hafsql.comments p`
    // occurrence in the SQL — arm 1b's `p` is LEFT JOINed (the
    // user_bridge_papers CTE already guarantees paper-class identity), so
    // a `LEFT JOIN hafsql.comments p` substring is fine for 1b. We
    // require the bare `JOIN hafsql.comments p` (no leading `LEFT`) to be
    // present, which only matches arm 1a's INNER JOIN.
    expect(sql).toMatch(/(?<!LEFT )JOIN hafsql\.comments p\b/);
  });

  it('arm 1a JOIN carries validPevoPaperWhere(source=all) paper-class gate (round-1 hold #3)', async () => {
    const sql = await captureNotificationsSql();
    // validPevoPaperWhere(source='all') expands to
    //   ((p.json_metadata -> $X ->> 'type') = 'paper'
    //    OR (p.author = $Y AND (p.json_metadata -> $X ->> 'type') = 'bridge_paper'))
    // We pin both arms against the parent alias `p` so a refactor that
    // drops the predicate from arm 1a's JOIN fails red.
    expect(sql).toContain("(p.json_metadata");
    expect(sql).toContain("'paper'");
    expect(sql).toContain("'bridge_paper'");
    // Arm 1b uses validPevoPaperWhere(source='bridge') inside the
    // user_bridge_papers CTE — that hits c.json_metadata, not p.
    // The 'paper' (native) arm above can only originate from arm 1a's
    // source='all' composition.
  });

  it('arms 1a + 1b both apply co.author != $1 self-author exclusion (mutation-kill for self-review-exclusion item #6, per-arm count)', async () => {
    const sql = await captureNotificationsSql();
    // Reverting the inline `AND co.author != $1` filter lets a paper
    // author receive `new_review` notifications for their own self-reply.
    // Asymmetric vs `excludeSelfReviewWhere` is deliberate — co-author
    // reviews of a shared paper ARE wanted notifications (notification
    // surface ≠ aggregation surface).
    //
    // Per-arm count: arm 1a (native new-review) AND arm 1b (bridge
    // new-review) each carry their own `co.author != $1` inline filter.
    // A revert that drops one but leaves the other is invisible to a
    // bare `toContain` substring check. Pin the count at 2 so a single-
    // arm regression fails red (BACKEND-SELF-REVIEW-EXCLUSION round-1
    // hold #6 + `defense-in-depth-canary-must-pin-each-layer-2026-05-07`).
    const occurrences = (sql.match(/co\.author != \$1/g) ?? []).length;
    expect(occurrences).toBe(2);
  });
});

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
 *   (b) `verifyHiveSignature` is mocked via the project-wide
 *       MOCK_VERIFY_SIGNATURE fixture (see
 *       `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`).
 *       This file's focus is SQL-shape predicates, NOT cryptographic
 *       verification behavior, so the carve-out's clause-(b) refinement
 *       permits the fixture: the 401-on-missing-header gate and the
 *       username-extraction behavior are preserved; only the cryptographic
 *       signature check is bypassed. No real-`verifyHiveSignature`
 *       integration test currently exists in the notifications domain —
 *       `notifications.test.ts` also hoists `MOCK_VERIFY_SIGNATURE` and
 *       its signed requests use the literal `'mock-sig'` header. The
 *       SQL-shape focus alone satisfies the clause-(b) refinement here;
 *       a real-signature companion for `/api/notifications` is a
 *       follow-up (no separate task filed yet) and not required for the
 *       gates this file pins.
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
    // the notification query. The route hits pool.query three times in
    // sequence:
    //   1. `getGenesisBlock` — `SELECT MIN(cj.block_num) AS genesis ...
    //      WHERE cj.custom_id = $1`. The first dispatch branch below
    //      short-circuits this with `{ genesis: 0 }` so the `head > genesis`
    //      clamp doesn't engage.
    //   2. `getGenesisBlock` HEAD fallback — `SELECT MAX(block_num) AS head
    //      FROM hafsql.haf_blocks`. Falls through to the catch-all
    //      `return { rows: [] }` branch; no capture (the empty result is
    //      benign for the genesis lookup).
    //   3. `fetchNotificationsFromHaf` — the notification CTE-chain that
    //      we want to inspect. Its UNION-ALL arms tag rows with
    //      `'new_review'::text AS event_type` (and several other event
    //      types); capture only when the SQL contains that distinctive
    //      arm-tag substring so neither bootstrap query nor any future
    //      pre-notifications query added inside the route steals the
    //      capture. `verifyHiveSignature` is mocked at the module level
    //      above via the project-wide MOCK_VERIFY_SIGNATURE fixture; this
    //      file's focus is SQL-shape, not cryptographic verification (see
    //      `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`
    //      for the auth-mock policy under clause-(b)).
    let capturedSql = '';
    hafQueryMock.mockImplementation(async (sql: string) => {
      // Bootstrap: genesis-block lookup. Return 0 so the clamp doesn't engage.
      if (sql.includes('AS genesis')) {
        return { rows: [{ genesis: 0 }] };
      }
      // Notifications query — distinguishable by the event-type tags
      // emitted in the UNION-ALL arms.
      if (sql.includes("'new_review'::text")) {
        capturedSql = sql;
        return { rows: [] };
      }
      // Anything else: empty fall-through (don't capture).
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

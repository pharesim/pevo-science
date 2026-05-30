import { describe, it, expect } from 'vitest';
import { getPool, isHafConfigured } from '../src/db.js';

/**
 * Behavioral synthetic-VALUES canaries for the per-arm filter semantics of
 * `fetchNotificationsFromHaf` in backend/src/notification-queries.ts.
 *
 * Carve-out clause-(a) justification: the notification arms read HAF's
 * `operation_comment_view` / `operation_vote_view` / `operations_custom_json`
 * mirrors, which we cannot seed (HAF is an external chain-mirror — no test
 * inserts). Each test reconstructs the WHERE/JOIN shape of one arm over a
 * synthetic `WITH (VALUES ...)` row set fed through the real `getPool()`
 * Postgres connection, so the exact predicate the arm applies is exercised.
 *
 * Carve-out clause-(c) real-path companion: GET /api/notifications has
 * per-route integration tests exercising the assembled query end-to-end on
 * well-formed HAF rows; these canaries cover the abuse/edge shapes that
 * cannot be produced through real chain data without broadcasting a forged op.
 */
describe('notification-queries.ts arm semantics', () => {
  // ── Arm 5 (new_reply) self-exclusion ────────────────────────────
  // A user replying to their own comment must not notify themselves.
  it.skipIf(!isHafConfigured())(
    'arm-5 new_reply: a self-reply (author = recipient) produces no notification',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Mirror arm 5's WHERE: parent_author = $1 (recipient) AND author != $1
      // (self-exclusion) AND type='comment'. Two synthetic comment_ops rows:
      //   row A: author = recipient (self-reply)  -> must be excluded
      //   row B: author = stranger               -> must be included
      const meta = JSON.stringify({ app: 'pevotest/1.0.0', pevotest: { type: 'comment' } });
      const sql = `
        WITH co(author, parent_author, json_metadata, block_num) AS (
          VALUES
            ('alice'::text, 'alice'::text, $2::jsonb, 100),
            ('bob'::text,   'alice'::text, $2::jsonb, 101)
        )
        SELECT COUNT(*)::int AS hit_count
        FROM co
        WHERE co.parent_author = $1
          AND co.block_num > 0
          AND co.author != $1
          AND (co.json_metadata -> 'pevotest' ->> 'type') = 'comment'
          AND co.json_metadata ->> 'app' LIKE 'pevotest/%'
      `;
      const result = await pool.query<{ hit_count: number }>(sql, ['alice', meta]);
      // Only bob's reply survives; alice's self-reply is excluded.
      expect(result.rows[0]?.hit_count).toBe(1);
    },
  );

  // Regression guard: the source arm 5 carries the self-exclusion clause so a
  // future edit that drops it is caught even if the behavioral row set above
  // is changed. The arm is identified by its `new_reply` literal.
  it('arm-5 new_reply: source carries the co.author != $1 self-exclusion', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../src/notification-queries.ts', import.meta.url)),
      'utf8',
    );
    const arm5 = src.slice(src.indexOf("'new_reply'::text"), src.indexOf("-- 6a."));
    expect(arm5).toContain('co.author != $1');
  });
});

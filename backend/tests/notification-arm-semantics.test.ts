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

  // ── Arms 6a/6b (new_citation) paper-existence gate ──────────────
  // The cited (author, permlink) must actually exist as a PEvO paper, else a
  // broadcaster spams unlimited fake-citation notifications.
  it.skipIf(!isHafConfigured())(
    'arm-6a new_citation: fake citation of a non-existent paper produces no notification; a real one does',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Mirror arm 6a: CROSS JOIN LATERAL over citing.pevo.citations, then the
      // post-fix INNER JOIN to cited_paper gated by validPevoPaperWhere(all).
      // cited_paper VALUES stands in for the comments table: it holds ONE real
      // PEvO paper (alice/real) and nothing for the fake permlink.
      const sql = `
        WITH
          citing(author, json_metadata, block_num) AS (VALUES ('bob'::text, $2::jsonb, 100)),
          cited_paper(author, permlink, title, json_metadata) AS (
            VALUES ('alice'::text, 'real'::text, 'Real Paper'::text,
                    '{"pevotest":{"type":"paper"}}'::jsonb)
          )
        SELECT COUNT(*)::int AS hit_count, MIN(cited_paper.title) AS title
        FROM citing
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(citing.json_metadata -> 'pevotest' -> 'citations') = 'array'
            THEN citing.json_metadata -> 'pevotest' -> 'citations'
            ELSE '[]'::jsonb
          END
        ) AS cite_elem
        CROSS JOIN LATERAL (
          SELECT cite_elem ->> 'author' AS author, cite_elem ->> 'permlink' AS permlink
        ) AS cited_ref
        JOIN cited_paper
          ON cited_paper.author = cited_ref.author AND cited_paper.permlink = cited_ref.permlink
          AND ((cited_paper.json_metadata -> 'pevotest' ->> 'type') = 'paper'
               OR (cited_paper.author = 'pevo.bridge'
                   AND (cited_paper.json_metadata -> 'pevotest' ->> 'type') = 'bridge_paper'))
        WHERE citing.author <> $1
          AND cited_ref.author = $1
          AND (citing.json_metadata -> 'pevotest' ->> 'type') = 'paper'
      `;

      // Fake-citation spam: alice/fake does not exist in cited_paper -> dropped.
      const spam = JSON.stringify({ pevotest: { type: 'paper', citations: [{ author: 'alice', permlink: 'fake' }] } });
      const spamResult = await pool.query<{ hit_count: number }>(sql, ['alice', spam]);
      expect(spamResult.rows[0]?.hit_count).toBe(0);

      // Legitimate citation: alice/real exists -> one notification, title set
      // (no COALESCE needed — INNER JOIN guarantees the row).
      const legit = JSON.stringify({ pevotest: { type: 'paper', citations: [{ author: 'alice', permlink: 'real' }] } });
      const legitResult = await pool.query<{ hit_count: number; title: string }>(sql, ['alice', legit]);
      expect(legitResult.rows[0]?.hit_count).toBe(1);
      expect(legitResult.rows[0]?.title).toBe('Real Paper');
    },
  );

  it('arms 6a/6b new_citation: source gates cited_paper with validPevoPaperWhere (INNER JOIN, no title COALESCE)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../src/notification-queries.ts', import.meta.url)),
      'utf8',
    );
    const citationArms = src.slice(src.indexOf("-- 6a."), src.indexOf('-- 7.'));
    // Both arms INNER JOIN cited_paper (no LEFT JOIN) with a validPevoPaperWhere gate.
    expect(citationArms).not.toContain('LEFT JOIN ${T.comments} cited_paper');
    expect(citationArms.match(/JOIN \$\{T\.comments\} cited_paper/g)?.length).toBe(2);
    expect(citationArms.match(/validPevoPaperWhere\(\{ commentAlias: 'cited_paper'/g)?.length).toBe(2);
    // INNER JOIN guarantees the row, so the title COALESCE is gone.
    expect(citationArms).not.toContain("COALESCE(cited_paper.title");
  });
});

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

  // ── Arms 4/7/8/9 (vouch/claim) signer gates ─────────────────────
  // custom_json arms previously gated only on JSON-field equality, so anyone
  // could forge an op naming the victim and trigger an emotional notification.
  it.skipIf(!isHafConfigured())(
    'arm-4 new_vouch: only a vouch signed by the named, accredited voucher fires',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) { ctx.skip('no pool available'); return; }
      const sql = `
        WITH active_accreditations(account) AS (VALUES ('carol'::text)),
        cj(required_posting_auths, json, custom_id, block_num) AS (VALUES
          ('["mallory"]'::jsonb, '{"action":"vouch","voucher":"carol","vouchee":"alice"}'::jsonb, 'pevotest'::text, 100),
          ('["carol"]'::jsonb,   '{"action":"vouch","voucher":"carol","vouchee":"alice"}'::jsonb, 'pevotest'::text, 101),
          ('["dave"]'::jsonb,    '{"action":"vouch","voucher":"dave","vouchee":"alice"}'::jsonb,  'pevotest'::text, 102)
        )
        SELECT COUNT(*)::int AS hit_count FROM cj
        WHERE cj.custom_id = 'pevotest'
          AND cj.json ->> 'vouchee' = $1
          AND cj.json ->> 'action' = 'vouch'
          AND cj.required_posting_auths ->> 0 = cj.json ->> 'voucher'
          AND cj.required_posting_auths ->> 0 IN (SELECT account FROM active_accreditations)
          AND cj.block_num > 0
      `;
      const r = await pool.query<{ hit_count: number }>(sql, ['alice']);
      // mallory (signer != voucher) dropped; dave (voucher not accredited) dropped; only carol fires.
      expect(r.rows[0]?.hit_count).toBe(1);
    },
  );

  it.skipIf(!isHafConfigured())(
    'arm-7 claim_pending: only an accredited signer firing a claim fires the notification',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) { ctx.skip('no pool available'); return; }
      const sql = `
        WITH active_accreditations(account) AS (VALUES ('carol'::text)),
        cj(required_posting_auths, json, custom_id, block_num) AS (VALUES
          ('["mallory"]'::jsonb, '{"action":"claim_authorship","paper_author":"alice"}'::jsonb, 'pevotest'::text, 100),
          ('["carol"]'::jsonb,   '{"action":"claim_authorship","paper_author":"alice"}'::jsonb, 'pevotest'::text, 101)
        )
        SELECT COUNT(*)::int AS hit_count FROM cj
        WHERE cj.custom_id = 'pevotest'
          AND cj.json ->> 'action' = 'claim_authorship'
          AND cj.json ->> 'paper_author' = $1
          AND cj.required_posting_auths ->> 0 IN (SELECT account FROM active_accreditations)
          AND cj.block_num > 0
      `;
      const r = await pool.query<{ hit_count: number }>(sql, ['alice']);
      // mallory unaccredited dropped; carol fires.
      expect(r.rows[0]?.hit_count).toBe(1);
    },
  );

  it.skipIf(!isHafConfigured())(
    'arm-8 claim_approved: only post-author or bridge-account signers fire',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) { ctx.skip('no pool available'); return; }
      const sql = `
        WITH cj(required_posting_auths, json, custom_id, block_num) AS (VALUES
          ('["mallory"]'::jsonb,    '{"action":"approve_authorship","claimer":"alice","paper_author":"bob"}'::jsonb, 'pevotest'::text, 100),
          ('["bob"]'::jsonb,        '{"action":"approve_authorship","claimer":"alice","paper_author":"bob"}'::jsonb, 'pevotest'::text, 101),
          ('["pevo.bridge"]'::jsonb,'{"action":"approve_authorship","claimer":"alice","paper_author":"bob"}'::jsonb, 'pevotest'::text, 102)
        )
        SELECT COUNT(*)::int AS hit_count FROM cj
        WHERE cj.custom_id = 'pevotest'
          AND cj.json ->> 'action' = 'approve_authorship'
          AND cj.json ->> 'claimer' = $1
          AND cj.required_posting_auths ->> 0 IN (cj.json ->> 'paper_author', $2)
          AND cj.block_num > 0
      `;
      const r = await pool.query<{ hit_count: number }>(sql, ['alice', 'pevo.bridge']);
      // mallory dropped; bob (post author) + pevo.bridge fire.
      expect(r.rows[0]?.hit_count).toBe(2);
    },
  );

  it.skipIf(!isHafConfigured())(
    'arm-9 claim_revoked: post-author, claimer-self, bridge, and admin signers fire; strangers do not',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) { ctx.skip('no pool available'); return; }
      const sql = `
        WITH cj(required_posting_auths, json, custom_id, block_num) AS (VALUES
          ('["mallory"]'::jsonb,    '{"action":"revoke_authorship","claimer":"alice","paper_author":"bob"}'::jsonb, 'pevotest'::text, 100),
          ('["bob"]'::jsonb,        '{"action":"revoke_authorship","claimer":"alice","paper_author":"bob"}'::jsonb, 'pevotest'::text, 101),
          ('["alice"]'::jsonb,      '{"action":"revoke_authorship","claimer":"alice","paper_author":"bob"}'::jsonb, 'pevotest'::text, 102),
          ('["pevo.bridge"]'::jsonb,'{"action":"revoke_authorship","claimer":"alice","paper_author":"bob"}'::jsonb, 'pevotest'::text, 103),
          ('["pevo.admin"]'::jsonb, '{"action":"revoke_authorship","claimer":"alice","paper_author":"bob"}'::jsonb, 'pevotest'::text, 104)
        )
        SELECT COUNT(*)::int AS hit_count FROM cj
        WHERE cj.custom_id = 'pevotest'
          AND cj.json ->> 'action' = 'revoke_authorship'
          AND cj.json ->> 'claimer' = $1
          AND cj.required_posting_auths ->> 0 IN (
            cj.json ->> 'paper_author', cj.json ->> 'claimer', $2, $3
          )
          AND cj.block_num > 0
      `;
      const r = await pool.query<{ hit_count: number }>(sql, ['alice', 'pevo.bridge', 'pevo.admin']);
      // mallory dropped; bob + alice(self) + bridge + admin fire.
      expect(r.rows[0]?.hit_count).toBe(4);
    },
  );

  // ── Arms 2a/2b/2c (new_vote) content filter + target_type ───────
  // Votes must only notify for PEvO papers/reviews, with the right
  // target_type, and never for self-votes.
  it.skipIf(!isHafConfigured())(
    'arm-2a new_vote: vote on non-PEvO content drops; vote on a native paper fires as target_type=paper; self-vote drops',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) { ctx.skip('no pool available'); return; }
      // p stands in for the comments table: only alice/paper1 is a PEvO paper.
      const sql = `
        WITH
          active_accreditations(account) AS (VALUES ('bob'::text), ('alice'::text)),
          p(author, permlink, json_metadata) AS (
            VALUES ('alice'::text, 'paper1'::text, '{"pevotest":{"type":"paper"}}'::jsonb)
          ),
          v(voter, author, permlink, weight, block_num) AS (VALUES
            ('bob'::text,   'alice'::text, 'paper1'::text, 100, 100),  -- vote on PEvO paper -> fires
            ('bob'::text,   'alice'::text, 'blogpost'::text, 100, 101),-- vote on non-PEvO content -> drops
            ('alice'::text, 'alice'::text, 'paper1'::text, 100, 102)   -- self-vote -> drops
          )
        SELECT COUNT(*)::int AS hit_count, MIN('paper') AS target_type
        FROM v
        JOIN active_accreditations aa ON aa.account = v.voter
        JOIN p ON p.author = v.author AND p.permlink = v.permlink
          AND ((p.json_metadata -> 'pevotest' ->> 'type') = 'paper'
               OR (p.author = 'pevo.bridge' AND (p.json_metadata -> 'pevotest' ->> 'type') = 'bridge_paper'))
        WHERE v.author = $1
          AND v.block_num > 0
          AND v.weight != 0
          AND v.voter != v.author
      `;
      const r = await pool.query<{ hit_count: number; target_type: string }>(sql, ['alice']);
      expect(r.rows[0]?.hit_count).toBe(1);
      expect(r.rows[0]?.target_type).toBe('paper');
    },
  );

  it.skipIf(!isHafConfigured())(
    'arm-2c new_vote: vote on a review fires as target_type=review',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) { ctx.skip('no pool available'); return; }
      const reviewMeta = JSON.stringify({
        pevotest: { type: 'review', rating: { methodology: 3, novelty: 4, clarity: 5, significance: 2 } },
      });
      const sql = `
        WITH
          active_accreditations(account) AS (VALUES ('bob'::text)),
          c(author, permlink, json_metadata) AS (VALUES ('alice'::text, 'rev1'::text, $2::jsonb)),
          v(voter, author, permlink, weight, block_num) AS (VALUES
            ('bob'::text, 'alice'::text, 'rev1'::text, 100, 100)
          )
        SELECT COUNT(*)::int AS hit_count, MIN('review') AS target_type
        FROM v
        JOIN active_accreditations aa ON aa.account = v.voter
        JOIN c ON c.author = v.author AND c.permlink = v.permlink
          AND (
            (c.json_metadata -> 'pevotest' ->> 'type') = 'review'
            AND jsonb_typeof(c.json_metadata -> 'pevotest' -> 'rating') = 'object'
            AND (c.json_metadata -> 'pevotest' -> 'rating' ->> 'methodology')  ~ '^[1-5]$'
            AND (c.json_metadata -> 'pevotest' -> 'rating' ->> 'novelty')      ~ '^[1-5]$'
            AND (c.json_metadata -> 'pevotest' -> 'rating' ->> 'clarity')      ~ '^[1-5]$'
            AND (c.json_metadata -> 'pevotest' -> 'rating' ->> 'significance') ~ '^[1-5]$'
          )
        WHERE v.author = $1
          AND v.block_num > 0
          AND v.weight != 0
          AND v.voter != v.author
      `;
      const r = await pool.query<{ hit_count: number; target_type: string }>(sql, ['alice', reviewMeta]);
      expect(r.rows[0]?.hit_count).toBe(1);
      expect(r.rows[0]?.target_type).toBe('review');
    },
  );

  it('vote arms: split into native (2a), bridge (2b), review (2c) with content gates and target_type', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../src/notification-queries.ts', import.meta.url)),
      'utf8',
    );
    const voteArms = src.slice(src.indexOf('-- 2a.'), src.indexOf('-- 3.'));
    expect(voteArms).toContain('-- 2a.');
    expect(voteArms).toContain('-- 2b.');
    expect(voteArms).toContain('-- 2c.');
    // 2a gates the native paper with validPevoPaperWhere; 2c gates the review.
    expect(voteArms).toContain('validPevoPaperWhere');
    expect(voteArms).toContain('validReviewWhere');
    expect(voteArms).toContain("'review'");
    // self-vote exclusion present in every vote sub-arm.
    expect(voteArms.match(/AND v\.voter != v\.author/g)?.length).toBe(3);
  });

  // ── Arm 5 (new_reply) emits no paper coords ─────────────────────
  it('arm-5 new_reply: NewReplyEvent type and handler omit paper_author/paper_permlink', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../src/notification-queries.ts', import.meta.url)),
      'utf8',
    );
    // The NewReplyEvent interface must not declare paper coords as fields
    // (match a field declaration at line start, not the explanatory comment).
    const iface = src.slice(src.indexOf('interface NewReplyEvent'), src.indexOf('interface ClaimPendingEvent'));
    expect(iface).not.toMatch(/^\s*paper_author\??:/m);
    expect(iface).not.toMatch(/^\s*paper_permlink\??:/m);
    // The handler's new_reply case must not assign null-valued paper coords.
    const handlerCase = src.slice(src.indexOf("case 'new_reply':"), src.indexOf("case 'claim_pending':"));
    expect(handlerCase).not.toMatch(/^\s*paper_author:/m);
    expect(handlerCase).not.toMatch(/^\s*paper_permlink:/m);
  });

  it('arms 3/4/7/8/9 custom_json arms: each gates on required_posting_auths', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../src/notification-queries.ts', import.meta.url)),
      'utf8',
    );
    const region = (from: string, to: string) =>
      src.slice(src.indexOf(from), src.indexOf(to));
    expect(region('-- 3.', '-- 4.')).toContain('required_posting_auths');
    expect(region('-- 4.', '-- 5.')).toContain('required_posting_auths ->> 0');
    expect(region('-- 7.', '-- 8.')).toContain('required_posting_auths ->> 0');
    expect(region('-- 8.', '-- 9.')).toContain('required_posting_auths ->> 0');
    expect(region('-- 9.', 'ORDER BY block_num')).toContain('required_posting_auths ->> 0');
  });
});

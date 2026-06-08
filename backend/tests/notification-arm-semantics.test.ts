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
        SELECT COUNT(*)::int AS hit_count, MIN(COALESCE(cited_paper.title, '')) AS title
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

      // Legitimate citation: alice/real exists -> one notification, title set.
      // The INNER JOIN guarantees the row; COALESCE(title,'') matches the source
      // projection so a null comments.title would surface as '' rather than null.
      const legit = JSON.stringify({ pevotest: { type: 'paper', citations: [{ author: 'alice', permlink: 'real' }] } });
      const legitResult = await pool.query<{ hit_count: number; title: string }>(sql, ['alice', legit]);
      expect(legitResult.rows[0]?.hit_count).toBe(1);
      expect(legitResult.rows[0]?.title).toBe('Real Paper');
    },
  );

  // Arm 6a/6b DISTINCT ON dedup: one citing post listing the same real cited
  // paper N times in its citations array fans out via jsonb_array_elements to N
  // candidate rows, but DISTINCT ON (citing.author, citing.permlink,
  // cited_ref.author, cited_ref.permlink) collapses them to a single
  // notification, so array-repetition cannot amplify citation spam.
  it.skipIf(!isHafConfigured())(
    'arms 6a/6b new_citation: a citations array repeating the same paper yields one notification (DISTINCT ON dedup)',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Mirror arm 6a's DISTINCT ON 4-tuple over a single citing post whose
      // citations array names alice/real three times. After the join + dedup the
      // outer COUNT must be 1.
      const sql = `
        WITH
          citing(author, permlink, json_metadata, block_num) AS (VALUES ('bob'::text, 'cite1'::text, $2::jsonb, 100)),
          cited_paper(author, permlink, title, json_metadata) AS (
            VALUES ('alice'::text, 'real'::text, 'Real Paper'::text,
                    '{"pevotest":{"type":"paper"}}'::jsonb)
          )
        SELECT COUNT(*)::int AS hit_count
        FROM (
          SELECT DISTINCT ON (citing.author, citing.permlink, cited_ref.author, cited_ref.permlink) 1
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
          ORDER BY citing.author, citing.permlink, cited_ref.author, cited_ref.permlink, citing.block_num ASC
        ) AS arm_6ab
      `;

      const dupes = JSON.stringify({
        pevotest: {
          type: 'paper',
          citations: [
            { author: 'alice', permlink: 'real' },
            { author: 'alice', permlink: 'real' },
            { author: 'alice', permlink: 'real' },
          ],
        },
      });
      const result = await pool.query<{ hit_count: number }>(sql, ['alice', dupes]);
      expect(result.rows[0]?.hit_count).toBe(1);
    },
  );

  // Arm 6b (bridge): a citation of a paper the recipient registered via the
  // bridge fires only when the cited ref matches a user_bridge_papers row AND the
  // belt-and-suspenders cited_paper INNER JOIN proves a valid bridge paper. A
  // fake permlink that user_bridge_papers does not carry produces no notification.
  it.skipIf(!isHafConfigured())(
    'arm-6b new_citation: fake citation of an unregistered bridge paper produces no notification; a registered one does',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Mirror arm 6b: the user_bridge_papers CTE pins the bridge paper to the
      // recipient ($1 = the registering user); the cited paper's chain author is
      // the bridge account (pevo.bridge), not the recipient. bp stands in for the
      // user_bridge_papers CTE (one registered bridge paper: pevo.bridge/real),
      // cited_paper stands in for the comments table (the belt-and-suspenders
      // validPevoPaperWhere(all) gate, satisfied by a bridge_paper row).
      const sql = `
        WITH
          citing(author, json_metadata, block_num) AS (VALUES ('bob'::text, $2::jsonb, 100)),
          bp(author, permlink) AS (VALUES ('pevo.bridge'::text, 'real'::text)),
          cited_paper(author, permlink, title, json_metadata) AS (
            VALUES
              ('pevo.bridge'::text, 'real'::text, 'Bridge Paper'::text,
                    '{"pevotest":{"type":"bridge_paper"}}'::jsonb),
              -- A valid bridge paper registered by a DIFFERENT user: present in
              -- cited_paper (the belt-and-suspenders validPevoPaperWhere gate) but
              -- absent from bp (alice's user_bridge_papers). It exists so the
              -- bp-JOIN-dropped regression has something to slip through.
              ('pevo.bridge'::text, 'other'::text, 'Another User Bridge Paper'::text,
                    '{"pevotest":{"type":"bridge_paper"}}'::jsonb)
          )
        SELECT COUNT(*)::int AS hit_count, MIN(COALESCE(cited_paper.title, '')) AS title
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
        JOIN bp ON bp.author = cited_ref.author AND bp.permlink = cited_ref.permlink
        JOIN cited_paper
          ON cited_paper.author = cited_ref.author AND cited_paper.permlink = cited_ref.permlink
          AND ((cited_paper.json_metadata -> 'pevotest' ->> 'type') = 'paper'
               OR (cited_paper.author = 'pevo.bridge'
                   AND (cited_paper.json_metadata -> 'pevotest' ->> 'type') = 'bridge_paper'))
        WHERE citing.author <> $1
          AND (citing.json_metadata -> 'pevotest' ->> 'type') = 'paper'
      `;

      // Fake-citation spam: pevo.bridge/fake is not in user_bridge_papers -> dropped.
      const spam = JSON.stringify({ pevotest: { type: 'paper', citations: [{ author: 'pevo.bridge', permlink: 'fake' }] } });
      const spamResult = await pool.query<{ hit_count: number }>(sql, ['alice', spam]);
      expect(spamResult.rows[0]?.hit_count).toBe(0);

      // Legitimate citation: pevo.bridge/real is registered by the recipient and
      // is a valid bridge paper -> one notification, title set via COALESCE.
      const legit = JSON.stringify({ pevotest: { type: 'paper', citations: [{ author: 'pevo.bridge', permlink: 'real' }] } });
      const legitResult = await pool.query<{ hit_count: number; title: string }>(sql, ['alice', legit]);
      expect(legitResult.rows[0]?.hit_count).toBe(1);
      expect(legitResult.rows[0]?.title).toBe('Bridge Paper');

      // A valid bridge paper registered by ANOTHER user: present in cited_paper
      // but absent from alice's bp. Must yield 0. Because the cited_paper INNER
      // JOIN alone would admit it (it is a real bridge_paper), a 0 here proves the
      // bp JOIN's registered_by=$1 ownership gate is load-bearing — drop the bp
      // JOIN and this turns into a spurious notification to alice about a paper she
      // never registered. (The earlier fake-permlink spam case cannot catch that
      // regression: pevo.bridge/fake is in neither bp nor cited_paper, so the
      // cited_paper INNER JOIN backstops it regardless of the bp JOIN.)
      const otherUser = JSON.stringify({ pevotest: { type: 'paper', citations: [{ author: 'pevo.bridge', permlink: 'other' }] } });
      const otherResult = await pool.query<{ hit_count: number }>(sql, ['alice', otherUser]);
      expect(otherResult.rows[0]?.hit_count).toBe(0);
    },
  );

  it('arms 6a/6b new_citation: source gates cited_paper with validPevoPaperWhere (INNER JOIN, title COALESCE parity)', async () => {
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
    // Title projection wraps cited_paper.title in COALESCE(..., '') in BOTH arms,
    // matching the sibling new_review arms (1a/1b). The INNER JOIN guarantees the
    // row exists but not that comments.title is non-null, so the COALESCE prevents
    // a null paper_title from reaching the NewCitationEvent string field.
    expect(citationArms.match(/COALESCE\(cited_paper\.title, ''\)/g)?.length).toBe(2);
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

  // Arms 8/9 require a real-paper existence proof: the signer must equal the
  // ACTUAL native post author (proven via the comments stand-in `p`), NOT the
  // JSON-self-asserted paper_author. The `p` CTE stands in for hafsql.comments
  // and holds ONE real native PEvO paper authored by bob (bob/paper1). Forged
  // rows self-naming a non-author as paper_author find no matching real paper
  // and are dropped.
  it.skipIf(!isHafConfigured())(
    'arm-8 claim_approved: real-author or bridge signers fire; a stranger self-asserting paper_author is dropped',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) { ctx.skip('no pool available'); return; }
      const sql = `
        WITH
          p(author, permlink, json_metadata) AS (
            VALUES ('bob'::text, 'paper1'::text, '{"pevotest":{"type":"paper"}}'::jsonb)
          ),
          cj(required_posting_auths, json, custom_id, block_num) AS (VALUES
            -- mallory self-signs and self-names as paper_author of a fake paper -> no real paper -> dropped
            ('["mallory"]'::jsonb,    '{"action":"approve_authorship","claimer":"alice","paper_author":"mallory","paper_permlink":"fake"}'::jsonb, 'pevotest'::text, 100),
            -- bob is the ACTUAL author of the real paper bob/paper1 -> fires
            ('["bob"]'::jsonb,        '{"action":"approve_authorship","claimer":"alice","paper_author":"bob","paper_permlink":"paper1"}'::jsonb, 'pevotest'::text, 101),
            -- bridge account on the real paper -> fires (param-bound branch, no JSON trust)
            ('["pevo.bridge"]'::jsonb,'{"action":"approve_authorship","claimer":"alice","paper_author":"bob","paper_permlink":"paper1"}'::jsonb, 'pevotest'::text, 102),
            -- carol self-signs naming bob's real paper but is NOT its author -> dropped
            ('["carol"]'::jsonb,      '{"action":"approve_authorship","claimer":"alice","paper_author":"bob","paper_permlink":"paper1"}'::jsonb, 'pevotest'::text, 103)
          )
        SELECT COUNT(*)::int AS hit_count FROM cj
        WHERE cj.custom_id = 'pevotest'
          AND cj.json ->> 'action' = 'approve_authorship'
          AND cj.json ->> 'claimer' = $1
          AND (
            EXISTS (
              SELECT 1 FROM p ap_paper
              WHERE ap_paper.author = cj.json ->> 'paper_author'
                AND ap_paper.permlink = cj.json ->> 'paper_permlink'
                AND (ap_paper.json_metadata -> 'pevotest' ->> 'type') = 'paper'
                AND cj.required_posting_auths ->> 0 = ap_paper.author
            )
            OR cj.required_posting_auths ->> 0 = $2
          )
          AND cj.block_num > 0
      `;
      const r = await pool.query<{ hit_count: number }>(sql, ['alice', 'pevo.bridge']);
      // mallory (fake paper) + carol (real paper, not its author) dropped;
      // bob (actual author) + pevo.bridge (param) fire.
      expect(r.rows[0]?.hit_count).toBe(2);
    },
  );

  it.skipIf(!isHafConfigured())(
    'arm-9 claim_revoked: real-author, claimer-self, bridge, admin fire; a stranger self-asserting paper_author is dropped',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) { ctx.skip('no pool available'); return; }
      const sql = `
        WITH
          p(author, permlink, json_metadata) AS (
            VALUES ('bob'::text, 'paper1'::text, '{"pevotest":{"type":"paper"}}'::jsonb)
          ),
          cj(required_posting_auths, json, custom_id, block_num) AS (VALUES
            -- mallory self-signs and self-names as paper_author of a fake paper -> dropped
            ('["mallory"]'::jsonb,    '{"action":"revoke_authorship","claimer":"alice","paper_author":"mallory","paper_permlink":"fake"}'::jsonb, 'pevotest'::text, 100),
            -- bob is the ACTUAL author of the real paper bob/paper1 -> fires
            ('["bob"]'::jsonb,        '{"action":"revoke_authorship","claimer":"alice","paper_author":"bob","paper_permlink":"paper1"}'::jsonb, 'pevotest'::text, 101),
            -- alice is the claimer (= recipient $1), revoking her own claim -> fires
            ('["alice"]'::jsonb,      '{"action":"revoke_authorship","claimer":"alice","paper_author":"bob","paper_permlink":"paper1"}'::jsonb, 'pevotest'::text, 102),
            -- bridge / admin param-bound branches on the real paper -> fire
            ('["pevo.bridge"]'::jsonb,'{"action":"revoke_authorship","claimer":"alice","paper_author":"bob","paper_permlink":"paper1"}'::jsonb, 'pevotest'::text, 103),
            ('["pevo.admin"]'::jsonb, '{"action":"revoke_authorship","claimer":"alice","paper_author":"bob","paper_permlink":"paper1"}'::jsonb, 'pevotest'::text, 104),
            -- carol self-signs naming bob's real paper but is NOT its author, claimer, bridge, or admin -> dropped
            ('["carol"]'::jsonb,      '{"action":"revoke_authorship","claimer":"alice","paper_author":"bob","paper_permlink":"paper1"}'::jsonb, 'pevotest'::text, 105)
          )
        SELECT COUNT(*)::int AS hit_count FROM cj
        WHERE cj.custom_id = 'pevotest'
          AND cj.json ->> 'action' = 'revoke_authorship'
          AND cj.json ->> 'claimer' = $1
          AND (
            EXISTS (
              SELECT 1 FROM p rv_paper
              WHERE rv_paper.author = cj.json ->> 'paper_author'
                AND rv_paper.permlink = cj.json ->> 'paper_permlink'
                AND (rv_paper.json_metadata -> 'pevotest' ->> 'type') = 'paper'
                AND cj.required_posting_auths ->> 0 = rv_paper.author
            )
            OR cj.required_posting_auths ->> 0 IN (
              cj.json ->> 'claimer', $2, $3
            )
          )
          AND cj.block_num > 0
      `;
      const r = await pool.query<{ hit_count: number }>(sql, ['alice', 'pevo.bridge', 'pevo.admin']);
      // mallory (fake paper) + carol (real paper, not author/claimer/bridge/admin) dropped;
      // bob (actual author) + alice(self) + bridge + admin fire.
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
      // target_type is derived from the joined paper row (NOT a MIN('<literal>')
      // constant in this test's own SELECT) so the assertion exercises the arm's
      // fixed 'paper'::text projection: if arm 2a emitted the wrong literal, the
      // joined value would differ and the assertion would fail.
      const sql = `
        WITH
          active_accreditations(account) AS (VALUES ('bob'::text), ('alice'::text)),
          p(author, permlink, json_metadata, target_type) AS (
            VALUES ('alice'::text, 'paper1'::text, '{"pevotest":{"type":"paper"}}'::jsonb, 'paper'::text)
          ),
          v(voter, author, permlink, weight, block_num) AS (VALUES
            ('bob'::text,   'alice'::text, 'paper1'::text, 100, 100),  -- vote on PEvO paper -> fires
            ('bob'::text,   'alice'::text, 'blogpost'::text, 100, 101),-- vote on non-PEvO content -> drops
            ('alice'::text, 'alice'::text, 'paper1'::text, 100, 102)   -- self-vote -> drops
          )
        SELECT COUNT(*)::int AS hit_count, MIN(p.target_type) AS target_type
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
    'arm-2b new_vote: vote on a registered bridge paper fires; vote on an unregistered bridge_paper drops',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) { ctx.skip('no pool available'); return; }
      // Mirror arm 2b: it INNER JOINs the user_bridge_papers CTE, which is the
      // bridge-paper existence proof. That CTE admits a comments row only when
      // it is authored by the bridge account, has type='bridge_paper', AND its
      // metadata source.registered_by equals the recipient. Reproduce both the
      // CTE and the arm's INNER JOIN so a JOIN-form weakening (INNER -> LEFT) or
      // a dropped registered_by predicate would surface the unregistered paper's
      // vote and break the hit_count = 1 expectation.
      //   bp_src row A: registered_by = recipient -> in the CTE
      //   bp_src row B: same bridge author + bridge_paper type, registered_by =
      //                 a stranger -> excluded by the registered_by predicate
      const sql = `
        WITH
          active_accreditations(account) AS (VALUES ('bob'::text)),
          bp_src(author, permlink, json_metadata, target_type) AS (VALUES
            ('pevo.bridge'::text, 'reg'::text,
             '{"pevotest":{"type":"bridge_paper","source":{"registered_by":"alice"}}}'::jsonb, 'paper'::text),
            ('pevo.bridge'::text, 'unreg'::text,
             '{"pevotest":{"type":"bridge_paper","source":{"registered_by":"mallory"}}}'::jsonb, 'paper'::text)
          ),
          user_bridge_papers AS (
            SELECT bp_src.author, bp_src.permlink, bp_src.target_type
            FROM bp_src
            WHERE bp_src.author = 'pevo.bridge'
              AND (bp_src.json_metadata -> 'pevotest' ->> 'type') = 'bridge_paper'
              AND bp_src.json_metadata -> 'pevotest' -> 'source' ->> 'registered_by' = $1
          ),
          v(voter, author, permlink, weight, block_num) AS (VALUES
            ('bob'::text, 'pevo.bridge'::text, 'reg'::text,   100, 100),  -- vote on registered bridge paper -> fires
            ('bob'::text, 'pevo.bridge'::text, 'unreg'::text, 100, 101)   -- vote on unregistered bridge_paper -> drops
          )
        -- target_type derived from the joined bridge-paper row (carried through
        -- user_bridge_papers), NOT a MIN('<literal>') constant in this test's own
        -- SELECT — mirrors the 2a/2c fixture-derived form so this canary cannot
        -- silently pass on a production projection-literal swap. The production
        -- literal itself is pinned in the source-shape test below.
        SELECT COUNT(*)::int AS hit_count, MIN(bp.target_type) AS target_type
        FROM v
        JOIN active_accreditations aa ON aa.account = v.voter
        JOIN user_bridge_papers bp ON bp.author = v.author AND bp.permlink = v.permlink
        WHERE v.block_num > 0
          AND v.weight != 0
          AND v.voter != v.author
      `;
      const r = await pool.query<{ hit_count: number; target_type: string }>(sql, ['alice']);
      // Only the registered bridge paper's vote survives the INNER JOIN; the
      // unregistered one is filtered out by the CTE's registered_by predicate.
      expect(r.rows[0]?.hit_count).toBe(1);
      // Bridge-paper votes surface as target_type 'paper' (same as native).
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
      // target_type is derived from the joined review row (NOT a MIN('<literal>')
      // constant in this test's own SELECT) so the assertion exercises the arm's
      // fixed 'review'::text projection: arm 2c distinguishes votes on reviews
      // from votes on papers, and emitting 'paper' here would be a regression the
      // joined-value derivation catches.
      const sql = `
        WITH
          active_accreditations(account) AS (VALUES ('bob'::text)),
          c(author, permlink, json_metadata, target_type) AS (
            VALUES ('alice'::text, 'rev1'::text, $2::jsonb, 'review'::text)
          ),
          v(voter, author, permlink, weight, block_num) AS (VALUES
            ('bob'::text, 'alice'::text, 'rev1'::text, 100, 100)
          )
        SELECT COUNT(*)::int AS hit_count, MIN(c.target_type) AS target_type
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

  it('vote arms: split into native (2a), bridge (2b), review (2c) with content gates and per-arm target_type literal', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../src/notification-queries.ts', import.meta.url)),
      'utf8',
    );
    const region = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to));
    const voteArms = region('-- 2a.', '-- 3.');
    expect(voteArms).toContain('-- 2a.');
    expect(voteArms).toContain('-- 2b.');
    expect(voteArms).toContain('-- 2c.');
    // 2a gates the native paper with validPevoPaperWhere; 2c gates the review.
    expect(voteArms).toContain('validPevoPaperWhere');
    expect(voteArms).toContain('validReviewWhere');
    // self-vote exclusion present in every vote sub-arm.
    expect(voteArms.match(/AND v\.voter != v\.author/g)?.length).toBe(3);

    // Per-arm target_type projection literal, pinned inside each arm's
    // tag-bounded slice. The SOURCE layer is the only one that consults
    // production's FIXED projection: the synthetic-VALUES canaries derive
    // target_type from their own fixture rows, so a production literal swap
    // (e.g. arm 2a/2b emitting 'review', or 2c emitting 'paper') is invisible to
    // them and only fails here.
    const arm2a = region('-- 2a.', '-- 2b.');
    const arm2b = region('-- 2b.', '-- 2c.');
    const arm2c = region('-- 2c.', '-- 3.');
    expect(arm2a).toContain("'paper'::text AS target_type");
    expect(arm2b).toContain("'paper'::text AS target_type");
    expect(arm2c).toContain("'review'::text AS target_type");

    // Arm 2b proves the bridge paper via an INNER JOIN to the user_bridge_papers
    // CTE; a LEFT variant would admit votes on unregistered bridge_papers.
    expect(arm2b).toContain('JOIN user_bridge_papers bp');
    expect(arm2b).not.toContain('LEFT JOIN user_bridge_papers');

    // The user_bridge_papers CTE's registered_by predicate is the bridge-paper
    // ownership gate: it admits a comments row only when source.registered_by
    // equals the recipient ($1). Dropping it would surface votes on any
    // bridge_paper, not just the recipient's registered ones.
    const cte = region('user_bridge_papers AS (', '-- 1a.');
    expect(cte).toContain("-> 'source' ->> 'registered_by' = $1");
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

  // Arms 8/9 must bind the signer to the REAL native post author, not the
  // JSON-self-asserted paper_author. The regression we guard against is a
  // refactor that reverts to the self-referential form
  // `required_posting_auths ->> 0 IN (cj.json ... 'paper_author', ...)`, which
  // an attacker passes by self-signing {paper_author:<self>, claimer:<victim>}.
  // The fix proves the named paper exists as a real PEvO native paper via
  // ${T.comments} + validPevoPaperWhere and equates the signer to that post's
  // actual author column.
  it('arms 8/9 claim approve/revoke: signer gate binds to the real native post author, not the self-asserted paper_author', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../src/notification-queries.ts', import.meta.url)),
      'utf8',
    );
    const arm8 = src.slice(src.indexOf('-- 8.'), src.indexOf('-- 9.'));
    const arm9 = src.slice(src.indexOf('-- 9.'), src.indexOf('ORDER BY block_num'));
    for (const [label, arm] of [['arm-8', arm8], ['arm-9', arm9]] as const) {
      // Existence proof present: EXISTS subquery against comments gated by
      // validPevoPaperWhere(source: 'native').
      expect(arm, `${label} carries an EXISTS existence proof`).toContain('EXISTS (');
      expect(arm, `${label} joins the comments table for the existence proof`).toContain('FROM ${T.comments}');
      expect(arm, `${label} gates the existence proof with validPevoPaperWhere`).toContain('validPevoPaperWhere');
      expect(arm, `${label} pins the existence proof to native papers`).toContain("source: 'native'");
      // Signer bound to the ACTUAL paper-row author column, not the JSON field.
      expect(arm, `${label} binds the signer to the real post author column`).toMatch(
        /cj\.required_posting_auths ->> 0 = \w+\.author/,
      );
      // The self-referential JSON-paper_author signer comparison must be gone:
      // the signer is NEVER compared directly to cj.json ... 'paper_author'.
      expect(
        arm.includes("required_posting_auths ->> 0 = cj.json::jsonb ->> 'paper_author'") ||
          arm.includes("required_posting_auths ->> 0 IN (cj.json::jsonb ->> 'paper_author'"),
        `${label} no longer trusts the self-asserted paper_author for the signer gate`,
      ).toBe(false);
    }
  });
});

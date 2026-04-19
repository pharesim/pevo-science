#!/usr/bin/env npx tsx
/**
 * Benchmark: per-user SQL queries vs single all-users query for reputation.
 *
 * Usage: source ~/.nvm/nvm.sh && nvm use 20
 *        cd backend && npx tsx tests/bench-reputation.ts
 *
 * Requires HAF_DATABASE_URL in .env (or env var).
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import pg from 'pg';

// Load .env manually
try {
  const envPath = resolve(import.meta.dirname || __dirname, '..', '..', '.env');
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

// ─── Config ──────────────────────────────────────────────────────

const HAF_URL = process.env.HAF_DATABASE_URL?.split(',')[0];
if (!HAF_URL) { console.error('HAF_DATABASE_URL not set'); process.exit(1); }

const APP_TAG = process.env.APP_TAG || 'pevotest';
const APP_LIKE = `${APP_TAG}/%`;

const T = {
  comments: 'hafsql.comments',
  commentOps: 'hafsql.operation_comment_view',
  voteOps: 'hafsql.operation_vote_view',
  customJson: 'hafsql.operation_custom_json_view',
  blocks: 'hafsql.haf_blocks',
};

// Default weights
const W = {
  paper: 20, review: 10, downvote: 2, citation: 3, citation_max: 15,
  accreditation_bonus: 5, self_citation_discount: 0.05,
  decay_rate: 0.02, decay_floor: 0.3, decay_grace_months: 6,
};

// ─── Shared setup ────────────────────────────────────────────────

async function setup(pool: pg.Pool) {
  // Genesis block
  const genesisResult = await pool.query(
    `SELECT MIN(cj.block_num) AS genesis
     FROM ${T.customJson} cj
     WHERE cj.custom_id = $1
       AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')`,
    [APP_TAG],
  );
  const genesis = Number(genesisResult.rows[0]?.genesis ?? 0);

  // Head block
  const headResult = await pool.query(`SELECT MAX(block_num) AS head FROM ${T.blocks}`);
  const headBlock = Number(headResult.rows[0]?.head ?? 0);

  // Accredited accounts
  const accredResult = await pool.query(
    `WITH accred_ranked AS (
       SELECT cj.json::jsonb ->> 'account' AS account,
              cj.json::jsonb ->> 'action' AS action,
              ROW_NUMBER() OVER (PARTITION BY cj.json::jsonb ->> 'account' ORDER BY cj.block_num DESC) AS rn
       FROM ${T.customJson} cj
       WHERE cj.custom_id = $1
         AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
         AND cj.block_num >= $2
     )
     SELECT account FROM accred_ranked WHERE rn = 1 AND action = 'accredit'`,
    [APP_TAG, genesis],
  );
  const accredited: string[] = accredResult.rows.map((r: any) => r.account);

  // Active accounts (users who have published or reviewed)
  const activeResult = await pool.query(
    `SELECT DISTINCT author FROM (
       SELECT c.author FROM ${T.comments} c
       WHERE c.parent_author = '' AND c.parent_permlink = $1
         AND (c.json_metadata -> $1 ->> 'type') IN ('paper', 'bridge_paper')
         AND c.json_metadata ->> 'app' LIKE $2
       UNION ALL
       SELECT c.author FROM ${T.comments} c
       JOIN ${T.comments} p ON p.author = c.parent_author AND p.permlink = c.parent_permlink
       WHERE p.parent_author = '' AND p.parent_permlink = $1
         AND p.json_metadata ->> 'app' LIKE $2
         AND (c.json_metadata -> $1 ->> 'type') = 'review'
         AND c.json_metadata ->> 'app' LIKE $2
     ) t`,
    [APP_TAG, APP_LIKE],
  );
  const activeUsers: string[] = activeResult.rows.map((r: any) => r.author);

  // Empty prev scores (bootstrap mode)
  const prevScores = '{}';

  return { genesis, headBlock, accredited, activeUsers, prevScores };
}

// ─── Per-user query (current approach) ───────────────────────────

const SINGLE_USER_SQL = `WITH
  cycle_ref AS (
    SELECT b.timestamp AS ref_ts FROM ${T.blocks} b WHERE b.block_num = $6 - 1
  ),
  prev_scores AS (
    SELECT key AS username, value::numeric AS rep FROM jsonb_each_text($5)
  ),
  active_accounts AS (
    SELECT DISTINCT author FROM (
      SELECT c.author FROM ${T.comments} c
      WHERE c.parent_author = '' AND c.parent_permlink = $3
        AND (c.json_metadata -> $3 ->> 'type') IN ('paper', 'bridge_paper')
        AND c.json_metadata ->> 'app' LIKE $4
      UNION ALL
      SELECT c.author FROM ${T.comments} c
      JOIN ${T.comments} p ON p.author = c.parent_author AND p.permlink = c.parent_permlink
      WHERE p.parent_author = '' AND p.parent_permlink = $3
        AND p.json_metadata ->> 'app' LIKE $4
        AND (c.json_metadata -> $3 ->> 'type') = 'review'
        AND c.json_metadata ->> 'app' LIKE $4
    ) t
  ),
  voter_weights AS (
    SELECT a.voter,
      CASE
        WHEN ps.rep IS NULL THEN 1.0
        WHEN aa.author IS NOT NULL THEN LEAST(1.0, GREATEST(0.4, 0.4 + 0.6 * sqrt(ps.rep / 100.0)))
        ELSE LEAST(1.0, sqrt(ps.rep / 100.0))
      END AS vw
    FROM unnest($2::text[]) AS a(voter)
    LEFT JOIN prev_scores ps ON ps.username = a.voter
    LEFT JOIN active_accounts aa ON aa.author = a.voter
  ),
  user_papers AS (
    SELECT c.author, c.permlink, c.created, c.json_metadata FROM ${T.comments} c
    WHERE c.author = $1 AND c.parent_author = '' AND c.parent_permlink = $3
      AND (c.json_metadata -> $3 ->> 'type') = 'paper'
      AND c.json_metadata ->> 'app' LIKE $4
      AND (c.json_metadata -> $3 -> 'continues') IS NULL
  ),
  paper_revisions AS (
    SELECT co.permlink, MAX(co.block_num) AS latest_revision_block
    FROM ${T.commentOps} co
    WHERE co.author = $1 AND co.parent_author = '' AND co.parent_permlink = $3 AND co.block_num < $6
    GROUP BY co.permlink HAVING COUNT(*) > 1
  ),
  paper_vote_signals AS (
    SELECT voter, permlink, weight, block_num FROM (
      SELECT vo.voter, vo.permlink, vo.weight, vo.block_num FROM ${T.voteOps} vo
      WHERE vo.voter = ANY($2::text[]) AND vo.author = $1
        AND vo.permlink IN (SELECT permlink FROM user_papers)
        AND vo.block_num >= $7 AND vo.block_num < $6
      UNION ALL
      SELECT cj.required_posting_auths ->> 0, cj.json::jsonb ->> 'permlink',
        (cj.json::jsonb ->> 'weight')::int, cj.block_num
      FROM ${T.customJson} cj
      WHERE cj.custom_id = $3 AND cj.json::jsonb ->> 'action' = 'revote'
        AND cj.json::jsonb ->> 'author' = $1
        AND cj.block_num >= $7 AND cj.block_num < $6
        AND cj.required_posting_auths ->> 0 = ANY($2::text[])
    ) all_signals
  ),
  paper_latest_votes AS (
    SELECT DISTINCT ON (voter, permlink) voter, permlink, weight, block_num
    FROM paper_vote_signals ORDER BY voter, permlink, block_num DESC
  ),
  paper_resolved_votes AS (
    SELECT plv.voter, plv.permlink, plv.weight
    FROM paper_latest_votes plv
    JOIN user_papers up ON up.permlink = plv.permlink
    LEFT JOIN paper_revisions prev ON prev.permlink = plv.permlink
    WHERE plv.voter != up.author AND plv.weight != 0
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(up.json_metadata -> $3 -> 'authors') a
        WHERE a ->> 'hive' = plv.voter
      )
      AND (prev.latest_revision_block IS NULL OR plv.block_num > prev.latest_revision_block)
  ),
  paper_reviews AS (
    SELECT up.permlink,
      AVG(((c.json_metadata -> $3 -> 'rating' ->> 'methodology')::numeric +
           (c.json_metadata -> $3 -> 'rating' ->> 'novelty')::numeric +
           (c.json_metadata -> $3 -> 'rating' ->> 'clarity')::numeric +
           (c.json_metadata -> $3 -> 'rating' ->> 'significance')::numeric) / 4.0) / 5.0 AS quality
    FROM user_papers up
    JOIN ${T.comments} c ON c.parent_author = up.author AND c.parent_permlink = up.permlink
      AND (c.json_metadata -> $3 ->> 'type') = 'review' AND c.json_metadata ->> 'app' LIKE $4
    GROUP BY up.permlink
  ),
  paper_vote_agg AS (
    SELECT prv.permlink,
      COALESCE(SUM(vw.vw * ABS(prv.weight) / 10000.0) FILTER (WHERE prv.weight > 0), 0) AS weighted_up,
      COALESCE(SUM(vw.vw * ABS(prv.weight) / 10000.0) FILTER (WHERE prv.weight < 0), 0) AS weighted_down
    FROM paper_resolved_votes prv JOIN voter_weights vw ON vw.voter = prv.voter GROUP BY prv.permlink
  ),
  paper_scores AS (
    SELECT up.permlink, up.author,
      GREATEST(-$8::numeric, LEAST($8::numeric,
        COALESCE(pr.quality, 1.0) * LEAST(COALESCE(pva.weighted_up, 0), $8::numeric)
        - COALESCE(pva.weighted_down, 0) * $10
      )) * GREATEST($16::numeric, CASE
        WHEN EXTRACT(EPOCH FROM (cr.ref_ts - up.created)) / (86400.0 * 30) <= $17::numeric THEN 1.0
        ELSE GREATEST($16::numeric, 1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - up.created)) / (86400.0 * 30) - $17::numeric) * $15::numeric))
      END) AS score
    FROM user_papers up CROSS JOIN cycle_ref cr
    LEFT JOIN paper_reviews pr ON pr.permlink = up.permlink
    LEFT JOIN paper_vote_agg pva ON pva.permlink = up.permlink
  ),
  user_reviews AS (
    SELECT c.author, c.permlink, c.created FROM ${T.comments} c
    WHERE c.author = $1 AND (c.json_metadata -> $3 ->> 'type') = 'review'
      AND c.json_metadata ->> 'app' LIKE $4
      AND COALESCE(c.json_metadata -> $3 ->> 'is_anonymous', 'false') != 'true'
  ),
  review_vote_signals AS (
    SELECT voter, permlink, weight, block_num FROM (
      SELECT vo.voter, vo.permlink, vo.weight, vo.block_num FROM ${T.voteOps} vo
      WHERE vo.voter = ANY($2::text[]) AND vo.author = $1
        AND vo.permlink IN (SELECT permlink FROM user_reviews)
        AND vo.block_num >= $7 AND vo.block_num < $6
      UNION ALL
      SELECT cj.required_posting_auths ->> 0, cj.json::jsonb ->> 'permlink',
        (cj.json::jsonb ->> 'weight')::int, cj.block_num
      FROM ${T.customJson} cj
      WHERE cj.custom_id = $3 AND cj.json::jsonb ->> 'action' = 'revote'
        AND cj.json::jsonb ->> 'author' = $1
        AND cj.block_num >= $7 AND cj.block_num < $6
        AND cj.required_posting_auths ->> 0 = ANY($2::text[])
    ) all_signals
  ),
  review_latest_votes AS (
    SELECT DISTINCT ON (voter, permlink) voter, permlink, weight
    FROM review_vote_signals ORDER BY voter, permlink, block_num DESC
  ),
  review_resolved_votes AS (
    SELECT rlv.voter, rlv.permlink, rlv.weight FROM review_latest_votes rlv
    WHERE rlv.voter != $1 AND rlv.weight != 0
  ),
  review_vote_agg AS (
    SELECT rrv.permlink,
      COALESCE(SUM(vw.vw * ABS(rrv.weight) / 10000.0) FILTER (WHERE rrv.weight > 0), 0) AS weighted_up,
      COALESCE(SUM(vw.vw * ABS(rrv.weight) / 10000.0) FILTER (WHERE rrv.weight < 0), 0) AS weighted_down
    FROM review_resolved_votes rrv JOIN voter_weights vw ON vw.voter = rrv.voter GROUP BY rrv.permlink
  ),
  review_scores AS (
    SELECT ur.permlink, ur.author,
      GREATEST(-$9::numeric, LEAST($9::numeric,
        LEAST(COALESCE(rva.weighted_up, 0), $9::numeric) - COALESCE(rva.weighted_down, 0) * $10
      )) * GREATEST($16::numeric, CASE
        WHEN EXTRACT(EPOCH FROM (cr.ref_ts - ur.created)) / (86400.0 * 30) <= $17::numeric THEN 1.0
        ELSE GREATEST($16::numeric, 1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - ur.created)) / (86400.0 * 30) - $17::numeric) * $15::numeric))
      END) AS score
    FROM user_reviews ur CROSS JOIN cycle_ref cr
    LEFT JOIN review_vote_agg rva ON rva.permlink = ur.permlink
  ),
  citing_papers AS (
    SELECT citing.author AS citing_author, citing.permlink AS citing_permlink,
      citing.created AS citing_created, citing.json_metadata AS citing_meta,
      COALESCE((cit ->> 'reputation_relevant')::boolean, true) AS reputation_relevant,
      cit ->> 'author' AS cited_author
    FROM ${T.comments} citing
    CROSS JOIN LATERAL jsonb_array_elements(citing.json_metadata -> $3 -> 'citations') AS cit
    WHERE citing.parent_author = '' AND citing.parent_permlink = $3
      AND (citing.json_metadata -> $3 ->> 'type') = 'paper'
      AND citing.json_metadata ->> 'app' LIKE $4
      AND jsonb_typeof(citing.json_metadata -> $3 -> 'citations') = 'array'
      AND citing.author = ANY($2::text[])
      AND (cit ->> 'author') = $1
      AND COALESCE((cit ->> 'reputation_relevant')::boolean, true) = true
  ),
  citing_vote_signals AS (
    SELECT voter, permlink, author, weight, block_num FROM (
      SELECT vo.voter, vo.permlink, vo.author, vo.weight, vo.block_num FROM ${T.voteOps} vo
      WHERE vo.voter = ANY($2::text[])
        AND (vo.author, vo.permlink) IN (SELECT citing_author, citing_permlink FROM citing_papers)
        AND vo.block_num >= $7 AND vo.block_num < $6
      UNION ALL
      SELECT cj.required_posting_auths ->> 0, cj.json::jsonb ->> 'permlink',
        cj.json::jsonb ->> 'author', (cj.json::jsonb ->> 'weight')::int, cj.block_num
      FROM ${T.customJson} cj
      WHERE cj.custom_id = $3 AND cj.json::jsonb ->> 'action' = 'revote'
        AND cj.block_num >= $7 AND cj.block_num < $6
        AND cj.required_posting_auths ->> 0 = ANY($2::text[])
        AND (cj.json::jsonb ->> 'author', cj.json::jsonb ->> 'permlink')
          IN (SELECT citing_author, citing_permlink FROM citing_papers)
    ) all_signals
  ),
  citing_latest_votes AS (
    SELECT DISTINCT ON (voter, author, permlink) voter, author, permlink, weight
    FROM citing_vote_signals ORDER BY voter, author, permlink, block_num DESC
  ),
  citing_paper_quality AS (
    SELECT cp.citing_author, cp.citing_permlink, cp.citing_created,
      cp.citing_author = $1 AS is_self,
      COALESCE(cpr.quality, 1.0) AS review_quality,
      COALESCE(SUM(vw.vw * ABS(clv.weight) / 10000.0)
        FILTER (WHERE clv.weight > 0 AND clv.voter != cp.citing_author AND clv.weight != 0), 0
      ) AS weighted_upvotes
    FROM citing_papers cp
    LEFT JOIN (
      SELECT up2.permlink, up2.author,
        AVG(((c2.json_metadata -> $3 -> 'rating' ->> 'methodology')::numeric +
             (c2.json_metadata -> $3 -> 'rating' ->> 'novelty')::numeric +
             (c2.json_metadata -> $3 -> 'rating' ->> 'clarity')::numeric +
             (c2.json_metadata -> $3 -> 'rating' ->> 'significance')::numeric) / 4.0) / 5.0 AS quality
      FROM ${T.comments} up2
      JOIN ${T.comments} c2 ON c2.parent_author = up2.author AND c2.parent_permlink = up2.permlink
        AND (c2.json_metadata -> $3 ->> 'type') = 'review' AND c2.json_metadata ->> 'app' LIKE $4
      WHERE (up2.author, up2.permlink) IN (SELECT citing_author, citing_permlink FROM citing_papers)
      GROUP BY up2.permlink, up2.author
    ) cpr ON cpr.author = cp.citing_author AND cpr.permlink = cp.citing_permlink
    LEFT JOIN citing_latest_votes clv ON clv.author = cp.citing_author AND clv.permlink = cp.citing_permlink
    LEFT JOIN voter_weights vw ON vw.voter = clv.voter
    GROUP BY cp.citing_author, cp.citing_permlink, cp.citing_created, cpr.quality
  ),
  citation_scores AS (
    SELECT LEAST($12::numeric, COALESCE(SUM(
      GREATEST(0, LEAST(1.0, cpq.review_quality * LEAST(cpq.weighted_upvotes, 1.0)))
      * CASE WHEN cpq.is_self THEN $14::numeric ELSE $11::numeric END
      * GREATEST($16::numeric, CASE
        WHEN EXTRACT(EPOCH FROM (cr.ref_ts - cpq.citing_created)) / (86400.0 * 30) <= $17::numeric THEN 1.0
        ELSE GREATEST($16::numeric, 1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - cpq.citing_created)) / (86400.0 * 30) - $17::numeric) * $15::numeric))
      END)
    ), 0)) AS score
    FROM citing_paper_quality cpq CROSS JOIN cycle_ref cr
  ),
  totals AS (
    SELECT
      COALESCE((SELECT SUM(score) FROM paper_scores), 0) AS papers,
      COALESCE((SELECT SUM(score) FROM review_scores), 0) AS reviews,
      COALESCE((SELECT score FROM citation_scores), 0) AS citations,
      CASE WHEN $18 THEN $13::numeric ELSE 0 END AS accreditation
  )
  SELECT
    LEAST(100, GREATEST(0, ROUND((papers + reviews + citations + accreditation)::numeric, 1))) AS score,
    ROUND(papers::numeric, 1) AS papers,
    ROUND(reviews::numeric, 1) AS reviews,
    ROUND(citations::numeric, 1) AS citations,
    accreditation::numeric AS accreditation
  FROM totals`;

// ─── All-users query (new approach) ──────────────────────────────

const ALL_USERS_SQL = `WITH
  target_users AS (
    SELECT unnest AS username FROM unnest($1::text[])
  ),
  cycle_ref AS (
    SELECT b.timestamp AS ref_ts FROM ${T.blocks} b WHERE b.block_num = $6 - 1
  ),
  prev_scores AS (
    SELECT key AS username, value::numeric AS rep FROM jsonb_each_text($5)
  ),
  active_accounts AS (
    SELECT DISTINCT author FROM (
      SELECT c.author FROM ${T.comments} c
      WHERE c.parent_author = '' AND c.parent_permlink = $3
        AND (c.json_metadata -> $3 ->> 'type') IN ('paper', 'bridge_paper')
        AND c.json_metadata ->> 'app' LIKE $4
      UNION ALL
      SELECT c.author FROM ${T.comments} c
      JOIN ${T.comments} p ON p.author = c.parent_author AND p.permlink = c.parent_permlink
      WHERE p.parent_author = '' AND p.parent_permlink = $3
        AND p.json_metadata ->> 'app' LIKE $4
        AND (c.json_metadata -> $3 ->> 'type') = 'review'
        AND c.json_metadata ->> 'app' LIKE $4
    ) t
  ),
  voter_weights AS (
    SELECT a.voter,
      CASE
        WHEN ps.rep IS NULL THEN 1.0
        WHEN aa.author IS NOT NULL THEN LEAST(1.0, GREATEST(0.4, 0.4 + 0.6 * sqrt(ps.rep / 100.0)))
        ELSE LEAST(1.0, sqrt(ps.rep / 100.0))
      END AS vw
    FROM unnest($2::text[]) AS a(voter)
    LEFT JOIN prev_scores ps ON ps.username = a.voter
    LEFT JOIN active_accounts aa ON aa.author = a.voter
  ),

  -- PAPERS (all target users at once)
  user_papers AS (
    SELECT c.author, c.permlink, c.created, c.json_metadata FROM ${T.comments} c
    WHERE c.author IN (SELECT username FROM target_users)
      AND c.parent_author = '' AND c.parent_permlink = $3
      AND (c.json_metadata -> $3 ->> 'type') = 'paper'
      AND c.json_metadata ->> 'app' LIKE $4
      AND (c.json_metadata -> $3 -> 'continues') IS NULL
  ),
  paper_revisions AS (
    SELECT co.author, co.permlink, MAX(co.block_num) AS latest_revision_block
    FROM ${T.commentOps} co
    WHERE co.author IN (SELECT username FROM target_users)
      AND co.parent_author = '' AND co.parent_permlink = $3 AND co.block_num < $6
    GROUP BY co.author, co.permlink HAVING COUNT(*) > 1
  ),
  paper_vote_signals AS (
    SELECT voter, author, permlink, weight, block_num FROM (
      SELECT vo.voter, vo.author, vo.permlink, vo.weight, vo.block_num FROM ${T.voteOps} vo
      WHERE vo.voter = ANY($2::text[])
        AND vo.author IN (SELECT username FROM target_users)
        AND vo.permlink IN (SELECT permlink FROM user_papers WHERE user_papers.author = vo.author)
        AND vo.block_num >= $7 AND vo.block_num < $6
      UNION ALL
      SELECT cj.required_posting_auths ->> 0,
        cj.json::jsonb ->> 'author',
        cj.json::jsonb ->> 'permlink',
        (cj.json::jsonb ->> 'weight')::int, cj.block_num
      FROM ${T.customJson} cj
      WHERE cj.custom_id = $3 AND cj.json::jsonb ->> 'action' = 'revote'
        AND cj.json::jsonb ->> 'author' IN (SELECT username FROM target_users)
        AND cj.block_num >= $7 AND cj.block_num < $6
        AND cj.required_posting_auths ->> 0 = ANY($2::text[])
    ) all_signals
  ),
  paper_latest_votes AS (
    SELECT DISTINCT ON (voter, author, permlink) voter, author, permlink, weight, block_num
    FROM paper_vote_signals ORDER BY voter, author, permlink, block_num DESC
  ),
  paper_resolved_votes AS (
    SELECT plv.voter, plv.author, plv.permlink, plv.weight, plv.block_num
    FROM paper_latest_votes plv
    JOIN user_papers up ON up.author = plv.author AND up.permlink = plv.permlink
    LEFT JOIN paper_revisions prev ON prev.author = plv.author AND prev.permlink = plv.permlink
    WHERE plv.voter != up.author AND plv.weight != 0
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(up.json_metadata -> $3 -> 'authors') a
        WHERE a ->> 'hive' = plv.voter
      )
      AND (prev.latest_revision_block IS NULL OR plv.block_num > prev.latest_revision_block)
  ),
  paper_reviews AS (
    SELECT up.author, up.permlink,
      AVG(((c.json_metadata -> $3 -> 'rating' ->> 'methodology')::numeric +
           (c.json_metadata -> $3 -> 'rating' ->> 'novelty')::numeric +
           (c.json_metadata -> $3 -> 'rating' ->> 'clarity')::numeric +
           (c.json_metadata -> $3 -> 'rating' ->> 'significance')::numeric) / 4.0) / 5.0 AS quality
    FROM user_papers up
    JOIN ${T.comments} c ON c.parent_author = up.author AND c.parent_permlink = up.permlink
      AND (c.json_metadata -> $3 ->> 'type') = 'review' AND c.json_metadata ->> 'app' LIKE $4
    GROUP BY up.author, up.permlink
  ),
  paper_vote_agg AS (
    SELECT prv.author, prv.permlink,
      COALESCE(SUM(vw.vw * ABS(prv.weight) / 10000.0) FILTER (WHERE prv.weight > 0), 0) AS weighted_up,
      COALESCE(SUM(vw.vw * ABS(prv.weight) / 10000.0) FILTER (WHERE prv.weight < 0), 0) AS weighted_down
    FROM paper_resolved_votes prv JOIN voter_weights vw ON vw.voter = prv.voter
    GROUP BY prv.author, prv.permlink
  ),
  paper_scores AS (
    SELECT up.author, up.permlink,
      GREATEST(-$8::numeric, LEAST($8::numeric,
        COALESCE(pr.quality, 1.0) * LEAST(COALESCE(pva.weighted_up, 0), $8::numeric)
        - COALESCE(pva.weighted_down, 0) * $10
      )) * GREATEST($16::numeric, CASE
        WHEN EXTRACT(EPOCH FROM (cr.ref_ts - up.created)) / (86400.0 * 30) <= $17::numeric THEN 1.0
        ELSE GREATEST($16::numeric, 1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - up.created)) / (86400.0 * 30) - $17::numeric) * $15::numeric))
      END) AS score
    FROM user_papers up CROSS JOIN cycle_ref cr
    LEFT JOIN paper_reviews pr ON pr.author = up.author AND pr.permlink = up.permlink
    LEFT JOIN paper_vote_agg pva ON pva.author = up.author AND pva.permlink = up.permlink
  ),

  -- REVIEWS (all target users at once)
  user_reviews AS (
    SELECT c.author, c.permlink, c.created FROM ${T.comments} c
    WHERE c.author IN (SELECT username FROM target_users)
      AND (c.json_metadata -> $3 ->> 'type') = 'review'
      AND c.json_metadata ->> 'app' LIKE $4
      AND COALESCE(c.json_metadata -> $3 ->> 'is_anonymous', 'false') != 'true'
  ),
  review_vote_signals AS (
    SELECT voter, author, permlink, weight, block_num FROM (
      SELECT vo.voter, vo.author, vo.permlink, vo.weight, vo.block_num FROM ${T.voteOps} vo
      WHERE vo.voter = ANY($2::text[])
        AND vo.author IN (SELECT username FROM target_users)
        AND vo.permlink IN (SELECT permlink FROM user_reviews WHERE user_reviews.author = vo.author)
        AND vo.block_num >= $7 AND vo.block_num < $6
      UNION ALL
      SELECT cj.required_posting_auths ->> 0,
        cj.json::jsonb ->> 'author',
        cj.json::jsonb ->> 'permlink',
        (cj.json::jsonb ->> 'weight')::int, cj.block_num
      FROM ${T.customJson} cj
      WHERE cj.custom_id = $3 AND cj.json::jsonb ->> 'action' = 'revote'
        AND cj.json::jsonb ->> 'author' IN (SELECT username FROM target_users)
        AND cj.block_num >= $7 AND cj.block_num < $6
        AND cj.required_posting_auths ->> 0 = ANY($2::text[])
    ) all_signals
  ),
  review_latest_votes AS (
    SELECT DISTINCT ON (voter, author, permlink) voter, author, permlink, weight
    FROM review_vote_signals ORDER BY voter, author, permlink, block_num DESC
  ),
  review_resolved_votes AS (
    SELECT rlv.voter, rlv.author, rlv.permlink, rlv.weight FROM review_latest_votes rlv
    JOIN user_reviews ur ON ur.author = rlv.author AND ur.permlink = rlv.permlink
    WHERE rlv.voter != rlv.author AND rlv.weight != 0
  ),
  review_vote_agg AS (
    SELECT rrv.author, rrv.permlink,
      COALESCE(SUM(vw.vw * ABS(rrv.weight) / 10000.0) FILTER (WHERE rrv.weight > 0), 0) AS weighted_up,
      COALESCE(SUM(vw.vw * ABS(rrv.weight) / 10000.0) FILTER (WHERE rrv.weight < 0), 0) AS weighted_down
    FROM review_resolved_votes rrv JOIN voter_weights vw ON vw.voter = rrv.voter
    GROUP BY rrv.author, rrv.permlink
  ),
  review_scores AS (
    SELECT ur.author, ur.permlink,
      GREATEST(-$9::numeric, LEAST($9::numeric,
        LEAST(COALESCE(rva.weighted_up, 0), $9::numeric) - COALESCE(rva.weighted_down, 0) * $10
      )) * GREATEST($16::numeric, CASE
        WHEN EXTRACT(EPOCH FROM (cr.ref_ts - ur.created)) / (86400.0 * 30) <= $17::numeric THEN 1.0
        ELSE GREATEST($16::numeric, 1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - ur.created)) / (86400.0 * 30) - $17::numeric) * $15::numeric))
      END) AS score
    FROM user_reviews ur CROSS JOIN cycle_ref cr
    LEFT JOIN review_vote_agg rva ON rva.author = ur.author AND rva.permlink = ur.permlink
  ),

  -- CITATIONS (all target users at once)
  citing_papers AS (
    SELECT citing.author AS citing_author, citing.permlink AS citing_permlink,
      citing.created AS citing_created, citing.json_metadata AS citing_meta,
      cit ->> 'author' AS cited_author,
      COALESCE((cit ->> 'reputation_relevant')::boolean, true) AS reputation_relevant
    FROM ${T.comments} citing
    CROSS JOIN LATERAL jsonb_array_elements(citing.json_metadata -> $3 -> 'citations') AS cit
    WHERE citing.parent_author = '' AND citing.parent_permlink = $3
      AND (citing.json_metadata -> $3 ->> 'type') = 'paper'
      AND citing.json_metadata ->> 'app' LIKE $4
      AND jsonb_typeof(citing.json_metadata -> $3 -> 'citations') = 'array'
      AND citing.author = ANY($2::text[])
      AND (cit ->> 'author') IN (SELECT username FROM target_users)
      AND COALESCE((cit ->> 'reputation_relevant')::boolean, true) = true
  ),
  citing_vote_signals AS (
    SELECT voter, permlink, author, weight, block_num FROM (
      SELECT vo.voter, vo.permlink, vo.author, vo.weight, vo.block_num FROM ${T.voteOps} vo
      WHERE vo.voter = ANY($2::text[])
        AND (vo.author, vo.permlink) IN (SELECT citing_author, citing_permlink FROM citing_papers)
        AND vo.block_num >= $7 AND vo.block_num < $6
      UNION ALL
      SELECT cj.required_posting_auths ->> 0, cj.json::jsonb ->> 'permlink',
        cj.json::jsonb ->> 'author', (cj.json::jsonb ->> 'weight')::int, cj.block_num
      FROM ${T.customJson} cj
      WHERE cj.custom_id = $3 AND cj.json::jsonb ->> 'action' = 'revote'
        AND cj.block_num >= $7 AND cj.block_num < $6
        AND cj.required_posting_auths ->> 0 = ANY($2::text[])
        AND (cj.json::jsonb ->> 'author', cj.json::jsonb ->> 'permlink')
          IN (SELECT citing_author, citing_permlink FROM citing_papers)
    ) all_signals
  ),
  citing_latest_votes AS (
    SELECT DISTINCT ON (voter, author, permlink) voter, author, permlink, weight
    FROM citing_vote_signals ORDER BY voter, author, permlink, block_num DESC
  ),
  citing_paper_quality AS (
    SELECT cp.cited_author, cp.citing_author, cp.citing_permlink, cp.citing_created,
      cp.citing_author = cp.cited_author AS is_self,
      COALESCE(cpr.quality, 1.0) AS review_quality,
      COALESCE(SUM(vw.vw * ABS(clv.weight) / 10000.0)
        FILTER (WHERE clv.weight > 0 AND clv.voter != cp.citing_author AND clv.weight != 0), 0
      ) AS weighted_upvotes
    FROM citing_papers cp
    LEFT JOIN (
      SELECT up2.permlink, up2.author,
        AVG(((c2.json_metadata -> $3 -> 'rating' ->> 'methodology')::numeric +
             (c2.json_metadata -> $3 -> 'rating' ->> 'novelty')::numeric +
             (c2.json_metadata -> $3 -> 'rating' ->> 'clarity')::numeric +
             (c2.json_metadata -> $3 -> 'rating' ->> 'significance')::numeric) / 4.0) / 5.0 AS quality
      FROM ${T.comments} up2
      JOIN ${T.comments} c2 ON c2.parent_author = up2.author AND c2.parent_permlink = up2.permlink
        AND (c2.json_metadata -> $3 ->> 'type') = 'review' AND c2.json_metadata ->> 'app' LIKE $4
      WHERE (up2.author, up2.permlink) IN (SELECT citing_author, citing_permlink FROM citing_papers)
      GROUP BY up2.permlink, up2.author
    ) cpr ON cpr.author = cp.citing_author AND cpr.permlink = cp.citing_permlink
    LEFT JOIN citing_latest_votes clv ON clv.author = cp.citing_author AND clv.permlink = cp.citing_permlink
    LEFT JOIN voter_weights vw ON vw.voter = clv.voter
    GROUP BY cp.cited_author, cp.citing_author, cp.citing_permlink, cp.citing_created, cpr.quality
  ),
  citation_scores AS (
    SELECT cpq.cited_author AS author,
      LEAST($12::numeric, SUM(
        GREATEST(0, LEAST(1.0, cpq.review_quality * LEAST(cpq.weighted_upvotes, 1.0)))
        * CASE WHEN cpq.is_self THEN $14::numeric ELSE $11::numeric END
        * GREATEST($16::numeric, CASE
          WHEN EXTRACT(EPOCH FROM (cr.ref_ts - cpq.citing_created)) / (86400.0 * 30) <= $17::numeric THEN 1.0
          ELSE GREATEST($16::numeric, 1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - cpq.citing_created)) / (86400.0 * 30) - $17::numeric) * $15::numeric))
        END)
      )) AS score
    FROM citing_paper_quality cpq CROSS JOIN cycle_ref cr
    GROUP BY cpq.cited_author
  ),

  -- FINAL: aggregate per target user
  totals AS (
    SELECT
      tu.username,
      COALESCE(ps_agg.papers, 0) AS papers,
      COALESCE(rs_agg.reviews, 0) AS reviews,
      COALESCE(cs.score, 0) AS citations,
      CASE WHEN tu.username = ANY($2::text[]) THEN $13::numeric ELSE 0 END AS accreditation
    FROM target_users tu
    LEFT JOIN (SELECT author, SUM(score) AS papers FROM paper_scores GROUP BY author) ps_agg ON ps_agg.author = tu.username
    LEFT JOIN (SELECT author, SUM(score) AS reviews FROM review_scores GROUP BY author) rs_agg ON rs_agg.author = tu.username
    LEFT JOIN citation_scores cs ON cs.author = tu.username
  )
  SELECT
    username,
    LEAST(100, GREATEST(0, ROUND((papers + reviews + citations + accreditation)::numeric, 1))) AS score,
    ROUND(papers::numeric, 1) AS papers,
    ROUND(reviews::numeric, 1) AS reviews,
    ROUND(citations::numeric, 1) AS citations,
    accreditation::numeric AS accreditation
  FROM totals`;

// ─── Benchmark runner ────────────────────────────────────────────

async function main() {
  const pool = new pg.Pool({ connectionString: HAF_URL, max: 10 });
  const { genesis, headBlock, accredited, activeUsers, prevScores } = await setup(pool);

  console.log(`APP_TAG:     ${APP_TAG}`);
  console.log(`Genesis:     ${genesis}`);
  console.log(`Head block:  ${headBlock}`);
  console.log(`Accredited:  ${accredited.length}`);
  console.log(`Active:      ${activeUsers.length}`);
  console.log('');

  if (activeUsers.length === 0) {
    console.log('No active users found. Nothing to benchmark.');
    await pool.end();
    return;
  }

  // ── Warmup: run one single-user query to warm Postgres caches ──
  console.log('Warming up Postgres caches...');
  await pool.query(SINGLE_USER_SQL, [
    activeUsers[0], accredited, APP_TAG, APP_LIKE, prevScores,
    headBlock, genesis,
    W.paper, W.review, W.downvote, W.citation, W.citation_max,
    W.accreditation_bonus, W.self_citation_discount,
    W.decay_rate, W.decay_floor, W.decay_grace_months,
    accredited.includes(activeUsers[0]),
  ]);
  console.log('');

  // ── Approach A: per-user queries (sequential, like batch with concurrency=1) ──
  console.log(`=== Approach A: ${activeUsers.length} per-user queries (sequential) ===`);
  const resultsA = new Map<string, number>();
  const startA = Date.now();
  for (const user of activeUsers) {
    const r = await pool.query(SINGLE_USER_SQL, [
      user, accredited, APP_TAG, APP_LIKE, prevScores,
      headBlock, genesis,
      W.paper, W.review, W.downvote, W.citation, W.citation_max,
      W.accreditation_bonus, W.self_citation_discount,
      W.decay_rate, W.decay_floor, W.decay_grace_months,
      accredited.includes(user),
    ]);
    resultsA.set(user, Number(r.rows[0]?.score ?? 0));
  }
  const durationA = Date.now() - startA;
  console.log(`  Total:   ${durationA}ms`);
  console.log(`  Per user: ${Math.round(durationA / activeUsers.length)}ms avg`);
  console.log('');

  // ── Approach B: single all-users query ──
  console.log(`=== Approach B: single all-users query ===`);
  const startB = Date.now();
  const resultB = await pool.query(ALL_USERS_SQL, [
    activeUsers, accredited, APP_TAG, APP_LIKE, prevScores,
    headBlock, genesis,
    W.paper, W.review, W.downvote, W.citation, W.citation_max,
    W.accreditation_bonus, W.self_citation_discount,
    W.decay_rate, W.decay_floor, W.decay_grace_months,
  ]);
  const durationB = Date.now() - startB;
  const resultsB = new Map<string, number>();
  for (const row of resultB.rows) {
    resultsB.set(row.username, Number(row.score));
  }
  console.log(`  Total:   ${durationB}ms`);
  console.log(`  Users:   ${resultsB.size}`);
  console.log('');

  // ── Compare results ──
  console.log('=== Comparison ===');
  console.log(`  Speedup: ${(durationA / durationB).toFixed(1)}x`);
  console.log('');

  // Verify scores match
  let mismatches = 0;
  for (const user of activeUsers) {
    const a = resultsA.get(user) ?? 0;
    const b = resultsB.get(user) ?? 0;
    if (Math.abs(a - b) > 0.1) {
      console.log(`  MISMATCH: ${user}: A=${a}, B=${b}`);
      mismatches++;
    }
  }
  if (mismatches === 0) {
    console.log('  Scores match across all users.');
  } else {
    console.log(`  ${mismatches} mismatches found!`);
  }

  // Show breakdowns for debugging
  console.log('  Breakdowns (all-users):');
  for (const row of resultB.rows) {
    console.log(`    ${row.username}: score=${row.score} papers=${row.papers} reviews=${row.reviews} citations=${row.citations} accreditation=${row.accreditation}`);
  }
  console.log('');
  console.log('  Breakdowns (per-user):');
  for (const user of activeUsers) {
    const r = await pool.query(SINGLE_USER_SQL, [
      user, accredited, APP_TAG, APP_LIKE, prevScores,
      headBlock, genesis,
      W.paper, W.review, W.downvote, W.citation, W.citation_max,
      W.accreditation_bonus, W.self_citation_discount,
      W.decay_rate, W.decay_floor, W.decay_grace_months,
      accredited.includes(user),
    ]);
    const row = r.rows[0];
    console.log(`    ${user}: score=${row.score} papers=${row.papers} reviews=${row.reviews} citations=${row.citations} accreditation=${row.accreditation}`);
  }

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });

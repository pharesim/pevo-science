/**
 * Reputation computation module.
 *
 * All reputation is computed via the canonical SQL query against HAF.
 * Voter weighting, decay, and vote resolution live entirely in SQL.
 */
import pg from 'pg';
import { getPool, isHafAvailable } from './db.js';
import { config } from './config.js';
import { getAllAccreditedAccounts } from './accreditation.js';
import { hafCache } from './cache.js';
import { getRedis } from './redis.js';
import { logger } from './logger.js';
import { DEFAULT_REPUTATION_WEIGHTS, type ReputationWeights, type ReputationScore } from './types/index.js';
import { T, getCachedGenesisBlock } from './hafsql.js';

const REPUTATION_CACHE_TTL = 60 * 60_000; // 1 hour

async function loadActiveAccounts(): Promise<string[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    // Use UNION to avoid full-table scan: papers are found by parent_permlink (indexed),
    // reviews are found by joining through their parent paper.
    const result = await pool.query(
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
      [config.appTag, `${config.appTag}/%`],
    );
    return result.rows.map((r: { author: string }) => r.author);
  } catch (err) {
    logger.warn({ err }, 'Failed to query active PEvO accounts');
    return [];
  }
}

/**
 * Get all accounts that have published at least one PEvO paper or review.
 * Cached as Set<string> with 1h TTL. Used for activity-gated voter weight (R9).
 */
export async function getActiveAccounts(): Promise<Set<string>> {
  const arr = await hafCache.getOrSet<string[]>('active_pevo_accounts', loadActiveAccounts, REPUTATION_CACHE_TTL, true);
  return new Set(arr);
}

/** Warm the active accounts cache at startup via periodic refresh. */
export async function startActiveAccountsCache(): Promise<void> {
  await hafCache.registerPeriodicRefresh('active_pevo_accounts', loadActiveAccounts, REPUTATION_CACHE_TTL);
  logger.info('Active accounts cache loaded');
}

/**
 * Read batch-computed reputation scores from Redis.
 * Returns empty map if Redis unavailable or no batch scores exist.
 */
export async function getBatchReputationMap(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const redis = getRedis();
  if (!redis) return map;

  try {
    const keys = await redis.keys('reputation:batch:*');
    if (keys.length === 0) return map;

    const values = await redis.mget(keys);
    for (let i = 0; i < keys.length; i++) {
      const username = keys[i].replace('reputation:batch:', '');
      const score = values[i] !== null ? Number(values[i]) : undefined;
      if (score !== undefined && !isNaN(score)) {
        map.set(username, score);
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to read batch reputation scores from Redis');
  }
  return map;
}

// ─── Weights ────────────────────────────────────────────────────

const WEIGHTS_TTL = 30 * 60_000;

async function loadReputationWeights(): Promise<ReputationWeights> {
  const pool = getPool();
  if (!pool) return DEFAULT_REPUTATION_WEIGHTS;

  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 2000');

    const exists = await client.query(
      `SELECT 1 FROM ${T.customJson} cj
       WHERE cj.custom_id = $1
         AND cj.json LIKE '%update_weights%'
         AND cj.block_num >= $2
       LIMIT 1`,
      [config.appTag, getCachedGenesisBlock()],
    );

    if (exists.rows.length === 0) {
      await client.query('COMMIT');
      client.release();
      return DEFAULT_REPUTATION_WEIGHTS;
    }

    await client.query('SET LOCAL statement_timeout = 5000');
    const result = await client.query(
      `SELECT cj.json FROM ${T.customJson} cj
       WHERE cj.custom_id = $1
         AND cj.json::jsonb ->> 'action' = 'update_weights'
         AND cj.block_num >= $2
       ORDER BY cj.block_num DESC
       LIMIT 1`,
      [config.appTag, getCachedGenesisBlock()],
    );
    await client.query('COMMIT');
    client.release();

    if (result.rows.length === 0) return DEFAULT_REPUTATION_WEIGHTS;

    const payload = typeof result.rows[0].json === 'string'
      ? JSON.parse(result.rows[0].json)
      : result.rows[0].json;

    return { ...DEFAULT_REPUTATION_WEIGHTS, ...payload.weights };
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    logger.warn({ err }, 'Reputation weights query failed, using defaults');
    return DEFAULT_REPUTATION_WEIGHTS;
  }
}

export async function getReputationWeights(): Promise<ReputationWeights> {
  return hafCache.getOrSet<ReputationWeights>('reputation_weights', loadReputationWeights, WEIGHTS_TTL, true);
}

/** Warm the reputation weights cache at startup via periodic refresh. */
export async function startReputationWeightsCache(): Promise<void> {
  await hafCache.registerPeriodicRefresh('reputation_weights', loadReputationWeights, WEIGHTS_TTL);
  logger.info('Reputation weights cache loaded');
}

// ─── SQL Reputation Computation ───────────────────────────────

/**
 * Compute reputation for multiple users in a single SQL query.
 * Shared CTEs (voter_weights, active_accounts, etc.) run once.
 *
 * Parameters: $1 = target usernames, $2 = accredited, $3 = app_tag,
 * $4 = app_like, $5 = prev scores jsonb, $6 = cycle_end_block,
 * $7 = genesis block, $8-$17 = weights (cast once in `w` CTE).
 */
export async function computeReputationBatch(
  usernames: string[],
  prevScores?: Record<string, number>,
  cycleEndBlock?: number,
): Promise<Map<string, ReputationScore>> {
  const results = new Map<string, ReputationScore>();
  if (usernames.length === 0) return results;

  const pool = getPool();
  if (!pool) return results;

  try {
    const [accreditedAccounts, weights] = await Promise.all([
      getAllAccreditedAccounts(),
      getReputationWeights(),
    ]);

    const accreditedArr = [...accreditedAccounts];

    let endBlock = cycleEndBlock;
    if (!endBlock) {
      const headResult = await pool.query(`SELECT MAX(block_num) AS head FROM ${T.blocks}`, []);
      endBlock = Number(headResult.rows[0]?.head ?? 0);
      if (endBlock === 0) return results;
    }

    const prevJson = prevScores ?? Object.fromEntries(await getBatchReputationMap());

    const result = await pool.query(
      `WITH

      -- Cast weight parameters once
      w AS (SELECT
        $8::numeric  AS paper,
        $9::numeric  AS review,
        $10::numeric AS downvote,
        $11::numeric AS citation,
        $12::numeric AS citation_max,
        $13::numeric AS accreditation_bonus,
        $14::numeric AS self_citation_discount,
        $15::numeric AS decay_rate,
        $16::numeric AS decay_floor,
        $17::numeric AS decay_grace_months
      ),

      target_users AS (
        SELECT unnest AS username FROM unnest($1::text[])
      ),

      cycle_ref AS (
        SELECT b.timestamp AS ref_ts
        FROM ${T.blocks} b
        WHERE b.block_num = $6 - 1
      ),

      prev_scores AS (
        SELECT key AS username, value::numeric AS rep
        FROM jsonb_each_text($5)
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
        SELECT
          a.voter,
          CASE
            WHEN ps.rep IS NULL THEN 1.0
            WHEN aa.author IS NOT NULL THEN
              LEAST(1.0, GREATEST(0.4, 0.4 + 0.6 * sqrt(ps.rep / 100.0)))
            ELSE
              LEAST(1.0, sqrt(ps.rep / 100.0))
          END AS vw
        FROM unnest($2::text[]) AS a(voter)
        LEFT JOIN prev_scores ps ON ps.username = a.voter
        LEFT JOIN active_accounts aa ON aa.author = a.voter
      ),

      -- ═══ PAPERS ═══
      user_papers AS (
        SELECT c.author, c.permlink, c.created, c.json_metadata
        FROM ${T.comments} c
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
          AND co.parent_author = '' AND co.parent_permlink = $3
          AND co.block_num < $6
        GROUP BY co.author, co.permlink
        HAVING COUNT(*) > 1
      ),

      paper_vote_signals AS (
        SELECT voter, author, permlink, weight, block_num FROM (
          SELECT vo.voter, vo.author, vo.permlink, vo.weight, vo.block_num
          FROM ${T.voteOps} vo
          WHERE vo.voter = ANY($2::text[])
            AND vo.author IN (SELECT username FROM target_users)
            AND EXISTS (SELECT 1 FROM user_papers up WHERE up.author = vo.author AND up.permlink = vo.permlink)
            AND vo.block_num >= $7 AND vo.block_num < $6
          UNION ALL
          SELECT
            cj.required_posting_auths ->> 0 AS voter,
            cj.json::jsonb ->> 'author' AS author,
            cj.json::jsonb ->> 'permlink' AS permlink,
            (cj.json::jsonb ->> 'weight')::int AS weight,
            cj.block_num
          FROM ${T.customJson} cj
          WHERE cj.custom_id = $3
            AND cj.json::jsonb ->> 'action' = 'revote'
            AND cj.json::jsonb ->> 'author' IN (SELECT username FROM target_users)
            AND cj.block_num >= $7 AND cj.block_num < $6
            AND cj.required_posting_auths ->> 0 = ANY($2::text[])
        ) all_signals
      ),

      paper_latest_votes AS (
        SELECT DISTINCT ON (voter, author, permlink) voter, author, permlink, weight, block_num
        FROM paper_vote_signals
        ORDER BY voter, author, permlink, block_num DESC
      ),

      paper_resolved_votes AS (
        SELECT plv.voter, plv.author, plv.permlink, plv.weight, plv.block_num
        FROM paper_latest_votes plv
        JOIN user_papers up ON up.author = plv.author AND up.permlink = plv.permlink
        LEFT JOIN paper_revisions prev ON prev.author = plv.author AND prev.permlink = plv.permlink
        WHERE plv.voter != up.author
          AND plv.weight != 0
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(up.json_metadata -> $3 -> 'authors') a
            WHERE a ->> 'hive' = plv.voter
          )
          AND (prev.latest_revision_block IS NULL OR plv.block_num > prev.latest_revision_block)
      ),

      paper_reviews AS (
        SELECT up.author, up.permlink,
          AVG(
            ((c.json_metadata -> $3 -> 'rating' ->> 'methodology')::numeric +
             (c.json_metadata -> $3 -> 'rating' ->> 'novelty')::numeric +
             (c.json_metadata -> $3 -> 'rating' ->> 'clarity')::numeric +
             (c.json_metadata -> $3 -> 'rating' ->> 'significance')::numeric) / 4.0
          ) / 5.0 AS quality
        FROM user_papers up
        JOIN ${T.comments} c
          ON c.parent_author = up.author AND c.parent_permlink = up.permlink
          AND (c.json_metadata -> $3 ->> 'type') = 'review'
          AND c.json_metadata ->> 'app' LIKE $4
        GROUP BY up.author, up.permlink
      ),

      paper_vote_agg AS (
        SELECT prv.author, prv.permlink,
          COALESCE(SUM(vw.vw * ABS(prv.weight) / 10000.0) FILTER (WHERE prv.weight > 0), 0) AS weighted_up,
          COALESCE(SUM(vw.vw * ABS(prv.weight) / 10000.0) FILTER (WHERE prv.weight < 0), 0) AS weighted_down
        FROM paper_resolved_votes prv
        JOIN voter_weights vw ON vw.voter = prv.voter
        GROUP BY prv.author, prv.permlink
      ),

      paper_scores AS (
        SELECT up.author, up.permlink,
          GREATEST(-w.paper, LEAST(w.paper,
            COALESCE(pr.quality, 1.0) * LEAST(COALESCE(pva.weighted_up, 0), w.paper)
            - COALESCE(pva.weighted_down, 0) * w.downvote
          )) * GREATEST(w.decay_floor,
            CASE
              WHEN EXTRACT(EPOCH FROM (cr.ref_ts - up.created)) / (86400.0 * 30) <= w.decay_grace_months THEN 1.0
              ELSE GREATEST(w.decay_floor,
                1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - up.created)) / (86400.0 * 30) - w.decay_grace_months) * w.decay_rate)
              )
            END
          ) AS score
        FROM user_papers up
        CROSS JOIN cycle_ref cr
        CROSS JOIN w
        LEFT JOIN paper_reviews pr ON pr.author = up.author AND pr.permlink = up.permlink
        LEFT JOIN paper_vote_agg pva ON pva.author = up.author AND pva.permlink = up.permlink
      ),

      -- ═══ REVIEWS ═══
      user_reviews AS (
        SELECT c.author, c.permlink, c.created
        FROM ${T.comments} c
        WHERE c.author IN (SELECT username FROM target_users)
          AND (c.json_metadata -> $3 ->> 'type') = 'review'
          AND c.json_metadata ->> 'app' LIKE $4
          AND COALESCE(c.json_metadata -> $3 ->> 'is_anonymous', 'false') != 'true'
      ),

      review_vote_signals AS (
        SELECT voter, author, permlink, weight, block_num FROM (
          SELECT vo.voter, vo.author, vo.permlink, vo.weight, vo.block_num
          FROM ${T.voteOps} vo
          WHERE vo.voter = ANY($2::text[])
            AND vo.author IN (SELECT username FROM target_users)
            AND EXISTS (SELECT 1 FROM user_reviews ur WHERE ur.author = vo.author AND ur.permlink = vo.permlink)
            AND vo.block_num >= $7 AND vo.block_num < $6
          UNION ALL
          SELECT
            cj.required_posting_auths ->> 0 AS voter,
            cj.json::jsonb ->> 'author' AS author,
            cj.json::jsonb ->> 'permlink' AS permlink,
            (cj.json::jsonb ->> 'weight')::int AS weight,
            cj.block_num
          FROM ${T.customJson} cj
          WHERE cj.custom_id = $3
            AND cj.json::jsonb ->> 'action' = 'revote'
            AND cj.json::jsonb ->> 'author' IN (SELECT username FROM target_users)
            AND cj.block_num >= $7 AND cj.block_num < $6
            AND cj.required_posting_auths ->> 0 = ANY($2::text[])
        ) all_signals
      ),

      review_latest_votes AS (
        SELECT DISTINCT ON (voter, author, permlink) voter, author, permlink, weight
        FROM review_vote_signals
        ORDER BY voter, author, permlink, block_num DESC
      ),

      review_resolved_votes AS (
        SELECT rlv.voter, rlv.author, rlv.permlink, rlv.weight
        FROM review_latest_votes rlv
        JOIN user_reviews ur ON ur.author = rlv.author AND ur.permlink = rlv.permlink
        WHERE rlv.voter != rlv.author
          AND rlv.weight != 0
      ),

      review_vote_agg AS (
        SELECT rrv.author, rrv.permlink,
          COALESCE(SUM(vw.vw * ABS(rrv.weight) / 10000.0) FILTER (WHERE rrv.weight > 0), 0) AS weighted_up,
          COALESCE(SUM(vw.vw * ABS(rrv.weight) / 10000.0) FILTER (WHERE rrv.weight < 0), 0) AS weighted_down
        FROM review_resolved_votes rrv
        JOIN voter_weights vw ON vw.voter = rrv.voter
        GROUP BY rrv.author, rrv.permlink
      ),

      review_scores AS (
        SELECT ur.author, ur.permlink,
          GREATEST(-w.review, LEAST(w.review,
            LEAST(COALESCE(rva.weighted_up, 0), w.review)
            - COALESCE(rva.weighted_down, 0) * w.downvote
          )) * GREATEST(w.decay_floor,
            CASE
              WHEN EXTRACT(EPOCH FROM (cr.ref_ts - ur.created)) / (86400.0 * 30) <= w.decay_grace_months THEN 1.0
              ELSE GREATEST(w.decay_floor,
                1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - ur.created)) / (86400.0 * 30) - w.decay_grace_months) * w.decay_rate)
              )
            END
          ) AS score
        FROM user_reviews ur
        CROSS JOIN cycle_ref cr
        CROSS JOIN w
        LEFT JOIN review_vote_agg rva ON rva.author = ur.author AND rva.permlink = ur.permlink
      ),

      -- ═══ CITATIONS ═══
      citing_papers AS (
        SELECT
          citing.author AS citing_author,
          citing.permlink AS citing_permlink,
          citing.created AS citing_created,
          citing.json_metadata AS citing_meta,
          cit ->> 'author' AS cited_author,
          COALESCE((cit ->> 'reputation_relevant')::boolean, true) AS reputation_relevant
        FROM ${T.comments} citing
        CROSS JOIN LATERAL jsonb_array_elements(
          citing.json_metadata -> $3 -> 'citations'
        ) AS cit
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
          SELECT vo.voter, vo.permlink, vo.author, vo.weight, vo.block_num
          FROM ${T.voteOps} vo
          WHERE vo.voter = ANY($2::text[])
            AND (vo.author, vo.permlink) IN (SELECT citing_author, citing_permlink FROM citing_papers)
            AND vo.block_num >= $7 AND vo.block_num < $6
          UNION ALL
          SELECT
            cj.required_posting_auths ->> 0 AS voter,
            cj.json::jsonb ->> 'permlink' AS permlink,
            cj.json::jsonb ->> 'author' AS author,
            (cj.json::jsonb ->> 'weight')::int AS weight,
            cj.block_num
          FROM ${T.customJson} cj
          WHERE cj.custom_id = $3
            AND cj.json::jsonb ->> 'action' = 'revote'
            AND cj.block_num >= $7 AND cj.block_num < $6
            AND cj.required_posting_auths ->> 0 = ANY($2::text[])
            AND (cj.json::jsonb ->> 'author', cj.json::jsonb ->> 'permlink')
              IN (SELECT citing_author, citing_permlink FROM citing_papers)
        ) all_signals
      ),

      citing_latest_votes AS (
        SELECT DISTINCT ON (voter, author, permlink) voter, author, permlink, weight
        FROM citing_vote_signals
        ORDER BY voter, author, permlink, block_num DESC
      ),

      citing_paper_quality AS (
        SELECT
          cp.cited_author,
          cp.citing_author,
          cp.citing_permlink,
          cp.citing_created,
          cp.citing_author = cp.cited_author AS is_self,
          COALESCE(cpr.quality, 1.0) AS review_quality,
          COALESCE(SUM(vw.vw * ABS(clv.weight) / 10000.0)
            FILTER (WHERE clv.weight > 0 AND clv.voter != cp.citing_author AND clv.weight != 0), 0
          ) AS weighted_upvotes
        FROM citing_papers cp
        LEFT JOIN (
          SELECT up2.permlink, up2.author,
            AVG(
              ((c2.json_metadata -> $3 -> 'rating' ->> 'methodology')::numeric +
               (c2.json_metadata -> $3 -> 'rating' ->> 'novelty')::numeric +
               (c2.json_metadata -> $3 -> 'rating' ->> 'clarity')::numeric +
               (c2.json_metadata -> $3 -> 'rating' ->> 'significance')::numeric) / 4.0
            ) / 5.0 AS quality
          FROM ${T.comments} up2
          JOIN ${T.comments} c2
            ON c2.parent_author = up2.author AND c2.parent_permlink = up2.permlink
            AND (c2.json_metadata -> $3 ->> 'type') = 'review'
            AND c2.json_metadata ->> 'app' LIKE $4
          WHERE (up2.author, up2.permlink) IN (SELECT citing_author, citing_permlink FROM citing_papers)
          GROUP BY up2.permlink, up2.author
        ) cpr ON cpr.author = cp.citing_author AND cpr.permlink = cp.citing_permlink
        LEFT JOIN citing_latest_votes clv
          ON clv.author = cp.citing_author AND clv.permlink = cp.citing_permlink
        LEFT JOIN voter_weights vw ON vw.voter = clv.voter
        GROUP BY cp.cited_author, cp.citing_author, cp.citing_permlink, cp.citing_created, cpr.quality
      ),

      citation_scores AS (
        SELECT cpq.cited_author AS author,
          LEAST(w.citation_max, COALESCE(SUM(
            GREATEST(0, LEAST(1.0, cpq.review_quality * LEAST(cpq.weighted_upvotes, 1.0)))
            * CASE WHEN cpq.is_self THEN w.self_citation_discount ELSE w.citation END
            * GREATEST(w.decay_floor,
                CASE
                  WHEN EXTRACT(EPOCH FROM (cr.ref_ts - cpq.citing_created)) / (86400.0 * 30) <= w.decay_grace_months THEN 1.0
                  ELSE GREATEST(w.decay_floor,
                    1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - cpq.citing_created)) / (86400.0 * 30) - w.decay_grace_months) * w.decay_rate)
                  )
                END
              )
          ), 0)) AS score
        FROM citing_paper_quality cpq
        CROSS JOIN cycle_ref cr
        CROSS JOIN w
        GROUP BY cpq.cited_author, w.citation_max, w.self_citation_discount, w.citation,
                 w.decay_floor, w.decay_grace_months, w.decay_rate
      ),

      -- ═══ FINAL AGGREGATION ═══
      totals AS (
        SELECT
          tu.username,
          COALESCE(ps_agg.papers, 0) AS papers,
          COALESCE(rs_agg.reviews, 0) AS reviews,
          COALESCE(cs.score, 0) AS citations,
          CASE WHEN tu.username = ANY($2::text[]) THEN w.accreditation_bonus ELSE 0 END AS accreditation
        FROM target_users tu
        CROSS JOIN w
        LEFT JOIN (SELECT author, SUM(score) AS papers FROM paper_scores GROUP BY author) ps_agg
          ON ps_agg.author = tu.username
        LEFT JOIN (SELECT author, SUM(score) AS reviews FROM review_scores GROUP BY author) rs_agg
          ON rs_agg.author = tu.username
        LEFT JOIN citation_scores cs ON cs.author = tu.username
      )

      SELECT
        username,
        LEAST(100, GREATEST(0, ROUND((papers + reviews + citations + accreditation)::numeric, 1))) AS score,
        ROUND(papers::numeric, 1) AS papers,
        ROUND(reviews::numeric, 1) AS reviews,
        ROUND(citations::numeric, 1) AS citations,
        accreditation::numeric AS accreditation
      FROM totals`,
      [
        usernames,                        // $1
        accreditedArr,                    // $2
        config.appTag,                    // $3
        `${config.appTag}/%`,             // $4
        JSON.stringify(prevJson),         // $5 (jsonb)
        endBlock,                         // $6
        getCachedGenesisBlock(),          // $7
        weights.paper,                    // $8
        weights.review,                   // $9
        weights.downvote,                 // $10
        weights.citation,                 // $11
        weights.citation_max,             // $12
        weights.accreditation_bonus,      // $13
        weights.self_citation_discount,   // $14
        weights.decay_rate,               // $15
        weights.decay_floor,              // $16
        weights.decay_grace_months,       // $17
      ],
    );

    for (const row of result.rows) {
      results.set(row.username, {
        score: Number(row.score),
        breakdown: {
          papers: Number(row.papers),
          reviews: Number(row.reviews),
          citations: Number(row.citations),
          accreditation: Number(row.accreditation),
        },
      });
    }

    return results;
  } catch (err) {
    logger.error({ err }, 'Batch SQL reputation computation failed');
    return results;
  }
}

/**
 * Compute reputation for a single user. Delegates to computeReputationBatch.
 */
export async function computeReputationSql(
  username: string,
  prevScores?: Record<string, number>,
  cycleEndBlock?: number,
): Promise<ReputationScore | null> {
  const results = await computeReputationBatch([username], prevScores, cycleEndBlock);
  return results.get(username) ?? null;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Get cached reputation score for a single user (1h TTL).
 * Uses all-SQL computation when HAF is available, returns zero otherwise.
 */
export async function getReputationScore(username: string): Promise<ReputationScore> {
  return hafCache.getOrSet<ReputationScore>(`reputation:${username}`, async () => {
    // Primary path: all-SQL computation (v0.4)
    if (isHafAvailable()) {
      const sqlResult = await computeReputationSql(username);
      if (sqlResult) return sqlResult;
    }

    // Fallback: no HAF means no weighted reputation — return zero
    return { score: 0, breakdown: { papers: 0, reviews: 0, citations: 0, accreditation: 0 } };
  }, REPUTATION_CACHE_TTL, true);
}

/**
 * Batch-fetch reputation scores. Reads from Redis batch scores first
 * (populated by nightly batch job), then falls back to on-demand
 * computation only for users missing from the batch.
 */
export async function getReputationScores(usernames: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(usernames)];
  const result = new Map<string, number>();
  if (unique.length === 0) return result;

  // Try Redis batch scores first (no HAF queries needed)
  const redis = getRedis();
  const missing: string[] = [];
  if (redis) {
    try {
      const keys = unique.map((u) => `reputation:batch:${u}`);
      const values = await redis.mget(keys);
      for (let i = 0; i < unique.length; i++) {
        if (values[i] !== null) {
          result.set(unique[i], Number(values[i]));
        } else {
          missing.push(unique[i]);
        }
      }
    } catch {
      missing.push(...unique.filter((u) => !result.has(u)));
    }
  } else {
    missing.push(...unique);
  }

  // On-demand computation only for users not in the batch
  if (missing.length > 0) {
    const entries = await Promise.all(
      missing.map(async (u) => {
        const rep = await getReputationScore(u);
        return [u, rep.score] as const;
      }),
    );
    for (const [u, score] of entries) {
      result.set(u, score);
    }
  }

  return result;
}

/**
 * Fast batch-only reputation lookup. Reads Redis batch scores only —
 * returns 0 for users not yet computed. No HAF queries, no blocking.
 * Use this for list endpoints where speed matters more than completeness.
 */
export async function getBatchReputationScores(usernames: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(usernames)];
  const result = new Map<string, number>();
  if (unique.length === 0) return result;

  const redis = getRedis();
  if (!redis) return result;

  try {
    const keys = unique.map((u) => `reputation:batch:${u}`);
    const values = await redis.mget(keys);
    for (let i = 0; i < unique.length; i++) {
      if (values[i] !== null) {
        result.set(unique[i], Number(values[i]));
      }
    }
  } catch {
    // Redis unavailable — return empty map, all scores default to 0
  }
  return result;
}

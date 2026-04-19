/**
 * Shared reputation computation module.
 *
 * v3: reputation-weighted votes, quality multipliers, downvote penalties,
 * quality-weighted citations, batch convergence.
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

// ─── Types ──────────────────────────────────────────────────────

/** A single vote on a paper or review. */
export interface Vote {
  voter: string;
  /** Hive vote weight: -10000 to +10000 */
  weight: number;
}

/** Per-paper data for reputation computation. */
export interface PaperItem {
  permlink: string;
  created: string;
  votes: Vote[];
  /** Average review star rating / 5 (0.2-1.0), or null if no reviews. */
  review_quality: number | null;
}

/** Per-review data for reputation computation. */
export interface ReviewItem {
  permlink: string;
  created: string;
  votes: Vote[];
}

/** Citation of the user's work by another paper. */
export interface CitationItem {
  citing_author: string;
  citing_permlink: string;
  citing_created: string;
  /** Quality score of the citing paper: quality * min(weighted_upvotes, 1.0), clamped 0-1. */
  citing_quality: number;
  reputation_relevant: boolean;
  /** True when the citing author is the same as the cited author (self-citation). */
  is_self: boolean;
}

export interface UserStats {
  paper_count: number;
  review_count: number;
  citation_count: number;
  first_pevo_post: string | null;
  papers: PaperItem[];
  reviews: ReviewItem[];
  citations: CitationItem[];
  self_citations: number;
  external_citations: number;
}

// ─── Voter Weighting ────────────────────────────────────────────

/**
 * Voter weight with activity-gated floor (R9).
 *
 * - Active voter (has published a paper or written a review):
 *   0.4 + 0.6 * sqrt(rep/100), floored at 0.4, capped at 1.0.
 * - Inactive voter (no PEvO activity):
 *   sqrt(rep/100), no floor, capped at 1.0.
 *   This prevents sybil attacks: an empty accredited account with
 *   rep 5 gets weight 0.22 instead of 0.53.
 * - If no batch score exists, returns 1.0 (bootstrap mode).
 */
export function voterWeight(voterRep: number | undefined, hasActivity = true): number {
  if (voterRep === undefined) return 1.0;
  if (hasActivity) {
    return Math.min(1.0, Math.max(0.4, 0.4 + 0.6 * Math.sqrt(voterRep / 100)));
  }
  return Math.min(1.0, Math.sqrt(voterRep / 100));
}

/**
 * Vote influence = voter_weight * abs(hive_vote_percent) / 10000.
 * Uses the active accounts set to determine the voter weight branch.
 */
export function voteInfluence(
  vote: Vote,
  reputationMap: Map<string, number>,
  activeAccounts?: Set<string>,
): number {
  const hasActivity = activeAccounts ? activeAccounts.has(vote.voter) : true;
  const vw = voterWeight(reputationMap.get(vote.voter), hasActivity);
  const strength = Math.abs(vote.weight) / 10000;
  return vw * strength;
}

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

// ─── HAF Queries ────────────────────────────────────────────────

export async function getUserStatsFromHaf(username: string): Promise<UserStats | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    const accreditedSet = await getAllAccreditedAccounts();
    const accreditedArr = [...accreditedSet];

    // Run all 3 HAF queries + reputation map + active accounts in parallel
    const papersQuery = pool.query(
      `WITH user_papers AS (
         SELECT c.author, c.permlink, c.created, c.json_metadata
         FROM ${T.comments} c
         WHERE c.author = $1
           AND c.parent_author = '' AND c.parent_permlink = $3
           AND (c.json_metadata -> $3 ->> 'type') = 'paper'
           AND c.json_metadata ->> 'app' LIKE $4
           AND (c.json_metadata -> $3 -> 'continues') IS NULL
       ),
       paper_votes AS (
         SELECT up.permlink, up.created,
           COALESCE(json_agg(json_build_object('voter', v.voter, 'weight', v.weight, 'timestamp', v.timestamp))
             FILTER (WHERE v.voter IS NOT NULL), '[]') AS votes
         FROM user_papers up
         LEFT JOIN (
           SELECT DISTINCT ON (vo.voter, vo.permlink) vo.voter, vo.author, vo.permlink, vo.weight, vo.timestamp
           FROM ${T.voteOps} vo
           WHERE vo.voter = ANY($2::text[])
             AND vo.author = $1
             AND vo.permlink = ANY(SELECT permlink FROM user_papers)
           ORDER BY vo.voter, vo.permlink, vo.block_num DESC
         ) v ON v.permlink = up.permlink
           AND v.voter != up.author
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(up.json_metadata -> $3 -> 'authors') a
             WHERE a ->> 'hive' = v.voter
           )
         GROUP BY up.permlink, up.created
       ),
       paper_reviews AS (
         SELECT up.permlink,
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
         GROUP BY up.permlink
       )
       SELECT pv.permlink, pv.created, pv.votes, pr.quality
       FROM paper_votes pv
       LEFT JOIN paper_reviews pr ON pr.permlink = pv.permlink`,
      [username, accreditedArr, config.appTag, `${config.appTag}/%`],
    );

    const reviewsQuery = pool.query(
      `WITH user_reviews AS (
         SELECT ur.author, ur.permlink, ur.created
         FROM ${T.comments} ur
         WHERE ur.author = $1
           AND (ur.json_metadata -> $3 ->> 'type') = 'review'
           AND ur.json_metadata ->> 'app' LIKE $4
           AND COALESCE(ur.json_metadata -> $3 ->> 'is_anonymous', 'false') != 'true'
       )
       SELECT ur.permlink, ur.created,
         COALESCE(json_agg(json_build_object('voter', v.voter, 'weight', v.weight))
           FILTER (WHERE v.voter IS NOT NULL), '[]') AS votes
       FROM user_reviews ur
       LEFT JOIN (
         SELECT DISTINCT ON (vo.voter, vo.permlink) vo.voter, vo.permlink, vo.weight
         FROM ${T.voteOps} vo
         WHERE vo.voter = ANY($2::text[])
           AND vo.author = $1
           AND vo.permlink = ANY(SELECT permlink FROM user_reviews)
         ORDER BY vo.voter, vo.permlink, vo.block_num DESC
       ) v ON v.permlink = ur.permlink
         AND v.voter != $1
       GROUP BY ur.permlink, ur.created`,
      [username, accreditedArr, config.appTag, `${config.appTag}/%`],
    );

    const citationsQuery = pool.query(
      `WITH citing_papers AS (
         SELECT citing.author AS citing_author,
           citing.permlink AS citing_permlink,
           citing.created AS citing_created,
           cit,
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
           AND (cit ->> 'author') = $1
       ),
       citing_paper_votes AS (
         SELECT cp.citing_author, cp.citing_permlink, cp.citing_created,
           cp.reputation_relevant,
           COALESCE(json_agg(json_build_object('voter', v.voter, 'weight', v.weight))
             FILTER (WHERE v.voter IS NOT NULL AND v.weight > 0), '[]') AS upvotes
         FROM citing_papers cp
         LEFT JOIN (
           SELECT DISTINCT ON (vo.voter, vo.author, vo.permlink) vo.voter, vo.author, vo.permlink, vo.weight
           FROM ${T.voteOps} vo
           WHERE vo.voter = ANY($2::text[])
             AND (vo.author, vo.permlink) IN (SELECT citing_author, citing_permlink FROM citing_papers)
           ORDER BY vo.voter, vo.author, vo.permlink, vo.block_num DESC
         ) v ON v.author = cp.citing_author AND v.permlink = cp.citing_permlink
           AND v.weight > 0
           AND v.voter != cp.citing_author
         GROUP BY cp.citing_author, cp.citing_permlink, cp.citing_created, cp.reputation_relevant
       ),
       citing_paper_reviews AS (
         SELECT cpv.citing_author, cpv.citing_permlink,
           AVG(
             ((c.json_metadata -> $3 -> 'rating' ->> 'methodology')::numeric +
              (c.json_metadata -> $3 -> 'rating' ->> 'novelty')::numeric +
              (c.json_metadata -> $3 -> 'rating' ->> 'clarity')::numeric +
              (c.json_metadata -> $3 -> 'rating' ->> 'significance')::numeric) / 4.0
           ) / 5.0 AS quality
         FROM citing_paper_votes cpv
         JOIN ${T.comments} c
           ON c.parent_author = cpv.citing_author AND c.parent_permlink = cpv.citing_permlink
           AND (c.json_metadata -> $3 ->> 'type') = 'review'
           AND c.json_metadata ->> 'app' LIKE $4
         GROUP BY cpv.citing_author, cpv.citing_permlink
       )
       SELECT cpv.citing_author, cpv.citing_permlink, cpv.citing_created,
         cpv.reputation_relevant, cpv.upvotes,
         cpr.quality AS review_quality
       FROM citing_paper_votes cpv
       LEFT JOIN citing_paper_reviews cpr
         ON cpr.citing_author = cpv.citing_author AND cpr.citing_permlink = cpv.citing_permlink`,
      [username, accreditedArr, config.appTag, `${config.appTag}/%`],
    );

    // §31: Latest revision timestamp per paper (papers with >1 comment operations)
    const revisionsQuery = pool.query(
      `SELECT co.permlink, MAX(co.timestamp) AS latest_revision_ts
       FROM ${T.commentOps} co
       WHERE co.author = $1
         AND co.parent_author = '' AND co.parent_permlink = $2
       GROUP BY co.permlink
       HAVING COUNT(*) > 1`,
      [username, config.appTag],
    );

    // §31: All revotes on this user's papers (batched)
    const revotesQuery = pool.query(
      `SELECT cj.json::jsonb ->> 'permlink' AS permlink,
              cj.required_posting_auths ->> 0 AS voter,
              (cj.json::jsonb ->> 'weight')::int AS weight,
              cj.json::jsonb ->> 'version' AS version,
              cj.timestamp AS revote_ts
       FROM ${T.customJson} cj
       WHERE cj.custom_id = $1
         AND cj.json::jsonb ->> 'action' = 'revote'
         AND cj.json::jsonb ->> 'author' = $2
         AND cj.block_num >= $3
       ORDER BY cj.block_num DESC`,
      [config.appTag, username, getCachedGenesisBlock()],
    );

    // Await all queries and lookups in parallel
    const [papersResult, reviewsResult, citationsResult, reputationMap, activeSet, revisionsResult, revotesResult] = await Promise.all([
      papersQuery, reviewsQuery, citationsQuery, getBatchReputationMap(), getActiveAccounts(), revisionsQuery, revotesQuery,
    ]);

    // §31: Build revision timestamp map (permlink → latest revision Date)
    const revisionMap = new Map<string, Date>();
    for (const r of revisionsResult.rows) {
      revisionMap.set(r.permlink as string, new Date(r.latest_revision_ts as string));
    }

    // §31: Build revote map (permlink → voter → {weight, timestamp}), latest revote per voter per paper
    // Validates §3.1 schema: voter, weight range, required fields
    const revoteMap = new Map<string, Map<string, { weight: number; timestamp: Date }>>();
    for (const r of revotesResult.rows) {
      const pl = r.permlink as string;
      const voter = r.voter as string;
      const weight = Number(r.weight);
      const version = r.version;
      // §3.1 validation: required fields (author/permlink/version) and weight range
      if (!voter || !pl || version == null || isNaN(weight) || weight < -10000 || weight > 10000) {
        logger.debug({ voter, permlink: pl, weight }, 'Ignoring invalid revote custom_json');
        continue;
      }
      if (!revoteMap.has(pl)) revoteMap.set(pl, new Map());
      const paperRevotes = revoteMap.get(pl)!;
      // Already ordered by block_num DESC — keep only the latest per voter
      if (!paperRevotes.has(voter)) {
        paperRevotes.set(voter, { weight, timestamp: new Date(r.revote_ts as string) });
      }
    }

    // Parse papers — apply §31 vote staleness
    const papers: PaperItem[] = papersResult.rows.map((row: any) => {
      const rawVotes: Array<{ voter: string; weight: number; timestamp: string }> =
        Array.isArray(row.votes) ? row.votes : [];
      const latestRevisionTs = revisionMap.get(row.permlink) ?? null;
      const paperRevotes = revoteMap.get(row.permlink) ?? null;

      const nativeVoters = new Set<string>();
      const votes: Vote[] = rawVotes.map((v) => {
        nativeVoters.add(v.voter);
        if (!latestRevisionTs) {
          // No content revisions — vote is not stale
          return { voter: v.voter, weight: v.weight };
        }
        const nativeTs = new Date(v.timestamp);
        const revote = paperRevotes?.get(v.voter);
        // Vote resolution: if both signals are post-revision, use the later timestamp
        if (revote && revote.timestamp > latestRevisionTs) {
          if (nativeTs > latestRevisionTs && nativeTs > revote.timestamp) {
            return { voter: v.voter, weight: v.weight };
          }
          return { voter: v.voter, weight: revote.weight };
        }
        if (nativeTs > latestRevisionTs) {
          return { voter: v.voter, weight: v.weight };
        }
        // Stale: vote predates latest content revision with no post-revision re-vote
        return { voter: v.voter, weight: 0 };
      });

      // Include revote-only voters (no prior native vote)
      if (paperRevotes) {
        for (const [voter, revote] of paperRevotes) {
          if (nativeVoters.has(voter)) continue;
          if (revote.weight === 0) continue;
          const stale = latestRevisionTs ? revote.timestamp <= latestRevisionTs : false;
          votes.push({ voter, weight: stale ? 0 : revote.weight });
        }
      }

      return {
        permlink: row.permlink,
        created: row.created,
        votes,
        review_quality: row.quality !== null ? Number(row.quality) : null,
      };
    });

    // Parse reviews
    const reviews: ReviewItem[] = reviewsResult.rows.map((row: any) => ({
      permlink: row.permlink,
      created: row.created,
      votes: Array.isArray(row.votes) ? row.votes : [],
    }));

    // Parse citations and compute citing paper quality
    let selfCitations = 0;
    let externalCitations = 0;
    const citations: CitationItem[] = citationsResult.rows.map((row: any) => {
      const isSelf = row.citing_author === username;
      if (isSelf) selfCitations++;
      else externalCitations++;

      // Compute citing paper quality: quality * min(weighted_upvotes, 1.0)
      const upvotes: Vote[] = Array.isArray(row.upvotes) ? row.upvotes : [];
      const reviewQuality = row.review_quality !== null ? Number(row.review_quality) : 1.0;
      const weightedUpvotes = upvotes.reduce(
        (sum: number, v: Vote) => sum + voteInfluence(v, reputationMap, activeSet), 0,
      );
      const citingQuality = Math.min(1.0, Math.max(0, reviewQuality * Math.min(weightedUpvotes, 1.0)));

      return {
        citing_author: row.citing_author,
        citing_permlink: row.citing_permlink,
        citing_created: row.citing_created,
        citing_quality: citingQuality,
        reputation_relevant: row.reputation_relevant !== false,
        is_self: isSelf,
      };
    });

    const firstPost = papers.length > 0
      ? papers.reduce((min, p) => p.created < min ? p.created : min, papers[0].created)
      : null;

    return {
      paper_count: papers.length,
      review_count: reviews.length,
      citation_count: selfCitations + externalCitations,
      first_pevo_post: firstPost,
      papers,
      reviews,
      citations,
      self_citations: selfCitations,
      external_citations: externalCitations,
    };
  } catch (err) {
    logger.error({ err }, 'HAF user stats query failed');
    return null;
  }
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

// ─── Temporal Decay ─────────────────────────────────────────────

export function decay(ageMonths: number, w: ReputationWeights): number {
  if (w.decay_rate === 0) return 1.0;
  if (ageMonths <= w.decay_grace_months) return 1.0;
  return Math.max(w.decay_floor, 1.0 - ((ageMonths - w.decay_grace_months) * w.decay_rate));
}

function ageInMonths(created: string): number {
  return (Date.now() - new Date(created).getTime()) / (1000 * 60 * 60 * 24 * 30);
}

/** Round to one decimal place. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ─── Reputation Computation (v3) ────────────────────────────────

/**
 * Compute reputation score using v3 algorithm.
 *
 * @param stats          User's papers, reviews, and citations with vote data
 * @param isAccredited   Whether the user is accredited
 * @param weightsOverride Optional weight override (uses on-chain weights if not provided)
 * @param reputationMap  Prior-cycle batch scores for voter weighting (empty = bootstrap)
 * @param activeAccounts Set of accounts with PEvO activity (for activity-gated voter weight)
 */
export async function computeReputation(
  stats: UserStats,
  isAccredited: boolean,
  weightsOverride?: ReputationWeights,
  reputationMap?: Map<string, number>,
  activeAccounts?: Set<string>,
): Promise<ReputationScore> {
  const w = weightsOverride ?? await getReputationWeights();
  const repMap = reputationMap ?? await getBatchReputationMap();
  const activeSet = activeAccounts ?? await getActiveAccounts();

  // ── Papers ──
  let papersScore = 0;
  for (const p of stats.papers) {
    const upvotes = p.votes.filter((v) => v.weight > 0);
    const downvotes = p.votes.filter((v) => v.weight < 0);

    const weightedUpvotes = upvotes.reduce((sum, v) => sum + voteInfluence(v, repMap, activeSet), 0);
    const weightedDownvotes = downvotes.reduce((sum, v) => sum + voteInfluence(v, repMap, activeSet), 0);

    const quality = p.review_quality !== null ? p.review_quality : 1.0;
    const raw = quality * Math.min(weightedUpvotes, w.paper) - weightedDownvotes * w.downvote;
    const clamped = Math.max(-w.paper, Math.min(w.paper, raw));

    papersScore += clamped * decay(ageInMonths(p.created), w);
  }

  // ── Reviews ──
  let reviewsScore = 0;
  for (const r of stats.reviews) {
    const upvotes = r.votes.filter((v) => v.weight > 0);
    const downvotes = r.votes.filter((v) => v.weight < 0);

    const weightedUpvotes = upvotes.reduce((sum, v) => sum + voteInfluence(v, repMap, activeSet), 0);
    const weightedDownvotes = downvotes.reduce((sum, v) => sum + voteInfluence(v, repMap, activeSet), 0);

    const raw = Math.min(weightedUpvotes, w.review) - weightedDownvotes * w.downvote;
    const clamped = Math.max(-w.review, Math.min(w.review, raw));

    reviewsScore += clamped * decay(ageInMonths(r.created), w);
  }

  // ── Citations (quality-weighted, self-citation discounted, capped) ──
  let citationScore = 0;
  for (const c of stats.citations) {
    if (!c.reputation_relevant) continue;
    const citingAge = ageInMonths(c.citing_created);
    const decayMult = decay(citingAge, w);
    const weightMult = c.is_self ? w.self_citation_discount : w.citation;
    citationScore += c.citing_quality * weightMult * decayMult;
  }
  citationScore = Math.min(citationScore, w.citation_max);

  const accreditationScore = isAccredited ? w.accreditation_bonus : 0;

  const raw = papersScore + reviewsScore + citationScore + accreditationScore;
  const score = Math.min(100, Math.max(0, round1(raw)));

  return {
    score,
    breakdown: {
      papers: round1(papersScore),
      reviews: round1(reviewsScore),
      citations: round1(citationScore),
      accreditation: accreditationScore,
    },
  };
}

// ─── All-SQL Reputation Computation (v0.4) ─────────────────────

/**
 * Compute reputation for a single user using the canonical all-SQL query.
 * Replaces getUserStatsFromHaf() + computeReputation() with a single DB call.
 *
 * @param username         The user whose reputation is being computed
 * @param prevScores       Previous cycle scores as jsonb (empty object for cycle 0)
 * @param cycleEndBlock    Only data with block_num < cycleEndBlock is included (0 = use head block)
 */
export async function computeReputationSql(
  username: string,
  prevScores?: Record<string, number>,
  cycleEndBlock?: number,
): Promise<ReputationScore | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    const [accreditedAccounts, weights] = await Promise.all([
      getAllAccreditedAccounts(),
      getReputationWeights(),
    ]);

    const accreditedArr = [...accreditedAccounts];
    const isAccredited = accreditedAccounts.has(username);

    // If no cycleEndBlock provided, use head block
    let endBlock = cycleEndBlock;
    if (!endBlock) {
      const headResult = await pool.query(`SELECT MAX(block_num) AS head FROM ${T.blocks}`, []);
      endBlock = Number(headResult.rows[0]?.head ?? 0);
      if (endBlock === 0) return null;
    }

    // Use provided prev scores or fetch from batch
    const prevJson = prevScores ?? Object.fromEntries(await getBatchReputationMap());

    const result = await pool.query(
      `WITH

      cycle_ref AS (
        SELECT b.created_at AS ref_ts
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
          a.unnest AS voter,
          CASE
            WHEN ps.rep IS NULL THEN 1.0
            WHEN aa.author IS NOT NULL THEN
              LEAST(1.0, GREATEST(0.4, 0.4 + 0.6 * sqrt(ps.rep / 100.0)))
            ELSE
              LEAST(1.0, sqrt(ps.rep / 100.0))
          END AS vw
        FROM unnest($2::text[]) a
        LEFT JOIN prev_scores ps ON ps.username = a.unnest
        LEFT JOIN active_accounts aa ON aa.author = a.unnest
      ),

      -- PAPERS
      user_papers AS (
        SELECT c.author, c.permlink, c.created, c.json_metadata
        FROM ${T.comments} c
        WHERE c.author = $1
          AND c.parent_author = '' AND c.parent_permlink = $3
          AND (c.json_metadata -> $3 ->> 'type') = 'paper'
          AND c.json_metadata ->> 'app' LIKE $4
          AND (c.json_metadata -> $3 -> 'continues') IS NULL
      ),

      -- Vote staleness: latest revision block per paper
      paper_revisions AS (
        SELECT co.permlink, MAX(co.block_num) AS latest_revision_block
        FROM ${T.commentOps} co
        WHERE co.author = $1
          AND co.parent_author = '' AND co.parent_permlink = $3
          AND co.block_num < $6
        GROUP BY co.permlink
        HAVING COUNT(*) > 1
      ),

      paper_vote_signals AS (
        SELECT voter, permlink, weight, block_num FROM (
          SELECT vo.voter, vo.permlink, vo.weight, vo.block_num
          FROM ${T.voteOps} vo
          WHERE vo.voter = ANY($2::text[])
            AND vo.author = $1
            AND vo.permlink IN (SELECT permlink FROM user_papers)
            AND vo.block_num >= $7
            AND vo.block_num < $6
          UNION ALL
          SELECT
            cj.required_posting_auths ->> 0 AS voter,
            cj.json::jsonb ->> 'permlink' AS permlink,
            (cj.json::jsonb ->> 'weight')::int AS weight,
            cj.block_num
          FROM ${T.customJson} cj
          WHERE cj.custom_id = $3
            AND cj.json::jsonb ->> 'action' = 'revote'
            AND cj.json::jsonb ->> 'author' = $1
            AND cj.block_num >= $7
            AND cj.block_num < $6
            AND cj.required_posting_auths ->> 0 = ANY($2::text[])
        ) all_signals
      ),

      paper_latest_votes AS (
        SELECT DISTINCT ON (voter, permlink) voter, permlink, weight, block_num
        FROM paper_vote_signals
        ORDER BY voter, permlink, block_num DESC
      ),

      paper_resolved_votes AS (
        SELECT plv.voter, plv.permlink, plv.weight
        FROM paper_latest_votes plv
        JOIN user_papers up ON up.permlink = plv.permlink
        LEFT JOIN paper_revisions prev ON prev.permlink = plv.permlink
        WHERE plv.voter != up.author
          AND plv.weight != 0
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(up.json_metadata -> $3 -> 'authors') a
            WHERE a ->> 'hive' = plv.voter
          )
          AND (prev.latest_revision_block IS NULL OR plv.block_num > prev.latest_revision_block)
      ),

      paper_reviews AS (
        SELECT up.permlink,
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
        GROUP BY up.permlink
      ),

      paper_vote_agg AS (
        SELECT
          prv.permlink,
          COALESCE(SUM(vw.vw * ABS(prv.weight) / 10000.0) FILTER (WHERE prv.weight > 0), 0) AS weighted_up,
          COALESCE(SUM(vw.vw * ABS(prv.weight) / 10000.0) FILTER (WHERE prv.weight < 0), 0) AS weighted_down
        FROM paper_resolved_votes prv
        JOIN voter_weights vw ON vw.voter = prv.voter
        GROUP BY prv.permlink
      ),

      paper_scores AS (
        SELECT
          up.permlink,
          GREATEST(-$8, LEAST($8,
            COALESCE(pr.quality, 1.0) * LEAST(COALESCE(pva.weighted_up, 0), $8)
            - COALESCE(pva.weighted_down, 0) * $10
          )) * GREATEST($16,
            CASE
              WHEN EXTRACT(EPOCH FROM (cr.ref_ts - up.created)) / (86400.0 * 30) <= $17 THEN 1.0
              ELSE GREATEST($16,
                1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - up.created)) / (86400.0 * 30) - $17) * $15)
              )
            END
          ) AS score
        FROM user_papers up
        CROSS JOIN cycle_ref cr
        LEFT JOIN paper_reviews pr ON pr.permlink = up.permlink
        LEFT JOIN paper_vote_agg pva ON pva.permlink = up.permlink
      ),

      -- REVIEWS
      user_reviews AS (
        SELECT c.author, c.permlink, c.created
        FROM ${T.comments} c
        WHERE c.author = $1
          AND (c.json_metadata -> $3 ->> 'type') = 'review'
          AND c.json_metadata ->> 'app' LIKE $4
          AND COALESCE(c.json_metadata -> $3 ->> 'is_anonymous', 'false') != 'true'
      ),

      review_vote_signals AS (
        SELECT voter, permlink, weight, block_num FROM (
          SELECT vo.voter, vo.permlink, vo.weight, vo.block_num
          FROM ${T.voteOps} vo
          WHERE vo.voter = ANY($2::text[])
            AND vo.author = $1
            AND vo.permlink IN (SELECT permlink FROM user_reviews)
            AND vo.block_num >= $7
            AND vo.block_num < $6
          UNION ALL
          SELECT
            cj.required_posting_auths ->> 0 AS voter,
            cj.json::jsonb ->> 'permlink' AS permlink,
            (cj.json::jsonb ->> 'weight')::int AS weight,
            cj.block_num
          FROM ${T.customJson} cj
          WHERE cj.custom_id = $3
            AND cj.json::jsonb ->> 'action' = 'revote'
            AND cj.json::jsonb ->> 'author' = $1
            AND cj.block_num >= $7
            AND cj.block_num < $6
            AND cj.required_posting_auths ->> 0 = ANY($2::text[])
        ) all_signals
      ),

      review_latest_votes AS (
        SELECT DISTINCT ON (voter, permlink) voter, permlink, weight
        FROM review_vote_signals
        ORDER BY voter, permlink, block_num DESC
      ),

      review_resolved_votes AS (
        SELECT rlv.voter, rlv.permlink, rlv.weight
        FROM review_latest_votes rlv
        WHERE rlv.voter != $1
          AND rlv.weight != 0
      ),

      review_vote_agg AS (
        SELECT
          rrv.permlink,
          COALESCE(SUM(vw.vw * ABS(rrv.weight) / 10000.0) FILTER (WHERE rrv.weight > 0), 0) AS weighted_up,
          COALESCE(SUM(vw.vw * ABS(rrv.weight) / 10000.0) FILTER (WHERE rrv.weight < 0), 0) AS weighted_down
        FROM review_resolved_votes rrv
        JOIN voter_weights vw ON vw.voter = rrv.voter
        GROUP BY rrv.permlink
      ),

      review_scores AS (
        SELECT
          ur.permlink,
          GREATEST(-$9, LEAST($9,
            LEAST(COALESCE(rva.weighted_up, 0), $9)
            - COALESCE(rva.weighted_down, 0) * $10
          )) * GREATEST($16,
            CASE
              WHEN EXTRACT(EPOCH FROM (cr.ref_ts - ur.created)) / (86400.0 * 30) <= $17 THEN 1.0
              ELSE GREATEST($16,
                1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - ur.created)) / (86400.0 * 30) - $17) * $15)
              )
            END
          ) AS score
        FROM user_reviews ur
        CROSS JOIN cycle_ref cr
        LEFT JOIN review_vote_agg rva ON rva.permlink = ur.permlink
      ),

      -- CITATIONS
      citing_papers AS (
        SELECT
          citing.author AS citing_author,
          citing.permlink AS citing_permlink,
          citing.created AS citing_created,
          citing.json_metadata AS citing_meta,
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
          AND (cit ->> 'author') = $1
          AND COALESCE((cit ->> 'reputation_relevant')::boolean, true) = true
      ),

      citing_vote_signals AS (
        SELECT voter, permlink, author, weight, block_num FROM (
          SELECT vo.voter, vo.permlink, vo.author, vo.weight, vo.block_num
          FROM ${T.voteOps} vo
          WHERE vo.voter = ANY($2::text[])
            AND (vo.author, vo.permlink) IN (SELECT citing_author, citing_permlink FROM citing_papers)
            AND vo.block_num >= $7
            AND vo.block_num < $6
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
            AND cj.block_num >= $7
            AND cj.block_num < $6
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
          cp.citing_author,
          cp.citing_permlink,
          cp.citing_created,
          cp.citing_author = $1 AS is_self,
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
        GROUP BY cp.citing_author, cp.citing_permlink, cp.citing_created, cpr.quality
      ),

      citation_scores AS (
        SELECT LEAST($12, SUM(
          GREATEST(0, LEAST(1.0, cpq.review_quality * LEAST(cpq.weighted_upvotes, 1.0)))
          * CASE WHEN cpq.is_self THEN $14 ELSE $11 END
          * GREATEST($16,
              CASE
                WHEN EXTRACT(EPOCH FROM (cr.ref_ts - cpq.citing_created)) / (86400.0 * 30) <= $17 THEN 1.0
                ELSE GREATEST($16,
                  1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - cpq.citing_created)) / (86400.0 * 30) - $17) * $15)
                )
              END
            )
        )) AS score
        FROM citing_paper_quality cpq
        CROSS JOIN cycle_ref cr
      ),

      -- FINAL AGGREGATION
      totals AS (
        SELECT
          COALESCE((SELECT SUM(score) FROM paper_scores), 0) AS papers,
          COALESCE((SELECT SUM(score) FROM review_scores), 0) AS reviews,
          COALESCE((SELECT score FROM citation_scores), 0) AS citations,
          CASE WHEN $18 THEN $13 ELSE 0 END AS accreditation
      )

      SELECT
        LEAST(100, GREATEST(0, ROUND((papers + reviews + citations + accreditation)::numeric, 1))) AS score,
        ROUND(papers::numeric, 1) AS papers,
        ROUND(reviews::numeric, 1) AS reviews,
        ROUND(citations::numeric, 1) AS citations,
        accreditation::numeric AS accreditation
      FROM totals`,
      [
        username,                         // $1
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
        isAccredited,                     // $18
      ],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      score: Number(row.score),
      breakdown: {
        papers: Number(row.papers),
        reviews: Number(row.reviews),
        citations: Number(row.citations),
        accreditation: Number(row.accreditation),
      },
    };
  } catch (err) {
    logger.error({ err }, 'SQL reputation computation failed');
    return null;
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Get cached reputation score for a single user (1h TTL).
 * Uses all-SQL computation when HAF is available, falls back to JS computation.
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

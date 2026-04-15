/**
 * Shared reputation computation module.
 *
 * v3: reputation-weighted votes, quality multipliers, downvote penalties,
 * quality-weighted citations, batch convergence. See reputation-algorithm-v3.md.
 */
import pg from 'pg';
import { getPool, isHafAvailable } from './db.js';
import { hiveClient } from './hive.js';
import { config } from './config.js';
import { parseMeta, isPevoPaper } from './helpers.js';
import { getAccreditedSet, getAllAccreditedAccounts } from './accreditation.js';
import { hafCache } from './cache.js';
import { getRedis } from './redis.js';
import { logger } from './logger.js';
import { DEFAULT_REPUTATION_WEIGHTS, type ReputationWeights, type ReputationScore } from './types/index.js';
import { T } from './hafsql.js';

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

function emptyStats(): UserStats {
  return {
    paper_count: 0, review_count: 0, citation_count: 0, first_pevo_post: null,
    papers: [], reviews: [], citations: [], self_citations: 0, external_citations: 0,
  };
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
    const result = await pool.query(
      `SELECT DISTINCT c.author
       FROM ${T.comments} c
       WHERE c.json_metadata ->> 'app' LIKE $1
         AND (
           (c.parent_author = '' AND c.parent_permlink = $2
            AND (c.json_metadata -> $2 ->> 'type') = 'paper')
           OR
           (c.json_metadata -> $2 ->> 'type') = 'review'
         )`,
      [`${config.appTag}/%`, config.appTag],
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
           COALESCE(json_agg(json_build_object('voter', v.voter, 'weight', v.weight))
             FILTER (WHERE v.voter IS NOT NULL), '[]') AS votes
         FROM user_papers up
         LEFT JOIN (
           SELECT DISTINCT ON (vo.voter, vo.permlink) vo.voter, vo.author, vo.permlink, vo.weight
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

    // Await all queries and lookups in parallel
    const [papersResult, reviewsResult, citationsResult, reputationMap, activeSet] = await Promise.all([
      papersQuery, reviewsQuery, citationsQuery, getBatchReputationMap(), getActiveAccounts(),
    ]);

    // Parse papers
    const papers: PaperItem[] = papersResult.rows.map((row: any) => ({
      permlink: row.permlink,
      created: row.created,
      votes: Array.isArray(row.votes) ? row.votes : [],
      review_quality: row.quality !== null ? Number(row.quality) : null,
    }));

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

export async function getUserStatsFromHiveApi(username: string): Promise<UserStats> {
  try {
    const discussions: Awaited<ReturnType<typeof hiveClient.database.getDiscussions>> = [];
    let startAuthor: string | undefined;
    let startPermlink: string | undefined;
    for (let page = 0; page < 5; page++) {
      const query: Record<string, unknown> = { tag: username, limit: 20 };
      if (startAuthor && startPermlink) {
        query.start_author = startAuthor;
        query.start_permlink = startPermlink;
      }
      const batch = await hiveClient.database.getDiscussions('blog', query as any);
      if (batch.length === 0) break;
      const newItems = page === 0 ? batch : batch.slice(1);
      discussions.push(...newItems);
      if (batch.length < 20) break;
      const last = batch[batch.length - 1];
      startAuthor = last.author;
      startPermlink = last.permlink;
    }

    const papers = discussions.filter((d) => {
      if (d.parent_permlink !== config.appTag) return false;
      const meta = parseMeta(d.json_metadata);
      return isPevoPaper(meta);
    });

    const reviews = discussions.filter((d) => {
      const meta = parseMeta(d.json_metadata);
      const appMeta = (meta[config.appTag] || {}) as Record<string, unknown>;
      return appMeta.type === 'review';
    });

    const firstPost = papers.length > 0
      ? papers.reduce((min, d) => d.created < min ? d.created : min, papers[0].created)
      : null;

    // Hive API fallback: no vote details, no citation quality — minimal data
    const paperItems: PaperItem[] = papers.map((d) => ({
      permlink: d.permlink,
      created: d.created,
      votes: [],
      review_quality: null,
    }));
    const reviewItems: ReviewItem[] = reviews.map((d) => ({
      permlink: d.permlink,
      created: d.created,
      votes: [],
    }));

    return {
      paper_count: papers.length,
      review_count: reviews.length,
      citation_count: 0,
      first_pevo_post: firstPost,
      papers: paperItems,
      reviews: reviewItems,
      citations: [],
      self_citations: 0,
      external_citations: 0,
    };
  } catch (err) {
    logger.error({ err }, 'Hive API user stats query failed');
    return emptyStats();
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
       LIMIT 1`,
      [config.appTag],
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
       ORDER BY cj.block_num DESC
       LIMIT 1`,
      [config.appTag],
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

// ─── Public API ─────────────────────────────────────────────────

/**
 * Get cached reputation score for a single user (1h TTL).
 */
export async function getReputationScore(username: string): Promise<ReputationScore> {
  return hafCache.getOrSet<ReputationScore>(`reputation:${username}`, async () => {
    const accreditedSet = await getAccreditedSet([username]);
    const isAccredited = accreditedSet.has(username);
    let stats: UserStats | null = isHafAvailable() ? await getUserStatsFromHaf(username) : null;
    if (!stats) stats = await getUserStatsFromHiveApi(username);
    return computeReputation(stats, isAccredited);
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

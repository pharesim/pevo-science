/**
 * Shared reputation computation module.
 * Extracted from profile.ts so paper/review routes can populate
 * author_reputation and reviewer_reputation fields.
 *
 * v2: supports temporal decay, review quality weighting, and
 * self-citation discounting. Defaults produce v1-identical scores.
 */
import pg from 'pg';
import { getPool, isHafAvailable } from './db.js';
import { hiveClient } from './hive.js';
import { config } from './config.js';
import { parseMeta, isPevoPaper } from './helpers.js';
import { getAccreditedSet, getAllAccreditedAccounts } from './accreditation.js';
import { hafCache } from './cache.js';
import { logger } from './logger.js';
import { DEFAULT_REPUTATION_WEIGHTS, type ReputationWeights, type ReputationScore } from './types/index.js';
import { T } from './hafsql.js';

const REPUTATION_CACHE_TTL = 60 * 60_000; // 1 hour

/** Per-paper creation date for temporal decay */
export interface PaperItem {
  created: string;
}

/** Per-review stats for quality weighting + temporal decay */
export interface ReviewItem {
  created: string;
  rshares: number; // accredited-voter rshares on this review
}

export interface UserStats {
  paper_count: number;
  review_count: number;
  citation_count: number;
  first_pevo_post: string | null;
  paper_rshares: number;
  review_rshares: number;
  max_paper_rshares: number;
  max_review_rshares: number;
  // v2 fields
  papers: PaperItem[];
  reviews: ReviewItem[];
  max_single_review_rshares: number;
  external_citations: number;
  self_citations: number;
}

function emptyV2Fields(): Pick<UserStats, 'papers' | 'reviews' | 'max_single_review_rshares' | 'external_citations' | 'self_citations'> {
  return { papers: [], reviews: [], max_single_review_rshares: 0, external_citations: 0, self_citations: 0 };
}

/**
 * Fetch platform-wide max rshares for normalization.
 * Cached separately with a long TTL since this is a global stat
 * that only changes when new votes arrive on PEvO content.
 */
interface GlobalMaxRshares {
  max_paper_rshares: number;
  max_review_rshares: number;
  max_single_review_rshares: number;
}

const GLOBAL_MAX_CACHE_TTL = 4 * 60 * 60_000; // 4 hours

async function getGlobalMaxRshares(): Promise<GlobalMaxRshares> {
  return hafCache.getOrSet<GlobalMaxRshares>('reputation:global_max_rshares', async () => {
    const pool = getPool();
    if (!pool) return { max_paper_rshares: 0, max_review_rshares: 0, max_single_review_rshares: 0 };

    // Get cached accredited accounts to filter votes without the expensive CTE
    const accreditedSet = await getAllAccreditedAccounts();
    if (accreditedSet.size === 0) {
      return { max_paper_rshares: 0, max_review_rshares: 0, max_single_review_rshares: 0 };
    }
    const accreditedArr = [...accreditedSet];

    try {
      const result = await pool.query(
        `SELECT
           COALESCE(MAX(paper_rs), 0) AS max_paper_rshares,
           COALESCE(MAX(review_rs), 0) AS max_review_rshares,
           COALESCE(MAX(single_review_rs), 0) AS max_single_review_rshares
         FROM (
           SELECT c.author, c.permlink,
             COALESCE(SUM(v.rshares) FILTER (
               WHERE c.parent_author = '' AND c.parent_permlink = $2
                 AND (c.json_metadata -> $2 ->> 'type') = 'paper'
             ), 0) AS paper_rs,
             COALESCE(SUM(v.rshares) FILTER (
               WHERE (c.json_metadata -> $2 ->> 'type') = 'review'
             ), 0) AS review_rs,
             COALESCE(SUM(v.rshares) FILTER (
               WHERE (c.json_metadata -> $2 ->> 'type') = 'review'
             ), 0) AS single_review_rs
           FROM ${T.comments} c
           JOIN ${T.votes} v ON v.author = c.author AND v.permlink = c.permlink
             AND v.rshares > 0 AND v.voter = ANY($1::text[])
           WHERE c.json_metadata ->> 'app' LIKE $3
             AND (c.json_metadata -> $2 ->> 'type') IN ('paper', 'review')
           GROUP BY c.author, c.permlink
         ) sub`,
        [accreditedArr, config.appTag, `${config.appTag}/%`],
      );

      const row = result.rows[0];
      return {
        max_paper_rshares: Number(row?.max_paper_rshares) || 0,
        max_review_rshares: Number(row?.max_review_rshares) || 0,
        max_single_review_rshares: Number(row?.max_single_review_rshares) || 0,
      };
    } catch (err) {
      logger.error({ err }, 'Global max rshares query failed');
      return { max_paper_rshares: 0, max_review_rshares: 0, max_single_review_rshares: 0 };
    }
  }, GLOBAL_MAX_CACHE_TTL, true);
}

export async function getUserStatsFromHaf(username: string): Promise<UserStats | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    // Get cached accredited accounts to filter votes without the expensive CTE
    const accreditedSet = await getAllAccreditedAccounts();
    const accreditedArr = [...accreditedSet];

    // Single consolidated query: paper/review counts, dates, rshares, citations.
    // Uses the cached accredited set via ANY($2) instead of re-running the
    // ACTIVE_ACCREDITATIONS_CTE (which scans the entire operation_custom_json_view
    // table with text→jsonb casts) on every call.
    // $1 = username, $2 = accreditedArr, $3 = appTag, $4 = appTag/%
    const result = await pool.query(
      `WITH
       user_papers AS (
         SELECT c.permlink, c.created
         FROM ${T.comments} c
         WHERE c.author = $1
           AND c.parent_author = '' AND c.parent_permlink = $3
           AND (c.json_metadata -> $3 ->> 'type') = 'paper'
           AND c.json_metadata ->> 'app' LIKE $4
       ),
       user_reviews AS (
         SELECT c.permlink, c.created
         FROM ${T.comments} c
         WHERE c.author = $1
           AND (c.json_metadata -> $3 ->> 'type') = 'review'
           AND c.json_metadata ->> 'app' LIKE $4
           AND COALESCE(c.json_metadata -> $3 ->> 'is_anonymous', 'false') != 'true'
       ),
       paper_vote_stats AS (
         SELECT COALESCE(SUM(v.rshares), 0) AS total_rshares
         FROM user_papers up
         JOIN ${T.votes} v ON v.author = $1 AND v.permlink = up.permlink
           AND v.rshares > 0 AND v.voter = ANY($2::text[])
       ),
       review_vote_stats AS (
         SELECT ur.permlink, ur.created,
           COALESCE(SUM(v.rshares), 0) AS rshares
         FROM user_reviews ur
         LEFT JOIN ${T.votes} v ON v.author = $1 AND v.permlink = ur.permlink
           AND v.rshares > 0 AND v.voter = ANY($2::text[])
         GROUP BY ur.permlink, ur.created
       ),
       citation_stats AS (
         SELECT
           COALESCE(SUM(CASE WHEN citing.author != $1 THEN 1 ELSE 0 END), 0)::int AS external_citations,
           COALESCE(SUM(CASE WHEN citing.author = $1 THEN 1 ELSE 0 END), 0)::int AS self_citations
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
       )
       SELECT
         (SELECT count(*)::int FROM user_papers) AS paper_count,
         (SELECT count(*)::int FROM user_reviews) AS review_count,
         (SELECT MIN(created) FROM user_papers) AS first_post,
         (SELECT total_rshares FROM paper_vote_stats) AS paper_rshares,
         (SELECT COALESCE(SUM(rshares), 0) FROM review_vote_stats) AS review_rshares,
         (SELECT external_citations FROM citation_stats) AS external_citations,
         (SELECT self_citations FROM citation_stats) AS self_citations,
         (SELECT json_agg(json_build_object('created', created)) FROM user_papers) AS papers_json,
         (SELECT json_agg(json_build_object('created', created, 'rshares', rshares)) FROM review_vote_stats) AS reviews_json`,
      [username, accreditedArr, config.appTag, `${config.appTag}/%`],
    );

    // Fetch global max rshares (separately cached, long TTL)
    const globalMax = await getGlobalMaxRshares();

    const row = result.rows[0];
    const papersArr = row?.papers_json || [];
    const reviewsArr = row?.reviews_json || [];
    const papers: PaperItem[] = Array.isArray(papersArr) ? papersArr : [];
    const reviews: ReviewItem[] = (Array.isArray(reviewsArr) ? reviewsArr : []).map(
      (r: { created: string; rshares: number }) => ({
        created: r.created,
        rshares: Number(r.rshares) || 0,
      }),
    );

    const externalCitations = Number(row?.external_citations) || 0;
    const selfCitations = Number(row?.self_citations) || 0;

    return {
      paper_count: Number(row?.paper_count) || 0,
      review_count: Number(row?.review_count) || 0,
      citation_count: externalCitations + selfCitations,
      first_pevo_post: row?.first_post || null,
      paper_rshares: Number(row?.paper_rshares) || 0,
      review_rshares: Number(row?.review_rshares) || 0,
      max_paper_rshares: globalMax.max_paper_rshares,
      max_review_rshares: globalMax.max_review_rshares,
      papers,
      reviews,
      max_single_review_rshares: globalMax.max_single_review_rshares,
      external_citations: externalCitations,
      self_citations: selfCitations,
    };
  } catch (err) {
    logger.error({ err }, 'HAF user stats query failed');
    return null;
  }
}

const EMPTY_STATS: UserStats = {
  paper_count: 0, review_count: 0, citation_count: 0, first_pevo_post: null,
  paper_rshares: 0, review_rshares: 0, max_paper_rshares: 0, max_review_rshares: 0,
  papers: [], reviews: [], max_single_review_rshares: 0, external_citations: 0, self_citations: 0,
};

export async function getUserStatsFromHiveApi(username: string): Promise<UserStats> {
  try {
    // Paginate in batches of 20 (Hive API max) up to 100 posts
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
      // First result of subsequent pages overlaps with last of previous page
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
      const pevo = (meta.pevo || {}) as Record<string, unknown>;
      return pevo.type === 'review';
    });

    const firstPost = papers.length > 0
      ? papers.reduce((min, d) => d.created < min ? d.created : min, papers[0].created)
      : null;

    // v2: extract per-paper dates (best-effort from Hive API)
    const paperItems: PaperItem[] = papers.map((d) => ({ created: d.created }));
    // v2: per-review items (no rshares available from Hive API)
    const reviewItems: ReviewItem[] = reviews.map((d) => ({ created: d.created, rshares: 0 }));

    return {
      paper_count: papers.length,
      review_count: reviews.length,
      citation_count: 0,
      first_pevo_post: firstPost,
      paper_rshares: 0,
      review_rshares: 0,
      max_paper_rshares: 0,
      max_review_rshares: 0,
      papers: paperItems,
      reviews: reviewItems,
      max_single_review_rshares: 0,
      external_citations: 0,
      self_citations: 0,
    };
  } catch (err) {
    logger.error({ err }, 'Hive API user stats query failed');
    return { ...EMPTY_STATS };
  }
}

export async function getReputationWeights(): Promise<ReputationWeights> {
  return hafCache.getOrSet<ReputationWeights>('reputation_weights', async () => {
    const pool = getPool();
    if (!pool) return DEFAULT_REPUTATION_WEIGHTS;

    let client: pg.PoolClient | undefined;
    try {
      // The full query scans operation_custom_json_view with text→jsonb casts
      // and is expensive when no update_weights has ever been broadcast.
      // Optimisation: first do a cheap EXISTS check with a tight timeout.
      // If no matching row exists, skip the expensive ORDER BY query entirely.
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

      // At least one update_weights row exists — fetch the latest.
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
  }, 30 * 60_000, true);
}

/**
 * Temporal decay multiplier. Mirrors pevo.decay() SQL function.
 */
export function decay(ageMonths: number, w: ReputationWeights): number {
  if (w.decay_rate === 0) return 1.0;
  if (ageMonths <= w.decay_grace_months) return 1.0;
  return Math.max(w.decay_floor, 1.0 - ((ageMonths - w.decay_grace_months) * w.decay_rate));
}

function ageInMonths(created: string): number {
  return (Date.now() - new Date(created).getTime()) / (1000 * 60 * 60 * 24 * 30);
}

export async function computeReputation(stats: UserStats, isAccredited: boolean, weightsOverride?: ReputationWeights): Promise<ReputationScore> {
  const w = weightsOverride ?? await getReputationWeights();

  // v2: per-paper score with temporal decay
  let papersScore: number;
  if (stats.papers.length > 0) {
    papersScore = stats.papers.reduce(
      (sum, p) => sum + w.paper * decay(ageInMonths(p.created), w), 0,
    );
  } else {
    // Fallback: no per-paper data (Hive API fallback with empty papers list)
    papersScore = stats.paper_count * w.paper;
  }

  // v2: per-review quality-weighted score with temporal decay
  let reviewsScore: number;
  if (stats.reviews.length > 0) {
    reviewsScore = stats.reviews.reduce((sum, r) => {
      const normalized = stats.max_single_review_rshares > 0
        ? r.rshares / stats.max_single_review_rshares
        : 0;
      const qualityBonus = Math.min(normalized * w.review_quality_bonus_max, w.review_quality_bonus_max);
      return sum + (w.review + qualityBonus) * decay(ageInMonths(r.created), w);
    }, 0);
  } else {
    reviewsScore = stats.review_count * w.review;
  }

  const paperVotes = stats.max_paper_rshares > 0
    ? Math.min(Math.round(stats.paper_rshares / stats.max_paper_rshares * w.paper_votes_max), w.paper_votes_max)
    : 0;
  const reviewVotes = stats.max_review_rshares > 0
    ? Math.min(Math.round(stats.review_rshares / stats.max_review_rshares * w.review_votes_max), w.review_votes_max)
    : 0;

  // v2: self-citation discounting
  const adjustedCitations = stats.external_citations + stats.self_citations * w.self_citation_discount;
  const citationsScore = (adjustedCitations > 0 ? adjustedCitations : stats.citation_count) * w.citation;

  const accreditationScore = isAccredited ? w.accreditation_bonus : 0;

  let accountAge = 0;
  if (stats.first_pevo_post) {
    accountAge = Math.min(Math.floor(ageInMonths(stats.first_pevo_post)), w.account_age_max);
  }

  const raw = papersScore + reviewsScore + paperVotes + reviewVotes + citationsScore + accreditationScore + accountAge;
  const score = Math.min(100, Math.max(0, Math.round(raw)));

  return {
    score,
    breakdown: {
      papers: Math.round(papersScore),
      reviews: Math.round(reviewsScore),
      paper_votes: paperVotes,
      review_votes: reviewVotes,
      citations: Math.round(citationsScore),
      accreditation: accreditationScore,
      account_age: accountAge,
    },
  };
}

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
 * Batch-fetch reputation scores. Returns a map of username -> score.
 */
export async function getReputationScores(usernames: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(usernames)];
  const entries = await Promise.all(
    unique.map(async (u) => {
      const rep = await getReputationScore(u);
      return [u, rep.score] as const;
    }),
  );
  return new Map(entries);
}

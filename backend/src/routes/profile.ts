import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getPool } from '../db.js';
import { hiveClient } from '../hive.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { parseMeta, parsePageLimit, parseOrder, toPaperSummary } from '../helpers.js';
import { getAccreditedSet, getAllAccreditedAccounts } from '../accreditation.js';
import { getReputationScore, getReputationScores } from '../reputation.js';
import { logger } from '../logger.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { validate } from '../validation.js';
import { getLastBlock } from '../block-watcher.js';
import { getAppPool } from '../app-db.js';
import { hafCache } from '../cache.js';
import { T, isPevoReviewSql, getCachedGenesisBlock, buildWith, activeAccreditationsCteBody, authorshipClaimsCteBody } from '../hafsql.js';

const router = Router();

// ──────────────────────────────────────────────
// Helpers — accreditation lookup
// ──────────────────────────────────────────────

async function getAccreditationFromHaf(username: string) {
  const pool = getPool();
  if (!pool) return undefined; // no HAF available

  try {
    // Filter by accreditationAuthorities so a self-broadcast custom_json (signed
    // by the target account's own posting key) cannot masquerade as a real
    // accreditation and paint attacker-chosen metadata onto someone's profile.
    // See SEC-AUTH-BYPASS. Mirrors the same filter in accreditations.ts and
    // orcid.ts's getExistingAccreditation.
    const result = await pool.query(
      `SELECT cj.json, cj.id AS event_id FROM ${T.customJson} cj
       WHERE cj.custom_id = $2
         AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
         AND cj.required_posting_auths ?| $4::text[]
         AND cj.json::jsonb ->> 'account' = $1
         AND cj.block_num >= $3
       ORDER BY cj.block_num DESC
       LIMIT 1`,
      [username, config.appTag, getCachedGenesisBlock(), config.accreditationAuthorities],
    );
    if (result.rows.length === 0) return null;

    const payload = typeof result.rows[0].json === 'string'
      ? JSON.parse(result.rows[0].json)
      : result.rows[0].json;

    if (payload.action === 'revoke') return null;
    return {
      name: payload.name,
      institution: payload.institution,
      field: payload.field,
      method: payload.method,
      orcid: payload.orcid || null,
      timestamp: payload.timestamp,
      tx_id: result.rows[0].event_id?.toString() ?? null,
    };
  } catch (err) {
    logger.error({ err }, 'HAF accreditation query failed');
    return undefined;
  }
}

async function getAccreditation(username: string) {
  const result = await getAccreditationFromHaf(username);
  if (result !== undefined) return result;
  return null;
}

// ──────────────────────────────────────────────
// Helpers — profile stats (lightweight counts)
// ──────────────────────────────────────────────

async function getProfileStats(username: string) {
  const pool = getPool();
  if (!pool) return { paper_count: 0, review_count: 0, citation_count: 0, first_pevo_post: null };

  try {
    const result = await pool.query(
      `WITH user_papers AS (
         SELECT c.created
         FROM ${T.comments} c
         WHERE c.author = $1
           AND c.parent_author = '' AND c.parent_permlink = $2
           AND (c.json_metadata -> $2 ->> 'type') = 'paper'
           AND c.json_metadata ->> 'app' LIKE $3
           AND (c.json_metadata -> $2 -> 'continues') IS NULL
       ),
       user_reviews AS (
         SELECT 1
         FROM ${T.comments} c
         WHERE c.author = $1
           AND (c.json_metadata -> $2 ->> 'type') = 'review'
           AND c.json_metadata ->> 'app' LIKE $3
           AND COALESCE(c.json_metadata -> $2 ->> 'is_anonymous', 'false') != 'true'
       ),
       citations AS (
         SELECT 1
         FROM ${T.comments} citing
         CROSS JOIN LATERAL jsonb_array_elements(
           citing.json_metadata -> $2 -> 'citations'
         ) AS cit
         WHERE citing.parent_author = '' AND citing.parent_permlink = $2
           AND (citing.json_metadata -> $2 ->> 'type') = 'paper'
           AND citing.json_metadata ->> 'app' LIKE $3
           AND jsonb_typeof(citing.json_metadata -> $2 -> 'citations') = 'array'
           AND (cit ->> 'author') = $1
       )
       SELECT
         (SELECT COUNT(*) FROM user_papers) AS paper_count,
         (SELECT MIN(created) FROM user_papers) AS first_pevo_post,
         (SELECT COUNT(*) FROM user_reviews) AS review_count,
         (SELECT COUNT(*) FROM citations) AS citation_count`,
      [username, config.appTag, `${config.appTag}/%`],
    );

    const row = result.rows[0];
    return {
      paper_count: Number(row?.paper_count ?? 0),
      review_count: Number(row?.review_count ?? 0),
      citation_count: Number(row?.citation_count ?? 0),
      first_pevo_post: row?.first_pevo_post ?? null,
    };
  } catch (err) {
    logger.warn({ err }, 'Profile stats query failed');
    return { paper_count: 0, review_count: 0, citation_count: 0, first_pevo_post: null };
  }
}

// ──────────────────────────────────────────────
// GET /api/profile/:username
// ──────────────────────────────────────────────

router.get('/:username', async (req: Request, res: Response) => {
  const username = req.params.username as string;

  const data = await hafCache.getOrSet(`profile:${username}`, async () => {
    // Check account existence and accreditation first
    const [accountResult, accreditation] = await Promise.all([
      hiveClient.database.getAccounts([username]),
      getAccreditation(username),
    ]);

    const [account] = accountResult;
    if (!account) return null;

    const isAccredited = !!accreditation;

    // Non-accredited: return immediately with zeroed stats, skip expensive HAF/reputation queries
    if (!isAccredited) {
      return {
        username,
        is_accredited: false,
        accreditation: null,
        reputation: { score: 0, breakdown: { papers: 0, reviews: 0, citations: 0, accreditation: 0 } },
        stats: { paper_count: 0, review_count: 0, citation_count: 0, first_pevo_post: null },
      };
    }

    // Accredited: reputation (SQL, cached) + lightweight stats in parallel
    const [reputation, profileStats] = await Promise.all([
      getReputationScore(username),
      getProfileStats(username),
    ]);

    return {
      username,
      is_accredited: true,
      accreditation: accreditation || null,
      reputation,
      stats: profileStats,
    };
  }, 5 * 60_000, true);

  if (data === null) {
    return sendError(res, 404, 'NOT_FOUND', `Hive account @${username} does not exist`);
  }

  sendOk(res, data);
});

// ──────────────────────────────────────────────
// GET /api/profile/:username/papers
// ──────────────────────────────────────────────

async function fetchUserPapersFromHaf(username: string, limit: number, offset: number, sortCol: string, order: string) {
  const pool = getPool();
  if (!pool) return null;

  try {
    // Build CTEs for authorship claims to include claimed papers
    const cte = buildWith(1, activeAccreditationsCteBody, (idx) => authorshipClaimsCteBody(idx, { claimer: username }));

    // Base filter for PEvO papers (non-continuation)
    const paperFilter = `parent_author = '' AND parent_permlink = $${cte.nextIdx}
         AND (json_metadata -> $${cte.nextIdx} ->> 'type') = 'paper'
         AND json_metadata ->> 'app' LIKE $${cte.nextIdx + 1}
         AND (json_metadata -> $${cte.nextIdx} -> 'continues') IS NULL`;

    // UNION: papers authored by user + papers with accepted claims by user
    const unionSql = `${cte.sql},
      user_papers AS (
        SELECT DISTINCT c.author, c.permlink, c.title, LEFT(c.body, 300) AS body,
               c.json_metadata, c.created, c.total_rshares
        FROM ${T.comments} c
        WHERE c.author = $${cte.nextIdx + 2} AND ${paperFilter}
        UNION
        SELECT DISTINCT c.author, c.permlink, c.title, LEFT(c.body, 300) AS body,
               c.json_metadata, c.created, c.total_rshares
        FROM authorship_claims ac
        JOIN ${T.comments} c ON c.author = ac.paper_author AND c.permlink = ac.paper_permlink
        WHERE ac.claimer = $${cte.nextIdx + 2} AND ac.status = 'accepted'
          AND ${paperFilter}
      )`;

    const baseParams = [...cte.params, config.appTag, `${config.appTag}/%`, username];

    const countResult = await pool.query(
      `${unionSql} SELECT count(*)::int AS total FROM user_papers`,
      baseParams,
    );
    const total = countResult.rows[0]?.total ?? 0;

    const dataResult = await pool.query(
      `${unionSql}
       SELECT author, permlink, title, body, json_metadata, created
       FROM user_papers
       ORDER BY ${sortCol === 'net_votes' ? 'total_rshares' : 'created'} ${order === 'asc' ? 'ASC' : 'DESC'}
       LIMIT $${cte.nextIdx + 3} OFFSET $${cte.nextIdx + 4}`,
      [...baseParams, limit, offset],
    );

    const rows = dataResult.rows.map((r: Record<string, unknown>) => {
      const meta = parseMeta(r.json_metadata);
      return toPaperSummary(
        { author: r.author as string, permlink: r.permlink as string, title: r.title as string, body: r.body as string, created: r.created as string, net_votes: 0 },
        meta,
      );
    });

    return { rows, total };
  } catch (err) {
    logger.error({ err }, 'HAF user papers query failed');
    return null;
  }
}

router.get('/:username/papers', async (req: Request, res: Response) => {
  const username = req.params.username as string;
  const { page, limit, offset } = parsePageLimit(req);
  const order = parseOrder(req);
  const sort = (req.query.sort as string) === 'votes' ? 'net_votes' : 'created';

  const cacheKey = `profile-papers:${username}:${JSON.stringify({ sort, order, page, limit })}`;
  const result = await hafCache.getOrSet(cacheKey, async () => {
    const hafResult = await fetchUserPapersFromHaf(username, limit, offset, sort, order);
    if (hafResult) return hafResult;
    return { rows: [], total: 0 };
  });

  // Enrich with accreditation and reputation
  if (result.rows.length > 0) {
    const authorNames = result.rows.map((r) => r.author);
    const [accreditedSet, batchScores, allAccredited] = await Promise.all([
      getAccreditedSet(authorNames),
      getReputationScores(authorNames),
      getAllAccreditedAccounts(),
    ]);
    for (const row of result.rows) {
      const authorAccredited = accreditedSet.has(row.author);
      row.is_accredited = authorAccredited;
      // Symmetric chain pre-check: a non-accredited author shows score 0
      // even if a stale batch entry survives in Redis (per BACKEND-REPUTATION-SSOT
      // direction-of-truth: chain is SSoT, batch map is a perf cache).
      row.author_reputation = authorAccredited ? (batchScores.get(row.author) ?? 0) : 0;
      row.accredited_authors = (row.authors || [])
        .filter((a) => a.hive && allAccredited.has(a.hive))
        .map((a) => a.hive!);
    }
  }

  sendOk(res, result.rows, { page, limit, total: result.total });
});

// ──────────────────────────────────────────────
// GET /api/profile/:username/reviews
// ──────────────────────────────────────────────

function buildReviewSummary(
  post: { author: string; permlink: string; body: string; created: string },
  meta: Record<string, unknown>,
  paperAuthor: string,
  paperPermlink: string,
  paperTitle: string,
) {
  const pevo = (meta[config.appTag] || {}) as Record<string, unknown>;
  const rating = pevo.rating as Record<string, number> | undefined;
  return {
    author: post.author,
    permlink: post.permlink,
    body: post.body.slice(0, 300),
    rating: rating || { methodology: 0, novelty: 0, clarity: 0, significance: 0 },
    is_anonymous: pevo.is_anonymous ?? false,
    paper: {
      author: paperAuthor,
      permlink: paperPermlink,
      title: paperTitle,
    },
    created: post.created,
  };
}

async function fetchUserReviewsFromHaf(username: string, limit: number, offset: number, order: string, sort: string) {
  const pool = getPool();
  if (!pool) return null;

  try {
    const reviewFilter = isPevoReviewSql(2);

    const countResult = await pool.query(
      `SELECT count(*)::int AS total FROM ${T.comments} c
       WHERE c.author = $1 AND c.parent_author != ''
         AND ${reviewFilter.sql}`,
      [username, ...reviewFilter.params],
    );
    const total = countResult.rows[0]?.total ?? 0;

    // For sort-by-votes, compute accredited net_votes per review
    const accreditedAccounts = sort === 'votes' ? [...(await getAllAccreditedAccounts())] : [];
    const accreditedParamIdx = reviewFilter.nextIdx + 2; // after limit and offset
    const netVotesSubquery = sort === 'votes'
      ? `(SELECT COALESCE(SUM(CASE WHEN lv.weight > 0 THEN 1 WHEN lv.weight < 0 THEN -1 ELSE 0 END), 0)::int
          FROM (SELECT DISTINCT ON (v.voter) v.weight FROM ${T.voteOps} v
                WHERE v.author = c.author AND v.permlink = c.permlink
                  AND v.voter = ANY($${accreditedParamIdx}::text[]) AND v.voter != v.author
                ORDER BY v.voter, v.block_num DESC) lv WHERE lv.weight != 0) AS net_votes`
      : '0 AS net_votes';
    const orderClause = sort === 'votes'
      ? `net_votes ${order === 'asc' ? 'ASC' : 'DESC'}, c.created DESC`
      : `c.created ${order === 'asc' ? 'ASC' : 'DESC'}`;

    const dataParams = [username, ...reviewFilter.params, limit, offset];
    if (sort === 'votes') dataParams.push(accreditedAccounts);

    const dataResult = await pool.query(
      `SELECT c.author, c.permlink, LEFT(c.body, 300) AS body,
              c.json_metadata, c.created,
              c.parent_author, c.parent_permlink,
              p.title AS paper_title,
              ${netVotesSubquery}
       FROM ${T.comments} c
       LEFT JOIN ${T.comments} p ON p.author = c.parent_author AND p.permlink = c.parent_permlink
       WHERE c.author = $1 AND c.parent_author != ''
         AND ${reviewFilter.sql}
       ORDER BY ${orderClause}
       LIMIT $${reviewFilter.nextIdx} OFFSET $${reviewFilter.nextIdx + 1}`,
      dataParams,
    );

    const rows = dataResult.rows.map((r: Record<string, unknown>) => {
      const meta = parseMeta(r.json_metadata);
      return buildReviewSummary(
        { author: r.author as string, permlink: r.permlink as string, body: r.body as string, created: r.created as string },
        meta,
        r.parent_author as string,
        r.parent_permlink as string,
        (r.paper_title as string) || '',
      );
    });

    return { rows, total };
  } catch (err) {
    logger.error({ err }, 'HAF user reviews query failed');
    return null;
  }
}

router.get('/:username/reviews', async (req: Request, res: Response) => {
  const username = req.params.username as string;
  const { page, limit, offset } = parsePageLimit(req);
  const order = parseOrder(req);
  const sort = (req.query.sort as string) === 'votes' ? 'votes' : 'date';

  const cacheKey = `profile-reviews:${username}:${JSON.stringify({ sort, order, page, limit })}`;
  const result = await hafCache.getOrSet(cacheKey, async () => {
    const hafResult = await fetchUserReviewsFromHaf(username, limit, offset, order, sort);
    if (hafResult) return hafResult;
    return { rows: [], total: 0 };
  });

  sendOk(res, result.rows, { page, limit, total: result.total });
});

// ──────────────────────────────────────────────
// GET /api/profile/:username/notification-preferences
// ──────────────────────────────────────────────

router.get('/:username/notification-preferences', verifyHiveSignature, async (req: Request, res: Response) => {
  const username = req.params.username as string;

  if (req.hiveUsername !== username) {
    return sendError(res, 403, 'FORBIDDEN', 'Can only view your own notification preferences');
  }

  const pool = getAppPool();
  if (pool) {
    try {
      const result = await pool.query(
        `SELECT username, email_digest, digest_frequency, email, updated_at
         FROM notification_preferences WHERE username = $1`,
        [username],
      );
      if (result.rows.length > 0) {
        const row = result.rows[0];
        return sendOk(res, {
          username: row.username,
          email_digest: row.email_digest,
          digest_frequency: row.digest_frequency,
          email: row.email,
          updated_at: row.updated_at?.toISOString() ?? null,
        });
      }
    } catch (err) {
      logger.error({ err }, 'Failed to fetch notification preferences');
    }
  }

  // Return defaults
  sendOk(res, {
    username,
    email_digest: false,
    digest_frequency: 'weekly',
    email: null,
    updated_at: null,
  });
});

// ──────────────────────────────────────────────
// PUT /api/profile/:username/notification-preferences
// ──────────────────────────────────────────────

const notificationPrefsSchema = z.object({
  email_digest: z.boolean(),
  digest_frequency: z.enum(['daily', 'weekly']),
  email: z.string().email().max(254).nullable(),
});

router.put('/:username/notification-preferences', verifyHiveSignature, validate(notificationPrefsSchema), async (req: Request, res: Response) => {
  const username = req.params.username as string;

  if (req.hiveUsername !== username) {
    return sendError(res, 403, 'FORBIDDEN', 'Can only update your own notification preferences');
  }

  const { email_digest, digest_frequency, email } = req.body;

  const pool = getAppPool();
  if (!pool) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'App database not configured');
  }

  try {
    // When enabling digest, set last_digest_block to current head block
    // so the user doesn't receive a backlog email on their first digest
    const baselineBlock = email_digest ? getLastBlock() : 0;

    const result = await pool.query(
      `INSERT INTO notification_preferences (username, email_digest, digest_frequency, email, last_digest_block, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (username) DO UPDATE SET
         email_digest = EXCLUDED.email_digest,
         digest_frequency = EXCLUDED.digest_frequency,
         email = EXCLUDED.email,
         last_digest_block = CASE
           WHEN notification_preferences.email_digest = false AND EXCLUDED.email_digest = true
           THEN EXCLUDED.last_digest_block
           ELSE notification_preferences.last_digest_block
         END,
         updated_at = now()
       RETURNING username, email_digest, digest_frequency, email, updated_at`,
      [username, email_digest, digest_frequency, email, baselineBlock],
    );

    const row = result.rows[0];
    sendOk(res, {
      username: row.username,
      email_digest: row.email_digest,
      digest_frequency: row.digest_frequency,
      email: row.email,
      updated_at: row.updated_at?.toISOString() ?? null,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to update notification preferences');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update notification preferences');
  }
});

// ──────────────────────────────────────────────
// GET /api/profile/:username/notification-preferences/unsubscribe
// ──────────────────────────────────────────────

router.get('/:username/notification-preferences/unsubscribe', async (req: Request, res: Response) => {
  const username = req.params.username as string;
  const token = req.query.token as string;

  if (!token) {
    return sendError(res, 400, 'BAD_REQUEST', 'Missing unsubscribe token');
  }

  const { verifyUnsubscribeToken } = await import('../digest.js');
  if (!verifyUnsubscribeToken(username, token)) {
    return sendError(res, 400, 'BAD_REQUEST', 'Invalid unsubscribe token');
  }

  const pool = getAppPool();
  if (pool) {
    await pool.query(
      `UPDATE notification_preferences SET email_digest = false, updated_at = now() WHERE username = $1`,
      [username],
    );
  }

  sendOk(res, { message: 'Email digest unsubscribed' });
});

export { getAccreditation };
export default router;

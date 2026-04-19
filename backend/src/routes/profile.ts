import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getPool, isHafAvailable } from '../db.js';
import { hiveClient } from '../hive.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { parseMeta, isPevoPaper, isPevoReview, parsePageLimit, parseOrder, toPaperSummary } from '../helpers.js';
import { getAccreditedSet, getAllAccreditedAccounts } from '../accreditation.js';
import { getBatchReputationScores } from '../reputation.js';
import { logger } from '../logger.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { validate } from '../validation.js';
import { getLastBlock } from '../block-watcher.js';
import { getAppPool } from '../app-db.js';
import {
  getUserStatsFromHaf,
  computeReputation,
  getBatchReputationMap,
  getActiveAccounts,
} from '../reputation.js';
import { hafCache } from '../cache.js';
import { T, isPevoReviewSql, getCachedGenesisBlock } from '../hafsql.js';

const router = Router();

// ──────────────────────────────────────────────
// Helpers — accreditation lookup
// ──────────────────────────────────────────────

async function getAccreditationFromHaf(username: string) {
  const pool = getPool();
  if (!pool) return undefined; // signal to try fallback

  try {
    const result = await pool.query(
      `SELECT cj.json, cj.id AS event_id FROM ${T.customJson} cj
       WHERE cj.custom_id = $2
         AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
         AND cj.json::jsonb ->> 'account' = $1
         AND cj.block_num >= $3
       ORDER BY cj.block_num DESC
       LIMIT 1`,
      [username, config.appTag, getCachedGenesisBlock()],
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
      timestamp: payload.timestamp,
      tx_id: result.rows[0].event_id?.toString() || null,
    };
  } catch (err) {
    logger.error({ err }, 'HAF accreditation query failed');
    return undefined;
  }
}

async function getAccreditationFromHiveApi(username: string) {
  // custom_json lookup via condenser API is limited; return null for now
  // In production HAF is the primary data source for custom_json
  return null;
}

async function getAccreditation(username: string) {
  if (isHafAvailable()) {
    const result = await getAccreditationFromHaf(username);
    if (result !== undefined) return result;
  }
  return getAccreditationFromHiveApi(username);
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

    // Accredited: run the expensive lookups
    const [hafStats, reputationMap, activeAccounts] = await Promise.all([
      isHafAvailable() ? getUserStatsFromHaf(username) : Promise.resolve(null),
      getBatchReputationMap(),
      getActiveAccounts(),
    ]);

    const stats = hafStats;
    const reputation = stats
      ? await computeReputation(stats, isAccredited, undefined, reputationMap, activeAccounts)
      : { score: 0, breakdown: { papers: 0, reviews: 0, citations: 0, accreditation: 0 } };

    return {
      username,
      is_accredited: true,
      accreditation: accreditation || null,
      reputation,
      stats: {
        paper_count: stats?.paper_count ?? 0,
        review_count: stats?.review_count ?? 0,
        citation_count: stats?.citation_count ?? 0,
        first_pevo_post: stats?.first_pevo_post ?? null,
      },
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
    const countResult = await pool.query(
      `SELECT count(*)::int AS total FROM ${T.comments}
       WHERE author = $1 AND parent_author = '' AND parent_permlink = $2
         AND (json_metadata -> $2 ->> 'type') = 'paper'
         AND json_metadata ->> 'app' LIKE $3`,
      [username, config.appTag, `${config.appTag}/%`],
    );
    const total = countResult.rows[0]?.total ?? 0;

    const dataResult = await pool.query(
      `SELECT author, permlink, title, LEFT(body, 300) AS body,
              json_metadata, created
       FROM ${T.comments}
       WHERE author = $1 AND parent_author = '' AND parent_permlink = $2
         AND (json_metadata -> $2 ->> 'type') = 'paper'
         AND json_metadata ->> 'app' LIKE $3
       ORDER BY ${sortCol === 'net_votes' ? 'total_rshares' : 'created'} ${order === 'asc' ? 'ASC' : 'DESC'}
       LIMIT $4 OFFSET $5`,
      [username, config.appTag, `${config.appTag}/%`, limit, offset],
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

async function fetchUserPapersFromHiveApi(username: string, limit: number) {
  try {
    const discussions = await hiveClient.database.getDiscussions('blog', {
      tag: username,
      limit: Math.min(limit, 100),
    });

    const papers = discussions.filter((d) => {
      if (d.parent_permlink !== config.appTag) return false;
      const meta = parseMeta(d.json_metadata);
      return isPevoPaper(meta);
    });

    const rows = papers.map((d) => {
      const meta = parseMeta(d.json_metadata);
      return toPaperSummary(
        { author: d.author, permlink: d.permlink, title: d.title, body: d.body, created: d.created, net_votes: 0 },
        meta,
      );
    });

    return { rows, total: rows.length };
  } catch (err) {
    logger.error({ err }, 'Hive API user papers query failed');
    return { rows: [], total: 0 };
  }
}

router.get('/:username/papers', async (req: Request, res: Response) => {
  const username = req.params.username as string;
  const { page, limit, offset } = parsePageLimit(req);
  const order = parseOrder(req);
  const sort = (req.query.sort as string) === 'votes' ? 'net_votes' : 'created';

  const cacheKey = `profile-papers:${username}:${JSON.stringify({ sort, order, page, limit })}`;
  const result = await hafCache.getOrSet(cacheKey, async () => {
    // Simple read: Hive API first (user's posts by blog)
    const hiveResult = await fetchUserPapersFromHiveApi(username, limit);
    if (hiveResult.rows.length > 0) {
      return hiveResult;
    }

    // HAF fallback (better pagination + sorting)
    if (isHafAvailable()) {
      const hafResult = await fetchUserPapersFromHaf(username, limit, offset, sort, order);
      if (hafResult) return hafResult;
    }

    return { rows: [], total: 0 };
  });

  // Enrich with accreditation and reputation
  if (result.rows.length > 0) {
    const authorNames = result.rows.map((r) => r.author);
    const [accreditedSet, batchScores, allAccredited] = await Promise.all([
      getAccreditedSet(authorNames),
      getBatchReputationScores(authorNames),
      getAllAccreditedAccounts(),
    ]);
    for (const row of result.rows) {
      row.is_accredited = accreditedSet.has(row.author);
      row.author_reputation = batchScores.get(row.author) ?? 0;
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

async function fetchUserReviewsFromHaf(username: string, limit: number, offset: number, order: string) {
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

    const dataResult = await pool.query(
      `SELECT c.author, c.permlink, LEFT(c.body, 300) AS body,
              c.json_metadata, c.created,
              c.parent_author, c.parent_permlink,
              p.title AS paper_title
       FROM ${T.comments} c
       LEFT JOIN ${T.comments} p ON p.author = c.parent_author AND p.permlink = c.parent_permlink
       WHERE c.author = $1 AND c.parent_author != ''
         AND ${reviewFilter.sql}
       ORDER BY c.created ${order === 'asc' ? 'ASC' : 'DESC'}
       LIMIT $${reviewFilter.nextIdx} OFFSET $${reviewFilter.nextIdx + 1}`,
      [username, ...reviewFilter.params, limit, offset],
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

async function fetchUserReviewsFromHiveApi(username: string, limit: number) {
  try {
    const discussions = await hiveClient.database.getDiscussions('comments', {
      tag: username,
      limit: Math.min(limit, 100),
    });

    const reviews = discussions.filter((d) => {
      const meta = parseMeta(d.json_metadata);
      return isPevoReview(meta);
    });

    // Fetch parent post titles
    const rows = await Promise.all(
      reviews.map(async (d) => {
        const meta = parseMeta(d.json_metadata);
        let paperTitle = '';
        try {
          const parent = await hiveClient.database.call('get_content', [d.parent_author, d.parent_permlink]);
          if (parent) paperTitle = parent.title || '';
        } catch {
          // parent title unavailable
        }
        return buildReviewSummary(
          { author: d.author, permlink: d.permlink, body: d.body, created: d.created },
          meta,
          d.parent_author,
          d.parent_permlink,
          paperTitle,
        );
      }),
    );

    return { rows, total: rows.length };
  } catch (err) {
    logger.error({ err }, 'Hive API user reviews query failed');
    return { rows: [], total: 0 };
  }
}

router.get('/:username/reviews', async (req: Request, res: Response) => {
  const username = req.params.username as string;
  const { page, limit, offset } = parsePageLimit(req);
  const order = parseOrder(req);

  const cacheKey = `profile-reviews:${username}:${JSON.stringify({ order, page, limit })}`;
  const result = await hafCache.getOrSet(cacheKey, async () => {
    if (isHafAvailable()) {
      const hafResult = await fetchUserReviewsFromHaf(username, limit, offset, order);
      if (hafResult) return hafResult;
    }

    return fetchUserReviewsFromHiveApi(username, limit);
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

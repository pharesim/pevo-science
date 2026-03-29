import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getPool, isHafAvailable } from '../db.js';
import { hiveClient } from '../hive.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { parseMeta, isPevoPaper, parsePageLimit, parseOrder, toPaperSummary } from '../helpers.js';
import { logger } from '../logger.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { validate } from '../validation.js';
import { getLastBlock } from '../block-watcher.js';
import { getAppPool } from '../app-db.js';
import {
  getUserStatsFromHaf,
  getUserStatsFromHiveApi,
  computeReputation,
} from '../reputation.js';
import { hafCache } from '../cache.js';
import { T } from '../hafsql.js';

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
       ORDER BY cj.block_num DESC
       LIMIT 1`,
      [username, config.appTag],
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
  const { username } = req.params;

  // Verify the Hive account actually exists
  try {
    const [account] = await hiveClient.database.getAccounts([username]);
    if (!account) {
      return sendError(res, 404, 'NOT_FOUND', `Hive account @${username} does not exist`);
    }
  } catch (err) {
    logger.error({ err, username }, 'Failed to verify Hive account existence');
    return sendError(res, 500, 'INTERNAL_ERROR', 'Unable to verify Hive account');
  }

  const data = await hafCache.getOrSet(`profile:${username}`, async () => {
    const accreditation = await getAccreditation(username);
    const isAccredited = !!accreditation;

    let stats = isHafAvailable() ? await getUserStatsFromHaf(username) : null;
    if (!stats) stats = await getUserStatsFromHiveApi(username);

    const reputation = await computeReputation(stats, isAccredited);

    return {
      username,
      is_accredited: isAccredited,
      accreditation: accreditation || null,
      reputation,
      stats: {
        paper_count: stats.paper_count,
        review_count: stats.review_count,
        citation_count: stats.citation_count,
        first_pevo_post: stats.first_pevo_post,
      },
    };
  }, 5 * 60_000, true);

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
        { author: d.author, permlink: d.permlink, title: d.title, body: d.body, created: d.created, net_votes: d.net_votes },
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
  const { username } = req.params;
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

  sendOk(res, result.rows, { page, limit, total: result.total });
});

// ──────────────────────────────────────────────
// GET /api/profile/:username/notification-preferences
// ──────────────────────────────────────────────

router.get('/:username/notification-preferences', verifyHiveSignature, async (req: Request, res: Response) => {
  const { username } = req.params;

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
  const { username } = req.params;

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
  const { username } = req.params;
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

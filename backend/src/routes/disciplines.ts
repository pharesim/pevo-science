import { Router, type Request, type Response } from 'express';
import { getPool, isHafAvailable } from '../db.js';
import { hiveClient } from '../hive.js';
import { config } from '../config.js';
import { sendOk } from '../response.js';
import { parseMeta, isPevoPaper } from '../helpers.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { T } from '../hafsql.js';

const router = Router();

// ──────────────────────────────────────────────
// GET /api/disciplines
// ──────────────────────────────────────────────

async function fetchDisciplinesFromHaf() {
  const pool = getPool();
  if (!pool) return null;

  try {
    const result = await pool.query(
      `SELECT
        (json_metadata -> $1 ->> 'discipline') AS name,
        count(*)::int AS paper_count
       FROM ${T.comments}
       WHERE parent_author = '' AND parent_permlink = $1
         AND (json_metadata -> $1 ->> 'type') = 'paper'
         AND json_metadata ->> 'app' LIKE $2
         AND (json_metadata -> $1 ->> 'discipline') IS NOT NULL
       GROUP BY (json_metadata -> $1 ->> 'discipline')
       ORDER BY paper_count DESC`,
      [config.appTag, `${config.appTag}/%`],
    );
    return result.rows;
  } catch (err) {
    logger.error({ err }, 'HAF disciplines query failed');
    return null;
  }
}

async function fetchDisciplinesFromHiveApi() {
  try {
    const discussions = await hiveClient.database.getDiscussions('created', {
      tag: config.appTag,
      limit: 100,
    });

    const counts = new Map<string, number>();
    for (const d of discussions) {
      const meta = parseMeta(d.json_metadata);
      if (!isPevoPaper(meta)) continue;
      const pevo = (meta[config.appTag] || {}) as Record<string, unknown>;
      const disc = pevo.discipline as string | undefined;
      if (disc) counts.set(disc, (counts.get(disc) || 0) + 1);
    }

    return Array.from(counts.entries())
      .map(([name, paper_count]) => ({ name, paper_count }))
      .sort((a, b) => b.paper_count - a.paper_count);
  } catch (err) {
    logger.error({ err }, 'Hive API disciplines query failed');
    return [];
  }
}

router.get('/', async (_req: Request, res: Response) => {
  if (isHafAvailable()) {
    const result = await hafCache.getOrSet('disciplines', fetchDisciplinesFromHaf, 60_000, true);
    if (result) return sendOk(res, result);
  }

  const result = await fetchDisciplinesFromHiveApi();
  sendOk(res, result);
});

export default router;

import { Router, type Request, type Response } from 'express';
import { getPool } from '../db.js';
import { config } from '../config.js';
import { sendOk } from '../response.js';
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
         AND (json_metadata -> $1 ->> 'type') IN ('paper', 'bridge_paper')
         AND json_metadata ->> 'app' LIKE $2
         AND (json_metadata -> $1 ->> 'discipline') IS NOT NULL
       GROUP BY (json_metadata -> $1 ->> 'discipline')
       ORDER BY paper_count DESC`,
      [config.appTag, `${config.appTag}/%`],
    );
    return result.rows;
  } catch (err) {
    logger.error({ err }, 'HAF disciplines query failed');
    return [];
  }
}

router.get('/', async (_req: Request, res: Response) => {
  const result = await hafCache.getOrSet('disciplines', fetchDisciplinesFromHaf, 60_000, true);
  sendOk(res, result);
});

export default router;

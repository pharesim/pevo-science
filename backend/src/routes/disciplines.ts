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
    // Dedup mixed-case discipline names (e.g. "Physics" vs "physics") by
    // grouping on LOWER(name). display_name is the arbitrary-but-stable
    // MAX(name) representative of the lowercase group; the frontend is
    // expected to titlecase it for rendering. canon_name is the lowercase
    // value that the ?discipline= filter (search.ts / papers.ts) matches on.
    const result = await pool.query(
      `SELECT
        LOWER(json_metadata -> $1 ->> 'discipline') AS canon_name,
        MAX(json_metadata -> $1 ->> 'discipline') AS display_name,
        count(*)::int AS paper_count
       FROM ${T.comments}
       WHERE parent_author = '' AND parent_permlink = $1
         AND (json_metadata -> $1 ->> 'type') IN ('paper', 'bridge_paper')
         AND json_metadata ->> 'app' LIKE $2
         AND (json_metadata -> $1 ->> 'discipline') IS NOT NULL
       GROUP BY LOWER(json_metadata -> $1 ->> 'discipline')
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

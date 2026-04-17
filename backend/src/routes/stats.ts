import { Router, type Request, type Response } from 'express';
import { getPool, isHafAvailable } from '../db.js';
import { config } from '../config.js';
import { sendOk } from '../response.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { T, activeAccreditationsCte } from '../hafsql.js';

const router = Router();

// ──────────────────────────────────────────────
// GET /api/stats
// ──────────────────────────────────────────────

const STATS_REFRESH_INTERVAL = 300_000; // 5 minutes

async function fetchStatsFromHaf() {
  const pool = getPool();
  if (!pool) return null;

  try {
    const cte = activeAccreditationsCte();
    const at = `$${cte.nextIdx}`;      // appTag
    const al = `$${cte.nextIdx + 1}`;  // appTag/%
    const params = [...cte.params, config.appTag, `${config.appTag}/%`];

    // Two queries in parallel: papers (single scan with conditional aggregation) + reviews
    const [papersResult, reviewsResult] = await Promise.all([
      pool.query(`
        ${cte.sql},
        papers AS (
          SELECT c.json_metadata, c.created
          FROM ${T.comments} c
          JOIN active_accreditations aa ON aa.account = c.author
          WHERE c.parent_author = '' AND c.parent_permlink = ${at}
            AND (c.json_metadata -> ${at} ->> 'type') IN ('paper', 'bridge_paper')
            AND c.json_metadata ->> 'app' LIKE ${al}
        )
        SELECT
          (SELECT count(*)::int FROM active_accreditations) AS total_accredited_researchers,
          count(*) FILTER (WHERE (json_metadata -> ${at} ->> 'type') = 'paper')::int AS total_papers,
          count(*) FILTER (WHERE (json_metadata -> ${at} ->> 'type') = 'bridge_paper')::int AS total_bridge_papers,
          count(*) FILTER (WHERE (json_metadata -> ${at} ->> 'type') = 'paper'
            AND created >= now() - interval '30 days')::int AS papers_last_30_days,
          count(DISTINCT (json_metadata -> ${at} ->> 'discipline'))
            FILTER (WHERE (json_metadata -> ${at} ->> 'discipline') IS NOT NULL)::int AS active_disciplines,
          COALESCE((
            SELECT count(*)::int FROM papers ci,
              jsonb_array_elements(ci.json_metadata -> ${at} -> 'citations') AS cit
            WHERE jsonb_typeof(ci.json_metadata -> ${at} -> 'citations') = 'array'
          ), 0) AS total_citations
        FROM papers
      `, params),
      pool.query(`
        ${cte.sql}
        SELECT
          count(*)::int AS total_reviews,
          count(*) FILTER (WHERE c.created >= now() - interval '30 days')::int AS reviews_last_30_days
        FROM ${T.comments} c
        JOIN active_accreditations aa ON aa.account = c.author
        WHERE (c.json_metadata -> ${at} ->> 'type') = 'review'
          AND c.json_metadata ->> 'app' LIKE ${al}
      `, params),
    ]);

    const p = papersResult.rows[0];
    const r = reviewsResult.rows[0];
    return {
      total_papers: p.total_papers,
      total_reviews: r.total_reviews,
      total_accredited_researchers: p.total_accredited_researchers,
      total_citations: p.total_citations,
      active_disciplines: p.active_disciplines,
      papers_last_30_days: p.papers_last_30_days,
      reviews_last_30_days: r.reviews_last_30_days,
      total_bridge_papers: p.total_bridge_papers,
    };
  } catch (err) {
    logger.error({ err }, 'HAF stats query failed');
    return null;
  }
}

const ZERO_STATS = {
  total_papers: 0,
  total_reviews: 0,
  total_accredited_researchers: 0,
  total_citations: 0,
  active_disciplines: 0,
  papers_last_30_days: 0,
  reviews_last_30_days: 0,
  total_bridge_papers: 0,
};

router.get('/', async (_req: Request, res: Response) => {
  if (isHafAvailable()) {
    const result = await hafCache.get('stats');
    if (result) return sendOk(res, result);
  }

  sendOk(res, ZERO_STATS);
});

/** Warm the stats cache at startup via periodic refresh. */
export async function startStatsCache(): Promise<void> {
  await hafCache.registerPeriodicRefresh('stats', fetchStatsFromHaf, STATS_REFRESH_INTERVAL);
}

export default router;

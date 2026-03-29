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

async function fetchStatsFromHaf() {
  const pool = getPool();
  if (!pool) return null;

  try {
    const cte = activeAccreditationsCte();
    const at = `$${cte.nextIdx}`;      // appTag
    const al = `$${cte.nextIdx + 1}`;  // appTag/%
    const result = await pool.query(`
      ${cte.sql}
      SELECT
        (SELECT count(*)::int FROM ${T.comments} c
         JOIN active_accreditations aa ON aa.account = c.author
         WHERE c.parent_author = '' AND c.parent_permlink = ${at}
           AND (c.json_metadata -> ${at} ->> 'type') = 'paper'
           AND c.json_metadata ->> 'app' LIKE ${al})
        AS total_papers,

        (SELECT count(*)::int FROM ${T.comments} c
         JOIN active_accreditations aa ON aa.account = c.author
         WHERE (c.json_metadata -> ${at} ->> 'type') = 'review'
           AND c.json_metadata ->> 'app' LIKE ${al})
        AS total_reviews,

        (SELECT count(*)::int FROM active_accreditations)
        AS total_accredited_researchers,

        (SELECT count(*)::int FROM ${T.comments} c
         JOIN active_accreditations aa ON aa.account = c.author
         WHERE c.parent_author = '' AND c.parent_permlink = ${at}
           AND (c.json_metadata -> ${at} ->> 'type') = 'paper'
           AND c.json_metadata ->> 'app' LIKE ${al}
           AND c.created >= now() - interval '30 days')
        AS papers_last_30_days,

        (SELECT count(*)::int FROM ${T.comments} c
         JOIN active_accreditations aa ON aa.account = c.author
         WHERE (c.json_metadata -> ${at} ->> 'type') = 'review'
           AND c.json_metadata ->> 'app' LIKE ${al}
           AND c.created >= now() - interval '30 days')
        AS reviews_last_30_days,

        (SELECT count(DISTINCT (c.json_metadata -> ${at} ->> 'discipline'))::int
         FROM ${T.comments} c
         JOIN active_accreditations aa ON aa.account = c.author
         WHERE c.parent_author = '' AND c.parent_permlink = ${at}
           AND (c.json_metadata -> ${at} ->> 'type') = 'paper'
           AND c.json_metadata ->> 'app' LIKE ${al}
           AND (c.json_metadata -> ${at} ->> 'discipline') IS NOT NULL)
        AS active_disciplines,

        (SELECT count(*)::int
         FROM ${T.comments} c
         JOIN active_accreditations aa ON aa.account = c.author,
              jsonb_array_elements(c.json_metadata -> ${at} -> 'citations') AS cit
         WHERE c.parent_author = '' AND c.parent_permlink = ${at}
           AND (c.json_metadata -> ${at} ->> 'type') IN ('paper', 'bridge_paper')
           AND c.json_metadata ->> 'app' LIKE ${al}
           AND jsonb_typeof(c.json_metadata -> ${at} -> 'citations') = 'array')
        AS total_citations,

        (SELECT count(*)::int FROM ${T.comments} c
         JOIN active_accreditations aa ON aa.account = c.author
         WHERE c.parent_author = '' AND c.parent_permlink = ${at}
           AND (c.json_metadata -> ${at} ->> 'type') = 'bridge_paper'
           AND c.json_metadata ->> 'app' LIKE ${al})
        AS total_bridge_papers
    `, [...cte.params, config.appTag, `${config.appTag}/%`]);

    const row = result.rows[0];
    return {
      total_papers: row.total_papers,
      total_reviews: row.total_reviews,
      total_accredited_researchers: row.total_accredited_researchers,
      total_citations: row.total_citations,
      active_disciplines: row.active_disciplines,
      papers_last_30_days: row.papers_last_30_days,
      reviews_last_30_days: row.reviews_last_30_days,
      total_bridge_papers: row.total_bridge_papers,
    };
  } catch (err) {
    logger.error({ err }, 'HAF stats query failed');
    return null;
  }
}

router.get('/', async (_req: Request, res: Response) => {
  if (isHafAvailable()) {
    const result = await hafCache.getOrSet('stats', fetchStatsFromHaf, 60_000, true);
    if (result) return sendOk(res, result);
  }

  // Without HAF, return zeros
  sendOk(res, {
    total_papers: 0,
    total_reviews: 0,
    total_accredited_researchers: 0,
    total_citations: 0,
    active_disciplines: 0,
    papers_last_30_days: 0,
    reviews_last_30_days: 0,
    total_bridge_papers: 0,
  });
});

export default router;

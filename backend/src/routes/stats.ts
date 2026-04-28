import { Router, type Request, type Response } from 'express';
import { getPool, isHafAvailable } from '../db.js';
import { config } from '../config.js';
import { sendOk } from '../response.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { T, activeAccreditationsCte } from '../hafsql.js';
import { getBatchReputationMap } from '../reputation.js';

const router = Router();

// ──────────────────────────────────────────────
// GET /api/stats
// ──────────────────────────────────────────────

const STATS_REFRESH_INTERVAL = 300_000; // 5 minutes

// Exported for tests so the stats SQL can be exercised without registering a
// periodic-refresh setInterval (see BE-DISCIPLINE-CANONICALIZE round-2 hold
// #4). Production callers should go through the HTTP route, which reads from
// the cache warmed by startStatsCache().
export async function fetchStatsFromHaf() {
  const pool = getPool();
  if (!pool) return null;

  try {
    const cte = activeAccreditationsCte();
    const at = `$${cte.nextIdx}`;      // appTag
    const al = `$${cte.nextIdx + 1}`;  // appTag/%
    const anon = `$${cte.nextIdx + 2}`; // anonymous review account
    const bridge = `$${cte.nextIdx + 3}`; // platform bridge account (pins bridge_paper carve-out)
    const params = [...cte.params, config.appTag, `${config.appTag}/%`, config.hiveAnonAccount, config.hiveBridgeAccount];

    // Single query: papers CTE narrows to PEvO posts, reviews CTE joins through
    // papers (children of known papers) to avoid a full hafsql.comments scan.
    //
    // The bridge_paper accreditation carve-out is pinned to
    // `c.author = config.hiveBridgeAccount`. Without the author equality, any
    // unaccredited Hive account can spoof `type: bridge_paper` in
    // json_metadata to slip past the accreditation gate (the carve-out then
    // ALSO leaks into `total_bridge_papers` since the SELECT subquery only
    // gates on type after the CTE has admitted it). Mirrors papers.ts and
    // search.ts.
    const result = await pool.query(`
      ${cte.sql},
      papers AS (
        SELECT c.author, c.permlink, c.json_metadata, c.created
        FROM ${T.comments} c
        LEFT JOIN active_accreditations aa ON aa.account = c.author
        WHERE c.parent_author = '' AND c.parent_permlink = ${at}
          AND (c.json_metadata -> ${at} ->> 'type') IN ('paper', 'bridge_paper')
          AND c.json_metadata ->> 'app' LIKE ${al}
          AND (c.json_metadata -> ${at} -> 'continues') IS NULL
          AND (aa.account IS NOT NULL
               OR (c.author = ${bridge} AND (c.json_metadata -> ${at} ->> 'type') = 'bridge_paper'))
      ),
      reviews AS (
        SELECT r.created
        FROM ${T.comments} r
        INNER JOIN papers p ON r.parent_author = p.author AND r.parent_permlink = p.permlink
        WHERE (r.json_metadata -> ${at} ->> 'type') = 'review'
          AND r.json_metadata ->> 'app' LIKE ${al}
          AND (EXISTS (SELECT 1 FROM active_accreditations aa WHERE aa.account = r.author)
               OR r.author = ${anon})
      )
      SELECT
        (SELECT count(*)::int FROM active_accreditations) AS total_accredited_researchers,
        (SELECT count(*)::int FROM papers WHERE (json_metadata -> ${at} ->> 'type') = 'paper') AS total_papers,
        (SELECT count(*)::int FROM papers WHERE (json_metadata -> ${at} ->> 'type') = 'bridge_paper') AS total_bridge_papers,
        (SELECT count(*)::int FROM papers WHERE (json_metadata -> ${at} ->> 'type') = 'paper'
          AND created >= now() - interval '30 days') AS papers_last_30_days,
        (SELECT count(DISTINCT LOWER(json_metadata -> ${at} ->> 'discipline'))::int FROM papers
          WHERE (json_metadata -> ${at} ->> 'discipline') IS NOT NULL) AS active_disciplines,
        COALESCE((
          SELECT count(*)::int FROM papers ci,
            jsonb_array_elements(ci.json_metadata -> ${at} -> 'citations') AS cit
          WHERE jsonb_typeof(ci.json_metadata -> ${at} -> 'citations') = 'array'
        ), 0) AS total_citations,
        (SELECT count(*)::int FROM reviews) AS total_reviews,
        (SELECT count(*)::int FROM reviews WHERE created >= now() - interval '30 days') AS reviews_last_30_days
    `, params);

    const row = result.rows[0];

    // Find highest reputation from Redis batch scores. The map values are
    // ReputationScore objects ({score, breakdown}); compare on `.score`.
    // Leave highest_reputation_user null when nobody has a strictly positive
    // score — the frontend hides the card on a falsy value, which is the
    // correct rendering for the "fresh Redis, no cycle yet" state.
    let highest_reputation_user: string | null = null;
    let highest_reputation_score = 0;
    const repMap = await getBatchReputationMap();
    for (const [username, rep] of repMap) {
      if (rep.score > highest_reputation_score) {
        highest_reputation_score = rep.score;
        highest_reputation_user = username;
      }
    }

    return {
      total_papers: row.total_papers,
      total_reviews: row.total_reviews,
      total_accredited_researchers: row.total_accredited_researchers,
      total_citations: row.total_citations,
      active_disciplines: row.active_disciplines,
      papers_last_30_days: row.papers_last_30_days,
      reviews_last_30_days: row.reviews_last_30_days,
      total_bridge_papers: row.total_bridge_papers,
      highest_reputation_user,
      highest_reputation_score,
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
  highest_reputation_user: null as string | null,
  highest_reputation_score: 0,
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

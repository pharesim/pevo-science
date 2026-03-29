import { Router, type Request, type Response } from 'express';
import { getPool, isHafAvailable } from '../db.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { parsePageLimit } from '../helpers.js';
import { getAccreditedSet } from '../accreditation.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { T, activeAccreditationsCteBody, retractedPapersCteBody, buildWith } from '../hafsql.js';

const router = Router();

// ──────────────────────────────────────────────
// GET /api/search?q=...
// ──────────────────────────────────────────────

async function searchFromHaf(
  query: string,
  type: string,
  discipline: string | undefined,
  language: string | undefined,
  source: string | undefined,
  accreditedOnly: boolean,
  includeRetracted: boolean,
  sort: string,
  limit: number,
  offset: number,
) {
  const pool = getPool();
  if (!pool) return null;

  try {
    // Build CTEs with parameterized appTag — $1 is always the search query
    const cte = buildWith(2, activeAccreditationsCteBody, retractedPapersCteBody);
    let paramIdx = cte.nextIdx;

    // appTag params for WHERE conditions
    const appTagParam = `$${paramIdx++}`;
    const appLikeParam = `$${paramIdx++}`;
    const cteParams = [...cte.params, config.appTag, `${config.appTag}/%`];

    const conditions: string[] = [
      `c.json_metadata ->> 'app' LIKE ${appLikeParam}`,
    ];
    const params: unknown[] = [query, ...cteParams];

    if (type === 'paper') {
      // Apply source filter within paper type
      if (source === 'native') {
        conditions.push(`(c.json_metadata -> ${appTagParam} ->> 'type') = 'paper'`);
      } else if (source === 'bridge') {
        conditions.push(`(c.json_metadata -> ${appTagParam} ->> 'type') = 'bridge_paper'`);
      } else {
        conditions.push(`(c.json_metadata -> ${appTagParam} ->> 'type') IN ('paper', 'bridge_paper')`);
      }
      conditions.push("c.parent_author = ''");
      conditions.push(`c.parent_permlink = ${appTagParam}`);
    } else if (type === 'review') {
      conditions.push(`(c.json_metadata -> ${appTagParam} ->> 'type') = 'review'`);
    } else {
      // All types — include bridge papers alongside native
      if (source === 'native') {
        conditions.push(`(c.json_metadata -> ${appTagParam} ->> 'type') IN ('paper', 'review')`);
      } else if (source === 'bridge') {
        conditions.push(`(c.json_metadata -> ${appTagParam} ->> 'type') = 'bridge_paper'`);
      } else {
        conditions.push(`(c.json_metadata -> ${appTagParam} ->> 'type') IN ('paper', 'bridge_paper', 'review')`);
      }
    }

    if (discipline) {
      conditions.push(`(c.json_metadata -> ${appTagParam} ->> 'discipline') = $${paramIdx++}`);
      params.push(discipline);
    }

    if (language) {
      conditions.push(`(c.json_metadata -> ${appTagParam} ->> 'language') = $${paramIdx++}`);
      params.push(language);
    }

    if (accreditedOnly) {
      conditions.push(`c.author IN (SELECT account FROM active_accreditations)`);
    }
    if (!includeRetracted) {
      conditions.push(`NOT EXISTS (SELECT 1 FROM retracted_papers rp WHERE rp.author = c.author AND rp.permlink = c.permlink)`);
    }

    const where = conditions.join(' AND ');
    const tsQuery = 'plainto_tsquery($1)';
    const rankExpr = sort === 'date'
      ? 'c.created DESC'
      : `ts_rank_cd(to_tsvector(c.title || ' ' || c.body), ${tsQuery}) DESC`;

    const countResult = await pool.query(
      `${cte.sql}
       SELECT count(*)::int AS total
       FROM ${T.comments} c
       WHERE ${where}
         AND to_tsvector(c.title || ' ' || c.body) @@ ${tsQuery}`,
      params,
    );
    const total = countResult.rows[0]?.total ?? 0;

    const dataResult = await pool.query(
      `${cte.sql}
       SELECT
        (c.json_metadata -> ${appTagParam} ->> 'type') AS type,
        c.author,
        c.permlink,
        c.title,
        ts_headline(c.body, ${tsQuery}, 'MaxFragments=2, MaxWords=30') AS snippet,
        ts_rank_cd(to_tsvector(c.title || ' ' || c.body), ${tsQuery}) AS rank,
        c.created
       FROM ${T.comments} c
       WHERE ${where}
         AND to_tsvector(c.title || ' ' || c.body) @@ ${tsQuery}
       ORDER BY ${rankExpr}
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset],
    );

    const authors = dataResult.rows.map((r: Record<string, unknown>) => r.author as string);
    const accreditedSet = await getAccreditedSet(authors);

    const rows = dataResult.rows.map((r: Record<string, unknown>) => ({
      type: r.type,
      author: r.author,
      permlink: r.permlink,
      title: r.title,
      snippet: r.snippet,
      rank: r.rank,
      created: r.created,
      is_accredited: accreditedSet.has(r.author as string),
    }));

    return { rows, total };
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'HAF search query failed');
    return null;
  }
}

router.get('/', async (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q || q.trim().length === 0) {
    return sendError(res, 400, 'BAD_REQUEST', 'Search query "q" is required');
  }

  const type = (req.query.type as string) || 'all';
  const discipline = req.query.discipline as string | undefined;
  const language = req.query.language as string | undefined;
  const source = req.query.source as string | undefined;
  const accreditedOnly = req.query.accredited_only !== 'false'; // default true
  const includeRetracted = req.query.include_retracted === 'true'; // default false
  const sort = (req.query.sort as string) === 'date' ? 'date' : 'relevance';
  const { page, limit, offset } = parsePageLimit(req);

  if (isHafAvailable()) {
    const cacheKey = `search:q=${q}:t=${type}:d=${discipline || ''}:l=${language || ''}:src=${source || ''}:a=${accreditedOnly}:r=${includeRetracted}:s=${sort}:p=${page}:lim=${limit}`;
    const result = await hafCache.getOrSet(cacheKey, () => searchFromHaf(q, type, discipline, language, source, accreditedOnly, includeRetracted, sort, limit, offset), 15_000);
    if (result) return sendOk(res, result.rows, { page, limit, total: result.total });
  }

  // Full-text search requires HAF/PostgreSQL; without it return empty results
  sendOk(res, [], { page, limit, total: 0 });
});

export default router;

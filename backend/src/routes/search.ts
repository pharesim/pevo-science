import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { getPool, isHafAvailable } from '../db.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { parsePageLimit } from '../helpers.js';
import { getAccreditedSet } from '../accreditation.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { T, activeAccreditationsCteBody, retractedPapersCteBody, buildWith } from '../hafsql.js';
import { validateDisciplineFilter, DisciplineFilterError } from '../types/disciplines.js';

const router = Router();

// ──────────────────────────────────────────────
// GET /api/search?q=...
// ──────────────────────────────────────────────

interface SearchRow {
  type: string;
  author: string;
  permlink: string;
  title: string | null;
  snippet: string;
  created: string;
  paper_author?: string;
  paper_permlink?: string;
}

async function searchPapersFromHaf(
  pool: ReturnType<typeof getPool> & object,
  query: string,
  discipline: string | undefined,
  language: string | undefined,
  source: string | undefined,
  accreditedOnly: boolean,
  includeRetracted: boolean,
  sort: string,
  limit: number,
  offset: number,
): Promise<{ rows: SearchRow[]; total: number } | null> {
  const cte = buildWith(1, activeAccreditationsCteBody, retractedPapersCteBody);
  let paramIdx = cte.nextIdx;

  const appTagParam = `$${paramIdx++}`;
  const appLikeParam = `$${paramIdx++}`;
  const cteParams = [...cte.params, config.appTag, `${config.appTag}/%`];

  const conditions: string[] = [
    `c.parent_permlink = ${appTagParam}`,
    "c.parent_author = ''",
    `c.json_metadata ->> 'app' LIKE ${appLikeParam}`,
  ];
  const params: unknown[] = [...cteParams];

  if (source === 'native') {
    conditions.push(`(c.json_metadata -> ${appTagParam} ->> 'type') = 'paper'`);
  } else if (source === 'bridge') {
    conditions.push(`(c.json_metadata -> ${appTagParam} ->> 'type') = 'bridge_paper'`);
  } else {
    conditions.push(`(c.json_metadata -> ${appTagParam} ->> 'type') IN ('paper', 'bridge_paper')`);
  }

  if (discipline) {
    // Case-insensitive match: canonicalize both sides to lowercase so a
    // `?discipline=physics` filter still matches papers tagged "Physics",
    // "PHYSICS", etc. Mirrors the LOWER()-grouped /api/disciplines query.
    // Callers (router, papers, search) lowercase `discipline` once at route
    // entry, so the bound parameter is already canonical here. (stats has no
    // `?discipline=` query param; it applies LOWER() inside a hard-coded
    // subquery.)
    conditions.push(`LOWER(c.json_metadata -> ${appTagParam} ->> 'discipline') = $${paramIdx++}`);
    params.push(discipline);
  }

  if (language) {
    conditions.push(`(c.json_metadata -> ${appTagParam} ->> 'language') = $${paramIdx++}`);
    params.push(language);
  }

  if (accreditedOnly) {
    // Pin the bridge_paper accreditation carve-out to the platform bridge
    // account. Without `c.author = config.hiveBridgeAccount`, any unaccredited
    // Hive account can spoof `type: bridge_paper` in json_metadata to bypass
    // the accreditation gate. Mirrors papers.ts and stats.ts.
    const bridgeAccountParam = `$${paramIdx++}`;
    conditions.push(`(c.author IN (SELECT account FROM active_accreditations) OR (c.author = ${bridgeAccountParam} AND (c.json_metadata -> ${appTagParam} ->> 'type') = 'bridge_paper'))`);
    params.push(config.hiveBridgeAccount);
  }
  if (!includeRetracted) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM retracted_papers rp WHERE rp.author = c.author AND rp.permlink = c.permlink)`);
  }

  conditions.push(`(c.json_metadata -> ${appTagParam} -> 'continues') IS NULL`);

  const where = conditions.join(' AND ');

  const ilikeParam = `$${paramIdx++}`;
  const ilikePattern = `%${query}%`;
  const textMatch = `(c.title ILIKE ${ilikeParam} OR c.body ILIKE ${ilikeParam})`;

  const orderBy = sort === 'date'
    ? 'c.created DESC'
    : `(CASE WHEN c.title ILIKE ${ilikeParam} THEN 1 ELSE 0 END) DESC, c.created DESC`;

  const snippetExpr = `substring(c.body from 1 for 300)`;

  const limitParam = `$${paramIdx++}`;
  const offsetParam = `$${paramIdx++}`;

  const [countResult, dataResult] = await Promise.all([
    pool.query(
      `${cte.sql}
       SELECT count(*)::int AS total
       FROM ${T.comments} c
       WHERE ${where}
         AND ${textMatch}`,
      [...params, ilikePattern],
    ),
    pool.query(
      `${cte.sql}
       SELECT
        (c.json_metadata -> ${appTagParam} ->> 'type') AS type,
        c.author,
        c.permlink,
        c.title,
        ${snippetExpr} AS snippet,
        c.created
       FROM ${T.comments} c
       WHERE ${where}
         AND ${textMatch}
       ORDER BY ${orderBy}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      [...params, ilikePattern, limit, offset],
    ),
  ]);

  const total = countResult.rows[0]?.total ?? 0;
  const rows: SearchRow[] = dataResult.rows.map((r: Record<string, unknown>) => ({
    type: r.type as string,
    author: r.author as string,
    permlink: r.permlink as string,
    title: r.title as string | null,
    snippet: r.snippet as string,
    created: r.created as string,
  }));

  return { rows, total };
}

async function searchReviewsFromHaf(
  pool: ReturnType<typeof getPool> & object,
  query: string,
  accreditedOnly: boolean,
  sort: string,
  limit: number,
  offset: number,
): Promise<{ rows: SearchRow[]; total: number } | null> {
  const cte = buildWith(1, activeAccreditationsCteBody);
  let paramIdx = cte.nextIdx;

  const appTagParam = `$${paramIdx++}`;
  const appLikeParam = `$${paramIdx++}`;
  const params: unknown[] = [...cte.params, config.appTag, `${config.appTag}/%`];

  // Reviews are child comments of PEvO papers
  const conditions: string[] = [
    `c.parent_author != ''`,
    `c.json_metadata ->> 'app' LIKE ${appLikeParam}`,
    `(c.json_metadata -> ${appTagParam} ->> 'type') = 'review'`,
    // Ensure parent is a PEvO paper (top-level post in our app namespace)
    `EXISTS (SELECT 1 FROM ${T.comments} p
       WHERE p.author = c.parent_author AND p.permlink = c.parent_permlink
         AND p.parent_author = '' AND p.parent_permlink = ${appTagParam})`,
  ];

  if (accreditedOnly) {
    conditions.push(`c.author IN (SELECT account FROM active_accreditations)`);
  }

  const where = conditions.join(' AND ');

  const ilikeParam = `$${paramIdx++}`;
  const ilikePattern = `%${query}%`;
  const textMatch = `c.body ILIKE ${ilikeParam}`;

  const orderBy = 'c.created DESC';

  const snippetExpr = `substring(c.body from 1 for 300)`;

  const limitParam = `$${paramIdx++}`;
  const offsetParam = `$${paramIdx++}`;

  const [countResult, dataResult] = await Promise.all([
    pool.query(
      `${cte.sql}
       SELECT count(*)::int AS total
       FROM ${T.comments} c
       WHERE ${where}
         AND ${textMatch}`,
      [...params, ilikePattern],
    ),
    pool.query(
      `${cte.sql}
       SELECT
        c.author,
        c.permlink,
        ${snippetExpr} AS snippet,
        c.created,
        c.parent_author AS paper_author,
        c.parent_permlink AS paper_permlink
       FROM ${T.comments} c
       WHERE ${where}
         AND ${textMatch}
       ORDER BY ${orderBy}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      [...params, ilikePattern, limit, offset],
    ),
  ]);

  const total = countResult.rows[0]?.total ?? 0;
  const rows: SearchRow[] = dataResult.rows.map((r: Record<string, unknown>) => ({
    type: 'review',
    author: r.author as string,
    permlink: r.permlink as string,
    title: null,
    snippet: r.snippet as string,
    created: r.created as string,
    paper_author: r.paper_author as string,
    paper_permlink: r.paper_permlink as string,
  }));

  return { rows, total };
}

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
    if (type === 'review') {
      return await searchReviewsFromHaf(pool, query, accreditedOnly, sort, limit, offset);
    }

    if (type === 'paper') {
      return await searchPapersFromHaf(pool, query, discipline, language, source, accreditedOnly, includeRetracted, sort, limit, offset);
    }

    // type === 'all': run both queries and merge
    const [paperResult, reviewResult] = await Promise.all([
      searchPapersFromHaf(pool, query, discipline, language, source, accreditedOnly, includeRetracted, sort, limit, offset),
      searchReviewsFromHaf(pool, query, accreditedOnly, sort, limit, offset),
    ]);

    if (!paperResult && !reviewResult) return null;

    const paperRows = paperResult?.rows ?? [];
    const reviewRows = reviewResult?.rows ?? [];

    // Merge by created date descending, then take limit
    const allRows = [...paperRows, ...reviewRows]
      .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
      .slice(0, limit);

    const total = (paperResult?.total ?? 0) + (reviewResult?.total ?? 0);

    return { rows: allRows, total };
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
  // Canonicalize `?discipline=` at route entry so downstream SQL binding and
  // cache-key construction share the same lowercased value. Three-site
  // lowercasing (route, SQL binder, cache key) drifted under refactor — see
  // BE-DISCIPLINE-CANONICALIZE round-2 hold #6. Round-3 hold #2: use a
  // typeof-narrowed check rather than `as string | undefined`; Express types
  // `req.query[k]` as `string | ParsedQs | string[] | ParsedQs[] | undefined`,
  // so repeated params (`?discipline=a&discipline=b`) yield `string[]` and an
  // unsafe cast silently coerces `.toLowerCase()` on the array to
  // `"[object Object]"` in the cache key.
  //
  // BE-DISCIPLINE-LENGTH-CAP: validate length + charset BEFORE .toLowerCase()
  // so a 1 MB oversize string is rejected before V8 does the lower. The helper
  // runs the length check on the raw input, rejects non-Unicode-safe charsets,
  // and returns the canonical lowercased value (or null for empty/non-string).
  let discipline: string | null;
  try {
    discipline = validateDisciplineFilter(req.query.discipline);
  } catch (err) {
    if (err instanceof DisciplineFilterError) {
      return sendError(res, 400, 'BAD_REQUEST', err.message);
    }
    throw err;
  }
  const language = req.query.language as string | undefined;
  const source = req.query.source as string | undefined;
  const accreditedOnly = req.query.accredited_only !== 'false'; // default true
  const includeRetracted = req.query.include_retracted === 'true'; // default false
  const sort = (req.query.sort as string) === 'date' ? 'date' : 'relevance';
  const { page, limit, offset } = parsePageLimit(req);

  if (isHafAvailable()) {
    // `discipline` is already lowercased at route entry (see above), so the
    // cache key is canonical — `?discipline=Physics` and `?discipline=physics`
    // share a single Redis entry.
    const rawKey = `q=${q}:t=${type}:d=${discipline || ''}:l=${language || ''}:src=${source || ''}:a=${accreditedOnly}:r=${includeRetracted}:s=${sort}:p=${page}:lim=${limit}`;
    const cacheKey = `search:${crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 32)}`;
    const result = await hafCache.getOrSet(cacheKey, () => searchFromHaf(q, type, discipline ?? undefined, language, source, accreditedOnly, includeRetracted, sort, limit, offset), 15_000);
    if (result) {
      const authors = result.rows.map((r) => r.author);
      const accreditedSet = await getAccreditedSet(authors);
      const rows = result.rows.map((r) => ({
        ...r,
        is_accredited: accreditedSet.has(r.author),
      }));
      return sendOk(res, rows, { page, limit, total: result.total });
    }
  }

  // Full-text search requires HAF/PostgreSQL; without it return empty results
  sendOk(res, [], { page, limit, total: 0 });
});

export default router;

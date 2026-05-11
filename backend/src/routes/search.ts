import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { getPool, isHafConfigured } from '../db.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { parsePageLimit } from '../helpers.js';
import { getAccreditedSet } from '../accreditation.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { T, activeAccreditationsCteBody, retractedPapersCteBody, buildWith, validPevoPaperWhere } from '../hafsql.js';
import { validateDisciplineFilter } from '../types/disciplines.js';
import { validateSearchQuery } from '../types/search-filters.js';

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
  includeRetracted: boolean,
  sort: string,
  limit: number,
  offset: number,
): Promise<{ rows: SearchRow[]; total: number } | null> {
  const cte = buildWith(1, activeAccreditationsCteBody, retractedPapersCteBody);
  let paramIdx = cte.nextIdx;

  const appTagParam = `$${paramIdx++}`;
  const appLikeParam = `$${paramIdx++}`;
  const bridgeAccountParam = `$${paramIdx++}`;
  const cteParams = [...cte.params, config.appTag, `${config.appTag}/%`, config.hiveBridgeAccount];

  const conditions: string[] = [
    `c.parent_permlink = ${appTagParam}`,
    "c.parent_author = ''",
    `c.json_metadata ->> 'app' LIKE ${appLikeParam}`,
  ];
  const params: unknown[] = [...cteParams];

  const paperSource: 'native' | 'bridge' | 'all' =
    source === 'native' ? 'native' : source === 'bridge' ? 'bridge' : 'all';
  conditions.push(validPevoPaperWhere({ commentAlias: 'c', appTagParam, bridgeAccountParam, source: paperSource }));

  if (discipline) {
    // LOWER() on both sides so case-variant on-chain values match.
    conditions.push(`LOWER(c.json_metadata -> ${appTagParam} ->> 'discipline') = $${paramIdx++}`);
    params.push(discipline);
  }

  if (language) {
    conditions.push(`(c.json_metadata -> ${appTagParam} ->> 'language') = $${paramIdx++}`);
    params.push(language);
  }

  // Accreditation gate is unconditional. Bridge-account-pinned bridge_paper
  // carve-out only — a bridge_paper from any other author is invalid data
  // per the pevo-object-identity convention. The legacy
  // `?accredited_only=false` opt-out is silently ignored per Express
  // convention (api-contracts/common.md).
  {
    const bridgeArm = validPevoPaperWhere({ commentAlias: 'c', appTagParam, bridgeAccountParam, source: 'bridge' });
    conditions.push(`(c.author IN (SELECT account FROM active_accreditations) OR ${bridgeArm})`);
  }
  if (!includeRetracted) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM retracted_papers rp WHERE rp.author = c.author AND rp.permlink = c.permlink)`);
  }

  conditions.push(`(c.json_metadata -> ${appTagParam} -> 'continues') IS NULL`);

  const where = conditions.join(' AND ');

  // `query` arrives already LIKE-escaped + length-capped from the route
  // handler via `validateSearchQuery`. The wildcards we wrap around it are
  // the literal LIKE metacharacters; user-supplied `%` `_` `\` are
  // backslash-escaped inside `query` so Postgres treats them as literals
  // under the `ESCAPE '\\'` clause (BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP).
  const ilikeParam = `$${paramIdx++}`;
  const ilikePattern = `%${query}%`;
  const textMatch = `(c.title ILIKE ${ilikeParam} ESCAPE '\\' OR c.body ILIKE ${ilikeParam} ESCAPE '\\')`;

  const orderBy = sort === 'date'
    ? 'c.created DESC'
    : `(CASE WHEN c.title ILIKE ${ilikeParam} ESCAPE '\\' THEN 1 ELSE 0 END) DESC, c.created DESC`;

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

  // Accreditation gate is unconditional — see lane 4 of
  // backend-papers-filter-accreditation for the single-doc reviews gate
  // rationale; this list-mode site enforces the same predicate. Reviews
  // surfaces do NOT include the hiveAnonAccount OR-arm here because list
  // search has no need to surface anon-proxy reviews — the single-doc
  // detail endpoint (reviews.ts) handles that path.
  conditions.push(`c.author IN (SELECT account FROM active_accreditations)`);

  const where = conditions.join(' AND ');

  // See searchPapersFromHaf for the escape contract: `query` is pre-escaped,
  // ESCAPE '\\' makes Postgres treat embedded `\%` `\_` `\\` as literals.
  const ilikeParam = `$${paramIdx++}`;
  const ilikePattern = `%${query}%`;
  const textMatch = `c.body ILIKE ${ilikeParam} ESCAPE '\\'`;

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
  includeRetracted: boolean,
  sort: string,
  limit: number,
  offset: number,
) {
  const pool = getPool();
  if (!pool) return null;

  try {
    if (type === 'review') {
      return await searchReviewsFromHaf(pool, query, sort, limit, offset);
    }

    if (type === 'paper') {
      return await searchPapersFromHaf(pool, query, discipline, language, source, includeRetracted, sort, limit, offset);
    }

    // type === 'all': run both queries and merge
    const [paperResult, reviewResult] = await Promise.all([
      searchPapersFromHaf(pool, query, discipline, language, source, includeRetracted, sort, limit, offset),
      searchReviewsFromHaf(pool, query, sort, limit, offset),
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
  // BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP: validate length + LIKE-escape BEFORE
  // the bound parameter reaches the SQL binder. null = absent (missing,
  // empty/whitespace, repeated-param array shape, non-string) → 400 required;
  // ok=false = present-but-too-long → 400 too-long; ok=true → LIKE-escaped
  // value. The downstream SQL pairs with `ESCAPE '\\'` on every ILIKE site.
  const qResult = validateSearchQuery(req.query.q);
  if (qResult === null) {
    return sendError(res, 400, 'BAD_REQUEST', 'Search query "q" is required');
  }
  if (!qResult.ok) {
    return sendError(res, 400, 'BAD_REQUEST', qResult.message);
  }
  const q = qResult.value;

  // BE-SEARCH-REVIEWS-CONTRACT-RECONCILE: validate `?type=` against the
  // documented enum (`all` | `paper` | `review`) instead of silently coercing
  // unknown values to `'all'`. Untyped fall-through hid the contract drift
  // where `papers.md` claimed reviews were unsearchable while the code
  // shipped a live `type === 'review'` branch. Pin the enum here so any
  // future drift surfaces as a 400 rather than a quiet semantic shift.
  // Typeof-narrowed (mirrors the discipline pattern above) — repeated
  // params (`?type=a&type=b`) yield `string[]` which an `as string` cast
  // would coerce to `"a,b"`, slipping past the enum check.
  const VALID_SEARCH_TYPES = ['all', 'paper', 'review'] as const;
  type SearchType = typeof VALID_SEARCH_TYPES[number];
  const rawType = req.query.type;
  let type: SearchType;
  if (rawType === undefined) {
    type = 'all';
  } else if (typeof rawType === 'string' && (VALID_SEARCH_TYPES as readonly string[]).includes(rawType)) {
    type = rawType as SearchType;
  } else {
    return sendError(res, 400, 'BAD_REQUEST', `Invalid type. Must be one of: ${VALID_SEARCH_TYPES.join(', ')}`);
  }
  // Cache key uses the lowercased value (hashed downstream); the SQL gate
  // uses `discipline ?? undefined` so the `if (discipline)` predicate
  // suppresses the WHERE clause entirely on absent input. Same value, two
  // coalesce shapes, on purpose.
  const filterResult = validateDisciplineFilter(req.query.discipline);
  if (filterResult && !filterResult.ok) {
    return sendError(res, 400, 'BAD_REQUEST', filterResult.message);
  }
  const discipline: string | null = filterResult?.ok ? filterResult.value : null;
  const language = req.query.language as string | undefined;
  const source = req.query.source as string | undefined;
  const includeRetracted = req.query.include_retracted === 'true'; // default false
  const sort = (req.query.sort as string) === 'date' ? 'date' : 'relevance';
  const { page, limit, offset } = parsePageLimit(req);

  if (isHafConfigured()) {
    // `discipline` is already lowercased at route entry (see above), so the
    // cache key is canonical — `?discipline=Physics` and `?discipline=physics`
    // share a single Redis entry.
    const rawKey = `q=${q}:t=${type}:d=${discipline || ''}:l=${language || ''}:src=${source || ''}:r=${includeRetracted}:s=${sort}:p=${page}:lim=${limit}`;
    const cacheKey = `search:${crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 32)}`;
    const result = await hafCache.getOrSet(cacheKey, () => searchFromHaf(q, type, discipline ?? undefined, language, source, includeRetracted, sort, limit, offset), 15_000);
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

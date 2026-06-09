import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { getPool, isHafConfigured } from '../db.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { parsePageLimit } from '../helpers.js';
import { getAccreditedSet } from '../accreditation.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { T, activeAccreditationsCteBody, retractedPapersCteBody, authorshipClaimsCteBody, buildWith, validPevoPaperWhere, validReviewWhere, excludeSelfReviewWhere, excludeClaimedSelfWhere } from '../hafsql.js';
import { validateDisciplineFilter } from '../types/disciplines.js';
import {
  validateSearchQuery,
  SEARCH_TYPES,
  SEARCH_SOURCES,
  SEARCH_SORTS,
  isSearchType,
  isSearchSource,
  isSearchSort,
  parseLanguageFilter,
  type SearchType,
  type SearchSource,
  type SearchSort,
} from '../types/search-filters.js';

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
  source: SearchSource | undefined,
  includeRetracted: boolean,
  sort: SearchSort,
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

  // Single-pass count+data via `count(*) OVER ()`: eliminates the prior
  // parallel count query that re-materialized the
  // `active_accreditations + retracted_papers` CTEs and re-scanned the
  // `accred_ranked` ROW_NUMBER set. Empty-result page returns zero rows so
  // `dataResult.rows[0]?.total ?? 0` degrades to 0. Matches the shape
  // established at `fetchAccreditationsFromHaf`.
  const dataResult = await pool.query(
    `${cte.sql}
     SELECT
      (c.json_metadata -> ${appTagParam} ->> 'type') AS type,
      c.author,
      c.permlink,
      c.title,
      ${snippetExpr} AS snippet,
      c.created,
      count(*) OVER ()::int AS total
     FROM ${T.comments} c
     WHERE ${where}
       AND ${textMatch}
     ORDER BY ${orderBy}
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...params, ilikePattern, limit, offset],
  );

  const total = dataResult.rows[0]?.total ?? 0;
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
  sort: SearchSort,
  limit: number,
  offset: number,
): Promise<{ rows: SearchRow[]; total: number } | null> {
  // authorship_claims (unscoped — claim ops are low-cardinality) lets the review
  // search drop a credited claimer's self-review via excludeClaimedSelfWhere.
  const cte = buildWith(1, activeAccreditationsCteBody, (idx) => authorshipClaimsCteBody(idx));
  let paramIdx = cte.nextIdx;

  const appTagParam = `$${paramIdx++}`;
  const bridgeAccountParam = `$${paramIdx++}`;
  const params: unknown[] = [...cte.params, config.appTag, config.hiveBridgeAccount || ''];

  // Reviews are child comments of PEvO papers. validReviewWhere supplies the
  // canonical type+rating-shape gate; the `app LIKE 'pevotest/%'` gate is
  // intentionally absent (per the trust-layer principle, an accredited
  // reviewer's broadcast counts regardless of authoring client).
  // The JOIN against parent paper `p` doubles duty: it asserts the parent
  // is a PEvO paper-class post (native or pinned bridge_paper, per
  // `validPevoPaperWhere(source:'all')`) AND gives excludeSelfReviewWhere a
  // paperRowAlias to read authors[] from.
  //
  // Display↔reputation parity (cross-surface): the prior weaker
  // `p.parent_author = '' AND p.parent_permlink = $appTag` check admitted
  // review-shaped replies to *any* top-level pevotest-tagged post (peakd
  // blogs, non-paper comments) while reputation correctly excludes them via
  // the user_reviews CTE that composes validPevoPaperWhere. This site now
  // composes the same gate; see
  // `agents/docs/solutions/conventions/cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md`.
  const conditions: string[] = [
    `c.parent_author != ''`,
    validPevoPaperWhere({ commentAlias: 'p', appTagParam, bridgeAccountParam, source: 'all' }),
    validReviewWhere({ commentAlias: 'c', appTagParam }),
    excludeSelfReviewWhere({ paperRowAlias: 'p', appTagParam }),
    excludeClaimedSelfWhere({ authorExpr: 'c.author', paperAuthorExpr: 'p.author', paperPermlinkExpr: 'p.permlink' }),
  ];

  // Accreditation gate is unconditional — see lane 4 of
  // backend-papers-filter-accreditation for the single-doc reviews gate
  // rationale; this list-mode site enforces the same predicate. Reviews
  // surfaces do NOT include the hiveAnonAccount OR-arm here because list
  // search has no need to surface anon-proxy reviews — the single-doc
  // detail endpoint (reviews.ts) handles that path.
  conditions.push(`c.author IN (SELECT account FROM active_accreditations)`);

  const where = conditions.join(' AND ');
  const parentJoin = `JOIN ${T.comments} p ON p.author = c.parent_author AND p.permlink = c.parent_permlink`;

  // See searchPapersFromHaf for the escape contract: `query` is pre-escaped,
  // ESCAPE '\\' makes Postgres treat embedded `\%` `\_` `\\` as literals.
  const ilikeParam = `$${paramIdx++}`;
  const ilikePattern = `%${query}%`;
  const textMatch = `c.body ILIKE ${ilikeParam} ESCAPE '\\'`;

  // sort accepted for signature symmetry with searchPapersFromHaf;
  // relevance-ranking for reviews is not yet implemented. When it is,
  // wire the sort value through here (and add a ?type=review&sort=relevance
  // happy-path spec at search.test.ts).
  const orderBy = 'c.created DESC';

  const snippetExpr = `substring(c.body from 1 for 300)`;

  const limitParam = `$${paramIdx++}`;
  const offsetParam = `$${paramIdx++}`;

  // Per-branch SQL sentinel: the partial-degradation test in
  // `tests/routes/search-partial-degradation.test.ts` discriminates the
  // reviews branch from the papers branch by matching this comment in the
  // rendered SQL. Survives alias renames and JOIN restructuring (unlike the
  // prior ` p ON ` substring match) because it's emitted from the helper
  // itself rather than inferred from the rendered SQL shape.
  const branchSentinel = '/* search.reviews.branch */';
  // Single-pass count+data via `count(*) OVER ()`: eliminates the prior
  // parallel count query that re-materialized the `active_accreditations`
  // CTE and re-evaluated the parent-paper JOIN + accreditation gate. Empty-
  // result page returns zero rows so `dataResult.rows[0]?.total ?? 0`
  // degrades to 0. Matches the shape established at
  // `fetchAccreditationsFromHaf`.
  const dataResult = await pool.query(
    `${branchSentinel}
     ${cte.sql}
     SELECT
      c.author,
      c.permlink,
      ${snippetExpr} AS snippet,
      c.created,
      c.parent_author AS paper_author,
      c.parent_permlink AS paper_permlink,
      count(*) OVER ()::int AS total
     FROM ${T.comments} c
     ${parentJoin}
     WHERE ${where}
       AND ${textMatch}
     ORDER BY ${orderBy}
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...params, ilikePattern, limit, offset],
  );

  const total = dataResult.rows[0]?.total ?? 0;
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
  type: SearchType,
  discipline: string | undefined,
  language: string | undefined,
  source: SearchSource | undefined,
  includeRetracted: boolean,
  sort: SearchSort,
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

    // type === 'all': run both queries and merge.
    //
    // BE-SEARCH-PARTIAL-DEGRADATION-ALLSETTLED: `Promise.all` rejects on the
    // FIRST branch rejection and the outer catch swallows the failure into a
    // 200 empty envelope, which collapses both branches when only one is
    // broken. `Promise.allSettled` lets us return the surviving branch and
    // emit a structured `search.type_all.partial_degradation` event so
    // operators can distinguish "no matches in corpus" from "one branch
    // transiently broken". When BOTH branches throw, we still return an
    // empty result (the outer route renders that as 200 with `total: 0`),
    // preserving the prior no-throw-escape behavior for the catastrophic
    // case. Cache layer stores partial results — acceptable trade-off given
    // the 15s TTL and the rarity of single-branch HAF failures.
    const queryParams = { type: 'all' as const, discipline, language, source, includeRetracted, sort, limit, offset };
    const [paperSettled, reviewSettled] = await Promise.allSettled([
      searchPapersFromHaf(pool, query, discipline, language, source, includeRetracted, sort, limit, offset),
      searchReviewsFromHaf(pool, query, sort, limit, offset),
    ]);

    if (paperSettled.status === 'rejected') {
      const err = paperSettled.reason;
      logger.warn(
        {
          event: 'search.type_all.partial_degradation',
          branch: 'papers',
          errClass: err instanceof Error ? err.constructor.name : 'Unknown',
          err,
          queryParams,
        },
        'search type=all papers branch failed; returning reviews-only result',
      );
    }
    if (reviewSettled.status === 'rejected') {
      const err = reviewSettled.reason;
      logger.warn(
        {
          event: 'search.type_all.partial_degradation',
          branch: 'reviews',
          errClass: err instanceof Error ? err.constructor.name : 'Unknown',
          err,
          queryParams,
        },
        'search type=all reviews branch failed; returning papers-only result',
      );
    }

    const paperResult = paperSettled.status === 'fulfilled' ? paperSettled.value : null;
    const reviewResult = reviewSettled.status === 'fulfilled' ? reviewSettled.value : null;

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

  // BE-SEARCH-REVIEWS-CONTRACT-RECONCILE / BE-SEARCH-QUERY-PARAM-TYPEOF-NARROW-SWEEP:
  // four enum-shaped params (`?type=`, `?source=`, `?sort=`, `?language=`)
  // are each typeof-narrowed against their literal-tuple constant. Repeated
  // params yield `string[]` in Express's parsed query — the typeof-string
  // check rejects them so an `as string` cast can't silently coerce to
  // `"a,b"` and slip past the enum predicate. Unknown enum values 400 rather
  // than fall through to a silent default (the prior shape on `?sort=` was a
  // ternary that masked unknowns as `'relevance'`).
  const rawType = req.query.type;
  let type: SearchType;
  if (rawType === undefined) {
    type = 'all';
  } else if (typeof rawType === 'string' && isSearchType(rawType)) {
    type = rawType;
  } else {
    return sendError(res, 400, 'BAD_REQUEST', `Invalid type. Must be one of: ${SEARCH_TYPES.join(', ')}`);
  }

  const rawSource = req.query.source;
  let source: SearchSource | undefined;
  if (rawSource === undefined) {
    source = undefined;
  } else if (typeof rawSource === 'string' && isSearchSource(rawSource)) {
    source = rawSource;
  } else {
    return sendError(res, 400, 'BAD_REQUEST', `Invalid source. Must be one of: ${SEARCH_SOURCES.join(', ')}`);
  }

  const rawSort = req.query.sort;
  let sort: SearchSort;
  if (rawSort === undefined) {
    sort = 'relevance';
  } else if (typeof rawSort === 'string' && isSearchSort(rawSort)) {
    sort = rawSort;
  } else {
    return sendError(res, 400, 'BAD_REQUEST', `Invalid sort. Must be one of: ${SEARCH_SORTS.join(', ')}`);
  }

  const languageResult = parseLanguageFilter(req.query.language);
  if (!languageResult.ok) {
    return sendError(res, 400, 'BAD_REQUEST', languageResult.message);
  }
  const language = languageResult.value;

  // Cache key uses the lowercased value (hashed downstream); the SQL gate
  // uses `discipline ?? undefined` so the `if (discipline)` predicate
  // suppresses the WHERE clause entirely on absent input. Same value, two
  // coalesce shapes, on purpose.
  const filterResult = validateDisciplineFilter(req.query.discipline);
  if (filterResult && !filterResult.ok) {
    return sendError(res, 400, 'BAD_REQUEST', filterResult.message);
  }
  const discipline: string | null = filterResult?.ok ? filterResult.value : null;
  const includeRetracted = req.query.include_retracted === 'true'; // default false
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

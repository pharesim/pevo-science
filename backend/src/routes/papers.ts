import { Router, type Request, type Response } from 'express';
import { PrivateKey } from '@hiveio/dhive';
import { getPool, isHafAvailable } from '../db.js';
import { hiveClient } from '../hive.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import {
  parseMeta,
  isPevoPaper,
  isPevoAnyPaper,
  isPevoReview,
  parsePageLimit,
  parseSort,
  parseOrder,
  toPaperSummary,
  extractAbstract,
  type SortField,
} from '../helpers.js';
import { getAccreditedSet, getAllAccreditedAccounts } from '../accreditation.js';
import { getReputationScores } from '../reputation.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { rateLimit, byAccount } from '../middleware/rateLimit.js';
import {
  T,
  accreditedVoteCount,
  activeAccreditationsCteBody,
  retractedPapersCteBody,
  buildWith,
  type SqlFragment,
} from '../hafsql.js';

const router = Router();

/** Safely extract the pevo metadata sub-object with runtime validation. */
function safePevoMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const pevo = meta[config.appTag];
  if (pevo != null && typeof pevo === 'object' && !Array.isArray(pevo)) {
    return pevo as Record<string, unknown>;
  }
  return {};
}

const retractLimiter = rateLimit({ name: 'paper-retract', windowMs: 3_600_000, max: 5, keyFn: byAccount });
const doiAssignLimiter = rateLimit({ name: 'doi-assign', windowMs: 3_600_000, max: 10, keyFn: byAccount });

// ──────────────────────────────────────────────
// HAF SQL implementation for paper listing
// ──────────────────────────────────────────────

async function fetchPapersFromHaf(req: Request): Promise<{ rows: unknown[]; total: number } | null> {
  const pool = getPool();
  if (!pool) return null;

  const { limit, offset } = parsePageLimit(req);
  const sort = parseSort(req);
  const order = parseOrder(req);
  const discipline = req.query.discipline as string | undefined;
  const keyword = req.query.keyword as string | undefined;
  const author = req.query.author as string | undefined;
  const language = req.query.language as string | undefined;
  const accreditedOnly = req.query.accredited_only === 'true'; // default false
  const includeRetracted = req.query.include_retracted === 'true'; // default false
  const source = req.query.source as string | undefined; // 'native', 'bridge', or omit for both

  // Build CTEs with parameterized appTag
  const cte = buildWith(1, activeAccreditationsCteBody, retractedPapersCteBody);
  let paramIdx = cte.nextIdx;
  const cteParams: unknown[] = [...cte.params];

  // appTag params for WHERE conditions
  const appTagParam = `$${paramIdx++}`;
  const appLikeParam = `$${paramIdx++}`;
  cteParams.push(config.appTag, `${config.appTag}/%`);

  const typeFilter = source === 'native'
    ? `(c.json_metadata -> ${appTagParam} ->> 'type') = 'paper'`
    : source === 'bridge'
      ? `(c.json_metadata -> ${appTagParam} ->> 'type') = 'bridge_paper'`
      : `(c.json_metadata -> ${appTagParam} ->> 'type') IN ('paper', 'bridge_paper')`;

  const conditions: string[] = [
    `c.parent_permlink = ${appTagParam}`,
    "c.parent_author = ''",
    typeFilter,
    `c.json_metadata ->> 'app' LIKE ${appLikeParam}`,
  ];
  const filterParams: unknown[] = [];

  if (discipline) {
    conditions.push(`(c.json_metadata -> ${appTagParam} ->> 'discipline') = $${paramIdx++}`);
    filterParams.push(discipline);
  }
  if (keyword) {
    conditions.push(`c.json_metadata -> ${appTagParam} -> 'keywords' ? $${paramIdx++}`);
    filterParams.push(keyword);
  }
  if (author) {
    conditions.push(`c.author = $${paramIdx++}`);
    filterParams.push(author);
  }
  if (language) {
    conditions.push(`(c.json_metadata -> ${appTagParam} ->> 'language') = $${paramIdx++}`);
    filterParams.push(language);
  }
  if (accreditedOnly) {
    conditions.push(`c.author IN (SELECT account FROM active_accreditations)`);
  }
  if (!includeRetracted) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM retracted_papers rp WHERE rp.author = c.author AND rp.permlink = c.permlink)`);
  }

  const where = conditions.join(' AND ');
  const params = [...cteParams, ...filterParams];

  const sortMap: Record<SortField, string> = {
    date: 'c.created',
    votes: 'net_votes',
    reputation: 'author_reputation',
  };
  const safeOrder = order === 'asc' ? 'ASC' : 'DESC';
  const orderBy = `${sortMap[sort]} ${safeOrder}`;

  try {
    const limitParam = `$${paramIdx++}`;
    const offsetParam = `$${paramIdx++}`;

    const [countResult, dataResult] = await Promise.all([
      pool.query(
        `${cte.sql}
         SELECT count(*)::int AS total FROM ${T.comments} c WHERE ${where}`,
        params,
      ),
      pool.query(
        `${cte.sql}
         SELECT
          c.author,
          c.permlink,
          c.title,
          LEFT(c.body, 300) AS abstract,
          c.json_metadata,
          c.created,
          ${accreditedVoteCount('c.author', 'c.permlink')} AS net_votes,
          0 AS review_count,
          0 AS citation_count,
          0 AS author_reputation
        FROM ${T.comments} c
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
        [...params, limit, offset],
      ),
    ]);

    const total = countResult.rows[0]?.total ?? 0;
    const authors = dataResult.rows.map((r: Record<string, unknown>) => r.author as string);
    const [accreditedSet, reputationMap] = await Promise.all([
      getAccreditedSet(authors),
      getReputationScores(authors),
    ]);

    const rows = dataResult.rows.map((r: Record<string, unknown>) => {
      const meta = parseMeta(r.json_metadata);
      const pevo = safePevoMeta(meta);
      return {
        author: r.author,
        permlink: r.permlink,
        title: r.title,
        abstract: r.abstract,
        discipline: pevo.discipline || null,
        keywords: pevo.keywords || [],
        authors: pevo.authors || [],
        ipfs_cid: pevo.ipfs_cid || null,
        created: r.created,
        net_votes: r.net_votes,
        review_count: (r.review_count as number) ?? 0,
        citation_count: (r.citation_count as number) ?? 0,
        author_reputation: reputationMap.get(r.author as string) ?? 0,
        is_accredited: accreditedSet.has(r.author as string),
      };
    });

    return { rows, total };
  } catch (err) {
    logger.error({ err }, 'HAF query failed, falling back to Hive API');
    return null;
  }
}

// ──────────────────────────────────────────────
// Hive API fallback (dhive)
// ──────────────────────────────────────────────

async function fetchPapersFromHiveApi(req: Request): Promise<{ rows: unknown[]; total: number }> {
  const { limit } = parsePageLimit(req);
  const author = req.query.author as string | undefined;
  const discipline = req.query.discipline as string | undefined;

  try {
    const discussions = await hiveClient.database.getDiscussions('created', {
      tag: config.appTag,
      limit: Math.min(limit, 100),
    });

    const source = req.query.source as string | undefined;
    let papers = discussions.filter((d) => {
      const meta = parseMeta(d.json_metadata);
      if (!isPevoAnyPaper(meta)) return false;
      if (source === 'native') return isPevoPaper(meta);
      if (source === 'bridge') return !isPevoPaper(meta);
      return true;
    });

    if (author) papers = papers.filter((d) => d.author === author);
    if (discipline) {
      papers = papers.filter((d) => {
        const meta = parseMeta(d.json_metadata);
        return (meta.pevo as Record<string, unknown>)?.discipline === discipline;
      });
    }
    if (req.query.language) {
      const lang = req.query.language as string;
      papers = papers.filter((d) => {
        const meta = parseMeta(d.json_metadata);
        return (meta.pevo as Record<string, unknown>)?.language === lang;
      });
    }

    const rows = papers.map((d) => {
      const meta = parseMeta(d.json_metadata);
      return toPaperSummary(
        { author: d.author, permlink: d.permlink, title: d.title, body: d.body, created: d.created, net_votes: d.active_votes?.length ?? 0 },
        meta,
      );
    });

    // Enrich with accreditation and reputation
    const authorNames = rows.map((r) => r.author);
    const [accreditedSet, reputationMap] = await Promise.all([
      getAccreditedSet(authorNames),
      getReputationScores(authorNames),
    ]);
    for (const row of rows) {
      row.is_accredited = accreditedSet.has(row.author);
      row.author_reputation = reputationMap.get(row.author) ?? 0;
    }

    return { rows, total: rows.length };
  } catch (err) {
    logger.error({ err }, 'Hive API query failed');
    return { rows: [], total: 0 };
  }
}

// ──────────────────────────────────────────────
// GET /api/papers — list papers
// ──────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const { page, limit } = parsePageLimit(req);

  if (isHafAvailable()) {
    const sort = parseSort(req);
    const order = parseOrder(req);
    const discipline = req.query.discipline || '';
    const keyword = req.query.keyword || '';
    const author = req.query.author || '';
    const language = req.query.language || '';
    const accreditedOnly = req.query.accredited_only === 'true';
    const includeRetracted = req.query.include_retracted === 'true';
    const source = req.query.source || '';
    const cacheKey = `papers:p=${page}:l=${limit}:s=${sort}:o=${order}:d=${discipline}:k=${keyword}:a=${author}:lang=${language}:ao=${accreditedOnly}:ir=${includeRetracted}:src=${source}`;
    const result = await hafCache.getOrSetSWR(cacheKey, () => fetchPapersFromHaf(req));
    if (result) {
      return sendOk(res, result.rows, { page, limit, total: result.total });
    }
  }

  const hiveResult = await fetchPapersFromHiveApi(req);
  sendOk(res, hiveResult.rows, { page, limit, total: hiveResult.total });
});

// ──────────────────────────────────────────────
// GET /api/papers/batch-counts — review & citation counts
// ──────────────────────────────────────────────

router.get('/batch-counts', async (req: Request, res: Response) => {
  const idsParam = (req.query.ids as string) || '';
  const pairs = idsParam
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 20) // cap to prevent abuse
    .map((id) => {
      const sep = id.indexOf('/');
      return sep > 0 ? { author: id.slice(0, sep), permlink: id.slice(sep + 1) } : null;
    })
    .filter((p): p is { author: string; permlink: string } => p !== null);

  if (pairs.length === 0) {
    return sendOk(res, {});
  }

  const pool = getPool();
  if (!pool || !isHafAvailable()) {
    // Return zeros when HAF is unavailable
    const zeros: Record<string, { review_count: number; citation_count: number }> = {};
    for (const p of pairs) zeros[`${p.author}/${p.permlink}`] = { review_count: 0, citation_count: 0 };
    return sendOk(res, zeros);
  }

  const cacheKey = `batch-counts:${pairs.map((p) => `${p.author}/${p.permlink}`).sort().join(',')}`;
  const result = await hafCache.getOrSet(cacheKey, async () => {
    const cte = buildWith(1, activeAccreditationsCteBody);
    let paramIdx = cte.nextIdx;
    const appTagParam = `$${paramIdx++}`;
    const appLikeParam = `$${paramIdx++}`;
    const queryParams: unknown[] = [...cte.params, config.appTag, `${config.appTag}/%`];

    // Build VALUES list for the paper pairs
    const valueEntries: string[] = [];
    for (const p of pairs) {
      valueEntries.push(`($${paramIdx++}, $${paramIdx++})`);
      queryParams.push(p.author, p.permlink);
    }
    const valuesClause = valueEntries.join(', ');

    const sql = `${cte.sql},
      target_papers(author, permlink) AS (VALUES ${valuesClause})
      SELECT
        tp.author, tp.permlink,
        COALESCE((
          SELECT count(*)::int FROM ${T.comments} r
          JOIN active_accreditations aa ON aa.account = r.author
          WHERE r.parent_author = tp.author AND r.parent_permlink = tp.permlink
            AND (r.json_metadata -> ${appTagParam} ->> 'type') = 'review'
            AND r.json_metadata ->> 'app' LIKE ${appLikeParam}
        ), 0) AS review_count,
        COALESCE((
          SELECT count(*)::int FROM ${T.comments} ci
          JOIN active_accreditations aa ON aa.account = ci.author
          WHERE ci.parent_author = '' AND ci.parent_permlink = ${appTagParam}
            AND (ci.json_metadata -> ${appTagParam} ->> 'type') = 'paper'
            AND ci.json_metadata ->> 'app' LIKE ${appLikeParam}
            AND ci.json_metadata -> ${appTagParam} -> 'citations' @> jsonb_build_array(jsonb_build_object('author', tp.author, 'permlink', tp.permlink))
        ), 0) AS citation_count
      FROM target_papers tp`;

    const queryResult = await pool.query(sql, queryParams);
    const counts: Record<string, { review_count: number; citation_count: number }> = {};
    for (const row of queryResult.rows) {
      counts[`${row.author}/${row.permlink}`] = {
        review_count: row.review_count,
        citation_count: row.citation_count,
      };
    }
    return counts;
  }, 60_000, true); // 60s TTL, stable

  sendOk(res, result);
});

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink — single paper
// ──────────────────────────────────────────────

async function fetchPaperDetailFromHaf(author: string, permlink: string) {
  const pool = getPool();
  if (!pool) return null;

  try {
    // Fast path: fetch paper content + versions + retraction only.
    // Accreditation-dependent data (votes, reviews, citations) is loaded
    // lazily via the /enrichment endpoint.
    const [paperResult, versions, retraction] = await Promise.all([
      pool.query(
        `SELECT c.author, c.permlink, c.title, c.body, c.json_metadata,
                c.created, c.last_edited
         FROM ${T.comments} c
         WHERE c.author = $1 AND c.permlink = $2
           AND c.parent_author = '' AND c.parent_permlink = $3`,
        [author, permlink, config.appTag],
      ),
      resolveVersionsFromHaf(author, permlink),
      getRetractionInfo(author, permlink),
    ]);

    if (paperResult.rows.length === 0) return null;

    const row = paperResult.rows[0];
    const meta = parseMeta(row.json_metadata);
    if (!isPevoAnyPaper(meta)) return null;

    const detail = buildPaperDetail(row, meta, []);
    detail.versions = versions.length > 0 ? versions : [{ version_number: 1, created: detail.created as string, title: detail.title as string, is_content_revision: true }];
    detail.is_retracted = retraction.is_retracted;
    detail.retraction_reason = retraction.retraction_reason ?? null;
    detail.retraction_timestamp = retraction.retraction_timestamp ?? null;

    return detail;
  } catch (err) {
    logger.error({ err }, 'HAF paper detail query failed');
    return null;
  }
}

async function fetchPaperDetailFromHiveApi(author: string, permlink: string) {
  try {
    const post = await hiveClient.database.call('get_content', [author, permlink]);
    if (!post || !post.author || post.parent_permlink !== config.appTag) return null;

    const meta = parseMeta(post.json_metadata);
    if (!isPevoAnyPaper(meta)) return null;

    const detail = buildPaperDetail(post, meta, []);

    // Version history (Hive API only returns latest — use pevo.version from metadata)
    const pevoMeta = safePevoMeta(meta);
    const currentVersion = (pevoMeta.version as number) || 1;
    detail.versions = [{ version_number: currentVersion, created: detail.created as string, title: detail.title as string, is_content_revision: true }];

    return detail;
  } catch (err) {
    logger.error({ err }, 'Hive API paper detail failed');
    return null;
  }
}

// ──────────────────────────────────────────────
// Version history resolution (on-chain edits)
// ──────────────────────────────────────────────

interface PaperVersionEntry {
  version_number: number;
  created: string;
  title: string;
  is_content_revision: boolean;
}

async function resolveVersionsFromHaf(author: string, permlink: string): Promise<PaperVersionEntry[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    // Query all comment operations on this (author, permlink) — each op is a version.
    // (author, permlink) is unique on Hive so no parent filter needed.
    // Compute content_hash from actual title+body so external edits (no PEvO metadata) are detected.
    // Prefer PEvO metadata content_hash when present; fall back to SHA-256 of title+body.
    const result = await pool.query(
      `SELECT
         COALESCE(
           (co.json_metadata -> $3 ->> 'version')::int,
           ROW_NUMBER() OVER (ORDER BY co.block_num)::int
         ) AS version_number,
         co.title,
         co.created,
         COALESCE(
           co.json_metadata -> $3 ->> 'content_hash',
           encode(sha256((co.title || E'\\n' || co.body)::bytea), 'hex')
         ) AS content_hash
       FROM ${T.commentOps} co
       WHERE co.author = $1
         AND co.permlink = $2
       ORDER BY co.block_num ASC`,
      [author, permlink, config.appTag],
    );

    const rows = result.rows as Array<Record<string, unknown>>;
    let prevContentHash: string | null = null;

    return rows.map((r) => {
      const contentHash = (r.content_hash as string) || null;
      // First version is always a content revision.
      // Subsequent versions: content revision if hash changed.
      const isContentRevision = prevContentHash === null || contentHash === null || contentHash !== prevContentHash;
      prevContentHash = contentHash;

      return {
        version_number: r.version_number as number,
        created: r.created as string,
        title: (r.title as string) || '',
        is_content_revision: isContentRevision,
      };
    });
  } catch (err) {
    logger.error({ err }, 'HAF version history query failed');
    return [];
  }
}

async function getRetractionInfo(author: string, permlink: string): Promise<{ is_retracted: boolean; retraction_reason?: string | null; retraction_timestamp?: string | null }> {
  const pool = getPool();
  if (pool) {
    try {
      const result = await pool.query(
        `SELECT cj.json::jsonb ->> 'reason' AS reason, cj.json::jsonb ->> 'timestamp' AS ts
         FROM ${T.customJson} cj
         WHERE cj.custom_id = $3
           AND cj.json::jsonb ->> 'action' = 'retract_paper'
           AND cj.json::jsonb ->> 'author' = $1
           AND cj.json::jsonb ->> 'permlink' = $2
         ORDER BY cj.block_num DESC LIMIT 1`,
        [author, permlink, config.appTag],
      );
      if (result.rows.length > 0) {
        return { is_retracted: true, retraction_reason: result.rows[0].reason, retraction_timestamp: result.rows[0].ts };
      }
    } catch (err) {
      logger.error({ err }, 'HAF retraction info query failed');
    }
  }
  return { is_retracted: false, retraction_reason: null, retraction_timestamp: null };
}

function buildPaperDetail(
  post: Record<string, unknown>,
  meta: Record<string, unknown>,
  reviews: unknown[],
) {
  const pevo = safePevoMeta(meta);
  return {
    author: post.author,
    permlink: post.permlink,
    title: post.title,
    body: post.body,
    abstract: extractAbstract(post.body as string),
    json_metadata: meta,
    created: post.created,
    last_update: post.last_edited || post.last_update || post.created,
    net_votes: post.net_votes ?? 0,
    discipline: pevo.discipline || null,
    keywords: pevo.keywords || [],
    authors: pevo.authors || [],
    ipfs_cid: pevo.ipfs_cid || null,
    ipfs_filename: pevo.ipfs_filename || null,
    document_hash: pevo.document_hash || null,
    abstract_hash: pevo.abstract_hash || null,
    language: pevo.language || 'en',
    citations: pevo.citations || [],
    citation_count: 0,
    author_reputation: 0,
    is_accredited: false,
    reviews,
    versions: [] as PaperVersionEntry[],
    is_retracted: false,
    retraction_reason: null as string | null,
    retraction_timestamp: null as string | null,
    supplementary_files: pevo.supplementary_files || [],
  };
}

router.get('/:author/:permlink', async (req: Request, res: Response) => {
  const { author, permlink } = req.params;

  const cacheKey = `paper-detail:${author}:${permlink}`;
  const cached = await hafCache.getOrSet(cacheKey, async () => {
    // Hive API first: get_content is a single fast call (~200ms) with no DB
    // connection needed. HAF only adds versions/retraction which are rare.
    const hiveResult = await fetchPaperDetailFromHiveApi(author, permlink);
    if (hiveResult) return hiveResult;

    // Fallback to HAF if Hive API failed
    if (isHafAvailable()) {
      return fetchPaperDetailFromHaf(author, permlink);
    }

    return null;
  }, 30 * 60_000, true);

  if (cached) return sendOk(res, cached);
  sendError(res, 404, 'NOT_FOUND', 'Paper not found');
});

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink/enrichment
// ──────────────────────────────────────────────

async function fetchEnrichmentFromHaf(author: string, permlink: string) {
  const pool = getPool();
  if (!pool) return null;

  try {
    const accreditedAccounts = await getAllAccreditedAccounts();
    const accreditedArr = [...accreditedAccounts];

    const [voteResult, reviewsResult, citationResult, versions, retraction] = await Promise.all([
      // Accredited vote count
      pool.query(
        `SELECT count(*)::int AS net_votes FROM ${T.votes} v
         WHERE v.author = $1 AND v.permlink = $2
           AND v.rshares > 0 AND v.voter = ANY($3::text[])`,
        [author, permlink, accreditedArr],
      ),
      // Reviews from accredited reviewers with accredited vote count
      pool.query(
        `SELECT c.author, c.permlink, c.body, c.json_metadata, c.created,
                (SELECT count(*)::int FROM ${T.votes} v
                 WHERE v.author = c.author AND v.permlink = c.permlink
                   AND v.rshares > 0 AND v.voter = ANY($5::text[])) AS net_votes
         FROM ${T.comments} c
         WHERE c.parent_author = $1 AND c.parent_permlink = $2
           AND c.author = ANY($5::text[])
           AND (c.json_metadata -> $3 ->> 'type') = 'review'
           AND c.json_metadata ->> 'app' LIKE $4
         ORDER BY c.created DESC`,
        [author, permlink, config.appTag, `${config.appTag}/%`, accreditedArr],
      ),
      // Citation count from accredited authors
      pool.query(
        `SELECT count(*)::int AS cnt FROM ${T.comments} ci
         WHERE ci.parent_author = '' AND ci.parent_permlink = $2
           AND ci.author = ANY($4::text[])
           AND (ci.json_metadata -> $2 ->> 'type') = 'paper'
           AND ci.json_metadata ->> 'app' LIKE $3
           AND ci.json_metadata -> $2 -> 'citations' @> $1::jsonb`,
        [JSON.stringify([{ author, permlink }]), config.appTag, `${config.appTag}/%`, accreditedArr],
      ),
      // Version history + retraction (moved from SSR-critical path)
      resolveVersionsFromHaf(author, permlink),
      getRetractionInfo(author, permlink),
    ]);

    const reviews = reviewsResult.rows.map((r: Record<string, unknown>) => {
      const rMeta = parseMeta(r.json_metadata);
      const pevo = safePevoMeta(rMeta);
      const rating = pevo.rating as Record<string, number> | undefined;
      return {
        author: r.author as string,
        permlink: r.permlink as string,
        body: r.body as string,
        rating: rating || { methodology: 0, novelty: 0, clarity: 0, significance: 0 },
        is_anonymous: pevo.is_anonymous ?? false,
        created: r.created as string,
        net_votes: r.net_votes as number,
        reviewer_reputation: 0,
        is_accredited: accreditedAccounts.has(r.author as string),
        reviewed_version: (pevo.reviewed_version as number) || 1,
      };
    });

    return {
      net_votes: voteResult.rows[0]?.net_votes ?? 0,
      reviews,
      citation_count: citationResult.rows[0]?.cnt ?? 0,
      is_accredited: accreditedAccounts.has(author),
      versions: versions.length > 0 ? versions : undefined,
      is_retracted: retraction.is_retracted,
      retraction_reason: retraction.retraction_reason ?? null,
      retraction_timestamp: retraction.retraction_timestamp ?? null,
    };
  } catch (err) {
    logger.error({ err }, 'HAF enrichment query failed');
    return null;
  }
}

async function fetchEnrichmentFromHiveApi(author: string, permlink: string) {
  try {
    const [post, replies, accreditedAccounts] = await Promise.all([
      hiveClient.database.call('get_content', [author, permlink]),
      hiveClient.database.call('get_content_replies', [author, permlink]),
      getAllAccreditedAccounts(),
    ]);

    if (!post || !post.author) return null;

    const reviews = (replies || [])
      .filter((r: Record<string, unknown>) => {
        const rMeta = parseMeta(r.json_metadata);
        return isPevoReview(rMeta) && accreditedAccounts.has(r.author as string);
      })
      .map((r: Record<string, unknown>) => {
        const rMeta = parseMeta(r.json_metadata);
        const pevo = safePevoMeta(rMeta);
        const rating = pevo.rating as Record<string, number> | undefined;
        return {
          author: r.author as string,
          permlink: r.permlink as string,
          body: r.body as string,
          rating: rating || { methodology: 0, novelty: 0, clarity: 0, significance: 0 },
          is_anonymous: pevo.is_anonymous ?? false,
          created: r.created as string,
          net_votes: r.net_votes as number,
          reviewer_reputation: 0,
          is_accredited: true,
          reviewed_version: (pevo.reviewed_version as number) || 1,
        };
      });

    return {
      net_votes: parseInt(post.net_votes, 10) || 0,
      reviews,
      citation_count: 0, // Cannot compute via Hive API
      is_accredited: accreditedAccounts.has(author),
      is_retracted: false,
      retraction_reason: null,
      retraction_timestamp: null,
    };
  } catch (err) {
    logger.error({ err }, 'Hive API enrichment failed');
    return null;
  }
}

router.get('/:author/:permlink/enrichment', async (req: Request, res: Response) => {
  const { author, permlink } = req.params;

  const cacheKey = `paper-enrichment:${author}:${permlink}`;
  const cached = await hafCache.getOrSet(cacheKey, async () => {
    if (isHafAvailable()) {
      const result = await fetchEnrichmentFromHaf(author, permlink);
      if (result) return result;
    }

    return fetchEnrichmentFromHiveApi(author, permlink);
  }, 5 * 60_000, true);

  if (cached) return sendOk(res, cached);
  sendError(res, 404, 'NOT_FOUND', 'Paper not found');
});

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink/citations
// ──────────────────────────────────────────────

async function fetchCitationsFromHaf(author: string, permlink: string, limit: number, offset: number) {
  const pool = getPool();
  if (!pool) return null;

  try {
    const citationJson = JSON.stringify([{ author, permlink }]);

    const countResult = await pool.query(
      `SELECT count(*)::int AS total FROM ${T.comments} c
       WHERE c.parent_author = '' AND c.parent_permlink = $2
         AND (c.json_metadata -> $2 ->> 'type') = 'paper'
         AND c.json_metadata ->> 'app' LIKE $3
         AND c.json_metadata -> $2 -> 'citations' @> $1::jsonb`,
      [citationJson, config.appTag, `${config.appTag}/%`],
    );
    const total = countResult.rows[0]?.total ?? 0;

    const dataResult = await pool.query(
      `SELECT c.author, c.permlink, c.title, LEFT(c.body, 300) AS body,
              c.json_metadata, c.created
       FROM ${T.comments} c
       WHERE c.parent_author = '' AND c.parent_permlink = $2
         AND (c.json_metadata -> $2 ->> 'type') = 'paper'
         AND c.json_metadata ->> 'app' LIKE $3
         AND c.json_metadata -> $2 -> 'citations' @> $1::jsonb
       ORDER BY c.created DESC
       LIMIT $4 OFFSET $5`,
      [citationJson, config.appTag, `${config.appTag}/%`, limit, offset],
    );

    const rows = dataResult.rows.map((r: Record<string, unknown>) => {
      const meta = parseMeta(r.json_metadata);
      return toPaperSummary(
        { author: r.author as string, permlink: r.permlink as string, title: r.title as string, body: r.body as string, created: r.created as string, net_votes: 0 },
        meta,
      );
    });

    return { rows, total };
  } catch (err) {
    logger.error({ err }, 'HAF citations query failed');
    return null;
  }
}

router.get('/:author/:permlink/citations', async (req: Request, res: Response) => {
  const { author, permlink } = req.params;
  const { page, limit, offset } = parsePageLimit(req);

  // Citations require HAF — reverse JSONB lookup cannot be done via Hive API
  if (isHafAvailable()) {
    const cacheKey = `citations:${author}:${permlink}:${page}:${limit}`;
    const result = await hafCache.getOrSet(cacheKey, () => fetchCitationsFromHaf(author, permlink, limit, offset));
    if (result) return sendOk(res, result.rows, { page, limit, total: result.total });
  }

  sendOk(res, [], { page, limit, total: 0 });
});

// ──────────────────────────────────────────────
// POST /api/papers/:author/:permlink/retract
// ──────────────────────────────────────────────

async function isRetracted(author: string, permlink: string): Promise<boolean> {
  const pool = getPool();
  if (pool) {
    try {
      const result = await pool.query(
        `SELECT 1 FROM ${T.customJson} cj
         WHERE cj.custom_id = $3
           AND cj.json::jsonb ->> 'action' = 'retract_paper'
           AND cj.json::jsonb ->> 'author' = $1
           AND cj.json::jsonb ->> 'permlink' = $2
         LIMIT 1`,
        [author, permlink, config.appTag],
      );
      return result.rows.length > 0;
    } catch (err) {
      logger.error({ err }, 'HAF retraction check failed');
    }
  }
  return false;
}

router.post('/:author/:permlink/retract', verifyHiveSignature, retractLimiter, async (req: Request, res: Response) => {
  const { author, permlink } = req.params;
  const username = req.hiveUsername!;
  const reason = (req.body.reason as string) || '';

  // Check paper exists
  let detail: Record<string, unknown> | null = null;
  if (isHafAvailable()) {
    detail = await fetchPaperDetailFromHaf(author, permlink) as Record<string, unknown> | null;
  }
  if (!detail) {
    detail = await fetchPaperDetailFromHiveApi(author, permlink) as Record<string, unknown> | null;
  }
  if (!detail) {
    return sendError(res, 404, 'NOT_FOUND', 'Paper not found');
  }

  // Authorization: paper author, pevo.admin, or (for bridge papers) registerer or original preprint author
  let authorized = username === author || username === config.hiveAdminAccount;
  if (!authorized) {
    const meta = (detail.json_metadata || {}) as Record<string, unknown>;
    const pevo = (meta[config.appTag] || {}) as Record<string, unknown>;
    if (pevo.type === 'bridge_paper') {
      const source = (pevo.source || {}) as Record<string, unknown>;
      const registeredBy = source.registered_by as string | undefined;
      if (registeredBy === username) {
        authorized = true;
      } else {
        const paperAuthors = (pevo.authors || []) as Array<{ hive?: string | null }>;
        authorized = paperAuthors.some((a) => a.hive === username);
      }
    }
  }
  if (!authorized) {
    return sendError(res, 403, 'FORBIDDEN', `Only the paper author, ${config.hiveAdminAccount}, or (for bridge papers) the registerer or an original author can retract`);
  }

  // Check not already retracted
  if (await isRetracted(author, permlink)) {
    return sendError(res, 422, 'VALIDATION_ERROR', 'Paper is already retracted');
  }

  // Broadcast retract_paper custom_json
  if (!config.pevoAdminPostingKey) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'Admin posting key not configured');
  }

  const payload = {
    action: 'retract_paper',
    author,
    permlink,
    reason,
    timestamp: new Date().toISOString(),
  };

  try {
    const key = PrivateKey.fromString(config.pevoAdminPostingKey);
    const result = await hiveClient.broadcast.json(
      { id: config.appTag, json: JSON.stringify(payload), required_auths: [], required_posting_auths: [config.hiveAdminAccount] },
      key,
    );
    sendOk(res, { message: 'Paper retracted', tx_id: result.id });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Failed to broadcast retraction');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to broadcast retraction to Hive');
  }
});

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink/cite
// ──────────────────────────────────────────────

const VALID_CITE_FORMATS = new Set(['bibtex', 'ris', 'apa']);

function generateBibtex(detail: Record<string, unknown>): string {
  const author = detail.author as string;
  const title = detail.title as string;
  const created = detail.created as string;
  const year = new Date(created).getFullYear();
  const pevo = ((detail.json_metadata as Record<string, unknown>)?.pevo || {}) as Record<string, unknown>;
  const authors = (pevo.authors || []) as Array<{ name: string; orcid?: string }>;
  const firstWord = title.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') || 'paper';
  const key = `${author}_${firstWord}_${year}`;
  const authorStr = authors.length > 0
    ? authors.map((a) => a.name).join(' and ')
    : author;
  const doi = (detail as Record<string, unknown>).doi as string | undefined;

  let bib = `@article{${key},\n`;
  bib += `  title = {${title}},\n`;
  bib += `  author = {${authorStr}},\n`;
  bib += `  year = {${year}},\n`;
  bib += `  publisher = {PEvO (Publish and Evaluate Onchain)},\n`;
  bib += `  url = {https://pevo.science/papers/${author}/${detail.permlink}}`;
  if (doi) bib += `,\n  doi = {${doi}}`;
  bib += `\n}`;
  return bib;
}

function generateRis(detail: Record<string, unknown>): string {
  const author = detail.author as string;
  const title = detail.title as string;
  const created = detail.created as string;
  const year = new Date(created).getFullYear();
  const pevo = ((detail.json_metadata as Record<string, unknown>)?.pevo || {}) as Record<string, unknown>;
  const authors = (pevo.authors || []) as Array<{ name: string }>;
  const doi = (detail as Record<string, unknown>).doi as string | undefined;

  const lines: string[] = [
    'TY  - JOUR',
    `TI  - ${title}`,
  ];
  if (authors.length > 0) {
    for (const a of authors) lines.push(`AU  - ${a.name}`);
  } else {
    lines.push(`AU  - ${author}`);
  }
  lines.push(`PY  - ${year}`);
  lines.push('PB  - PEvO (Publish and Evaluate Onchain)');
  lines.push(`UR  - https://pevo.science/papers/${author}/${detail.permlink}`);
  if (doi) lines.push(`DO  - ${doi}`);
  lines.push('ER  - ');
  return lines.join('\n');
}

function generateApa(detail: Record<string, unknown>): string {
  const author = detail.author as string;
  const title = detail.title as string;
  const created = detail.created as string;
  const year = new Date(created).getFullYear();
  const pevo = ((detail.json_metadata as Record<string, unknown>)?.pevo || {}) as Record<string, unknown>;
  const authors = (pevo.authors || []) as Array<{ name: string }>;

  const authorStr = authors.length > 0
    ? authors.map((a) => a.name).join(', ')
    : author;

  return `${authorStr} (${year}). ${title}. PEvO (Publish and Evaluate Onchain). https://pevo.science/papers/${author}/${detail.permlink}`;
}

router.get('/:author/:permlink/cite', async (req: Request, res: Response) => {
  const { author, permlink } = req.params;
  const format = (req.query.format as string || '').toLowerCase();

  if (!VALID_CITE_FORMATS.has(format)) {
    return sendError(res, 400, 'BAD_REQUEST', 'format must be one of: bibtex, ris, apa');
  }

  // Reuse paper detail fetch logic
  let detail: Record<string, unknown> | null = null;
  if (isHafAvailable()) {
    detail = await fetchPaperDetailFromHaf(author, permlink) as Record<string, unknown> | null;
  }
  if (!detail) {
    detail = await fetchPaperDetailFromHiveApi(author, permlink) as Record<string, unknown> | null;
  }
  if (!detail) {
    return sendError(res, 404, 'NOT_FOUND', 'Paper not found');
  }

  const generators: Record<string, (d: Record<string, unknown>) => string> = {
    bibtex: generateBibtex,
    ris: generateRis,
    apa: generateApa,
  };

  const content = generators[format](detail);
  sendOk(res, { format, content });
});

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink/doi
// ──────────────────────────────────────────────

async function getExistingDoi(author: string, permlink: string): Promise<{ doi: string; doi_url: string; registered_at: string } | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    const result = await pool.query(
      `SELECT cj.json::jsonb ->> 'doi' AS doi,
              cj.json::jsonb ->> 'doi_url' AS doi_url,
              cj.json::jsonb ->> 'timestamp' AS registered_at
       FROM ${T.customJson} cj
       WHERE cj.custom_id = $3
         AND cj.json::jsonb ->> 'action' = 'assign_doi'
         AND cj.json::jsonb ->> 'author' = $1
         AND cj.json::jsonb ->> 'permlink' = $2
       ORDER BY cj.block_num DESC LIMIT 1`,
      [author, permlink, config.appTag],
    );
    if (result.rows.length > 0) {
      return result.rows[0];
    }
  } catch (err) {
    logger.error({ err }, 'HAF DOI lookup failed');
  }
  return null;
}

router.get('/:author/:permlink/doi', async (req: Request, res: Response) => {
  const { author, permlink } = req.params;

  const existing = await getExistingDoi(author, permlink);
  if (existing) {
    return sendOk(res, {
      doi: existing.doi,
      doi_url: existing.doi_url,
      status: 'registered',
      registered_at: existing.registered_at,
    });
  }

  sendOk(res, { doi: null, doi_url: null, status: 'unregistered', registered_at: null });
});

router.post('/:author/:permlink/doi', verifyHiveSignature, doiAssignLimiter, async (req: Request, res: Response) => {
  const { author, permlink } = req.params;
  const username = req.hiveUsername!;

  if (username !== author) {
    return sendError(res, 403, 'FORBIDDEN', 'Only the paper author can assign a DOI');
  }

  // Check for existing DOI
  const existing = await getExistingDoi(author, permlink);
  if (existing) {
    return sendOk(res, {
      doi: existing.doi,
      doi_url: existing.doi_url,
      status: 'registered',
      registered_at: existing.registered_at,
    });
  }

  // Check paper exists and is not retracted
  if (await isRetracted(author, permlink)) {
    return sendError(res, 422, 'VALIDATION_ERROR', 'Cannot assign DOI to a retracted paper');
  }

  if (!config.dataciteRepositoryId || !config.datacitePassword || !config.dataciteDoiPrefix) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'DataCite integration is not configured');
  }

  // Fetch paper detail for metadata
  let detail: Record<string, unknown> | null = null;
  if (isHafAvailable()) {
    detail = await fetchPaperDetailFromHaf(author, permlink) as Record<string, unknown> | null;
  }
  if (!detail) {
    detail = await fetchPaperDetailFromHiveApi(author, permlink) as Record<string, unknown> | null;
  }
  if (!detail) {
    return sendError(res, 404, 'NOT_FOUND', 'Paper not found');
  }

  const pevo = ((detail.json_metadata as Record<string, unknown>)?.pevo || {}) as Record<string, unknown>;
  const paperAuthors = (pevo.authors || []) as Array<{ name: string; orcid?: string }>;
  const title = detail.title as string;
  const year = new Date(detail.created as string).getFullYear();
  const paperUrl = `https://pevo.science/papers/${author}/${permlink}`;

  const doiSuffix = `pevo.${author}.${permlink}`;
  const doi = `${config.dataciteDoiPrefix}/${doiSuffix}`;
  const doiUrl = `https://doi.org/${doi}`;

  // Register with DataCite
  const datacitePayload = {
    data: {
      type: 'dois',
      attributes: {
        doi,
        event: 'publish',
        creators: paperAuthors.length > 0
          ? paperAuthors.map((a) => ({
              name: a.name,
              ...(a.orcid ? { nameIdentifiers: [{ nameIdentifier: a.orcid, nameIdentifierScheme: 'ORCID', schemeUri: 'https://orcid.org' }] } : {}),
            }))
          : [{ name: author }],
        titles: [{ title }],
        publisher: 'PEvO (Publish and Evaluate Onchain)',
        publicationYear: year,
        types: { resourceTypeGeneral: 'Preprint' },
        url: paperUrl,
      },
    },
  };

  try {
    const dcRes = await fetch(`${config.dataciteApiUrl}/dois`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.api+json',
        'Authorization': `Basic ${Buffer.from(`${config.dataciteRepositoryId}:${config.datacitePassword}`).toString('base64')}`,
      },
      body: JSON.stringify(datacitePayload),
    });

    if (!dcRes.ok) {
      const errText = await dcRes.text();
      logger.error({ status: dcRes.status, body: errText }, 'DataCite DOI registration failed');
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to register DOI with DataCite');
    }

    // Broadcast assign_doi custom_json
    if (!config.pevoAdminPostingKey) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Admin posting key not configured');
    }

    const payload = {
      action: 'assign_doi',
      author,
      permlink,
      doi,
      doi_url: doiUrl,
      timestamp: new Date().toISOString(),
    };

    const key = PrivateKey.fromString(config.pevoAdminPostingKey);
    await hiveClient.broadcast.json(
      { id: config.appTag, json: JSON.stringify(payload), required_auths: [], required_posting_auths: [config.hiveAdminAccount] },
      key,
    );

    sendOk(res, { doi, doi_url: doiUrl, status: 'registered', registered_at: payload.timestamp });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'DOI assignment failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to assign DOI');
  }
});

export default router;

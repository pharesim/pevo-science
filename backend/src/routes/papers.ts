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
import { getReputationScores, getBatchReputationScores } from '../reputation.js';
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
  // E3: Hide continuation posts — they are revisions of existing papers, not separate papers
  conditions.push(`(c.json_metadata -> ${appTagParam} -> 'continues') IS NULL`);

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

    // Use batch reputation scores only (no on-demand HAF computation).
    // Returns 0 for users not yet in the batch — profile page has full scores.
    const batchScores = await getBatchReputationScores(authors);
    const accreditedSet = await getAccreditedSet(authors);

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
        author_reputation: batchScores.get(r.author as string) ?? 0,
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
        return (meta[config.appTag] as Record<string, unknown>)?.discipline === discipline;
      });
    }
    if (req.query.language) {
      const lang = req.query.language as string;
      papers = papers.filter((d) => {
        const meta = parseMeta(d.json_metadata);
        return (meta[config.appTag] as Record<string, unknown>)?.language === lang;
      });
    }

    const rows = papers.map((d) => {
      const meta = parseMeta(d.json_metadata);
      return toPaperSummary(
        { author: d.author, permlink: d.permlink, title: d.title, body: d.body, created: d.created, net_votes: 0 },
        meta,
      );
    });

    // Enrich with accreditation and batch reputation (no on-demand computation)
    const authorNames = rows.map((r) => r.author);
    const [accreditedSet, batchScores] = await Promise.all([
      getAccreditedSet(authorNames),
      getBatchReputationScores(authorNames),
    ]);
    for (const row of rows) {
      row.is_accredited = accreditedSet.has(row.author);
      row.author_reputation = batchScores.get(row.author) ?? 0;
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

    // E7: Resolve continuation chain to set head author/permlink
    const chain = await resolveContinuationChain(author, permlink);
    if (chain.length > 1) {
      const head = chain[chain.length - 1];
      detail.head_author = head.author;
      detail.head_permlink = head.permlink;
    }

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
    // Don't use Hive's unfiltered net_votes — enrichment provides accredited-only count
    detail.net_votes = 0;

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

import { diff_match_patch as DiffMatchPatch } from 'diff-match-patch';

const dmp = new DiffMatchPatch();

interface PaperVersionEntry {
  version_number: number;
  created: string;
  title: string;
  is_content_revision: boolean;
  author?: string;
  permlink?: string;
  addresses_reviews?: Array<{ author: string; permlink: string }>;
}

// ──────────────────────────────────────────────
// E1 — Continuation chain resolution
// ──────────────────────────────────────────────

interface ChainLink {
  author: string;
  permlink: string;
}

/**
 * Resolve the continuation chain starting from a canonical (root) post.
 * Follows `json_metadata -> appTag -> 'continues'` pointers iteratively.
 * Returns ordered array starting with the root post, ending at the chain head.
 * Uses block_num to resolve collisions (earliest wins). 50-hop safety cap.
 */
async function resolveContinuationChain(author: string, permlink: string): Promise<ChainLink[]> {
  const pool = getPool();
  if (!pool) return [{ author, permlink }];

  const chain: ChainLink[] = [{ author, permlink }];
  let currentAuthor = author;
  let currentPermlink = permlink;
  const MAX_HOPS = 50;

  try {
    for (let i = 0; i < MAX_HOPS; i++) {
      // Find any post whose continues field points to the current head
      const result = await pool.query(
        `SELECT c.author, c.permlink, co.block_num
         FROM ${T.comments} c
         JOIN ${T.commentOps} co ON co.author = c.author AND co.permlink = c.permlink
         WHERE c.parent_author = ''
           AND c.parent_permlink = $3
           AND c.json_metadata -> $3 -> 'continues' ->> 'author' = $1
           AND c.json_metadata -> $3 -> 'continues' ->> 'permlink' = $2
         ORDER BY co.block_num ASC
         LIMIT 1`,
        [currentAuthor, currentPermlink, config.appTag],
      );

      if (result.rows.length === 0) break;

      const next = result.rows[0];
      currentAuthor = next.author;
      currentPermlink = next.permlink;
      chain.push({ author: currentAuthor, permlink: currentPermlink });
    }
  } catch (err) {
    logger.error({ err }, 'Continuation chain resolution failed');
  }

  return chain;
}

/**
 * Walk backward from a continuation post to find the canonical (root) post.
 * Returns null if the given post is not a continuation.
 */
async function findCanonicalRoot(author: string, permlink: string): Promise<ChainLink | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    // Check if this post has a 'continues' field
    const result = await pool.query(
      `SELECT c.json_metadata -> $3 -> 'continues' ->> 'author' AS cont_author,
              c.json_metadata -> $3 -> 'continues' ->> 'permlink' AS cont_permlink
       FROM ${T.comments} c
       WHERE c.author = $1 AND c.permlink = $2
         AND c.parent_author = '' AND c.parent_permlink = $3
         AND c.json_metadata -> $3 -> 'continues' IS NOT NULL`,
      [author, permlink, config.appTag],
    );

    if (result.rows.length === 0) return null;

    // Walk backward to the root
    let currentAuthor = result.rows[0].cont_author as string;
    let currentPermlink = result.rows[0].cont_permlink as string;
    const MAX_HOPS = 50;

    for (let i = 0; i < MAX_HOPS; i++) {
      const parentResult = await pool.query(
        `SELECT c.json_metadata -> $3 -> 'continues' ->> 'author' AS cont_author,
                c.json_metadata -> $3 -> 'continues' ->> 'permlink' AS cont_permlink
         FROM ${T.comments} c
         WHERE c.author = $1 AND c.permlink = $2
           AND c.parent_author = '' AND c.parent_permlink = $3`,
        [currentAuthor, currentPermlink, config.appTag],
      );

      if (parentResult.rows.length === 0 || !parentResult.rows[0].cont_author) {
        // currentAuthor/currentPermlink is the root
        return { author: currentAuthor, permlink: currentPermlink };
      }

      currentAuthor = parentResult.rows[0].cont_author;
      currentPermlink = parentResult.rows[0].cont_permlink;
    }

    return { author: currentAuthor, permlink: currentPermlink };
  } catch (err) {
    logger.error({ err }, 'Canonical root lookup failed');
    return null;
  }
}

/** A fully reconstructed version with body content. */
interface ReconstructedVersion extends PaperVersionEntry {
  body: string;
  json_metadata: Record<string, unknown>;
  /** Author of the post this version came from (for continuation chains). */
  post_author: string;
  /** Permlink of the post this version came from (for continuation chains). */
  post_permlink: string;
}

/**
 * Apply a Hive `@@`-format diff patch to a base string.
 * If the body does NOT start with `@@`, it's treated as a full replacement.
 */
function applyHivePatch(base: string, raw: string): string {
  if (!raw.startsWith('@@')) return raw;
  const patches = dmp.patch_fromText(raw);
  const [result] = dmp.patch_apply(patches, base);
  return result;
}

/**
 * Fetch all comment operations and reconstruct full body at each version
 * by replaying `@@` diff patches. Resolves continuation chains: fetches
 * operations for all posts in the chain, ordered by block_num.
 * Continuation post first operations are always full body (not diffs of
 * the previous chain link). Returns versions in chronological order.
 */
async function reconstructVersionsFromHaf(
  author: string,
  permlink: string,
): Promise<ReconstructedVersion[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    // Resolve continuation chain to get all (author, permlink) pairs
    const chain = await resolveContinuationChain(author, permlink);

    // Build a query that fetches operations for ALL posts in the chain
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;
    for (const link of chain) {
      conditions.push(`(co.author = $${paramIdx++} AND co.permlink = $${paramIdx++})`);
      params.push(link.author, link.permlink);
    }

    const result = await pool.query(
      `SELECT
         ROW_NUMBER() OVER (ORDER BY co.block_num)::int AS version_number,
         co.author,
         co.permlink,
         co.title,
         co.body,
         co.timestamp AS created,
         co.json_metadata
       FROM ${T.commentOps} co
       WHERE ${conditions.join(' OR ')}
       ORDER BY co.block_num ASC`,
      params,
    );

    const rows = result.rows as Array<Record<string, unknown>>;
    const versions: ReconstructedVersion[] = [];
    // Track per-post body state for diff application (diffs are per-post, not cross-post)
    const bodyByPost = new Map<string, string>();
    let prevTitle = '';
    let lastGoodMeta: Record<string, unknown> | null = null;
    // Track which posts we've seen their first operation for
    const seenFirstOp = new Set<string>();

    for (const r of rows) {
      const postKey = `${r.author}/${r.permlink}`;
      const rawBody = (r.body as string) || '';
      const rawTitle = (r.title as string) || '';

      const isFirstOpForPost = !seenFirstOp.has(postKey);
      seenFirstOp.add(postKey);

      const prevBodyForPost = bodyByPost.get(postKey) || '';
      let body: string;

      if (isFirstOpForPost && chain.length > 1 && postKey !== `${chain[0].author}/${chain[0].permlink}`) {
        // Continuation post first operation: always full body (not diff of previous chain link)
        body = rawBody;
      } else {
        // Same-post edit: apply diff against previous body of THIS post
        body = applyHivePatch(prevBodyForPost, rawBody);
      }
      bodyByPost.set(postKey, body);

      const title = rawTitle || prevTitle;

      const isContentRevision =
        versions.length === 0 || body !== prevBodyForPost || title !== prevTitle || isFirstOpForPost;

      let meta = parseMeta(r.json_metadata);

      if (isPevoAnyPaper(meta)) {
        lastGoodMeta = meta;
      } else if (lastGoodMeta) {
        meta = { ...meta, app: lastGoodMeta.app, [config.appTag]: lastGoodMeta[config.appTag] };
      }

      // Extract addresses_reviews from version metadata
      const pevo = safePevoMeta(meta);
      const addressesReviews = (pevo.addresses_reviews as Array<{ author: string; permlink: string }>) || undefined;

      versions.push({
        version_number: r.version_number as number,
        created: r.created as string,
        title,
        body,
        is_content_revision: isContentRevision,
        json_metadata: meta,
        post_author: r.author as string,
        post_permlink: r.permlink as string,
        author: r.author as string,
        permlink: r.permlink as string,
        addresses_reviews: addressesReviews,
      });

      prevTitle = title;
    }

    return versions;
  } catch (err) {
    logger.error({ err }, 'HAF version reconstruction failed');
    return [];
  }
}

/** Return version metadata only (no bodies). */
async function resolveVersionsFromHaf(
  author: string,
  permlink: string,
): Promise<PaperVersionEntry[]> {
  const versions = await reconstructVersionsFromHaf(author, permlink);
  return versions.map(({ body: _body, json_metadata: _meta, post_author: _pa, post_permlink: _pp, ...entry }) => entry);
}

interface RetractionEntry {
  author: string;
  permlink: string;
  reason: string | null;
  timestamp: string | null;
}

async function loadRetractedPapers(): Promise<RetractionEntry[]> {
  const pool = getPool();
  if (!pool) return [];

  const result = await pool.query(
    `SELECT
       cj.json::jsonb ->> 'author' AS author,
       cj.json::jsonb ->> 'permlink' AS permlink,
       cj.json::jsonb ->> 'reason' AS reason,
       cj.json::jsonb ->> 'timestamp' AS ts
     FROM ${T.customJson} cj
     WHERE cj.custom_id = $1
       AND cj.json::jsonb ->> 'action' = 'retract_paper'`,
    [config.appTag],
  );
  return result.rows.map((r: Record<string, unknown>) => ({
    author: r.author as string,
    permlink: r.permlink as string,
    reason: (r.reason as string) || null,
    timestamp: (r.ts as string) || null,
  }));
}

async function getRetractionInfo(author: string, permlink: string): Promise<{ is_retracted: boolean; retraction_reason?: string | null; retraction_timestamp?: string | null }> {
  try {
    const allRetracted = await hafCache.get<RetractionEntry[]>('retracted-papers') ?? [];
    const entry = allRetracted.find((r) => r.author === author && r.permlink === permlink);
    if (entry) {
      return { is_retracted: true, retraction_reason: entry.reason, retraction_timestamp: entry.timestamp };
    }
  } catch (err) {
    logger.error({ err }, 'Failed to load retracted papers');
  }
  return { is_retracted: false, retraction_reason: null, retraction_timestamp: null };
}

/** Register periodic refresh for retracted papers cache. */
export async function startRetractionCache(): Promise<void> {
  await hafCache.registerPeriodicRefresh('retracted-papers', loadRetractedPapers, 24 * 60 * 60_000);
  logger.info('Retracted papers cache loaded');
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
    metadata_restored: false,
    // E7: For non-continuation papers, canonical = head = self
    canonical_author: post.author as string,
    canonical_permlink: post.permlink as string,
    head_author: post.author as string,
    head_permlink: post.permlink as string,
  };
}

router.get('/:author/:permlink', async (req: Request, res: Response) => {
  let author = req.params.author as string;
  let permlink = req.params.permlink as string;
  const requestedVersion = req.query.version ? parseInt(req.query.version as string, 10) : null;

  if (requestedVersion !== null && isNaN(requestedVersion)) {
    return sendError(res, 400, 'BAD_REQUEST', 'version must be an integer');
  }

  // E4: If this is a continuation post, redirect to the canonical root paper
  if (isHafAvailable()) {
    const canonicalRoot = await findCanonicalRoot(author, permlink);
    if (canonicalRoot) {
      author = canonicalRoot.author;
      permlink = canonicalRoot.permlink;
    }
  }

  // Historical versions require HAF (Hive API only has latest).
  if (requestedVersion !== null && isHafAvailable()) {
    const cacheKey = `paper-detail:${author}:${permlink}:v${requestedVersion}`;
    const cached = await hafCache.getOrSet(cacheKey, async () => {
      const versions = await reconstructVersionsFromHaf(author, permlink);
      if (versions.length === 0) return null;

      // Paper identity is established by the first version (original publication).
      // External edits may overwrite json_metadata, so don't check later versions.
      if (!isPevoAnyPaper(versions[0].json_metadata)) return null;

      const target = versions.find((v) => v.version_number === requestedVersion);
      if (!target) return null;

      // Use this version's metadata (IPFS CID, authors, etc.) but fall back to
      // the original publication's PEvO metadata for fields external edits may strip.
      const meta = target.json_metadata;
      const post = { author, permlink, title: target.title, body: target.body, json_metadata: meta, created: target.created, last_edited: target.created };
      const detail = buildPaperDetail(post, meta, []);
      detail.versions = versions.map(({ body: _b, json_metadata: _m, ...entry }) => entry);

      const retraction = await getRetractionInfo(author, permlink);
      detail.is_retracted = retraction.is_retracted;
      detail.retraction_reason = retraction.retraction_reason ?? null;
      detail.retraction_timestamp = retraction.retraction_timestamp ?? null;

      return detail;
    }, 30 * 60_000, true);

    if (cached) return sendOk(res, cached);
    return sendError(res, 404, 'NOT_FOUND', 'Version not found');
  }

  const cacheKey = `paper-detail:${author}:${permlink}`;
  const cached = await hafCache.getOrSet(cacheKey, async () => {
    // HAF first: local PostgreSQL is faster than remote Hive API calls.
    if (isHafAvailable()) {
      const hafResult = await fetchPaperDetailFromHaf(author, permlink);
      if (hafResult) return hafResult;

      // If current metadata was stripped by an external edit, reconstruct from
      // version history. The first version establishes paper identity; later
      // versions inherit PEvO metadata when the editing frontend dropped it.
      const versions = await reconstructVersionsFromHaf(author, permlink);
      if (versions.length > 0 && isPevoAnyPaper(versions[0].json_metadata)) {
        const latest = versions[versions.length - 1];
        const meta = latest.json_metadata;
        const post = { author, permlink, title: latest.title, body: latest.body, json_metadata: meta, created: versions[0].created, last_edited: latest.created };
        const detail = buildPaperDetail(post, meta, []);
        detail.versions = versions.map(({ body: _b, json_metadata: _m, ...entry }) => entry);
        detail.metadata_restored = true;

        const retraction = await getRetractionInfo(author, permlink);
        detail.is_retracted = retraction.is_retracted;
        detail.retraction_reason = retraction.retraction_reason ?? null;
        detail.retraction_timestamp = retraction.retraction_timestamp ?? null;

        return detail;
      }
    }

    // Fallback to Hive API if HAF is unavailable (no version history)
    const hiveResult = await fetchPaperDetailFromHiveApi(author, permlink);
    if (hiveResult) return hiveResult;

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
    // Include anonymous posting account so anonymous reviews appear
    const reviewAuthors = config.hiveAnonAccount
      ? [...accreditedArr, config.hiveAnonAccount]
      : accreditedArr;

    const [voteResult, reviewsResult, citationResult, versions, retraction] = await Promise.all([
      // Accredited voters (excluding self-votes) — use vote operations to survive payout
      pool.query(
        `SELECT DISTINCT ON (v.voter) v.voter, v.weight, v.timestamp FROM ${T.voteOps} v
         WHERE v.author = $1 AND v.permlink = $2
           AND v.voter = ANY($3::text[])
           AND v.voter != v.author
         ORDER BY v.voter, v.block_num DESC`,
        [author, permlink, accreditedArr],
      ),
      // Reviews from accredited reviewers (+ anon account) with accredited vote count
      pool.query(
        `SELECT c.author, c.permlink, c.body, c.json_metadata, c.created,
                (SELECT count(*)::int FROM (
                   SELECT DISTINCT ON (v.voter) v.weight FROM ${T.voteOps} v
                   WHERE v.author = c.author AND v.permlink = c.permlink
                     AND v.voter = ANY($5::text[]) AND v.voter != v.author
                   ORDER BY v.voter, v.block_num DESC
                 ) lv WHERE lv.weight > 0) AS net_votes
         FROM ${T.comments} c
         WHERE c.parent_author = $1 AND c.parent_permlink = $2
           AND c.author = ANY($6::text[])
           AND (c.json_metadata -> $3 ->> 'type') = 'review'
           AND c.json_metadata ->> 'app' LIKE $4
         ORDER BY c.created DESC`,
        [author, permlink, config.appTag, `${config.appTag}/%`, accreditedArr, reviewAuthors],
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

    const latestVersion = versions.length > 0 ? versions[versions.length - 1].version_number : 1;

    // §31: Vote staleness — find latest content revision timestamp
    const contentRevisions = versions.filter((v) => v.is_content_revision && v.version_number > 1);
    const latestRevisionTs = contentRevisions.length > 0
      ? new Date(contentRevisions[contentRevisions.length - 1].created)
      : null;

    // §31: If there are content revisions, batch-query revote custom_json ops
    let revoteMap: Map<string, { weight: number; timestamp: Date }> | null = null;
    if (latestRevisionTs && voteResult.rows.length > 0) {
      const revoteResult = await pool.query(
        `SELECT cj.required_posting_auths ->> 0 AS voter,
                (cj.json::jsonb ->> 'weight')::int AS weight,
                cj.json::jsonb ->> 'version' AS version,
                cj.timestamp AS revote_ts
         FROM ${T.customJson} cj
         WHERE cj.custom_id = $1
           AND cj.json::jsonb ->> 'action' = 'revote'
           AND cj.json::jsonb ->> 'author' = $2
           AND cj.json::jsonb ->> 'permlink' = $3
         ORDER BY cj.block_num DESC`,
        [config.appTag, author, permlink],
      );
      // §3.1: Build set of native voters for phantom revote check
      const nativeVoters = new Set(voteResult.rows.map((r: Record<string, unknown>) => r.voter as string));
      revoteMap = new Map();
      for (const r of revoteResult.rows) {
        const voter = r.voter as string;
        const weight = Number(r.weight);
        const version = r.version;
        // §3.1 validation: required fields (author/permlink/version) and weight range
        if (!voter || version == null || isNaN(weight) || weight < -10000 || weight > 10000) {
          logger.debug({ voter, weight, author, permlink }, 'Ignoring invalid revote custom_json');
          continue;
        }
        // §3.1: Ignore phantom revotes (voter must have a prior native Hive vote)
        if (!nativeVoters.has(voter)) {
          logger.debug({ voter, author, permlink }, 'Ignoring phantom revote — no prior native vote');
          continue;
        }
        // Keep only the latest revote per voter (already ordered by block_num DESC)
        if (!revoteMap.has(voter)) {
          revoteMap.set(voter, { weight, timestamp: new Date(r.revote_ts as string) });
        }
      }
    }

    const reviews = reviewsResult.rows.map((r: Record<string, unknown>) => {
      const rMeta = parseMeta(r.json_metadata);
      const pevo = safePevoMeta(rMeta);
      const rating = pevo.rating as Record<string, number> | undefined;
      const reviewedVersion = (pevo.reviewed_version as number) || 1;

      // E5: Review staleness — outdated if paper has been updated since review
      const outdated = reviewedVersion < latestVersion;

      // E5: Find if any version explicitly addresses this review
      const reviewAuthor = r.author as string;
      const reviewPermlink = r.permlink as string;
      let addressedByVersion: number | undefined;
      for (const v of versions) {
        if (v.addresses_reviews) {
          const found = v.addresses_reviews.some(
            (ar) => ar.author === reviewAuthor && ar.permlink === reviewPermlink,
          );
          if (found) {
            addressedByVersion = v.version_number;
            break;
          }
        }
      }

      return {
        author: reviewAuthor,
        permlink: reviewPermlink,
        body: r.body as string,
        rating: rating || { methodology: 0, novelty: 0, clarity: 0, significance: 0 },
        is_anonymous: pevo.is_anonymous ?? false,
        created: r.created as string,
        net_votes: r.net_votes as number,
        reviewer_reputation: 0,
        is_accredited: accreditedAccounts.has(reviewAuthor) || (pevo.is_anonymous === true),
        reviewed_version: reviewedVersion,
        outdated,
        addressed_by_version: addressedByVersion,
      };
    });

    // §31: Compute staleness per voter
    const voters = voteResult.rows.map((r: Record<string, unknown>) => {
      const voter = r.voter as string;
      const nativeWeight = Number(r.weight);
      const nativeTs = new Date(r.timestamp as string);

      if (!latestRevisionTs) {
        // No content revisions — all votes are non-stale
        return { voter, weight: nativeWeight, stale: false, effective_weight: nativeWeight };
      }

      const revote = revoteMap?.get(voter);
      // §31 vote resolution: if both signals are post-revision, use the later timestamp
      if (revote && revote.timestamp > latestRevisionTs) {
        if (nativeTs > latestRevisionTs && nativeTs > revote.timestamp) {
          return { voter, weight: nativeWeight, stale: false, effective_weight: nativeWeight };
        }
        return { voter, weight: revote.weight, stale: false, effective_weight: revote.weight };
      }
      if (nativeTs > latestRevisionTs) {
        return { voter, weight: nativeWeight, stale: false, effective_weight: nativeWeight };
      }
      // Vote predates latest content revision with no post-revision re-vote
      return { voter, weight: nativeWeight, stale: true, effective_weight: 0 };
    });
    const net_votes = voters.filter((v) => v.effective_weight > 0).length;

    return {
      net_votes,
      voters,
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
        const rAuthor = r.author as string;
        return isPevoReview(rMeta) && (accreditedAccounts.has(rAuthor) || rAuthor === config.hiveAnonAccount);
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
          is_accredited: accreditedAccounts.has(r.author as string) || (pevo.is_anonymous === true),
          reviewed_version: (pevo.reviewed_version as number) || 1,
        };
      });

    // §31: Hive API fallback — no version history available, assume non-stale
    const activeVotes: Array<{ voter: string; percent: number }> = post.active_votes || [];
    const voters = activeVotes
      .filter((v) => accreditedAccounts.has(v.voter) && v.voter !== author)
      .map((v) => ({ voter: v.voter, weight: v.percent, stale: false, effective_weight: v.percent }));
    const netVotes = voters.filter((v) => v.weight > 0).length;

    return {
      net_votes: netVotes,
      voters,
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
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;

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
// E6: POST /api/papers/:author/:permlink/invalidate
// ──────────────────────────────────────────────

const invalidateLimiter = rateLimit({ name: 'cache-invalidate', windowMs: 60_000, max: 10, keyFn: byAccount });

router.post('/:author/:permlink/invalidate', verifyHiveSignature, invalidateLimiter, async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;

  // Invalidate all cache keys for this paper
  await Promise.all([
    hafCache.invalidate(`paper-detail:${author}:${permlink}`),
    hafCache.invalidate(`paper-enrichment:${author}:${permlink}`),
  ]);

  sendOk(res, { message: 'Cache invalidated' });
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
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;
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
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;
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
    // Invalidate retraction cache so the change is visible immediately
    hafCache.invalidate('retracted-papers');
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
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;
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
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;

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
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;
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

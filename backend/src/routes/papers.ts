import { Router, type Request, type Response } from 'express';
import { PrivateKey } from '@hiveio/dhive';
import { getPool } from '../db.js';
import { broadcastJsonWithTimeout, BroadcastTimeoutError } from '../hive.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import {
  parseMeta,
  isPevoAnyPaper,
  parsePageLimit,
  parseSort,
  parseOrder,
  extractAbstract,
  type SortField,
} from '../helpers.js';
import { getAccreditedSet, getAllAccreditedAccounts } from '../accreditation.js';
import { getBatchReputationScores } from '../reputation.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { rateLimit, byAccount } from '../middleware/rateLimit.js';
import {
  T,
  accreditedVoteCount,
  activeAccreditationsCteBody,
  authorshipClaimsCteBody,
  retractedPapersCteBody,
  buildWith,
  getCachedGenesisBlock,
} from '../hafsql.js';

const router = Router();

// ─── Vote strength tiers ────────────────────────────────────────
function voteStrengthTier(avgWeight: number): string {
  if (avgWeight > 6000) return 'strong_endorsement';
  if (avgWeight > 2500) return 'endorsement';
  if (avgWeight > 0) return 'mild_endorsement';
  if (avgWeight === 0) return 'neutral';
  if (avgWeight >= -2500) return 'mild_concerns';
  if (avgWeight >= -6000) return 'reject';
  return 'strong_reject';
}

interface ResolvedVotes {
  net_votes: number;
  vote_strength: string | null;
}

/**
 * Compute resolved vote counts for a set of papers using parallel native + revote queries.
 * Returns a Map keyed by "author/permlink" with net_votes and vote_strength.
 */
async function batchResolveVotes(
  pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  papers: Array<{ author: string; permlink: string }>,
  accreditedArr: string[],
): Promise<Map<string, ResolvedVotes>> {
  if (papers.length === 0) return new Map();

  // Build (author, permlink) pairs for the batch native vote query
  const pairValues: string[] = [];
  const pairParams: unknown[] = [];
  let pIdx = 1;
  for (const p of papers) {
    pairValues.push(`($${pIdx++}, $${pIdx++})`);
    pairParams.push(p.author, p.permlink);
  }
  const accreditedParam = `$${pIdx++}`;
  pairParams.push(accreditedArr);

  const [nativeResult, revoteResult] = await Promise.all([
    // Batch native votes: latest per voter per paper, accredited only, excluding self-votes
    pool.query(
      `SELECT DISTINCT ON (v.author, v.permlink, v.voter)
              v.author, v.permlink, v.voter, v.weight, v.block_num
       FROM ${T.voteOps} v
       WHERE (v.author, v.permlink) IN (${pairValues.join(', ')})
         AND v.voter = ANY(${accreditedParam}::text[])
         AND v.voter != v.author
       ORDER BY v.author, v.permlink, v.voter, v.block_num DESC`,
      pairParams,
    ),
    // All revotes for APP_TAG
    pool.query(
      `SELECT cj.json::jsonb ->> 'author' AS author,
              cj.json::jsonb ->> 'permlink' AS permlink,
              cj.required_posting_auths ->> 0 AS voter,
              (cj.json::jsonb ->> 'weight')::int AS weight,
              cj.block_num
       FROM ${T.customJson} cj
       WHERE cj.custom_id = $1
         AND cj.json::jsonb ->> 'action' = 'revote'
         AND cj.block_num >= $2`,
      [config.appTag, getCachedGenesisBlock()],
    ),
  ]);

  // Index native votes: paper_key -> voter -> { weight, block_num }
  const accreditedSet = new Set(accreditedArr);
  type VoteSignal = { weight: number; block_num: number };
  const nativeByPaper = new Map<string, Map<string, VoteSignal>>();
  for (const r of nativeResult.rows) {
    const key = `${r.author}/${r.permlink}`;
    if (!nativeByPaper.has(key)) nativeByPaper.set(key, new Map());
    nativeByPaper.get(key)!.set(r.voter as string, {
      weight: Number(r.weight),
      block_num: Number(r.block_num),
    });
  }

  // Index revotes: paper_key -> voter -> { weight, block_num } (latest per voter per paper)
  const revoteByPaper = new Map<string, Map<string, VoteSignal>>();
  // Revote rows are not ordered, so we track latest block_num manually
  for (const r of revoteResult.rows) {
    const voter = r.voter as string;
    const weight = Number(r.weight);
    if (!voter || isNaN(weight) || weight < -10000 || weight > 10000) continue;
    const rAuthor = r.author as string;
    if (!rAuthor || !accreditedSet.has(voter) || voter === rAuthor) continue;
    const key = `${rAuthor}/${r.permlink}`;
    if (!revoteByPaper.has(key)) revoteByPaper.set(key, new Map());
    const existing = revoteByPaper.get(key)!.get(voter);
    const blockNum = Number(r.block_num);
    if (!existing || blockNum > existing.block_num) {
      revoteByPaper.get(key)!.set(voter, { weight, block_num: blockNum });
    }
  }

  // Merge: for each paper, resolve votes
  const results = new Map<string, ResolvedVotes>();
  for (const p of papers) {
    const key = `${p.author}/${p.permlink}`;
    const nativeVotes = nativeByPaper.get(key) || new Map<string, VoteSignal>();
    const revotes = revoteByPaper.get(key) || new Map<string, VoteSignal>();

    // Collect all voters across both sources
    const allVoters = new Set([...nativeVotes.keys(), ...revotes.keys()]);
    let upvotes = 0;
    let downvotes = 0;
    let weightSum = 0;
    let voterCount = 0;

    for (const voter of allVoters) {
      const native = nativeVotes.get(voter);
      const revote = revotes.get(voter);

      let effectiveWeight: number;
      if (native && revote) {
        effectiveWeight = revote.block_num > native.block_num ? revote.weight : native.weight;
      } else if (revote) {
        effectiveWeight = revote.weight;
      } else {
        effectiveWeight = native!.weight;
      }

      if (effectiveWeight === 0) continue; // retracted
      if (effectiveWeight > 0) upvotes++;
      else downvotes++;
      weightSum += effectiveWeight;
      voterCount++;
    }

    const net_votes = upvotes - downvotes;
    const vote_strength = voterCount > 0 ? voteStrengthTier(weightSum / voterCount) : null;
    results.set(key, { net_votes, vote_strength });
  }

  return results;
}

/** Safely extract the pevo metadata sub-object with runtime validation. */
function safePevoMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const pevo = meta[config.appTag];
  if (pevo != null && typeof pevo === 'object' && !Array.isArray(pevo)) {
    return pevo as Record<string, unknown>;
  }
  return {};
}

const retractLimiter = rateLimit({ name: 'paper-retract', windowMs: 3_600_000, max: 5, keyFn: byAccount });
// ──────────────────────────────────────────────
// HAF SQL implementation for paper listing
// ──────────────────────────────────────────────

async function fetchPapersFromHaf(
  req: Request,
  discipline: string | undefined,
): Promise<{ rows: unknown[]; total: number } | null> {
  const pool = getPool();
  if (!pool) return null;

  const { limit, offset } = parsePageLimit(req);
  const sort = parseSort(req);
  const order = parseOrder(req);
  // `discipline` is parsed + lowercased once by the route handler and passed in
  // explicitly (mirrors `search.ts:searchFromHaf(..., discipline)`). The SQL
  // gate below uses `: undefined` at the call site so the `if (discipline)`
  // branch suppresses the `WHERE LOWER(...) = $N` condition entirely rather
  // than emitting an empty-string match.
  const keyword = req.query.keyword as string | undefined;
  const author = req.query.author as string | undefined;
  const language = req.query.language as string | undefined;
  const accreditedOnly = req.query.accredited_only !== 'false'; // default true
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
    // Case-insensitive discipline match: mirrors /api/search and
    // /api/disciplines canon_name semantics. Without LOWER() on both sides,
    // `?discipline=physics` silently missed papers tagged "Physics" on the
    // primary paper-listing endpoint — the same drift the canonicalization
    // fix closed on /api/search. `discipline` is lowercased once at route
    // entry (see above); no duplicated `.toLowerCase()` here.
    conditions.push(`LOWER(c.json_metadata -> ${appTagParam} ->> 'discipline') = $${paramIdx++}`);
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
    // Bridge papers are posted by the system bridge account, not the original author,
    // so they are exempt from the accredited-only filter.
    conditions.push(`(c.author IN (SELECT account FROM active_accreditations) OR (c.json_metadata -> ${appTagParam} ->> 'type') = 'bridge_paper')`);
  }
  if (!includeRetracted) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM retracted_papers rp WHERE rp.author = c.author AND rp.permlink = c.permlink)`);
  }
  // E3: Hide continuation posts — they are revisions of existing papers, not separate papers
  conditions.push(`(c.json_metadata -> ${appTagParam} -> 'continues') IS NULL`);

  const where = conditions.join(' AND ');
  const countParams = [...cteParams, ...filterParams];

  // anonParam is only used in SELECT subqueries (review/citation count),
  // not in WHERE, so it must not be in countParams (PostgreSQL rejects extra bind params).
  const anonParam = `$${paramIdx++}`;
  const dataParams = [...cteParams, ...filterParams, config.hiveAnonAccount || ''];

  const sortMap: Record<SortField, string> = {
    date: 'c.created',
    votes: 'net_votes',
    reputation: 'author_reputation',
  };
  const safeOrder = order === 'asc' ? 'ASC' : 'DESC';
  const orderBy = `${sortMap[sort]} ${safeOrder}`;

  // Only compute the expensive vote subquery when sorting by votes
  const voteSelect = sort === 'votes'
    ? `${accreditedVoteCount('c.author', 'c.permlink')} AS net_votes`
    : '0 AS net_votes';

  // Review count: accredited reviewers + anonymous posting account
  const reviewCountSelect = `COALESCE((
    SELECT count(*)::int FROM ${T.comments} r
    WHERE r.parent_author = c.author AND r.parent_permlink = c.permlink
      AND (r.json_metadata -> ${appTagParam} ->> 'type') = 'review'
      AND r.json_metadata ->> 'app' LIKE ${appLikeParam}
      AND (EXISTS (SELECT 1 FROM active_accreditations aa WHERE aa.account = r.author) OR r.author = ${anonParam})
  ), 0) AS review_count`;

  // Average review rating: mean of all four rating dimensions across accredited reviews
  const avgRatingSelect = `COALESCE((
    SELECT round(avg(val)::numeric, 1)::float FROM (
      SELECT (
        (rv.json_metadata -> ${appTagParam} -> 'rating' ->> 'methodology')::float +
        (rv.json_metadata -> ${appTagParam} -> 'rating' ->> 'novelty')::float +
        (rv.json_metadata -> ${appTagParam} -> 'rating' ->> 'clarity')::float +
        (rv.json_metadata -> ${appTagParam} -> 'rating' ->> 'significance')::float
      ) / 4.0 AS val
      FROM ${T.comments} rv
      WHERE rv.parent_author = c.author AND rv.parent_permlink = c.permlink
        AND (rv.json_metadata -> ${appTagParam} ->> 'type') = 'review'
        AND rv.json_metadata ->> 'app' LIKE ${appLikeParam}
        AND (EXISTS (SELECT 1 FROM active_accreditations aa WHERE aa.account = rv.author) OR rv.author = ${anonParam})
        AND rv.json_metadata -> ${appTagParam} -> 'rating' IS NOT NULL
    ) sub
  ), 0) AS avg_rating`;

  // Citation count: accredited papers that cite this one (native papers only; bridge papers use Semantic Scholar)
  const citationCountSelect = `COALESCE((
    SELECT count(*)::int FROM ${T.comments} ci
    JOIN active_accreditations aa ON aa.account = ci.author
    WHERE ci.parent_author = '' AND ci.parent_permlink = ${appTagParam}
      AND (ci.json_metadata -> ${appTagParam} ->> 'type') = 'paper'
      AND ci.json_metadata ->> 'app' LIKE ${appLikeParam}
      AND ci.json_metadata -> ${appTagParam} -> 'citations' @> jsonb_build_array(jsonb_build_object('author', c.author, 'permlink', c.permlink))
  ), 0) AS citation_count`;

  try {
    const limitParam = `$${paramIdx++}`;
    const offsetParam = `$${paramIdx++}`;

    const [countResult, dataResult] = await Promise.all([
      pool.query(
        `${cte.sql}
         SELECT count(*)::int AS total FROM ${T.comments} c WHERE ${where}`,
        countParams,
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
          ${voteSelect},
          ${reviewCountSelect},
          ${citationCountSelect},
          ${avgRatingSelect},
          0 AS author_reputation
        FROM ${T.comments} c
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
        [...dataParams, limit, offset],
      ),
    ]);

    const total = countResult.rows[0]?.total ?? 0;
    const authors = dataResult.rows.map((r: Record<string, unknown>) => r.author as string);

    // Use batch reputation scores only (no on-demand HAF computation).
    // Returns 0 for users not yet in the batch — profile page has full scores.
    const allAccredited = await getAllAccreditedAccounts();
    const allAccreditedArr = [...allAccredited];
    const paperKeys = dataResult.rows.map((r: Record<string, unknown>) => ({
      author: r.author as string,
      permlink: r.permlink as string,
    }));

    // Parallel: batch reputation + accredited set + resolved votes (native + revotes)
    const [batchScores, accreditedSet, voteData] = await Promise.all([
      getBatchReputationScores(authors),
      getAccreditedSet(authors),
      batchResolveVotes(pool, paperKeys, allAccreditedArr),
    ]);

    const rows = dataResult.rows.map((r: Record<string, unknown>) => {
      const meta = parseMeta(r.json_metadata);
      const pevo = safePevoMeta(meta);
      const pevoAuthors: Array<{ hive?: string }> = (pevo.authors || []) as Array<{ hive?: string }>;
      const voteKey = `${r.author}/${r.permlink}`;
      const resolved = voteData.get(voteKey);
      return {
        author: r.author,
        permlink: r.permlink,
        title: r.title,
        abstract: r.abstract,
        discipline: pevo.discipline || null,
        keywords: pevo.keywords || [],
        authors: pevoAuthors,
        ipfs_cid: pevo.ipfs_cid || null,
        created: r.created,
        net_votes: resolved?.net_votes ?? (r.net_votes as number),
        vote_strength: resolved?.vote_strength ?? null,
        review_count: (r.review_count as number) ?? 0,
        avg_rating: (r.avg_rating as number) ?? 0,
        citation_count: (r.citation_count as number) ?? 0,
        author_reputation: batchScores.get(r.author as string) ?? 0,
        is_accredited: accreditedSet.has(r.author as string),
        accredited_authors: pevoAuthors
          .filter(a => a.hive && allAccredited.has(a.hive))
          .map(a => a.hive!),
        source_type: pevo.type === 'bridge_paper'
          ? ((pevo.source as Record<string, unknown>)?.type as 'arxiv' | 'crossref') || 'arxiv'
          : 'native',
        doi: pevo.type === 'bridge_paper'
          ? ((pevo.source as Record<string, unknown>)?.doi as string) || null
          : null,
      };
    });

    // Re-sort by resolved vote counts when sorting by votes (revotes may change order)
    if (sort === 'votes') {
      const dir = order === 'asc' ? 1 : -1;
      rows.sort((a, b) => (a.net_votes - b.net_votes) * dir);
    }

    // Enrich bridge papers with external citation counts
    const bridgeDois = rows.filter(r => r.doi).map(r => r.doi!);
    if (bridgeDois.length > 0) {
      const extCounts = await fetchExternalCitationCounts(bridgeDois);
      for (const row of rows) {
        if (row.doi && extCounts[row.doi] !== undefined) {
          row.citation_count = extCounts[row.doi];
        }
      }
    }

    return { rows, total };
  } catch (err) {
    logger.error({ err }, 'HAF papers query failed');
    return null;
  }
}

// ──────────────────────────────────────────────
// GET /api/papers — list papers
// ──────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const { page, limit } = parsePageLimit(req);
  const sort = parseSort(req);
  const order = parseOrder(req);
  // Canonicalize `?discipline=` at route entry so downstream SQL binding and
  // cache-key construction share the same lowercased value. Mirrors the
  // search.ts:287 pattern landed by BE-DISCIPLINE-CANONICALIZE round-2 hold
  // #6. Round-3 hold #1: without this, `?discipline=Physics` and
  // `?discipline=physics` populate independent Redis cache entries despite
  // the SQL-side LOWER() match — the dedup is defeated at the memoization
  // layer on the primary paper-feed endpoint. Round-3 hold #2: typeof-narrow
  // rather than `as string | undefined`; repeated params yield `string[]` at
  // runtime and `.toLowerCase()` on an array silently coerces to
  // `"[object Object]"` in the cache key.
  //
  // Fallback to `''` here (NOT `undefined`) is load-bearing for cache
  // stability: the template literal below would stringify `undefined` to the
  // literal `"undefined"`, invalidating every existing `d=` cache entry on
  // deploy. The inner SQL-gate path uses `: undefined` (passed to
  // `fetchPapersFromHaf`) so the `if (discipline)` condition suppresses the
  // `WHERE LOWER(...) = $N` branch entirely.
  const disciplineRaw = req.query.discipline;
  const discipline = typeof disciplineRaw === 'string' ? disciplineRaw.toLowerCase() : '';
  const keyword = req.query.keyword || '';
  const author = req.query.author || '';
  const language = req.query.language || '';
  const accreditedOnly = req.query.accredited_only !== 'false'; // default true
  const includeRetracted = req.query.include_retracted === 'true';
  const source = req.query.source || '';
  const cacheKey = `papers:p=${page}:l=${limit}:s=${sort}:o=${order}:d=${discipline}:k=${keyword}:a=${author}:lang=${language}:ao=${accreditedOnly}:ir=${includeRetracted}:src=${source}`;
  // Pass `discipline || undefined` so the inner `if (discipline)` SQL-gate
  // suppresses the `WHERE LOWER(...) = $N` condition when no filter was
  // requested. The cache-key `: ''` vs SQL-gate `: undefined` split is
  // intentional — see comment above.
  const result = await hafCache.getOrSetSWR(cacheKey, () => fetchPapersFromHaf(req, discipline || undefined));
  if (result) {
    return sendOk(res, result.rows, { page, limit, total: result.total });
  }

  sendOk(res, [], { page, limit, total: 0 });
});

// ──────────────────────────────────────────────
// Semantic Scholar external citation counts (cached 24h)
// ──────────────────────────────────────────────

async function fetchExternalCitationCounts(dois: string[]): Promise<Record<string, number>> {
  if (dois.length === 0) return {};

  const results: Record<string, number> = {};
  const uncached: string[] = [];

  for (const doi of dois) {
    const cached = await hafCache.get<number>(`ext-citations:${doi}`);
    if (cached !== undefined) {
      results[doi] = cached;
    } else {
      uncached.push(doi);
    }
  }

  if (uncached.length > 0) {
    try {
      const response = await fetch('https://api.semanticscholar.org/graph/v1/paper/batch?fields=citationCount', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: uncached.map((d) => `DOI:${d}`) }),
      });

      if (response.ok) {
        const data = await response.json() as Array<{ citationCount?: number } | null>;
        for (let i = 0; i < uncached.length; i++) {
          const count = data[i]?.citationCount ?? 0;
          results[uncached[i]] = count;
          await hafCache.set(`ext-citations:${uncached[i]}`, count, 86_400_000); // 24h
        }
      } else {
        logger.warn({ status: response.status }, 'Semantic Scholar batch request failed');
        for (const doi of uncached) results[doi] = 0;
      }
    } catch (err) {
      logger.warn({ err }, 'Semantic Scholar fetch failed');
      for (const doi of uncached) results[doi] = 0;
    }
  }

  return results;
}

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
    const [paperResult, fullVersions, retraction] = await Promise.all([
      pool.query(
        `SELECT c.author, c.permlink, c.title, c.body, c.json_metadata,
                c.created, c.last_edited
         FROM ${T.comments} c
         WHERE c.author = $1 AND c.permlink = $2
           AND c.parent_author = '' AND c.parent_permlink = $3`,
        [author, permlink, config.appTag],
      ),
      reconstructVersionsFromHaf(author, permlink),
      getRetractionInfo(author, permlink),
    ]);

    if (paperResult.rows.length === 0) return null;

    const row = paperResult.rows[0];
    const meta = parseMeta(row.json_metadata);
    if (!isPevoAnyPaper(meta)) return null;

    const detail = buildPaperDetail(row, meta, []);
    const versions = fullVersions.map(({ body: _body, json_metadata: _meta, post_author: _pa, post_permlink: _pp, ...entry }) => entry);
    detail.versions = versions.length > 0 ? versions : [{ version_number: 1, block_num: 0, created: detail.created as string, title: detail.title as string, is_content_revision: true }];
    detail.is_retracted = retraction.is_retracted;
    detail.retraction_reason = retraction.retraction_reason ?? null;
    detail.retraction_timestamp = retraction.retraction_timestamp ?? null;

    // E7: Resolve continuation chain to set head author/permlink
    // and use the latest version's content/metadata as the displayed paper
    const chain = await resolveContinuationChain(author, permlink);
    if (chain.length > 1) {
      const head = chain[chain.length - 1];
      detail.head_author = head.author;
      detail.head_permlink = head.permlink;

      // Replace displayed content with the latest version from the chain
      if (fullVersions.length > 0) {
        const latest = fullVersions[fullVersions.length - 1];
        detail.title = latest.title;
        detail.body = latest.body;
        detail.abstract = extractAbstract(latest.body);
        detail.last_update = latest.created;

        // Update metadata-derived fields from the head version
        const headMeta = latest.json_metadata;
        if (isPevoAnyPaper(headMeta)) {
          detail.json_metadata = headMeta;
          const headPevo = safePevoMeta(headMeta);
          detail.authors = headPevo.authors || [];
          detail.discipline = headPevo.discipline || null;
          detail.keywords = headPevo.keywords || [];
          detail.citations = headPevo.citations || [];
          detail.ipfs_cid = headPevo.ipfs_cid || null;
          detail.ipfs_filename = headPevo.ipfs_filename || null;
          detail.document_hash = headPevo.document_hash || null;
          detail.language = headPevo.language || 'en';
          detail.supplementary_files = headPevo.supplementary_files || [];
        }
      }
    }

    // Accreditation: is_accredited + accredited_authors
    const allAccredited = await getAllAccreditedAccounts();
    detail.is_accredited = allAccredited.has(author);
    const detailMeta = detail.json_metadata as Record<string, unknown>;
    const pevoAuthors: Array<{ hive?: string }> = (safePevoMeta(detailMeta).authors || []) as Array<{ hive?: string }>;
    detail.accredited_authors = pevoAuthors
      .filter(a => a.hive && allAccredited.has(a.hive))
      .map(a => a.hive!);

    // Citation count
    const pevo = safePevoMeta(meta);
    if (pevo.type === 'bridge_paper') {
      // External citation count for bridge papers
      const doi = ((pevo.source as Record<string, unknown>)?.doi as string) || null;
      if (doi) {
        const extCounts = await fetchExternalCitationCounts([doi]);
        if (extCounts[doi] !== undefined) detail.citation_count = extCounts[doi];
      }
    } else {
      // Native paper citation count from accredited authors
      const citCte = buildWith(1, activeAccreditationsCteBody);
      const citAppTag = `$${citCte.nextIdx}`;
      const citAppLike = `$${citCte.nextIdx + 1}`;
      const citJson = `$${citCte.nextIdx + 2}`;
      const citResult = await pool.query(
        `${citCte.sql}
         SELECT count(*)::int AS cnt FROM ${T.comments} ci
         JOIN active_accreditations aa ON aa.account = ci.author
         WHERE ci.parent_author = '' AND ci.parent_permlink = ${citAppTag}
           AND (ci.json_metadata -> ${citAppTag} ->> 'type') = 'paper'
           AND ci.json_metadata ->> 'app' LIKE ${citAppLike}
           AND ci.json_metadata -> ${citAppTag} -> 'citations' @> ${citJson}::jsonb`,
        [...citCte.params, config.appTag, `${config.appTag}/%`, JSON.stringify([{ author, permlink }])],
      );
      detail.citation_count = citResult.rows[0]?.cnt ?? 0;
    }

    return detail;
  } catch (err) {
    logger.error({ err }, 'HAF paper detail query failed');
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
  block_num: number;
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
         co.block_num,
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
        block_num: Number(r.block_num),
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
       AND cj.json::jsonb ->> 'action' = 'retract_paper'
       AND cj.block_num >= $2`,
    [config.appTag, getCachedGenesisBlock()],
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
    accredited_authors: [] as string[],
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
  const canonicalRoot = await findCanonicalRoot(author, permlink);
  if (canonicalRoot) {
    author = canonicalRoot.author;
    permlink = canonicalRoot.permlink;
  }

  if (requestedVersion !== null) {
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

    const [voteResult, reviewsResult, versions, claimsResult] = await Promise.all([
      // Accredited voters (excluding self-votes) — use vote operations to survive payout
      pool.query(
        `SELECT DISTINCT ON (v.voter) v.voter, v.weight, v.timestamp, v.block_num FROM ${T.voteOps} v
         WHERE v.author = $1 AND v.permlink = $2
           AND v.voter = ANY($3::text[])
           AND v.voter != v.author
         ORDER BY v.voter, v.block_num DESC`,
        [author, permlink, accreditedArr],
      ),
      // Reviews from accredited reviewers (+ anon account) with accredited vote count
      pool.query(
        `SELECT c.author, c.permlink, c.body, c.json_metadata, c.created,
                (SELECT COALESCE(SUM(CASE WHEN lv.weight > 0 THEN 1 WHEN lv.weight < 0 THEN -1 ELSE 0 END), 0)::int FROM (
                   SELECT DISTINCT ON (v.voter) v.weight FROM ${T.voteOps} v
                   WHERE v.author = c.author AND v.permlink = c.permlink
                     AND v.voter = ANY($5::text[]) AND v.voter != v.author
                   ORDER BY v.voter, v.block_num DESC
                 ) lv WHERE lv.weight != 0) AS net_votes
         FROM ${T.comments} c
         WHERE c.parent_author = $1 AND c.parent_permlink = $2
           AND c.author = ANY($6::text[])
           AND (c.json_metadata -> $3 ->> 'type') = 'review'
           AND c.json_metadata ->> 'app' LIKE $4
         ORDER BY c.created DESC`,
        [author, permlink, config.appTag, `${config.appTag}/%`, accreditedArr, reviewAuthors],
      ),
      // Version history (needed for review outdated computation)
      resolveVersionsFromHaf(author, permlink),
      // Authorship claims
      (async () => {
        const cte = buildWith(1, activeAccreditationsCteBody, (idx) => authorshipClaimsCteBody(idx, { paperAuthor: author, paperPermlink: permlink }));
        return pool.query(
          `${cte.sql}
           SELECT claimer, paper_author, paper_permlink, author_index, status, claimed_at
           FROM authorship_claims
           WHERE paper_author = $${cte.nextIdx}
             AND paper_permlink = $${cte.nextIdx + 1}
             AND status != 'revoked'`,
          [...cte.params, author, permlink],
        );
      })(),
    ]);

    const latestVersion = versions.length > 0 ? versions[versions.length - 1].version_number : 1;

    // Always query revote custom_json ops for this paper
    const revoteResult = await pool.query(
      `SELECT cj.required_posting_auths ->> 0 AS voter,
              (cj.json::jsonb ->> 'weight')::int AS weight,
              cj.json::jsonb ->> 'version' AS version,
              cj.timestamp AS revote_ts,
              cj.block_num
       FROM ${T.customJson} cj
       WHERE cj.custom_id = $1
         AND cj.json::jsonb ->> 'action' = 'revote'
         AND cj.json::jsonb ->> 'author' = $2
         AND cj.json::jsonb ->> 'permlink' = $3
         AND cj.block_num >= $4
       ORDER BY cj.block_num DESC`,
      [config.appTag, author, permlink, getCachedGenesisBlock()],
    );
    const revoteMap = new Map<string, { weight: number; timestamp: Date; block_num: number; version: number }>();
    for (const r of revoteResult.rows) {
      const voter = r.voter as string;
      const weight = Number(r.weight);
      const version = r.version;
      // Validation: required fields (author/permlink/version) and weight range
      if (!voter || version == null || isNaN(weight) || weight < -10000 || weight > 10000) {
        logger.debug({ voter, weight, author, permlink }, 'Ignoring invalid revote custom_json');
        continue;
      }
      // Only include accredited voters (excluding self-votes)
      if (!accreditedAccounts.has(voter) || voter === author) continue;
      // Keep only the latest revote per voter (already ordered by block_num DESC)
      if (!revoteMap.has(voter)) {
        revoteMap.set(voter, { weight, timestamp: new Date(r.revote_ts as string), block_num: Number(r.block_num), version: Number(version) });
      }
    }

    const reviews = reviewsResult.rows.map((r: Record<string, unknown>) => {
      const rMeta = parseMeta(r.json_metadata);
      const pevo = safePevoMeta(rMeta);
      const rating = pevo.rating as Record<string, number> | undefined;
      // Compute reviewed_version from timestamps: latest version created before this review
      const reviewCreated = new Date(r.created as string);
      let reviewedVersion = 1;
      for (const v of versions) {
        if (new Date(v.created) <= reviewCreated) {
          reviewedVersion = v.version_number;
        }
      }

      // E5: Review outdated — if paper has been updated since review
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

    // Vote resolution: for each voter, pick the signal with the highest block_num
    // across native votes and revote custom_json. Handle weight=0 as retraction.
    const processedVoters = new Set<string>();
    const voters: Array<{ voter: string; weight: number; effective_weight: number; voted_version: number }> = [];

    // Build sorted version block_nums for voted_version inference
    const versionBlocks = versions
      .map(v => ({ version_number: v.version_number, block_num: v.block_num }))
      .sort((a, b) => a.block_num - b.block_num);

    // Infer voted version from a vote's block_num: latest version where version_block <= vote_block
    function inferVotedVersion(voteBlockNum: number): number {
      let result = 1;
      for (const vb of versionBlocks) {
        if (vb.block_num <= voteBlockNum) result = vb.version_number;
        else break;
      }
      return result;
    }

    // Process voters with native votes
    for (const r of voteResult.rows) {
      const voter = r.voter as string;
      const nativeWeight = Number(r.weight);
      const nativeBlock = Number(r.block_num);
      processedVoters.add(voter);

      const revote = revoteMap.get(voter);
      // Pick latest signal by block_num
      const useRevote = revote && revote.block_num > nativeBlock;
      const effectiveSignalWeight = useRevote ? revote.weight : nativeWeight;

      // weight=0 means retracted
      if (effectiveSignalWeight === 0) continue;

      // Determine voted_version: revote has explicit version, native uses block_num inference
      const votedVersion = useRevote ? revote.version : inferVotedVersion(nativeBlock);

      voters.push({
        voter,
        weight: effectiveSignalWeight,
        effective_weight: effectiveSignalWeight,
        voted_version: votedVersion,
      });
    }

    // Process revote-only voters (no native Hive vote)
    for (const [voter, revote] of revoteMap) {
      if (processedVoters.has(voter)) continue;
      if (revote.weight === 0) continue;

      voters.push({
        voter,
        weight: revote.weight,
        effective_weight: revote.weight,
        voted_version: revote.version,
      });
    }

    const net_votes = voters.reduce((sum, v) => sum + (v.effective_weight > 0 ? 1 : v.effective_weight < 0 ? -1 : 0), 0);
    const effectiveVoters = voters.filter(v => v.effective_weight !== 0);
    const avgWeight = effectiveVoters.length > 0
      ? effectiveVoters.reduce((sum, v) => sum + v.effective_weight, 0) / effectiveVoters.length
      : 0;
    const vote_strength = effectiveVoters.length > 0 ? voteStrengthTier(avgWeight) : null;

    const authorship_claims = claimsResult.rows.map((r: Record<string, unknown>) => ({
      claimer: r.claimer as string,
      author_index: r.author_index as number | null,
      status: r.status as string,
      claimed_at: r.claimed_at as string,
    }));

    return {
      net_votes,
      vote_strength,
      voters,
      reviews,
      authorship_claims,
    };
  } catch (err) {
    logger.error({ err }, 'HAF enrichment query failed');
    return null;
  }
}

router.get('/:author/:permlink/enrichment', async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;

  const cacheKey = `paper-enrichment:${author}:${permlink}`;
  const cached = await hafCache.getOrSet(cacheKey, () =>
    fetchEnrichmentFromHaf(author, permlink),
  5 * 60_000, true);

  if (!cached) return sendError(res, 404, 'NOT_FOUND', 'Paper not found');
  sendOk(res, cached);
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
  const detail = await fetchPaperDetailFromHaf(author, permlink) as Record<string, unknown> | null;
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
    const result = await broadcastJsonWithTimeout(
      { id: config.appTag, json: JSON.stringify(payload), required_auths: [], required_posting_auths: [config.hiveAdminAccount] },
      key,
    );
    // Invalidate retraction cache so the change is visible immediately
    void hafCache.invalidate('retracted-papers');
    sendOk(res, { message: 'Paper retracted', tx_id: result.id });
  } catch (err) {
    if (err instanceof BroadcastTimeoutError) {
      logger.warn(
        { err, timeoutMs: err.timeoutMs, author, permlink },
        'papers.retract broadcast timed out',
      );
      return sendError(
        res,
        504,
        'BROADCAST_TIMEOUT',
        'Broadcasting paper retraction timed out',
        {
          retriable: false,
          outcome: 'uncertain',
          verify_before_retry: true,
          timeout_ms: err.timeoutMs,
        },
      );
    }
    logger.error({ err, author, permlink }, 'papers.retract broadcast failed');
    sendError(
      res,
      502,
      'BROADCAST_FAILED',
      'Failed to broadcast retraction to Hive',
      { retriable: false },
    );
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
  const detail = await fetchPaperDetailFromHaf(author, permlink) as Record<string, unknown> | null;
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

export default router;

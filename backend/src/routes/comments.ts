import { Router, type Request, type Response } from 'express';
import { getPool, HafQueryError, isRetriableHafError } from '../db.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { getAccreditedSet } from '../accreditation.js';
import { getReputationScores } from '../reputation.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { T, activeAccreditationsCteBody, accreditedVoteCount, validPevoPaperWhere } from '../hafsql.js';

const router = Router({ mergeParams: true });

type CommentSort = 'date' | 'votes';

function parseCommentParams(req: Request) {
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
  const offset = (page - 1) * limit;
  const sort: CommentSort = req.query.sort === 'votes' ? 'votes' : 'date';
  const order: 'asc' | 'desc' = req.query.order === 'desc' ? 'desc' : 'asc';
  return { page, limit, offset, sort, order };
}

// Shape of an enriched comment row returned to the SPA. Held by the canonical
// per-paper tree cache as the JS-side slice/sort/order inputs.
interface EnrichedComment {
  author: string;
  permlink: string;
  body: string;
  created: string;
  net_votes: number;
  is_accredited: boolean;
  author_reputation: number;
  parent_author: string;
  parent_permlink: string;
}

// Raw row shape the comment-tree query projects. `accredited_votes` comes from
// `accreditedVoteCount`'s `COALESCE(...)::int`, which node-pg surfaces as a JS
// number (int4, not bigint-as-string), so no per-field runtime coercion is
// needed. Naming the shape lets `pool.query<RawCommentRow>` type `result.rows`
// and drops the unsound `as string` / `as number` casts in the enrichment map.
// `created` is HafSQL's `comments.created`: empirically it arrives as an
// ISO-8601 text string, NOT a node-pg `Date` (an `.toISOString()` assumption
// threw at runtime against the live HAF node). Type it `string | Date` and
// normalize defensively in the enrichment map below so either shape yields the
// ISO wire string — NOT cast `::text` in the SELECT, which would yield a
// different (space-separated, micro-second) format and change the response shape.
interface RawCommentRow {
  author: string;
  permlink: string;
  body: string;
  created: string | Date;
  parent_author: string;
  parent_permlink: string;
  accredited_votes: number;
}

// ──────────────────────────────────────────────
// HAF SQL implementation
// ──────────────────────────────────────────────

async function paperExistsInHaf(author: string, permlink: string): Promise<boolean | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    const validPaper = validPevoPaperWhere({ commentAlias: 'c', appTagParam: '$3', bridgeAccountParam: '$5', source: 'all' });
    const result = await pool.query(
      `SELECT 1 FROM ${T.comments} c
       WHERE c.author = $1 AND c.permlink = $2
         AND c.parent_author = '' AND c.parent_permlink = $3
         AND ${validPaper}
         AND c.json_metadata ->> 'app' LIKE $4
       LIMIT 1`,
      [author, permlink, config.appTag, `${config.appTag}/%`, config.hiveBridgeAccount],
    );
    return result.rows.length > 0;
  } catch (err) {
    // Loud-fail on HAF query failure so the route handler can translate to
    // `503 SERVICE_UNAVAILABLE` with `details.retriable: true` rather than
    // collapsing to `null → 404 Paper not found` (which made HAF outage
    // indistinguishable from "paper does not exist"). The `null` return
    // shape is reserved for the pool-unavailable startup condition (above);
    // a query throw is a transient outage signal.
    logger.error({ err }, 'HAF paper existence check failed');
    throw new HafQueryError('paperExistsInHaf', { cause: err });
  }
}

/**
 * Fetch the FULL discussion-comment tree for a paper, enriched, with no
 * pagination/sort applied. One query (no LIMIT/OFFSET, no duplicate count
 * walk — `total = rows.length`). The route handler caches this once per
 * paper and applies sort/order/slice in JS, so a paper polled across N
 * pagination/sort variants reuses a single canonical entry instead of
 * fanning out N tree walks per cache-key.
 */
async function fetchCommentsTreeFromHaf(
  paperAuthor: string,
  paperPermlink: string,
): Promise<{ rows: EnrichedComment[]; total: number } | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    // PEvO object-identity gate is unconditional: comments are author-vouched
    // by accredited Hive accounts. A Hive comment with comment-shaped metadata
    // authored by an unaccredited account is not a PEvO comment. The legacy
    // `?accredited_only=false` opt-out is silently ignored per Express
    // convention (api-contracts/common.md).
    const accreditedJoin = `JOIN active_accreditations aa ON aa.account = dc.author`;

    // Build parameterized CTE
    const accredCte = activeAccreditationsCteBody();
    // appTag is used by the `type IS DISTINCT FROM 'review'` discriminator,
    // which excludes typed reviews from the discussion stream while admitting
    // both PEvO-authored comments (type='comment') and replies that carry no
    // pevotest metadata (e.g. peakd/ecency). Accreditation, not the authoring
    // client, is the gate (see CLAUDE.md: "accreditation is the trust layer").
    const appTagIdx = accredCte.nextIdx;
    const paperAuthorIdx = accredCte.nextIdx + 1;
    const paperPermlinkIdx = accredCte.nextIdx + 2;

    const params = [...accredCte.params, config.appTag, paperAuthor, paperPermlink];

    // Recursive CTE to get all discussion comments in the tree.
    // `WITH RECURSIVE` is required because `comment_tree` self-references in
    // the UNION ALL arm; PostgreSQL rejects forward references inside a
    // non-RECURSIVE WITH. A parse error here is not silent: the catch below
    // throws `HafQueryError`, so the route returns 503/500 — it is never a
    // silent `200 []`.
    //
    // No LIMIT/OFFSET/ORDER BY: the canonical tree is cached as a whole and
    // the route handler sorts + slices in JS. Pagination correctness rests on
    // `total = rows.length` (no duplicate count walk).
    //
    // Descent gate: the recursive arm additionally requires the parent
    // (`ct.author`) to be in `active_accreditations`. The base arm matches
    // `parent_author = paperAuthor`, i.e. the parent IS the paper page
    // itself — the rendered context — so a base-arm row is never an orphan
    // and needs no EXISTS check (the paper author need not be accredited:
    // `paperExistsInHaf`'s native-paper arm is type-only and bridge papers
    // are authored by `config.hiveBridgeAccount`; orphan-safety here rests
    // on the parent being the paper, not on parent accreditation). Without
    // the recursive-arm gate, an accredited reply whose parent was authored
    // by a non-accredited Hive account (e.g. posted via peakd/ecency by an
    // unaccredited user) would survive the outer `accreditedJoin` (which
    // only checks `dc.author`) and render as an orphan against missing
    // context. The outer `accreditedJoin` stays as the author-side gate.
    const query = `
      WITH RECURSIVE ${accredCte.sql},
      comment_tree AS (
        -- Base: direct replies to the paper that are discussion comments
        SELECT
          c.author, c.permlink, c.body, c.created,
          c.parent_author, c.parent_permlink, 0 AS depth
        FROM ${T.comments} c
        WHERE c.parent_author = $${paperAuthorIdx} AND c.parent_permlink = $${paperPermlinkIdx}
          AND (c.json_metadata -> $${appTagIdx} ->> 'type') IS DISTINCT FROM 'review'

        UNION ALL

        -- Recursive: replies to discussion comments. The negative
        -- discriminator (IS DISTINCT FROM 'review') admits comments that
        -- carry no pevotest metadata at all — NULL is considered "distinct".
        -- The EXISTS clause restricts descent to accredited parents so
        -- accredited replies under a non-accredited parent do not survive
        -- as orphans (the outer accreditedJoin only checks the row's own
        -- author, not the chain of ancestry).
        SELECT
          c.author, c.permlink, c.body, c.created,
          c.parent_author, c.parent_permlink, ct.depth + 1
        FROM ${T.comments} c
        JOIN comment_tree ct ON c.parent_author = ct.author AND c.parent_permlink = ct.permlink
        WHERE (c.json_metadata -> $${appTagIdx} ->> 'type') IS DISTINCT FROM 'review'
          AND ct.depth < 20
          AND EXISTS (SELECT 1 FROM active_accreditations aa WHERE aa.account = ct.author)
      )
      SELECT
        dc.author, dc.permlink, dc.body, dc.created,
        dc.parent_author, dc.parent_permlink,
        ${accreditedVoteCount('dc.author', 'dc.permlink', `$${appTagIdx}`)} AS accredited_votes
      FROM comment_tree dc
      ${accreditedJoin}`;

    const dataResult = await pool.query<RawCommentRow>(query, params);

    // Enrich with accreditation + reputation
    const authors = [...new Set(dataResult.rows.map((r) => r.author))];
    const [accreditedSet, reputationMap] = await Promise.all([
      getAccreditedSet(authors),
      getReputationScores(authors),
    ]);

    const rows: EnrichedComment[] = dataResult.rows.map((r) => {
      const author = r.author;
      const authorAccredited = accreditedSet.has(author);
      return {
        author,
        permlink: r.permlink,
        body: r.body,
        // HafSQL surfaces `created` as an ISO-8601 string; normalize defensively
        // so a future node-pg `Date` (or any non-string) is still emitted as the
        // ISO wire string, and `EnrichedComment.created: string` stays sound.
        created: r.created instanceof Date ? r.created.toISOString() : r.created,
        net_votes: r.accredited_votes,
        is_accredited: authorAccredited,
        // Symmetric chain pre-check: a non-accredited commenter shows score 0
        // even if a stale reputation-batch entry survives in Redis. The chain
        // is the source of truth; the reputation batch map is a performance
        // cache, so a stale entry for a revoked or unaccredited account must
        // not surface a non-zero score.
        author_reputation: authorAccredited ? (reputationMap.get(author) ?? 0) : 0,
        parent_author: r.parent_author,
        parent_permlink: r.parent_permlink,
      };
    });

    return { rows, total: rows.length };
  } catch (err) {
    // Loud-fail on HAF query failure so the route handler can translate
    // to `503 SERVICE_UNAVAILABLE` with `details.retriable: true`. The
    // sibling `paperExistsInHaf` preflight already throws; translating
    // the listing helper too keeps the route contract uniform across the
    // sequential queries. An outage that starts BETWEEN the preflight
    // (which succeeds) and this query (which fails) would otherwise
    // collapse to `200 []` for a paper the user knows has comments — the
    // SPA could not distinguish "comments listing temporarily down" from
    // "this paper has no comments yet". `hafCache.getOrSet` skips storing
    // on null AND on rejection (try/finally cleanup), so the throw does
    // not poison the cache for subsequent recovery-window callers.
    logger.error({ err }, 'HAF comments query failed');
    throw new HafQueryError('fetchCommentsTreeFromHaf', { cause: err });
  }
}

/**
 * Sort + slice an already-fetched canonical tree. Pure, no I/O — runs on
 * every request against the cached tree so an active paper polled across N
 * pagination/sort variants amortises to one tree walk per cache window.
 *
 * The comparator is a TOTAL order: the primary key (`created` or `net_votes`)
 * is followed by `permlink` then `author` tiebreakers, and (author, permlink)
 * is a comment's unique chain identity, so no two distinct rows ever compare
 * equal. This is load-bearing for pagination: page-1 and page-2 are served
 * from separate `stable`-cache reads of the same tree, so without a total
 * order, primary-key ties (equal `net_votes`, same-block `created`) would keep
 * the SQL scan's arbitrary order and could resolve differently between the two
 * reads — duplicating one comment and skipping another across the boundary.
 * The whole composite comparison is flipped for `order === 'desc'`, so desc is
 * exactly asc reversed. The recursive CTE intentionally has no `ORDER BY`: the
 * JS total order fully determines output regardless of scan order, so an SQL
 * sort would only add cost.
 */
function paginateTree(
  tree: { rows: EnrichedComment[]; total: number },
  params: ReturnType<typeof parseCommentParams>,
): { rows: EnrichedComment[]; total: number } {
  const { sort, order, offset, limit } = params;
  // Copy before sorting (do not mutate the cached array). `created` is a chain
  // timestamp string sortable lexicographically; `votes` uses the precomputed
  // `net_votes` projection.
  const sorted = [...tree.rows].sort((a, b) => {
    let cmp: number;
    if (sort === 'votes') {
      cmp = a.net_votes - b.net_votes;
    } else {
      cmp = a.created < b.created ? -1 : a.created > b.created ? 1 : 0;
    }
    // Deterministic tiebreakers applied BEFORE the order flip so a tied
    // primary key resolves to a stable total order. (permlink, author) is
    // unique per comment, so the comparator never returns 0 for distinct rows.
    if (cmp === 0) cmp = a.permlink < b.permlink ? -1 : a.permlink > b.permlink ? 1 : 0;
    if (cmp === 0) cmp = a.author < b.author ? -1 : a.author > b.author ? 1 : 0;
    return order === 'asc' ? cmp : -cmp;
  });
  return { rows: sorted.slice(offset, offset + limit), total: tree.total };
}

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink/comments
// ──────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;
  const params = parseCommentParams(req);

  try {
    const exists = await paperExistsInHaf(author, permlink);
    if (exists === false || exists === null) {
      return sendError(res, 404, 'NOT_FOUND', 'Paper not found');
    }

    // Canonical per-paper tree cache: one entry holds the full enriched tree;
    // sort/order/slice happen in JS below. `stable: true` + 30s TTL: the
    // block-watcher's ~3s `clearVolatile()` tick would otherwise wipe the
    // entry roughly synchronously with HAF ingest, giving back most of the
    // benefit, and there is no backend-side broadcast hook to issue a
    // precise DEL on new replies (comments are signed by the SPA via
    // Keychain and broadcast directly to the chain).
    const cacheKey = `comments:tree:${author}:${permlink}`;
    const tree = await hafCache.getOrSet<{ rows: EnrichedComment[]; total: number } | null>(
      cacheKey,
      () => fetchCommentsTreeFromHaf(author, permlink),
      30_000,
      true,
    );
    // The paperExistsInHaf preflight above already 404s when getPool() is
    // null, so fetchCommentsTreeFromHaf's own null-pool short-circuit is
    // structurally unreachable here. Guard explicitly anyway (no `!`
    // assertion, so the checker enforces the null branch): a pool dropped
    // between the preflight and this call returns null, which we translate to
    // the same retriable 503 the catch block uses rather than dereferencing.
    if (!tree) {
      return sendError(
        res,
        503,
        'SERVICE_UNAVAILABLE',
        'Comments temporarily unavailable. Please retry shortly.',
        { retriable: true },
      );
    }
    const page = paginateTree(tree, params);
    sendOk(res, page.rows, { page: params.page, limit: params.limit, total: page.total });
  } catch (err) {
    if (err instanceof HafQueryError && isRetriableHafError(err)) {
      // Cause-discriminated retriable envelope. Deterministic pg failures
      // (syntax error, permission error, data-type mismatch) fall through
      // to the central 500 handler so the SPA's retry-on-503-retriable
      // loop doesn't hammer a dead query.
      return sendError(
        res,
        503,
        'SERVICE_UNAVAILABLE',
        'Comments temporarily unavailable. Please retry shortly.',
        { retriable: true },
      );
    }
    throw err;
  }
});

export default router;

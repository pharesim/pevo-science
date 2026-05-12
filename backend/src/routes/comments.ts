import { Router, type Request, type Response } from 'express';
import { getPool } from '../db.js';
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
    logger.error({ err }, 'HAF paper existence check failed');
    return null;
  }
}

async function fetchCommentsFromHaf(
  paperAuthor: string,
  paperPermlink: string,
  params: ReturnType<typeof parseCommentParams>,
) {
  const pool = getPool();
  if (!pool) return null;

  const { limit, offset, sort, order } = params;

  try {
    // PEvO object-identity gate is unconditional: comments are author-vouched
    // by accredited Hive accounts. A Hive comment with comment-shaped metadata
    // authored by an unaccredited account is not a PEvO comment. The legacy
    // `?accredited_only=false` opt-out is silently ignored per Express
    // convention (api-contracts/common.md).
    const accreditedJoin = `JOIN active_accreditations aa ON aa.account = dc.author`;

    // ORDER BY runs on the outer `SELECT * FROM filtered`, where the
    // `dc` alias from inside the `filtered` CTE is no longer in scope.
    // Reference the projected column names directly.
    const sortCol = sort === 'votes' ? 'accredited_votes' : 'created';
    const safeOrder = order === 'asc' ? 'ASC' : 'DESC';

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
    const limitIdx = accredCte.nextIdx + 3;
    const offsetIdx = accredCte.nextIdx + 4;

    const baseParams = [...accredCte.params, config.appTag, paperAuthor, paperPermlink];

    // Recursive CTE to get all discussion comments in the tree.
    // `WITH RECURSIVE` is required because `comment_tree` self-references in
    // the UNION ALL arm; PostgreSQL rejects forward references inside a
    // non-RECURSIVE WITH (the failure is silent here — the caller catches
    // the parse error and returns []).
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
        SELECT
          c.author, c.permlink, c.body, c.created,
          c.parent_author, c.parent_permlink, ct.depth + 1
        FROM ${T.comments} c
        JOIN comment_tree ct ON c.parent_author = ct.author AND c.parent_permlink = ct.permlink
        WHERE (c.json_metadata -> $${appTagIdx} ->> 'type') IS DISTINCT FROM 'review'
          AND ct.depth < 20
      ),
      filtered AS (
        SELECT
          dc.author, dc.permlink, dc.body, dc.created,
          dc.parent_author, dc.parent_permlink,
          ${accreditedVoteCount('dc.author', 'dc.permlink')} AS accredited_votes
        FROM comment_tree dc
        ${accreditedJoin}
      )
      SELECT * FROM filtered
      ORDER BY ${sortCol} ${safeOrder}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

    const countQuery = `
      WITH RECURSIVE ${accredCte.sql},
      comment_tree AS (
        SELECT c.author, c.permlink, c.parent_author, c.parent_permlink, 0 AS depth
        FROM ${T.comments} c
        WHERE c.parent_author = $${paperAuthorIdx} AND c.parent_permlink = $${paperPermlinkIdx}
          AND (c.json_metadata -> $${appTagIdx} ->> 'type') IS DISTINCT FROM 'review'
        UNION ALL
        SELECT c.author, c.permlink, c.parent_author, c.parent_permlink, ct.depth + 1
        FROM ${T.comments} c
        JOIN comment_tree ct ON c.parent_author = ct.author AND c.parent_permlink = ct.permlink
        WHERE (c.json_metadata -> $${appTagIdx} ->> 'type') IS DISTINCT FROM 'review'
          AND ct.depth < 20
      )
      SELECT count(*)::int AS total
      FROM comment_tree dc
      ${accreditedJoin}`;

    const [dataResult, countResult] = await Promise.all([
      pool.query(query, [...baseParams, limit, offset]),
      pool.query(countQuery, baseParams),
    ]);

    const total = countResult.rows[0]?.total ?? 0;

    // Enrich with accreditation + reputation
    const authors = [...new Set(dataResult.rows.map((r: Record<string, unknown>) => r.author as string))];
    const [accreditedSet, reputationMap] = await Promise.all([
      getAccreditedSet(authors),
      getReputationScores(authors),
    ]);

    const rows = dataResult.rows.map((r: Record<string, unknown>) => {
      const authorAccredited = accreditedSet.has(r.author as string);
      return {
        author: r.author,
        permlink: r.permlink,
        body: r.body,
        created: r.created,
        net_votes: r.accredited_votes as number,
        is_accredited: authorAccredited,
        // Symmetric chain pre-check: non-accredited commenter shows score 0
        // even if a stale batch entry survives in Redis (per BACKEND-REPUTATION-SSOT
        // direction-of-truth: chain is SSoT, batch map is a perf cache).
        author_reputation: authorAccredited ? (reputationMap.get(r.author as string) ?? 0) : 0,
        parent_author: r.parent_author,
        parent_permlink: r.parent_permlink,
      };
    });

    return { rows, total };
  } catch (err) {
    logger.error({ err }, 'HAF comments query failed');
    return null;
  }
}

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink/comments
// ──────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;
  const params = parseCommentParams(req);

  const exists = await paperExistsInHaf(author, permlink);
  if (exists === false || exists === null) {
    return sendError(res, 404, 'NOT_FOUND', 'Paper not found');
  }

  const cacheKey = `comments:${author}:${permlink}:p=${params.page}:l=${params.limit}:s=${params.sort}:o=${params.order}`;
  const result = await hafCache.getOrSet(cacheKey, () =>
    fetchCommentsFromHaf(author, permlink, params),
  );
  if (result) {
    return sendOk(res, result.rows, { page: params.page, limit: params.limit, total: result.total });
  }

  sendOk(res, [], { page: params.page, limit: params.limit, total: 0 });
});

export default router;

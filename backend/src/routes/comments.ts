import { Router, type Request, type Response } from 'express';
import { getPool, isHafAvailable } from '../db.js';
import { hiveClient } from '../hive.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { parseMeta, isPevoAnyPaper } from '../helpers.js';
import { getAccreditedSet } from '../accreditation.js';
import { getReputationScores } from '../reputation.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { T, activeAccreditationsCteBody, accreditedVoteCount } from '../hafsql.js';

const router = Router({ mergeParams: true });

type CommentSort = 'date' | 'votes';

function parseCommentParams(req: Request) {
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
  const offset = (page - 1) * limit;
  const accreditedOnly = req.query.accredited_only !== 'false';
  const sort: CommentSort = req.query.sort === 'votes' ? 'votes' : 'date';
  const order: 'asc' | 'desc' = req.query.order === 'desc' ? 'desc' : 'asc';
  return { page, limit, offset, accreditedOnly, sort, order };
}

// ──────────────────────────────────────────────
// HAF SQL implementation
// ──────────────────────────────────────────────

async function paperExistsInHaf(author: string, permlink: string): Promise<boolean | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    const result = await pool.query(
      `SELECT 1 FROM ${T.comments}
       WHERE author = $1 AND permlink = $2
         AND parent_author = '' AND parent_permlink = $3
         AND (json_metadata -> $3 ->> 'type') IN ('paper', 'bridge_paper')
         AND json_metadata ->> 'app' LIKE $4
       LIMIT 1`,
      [author, permlink, config.appTag, `${config.appTag}/%`],
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

  const { limit, offset, accreditedOnly, sort, order } = params;

  try {
    const accreditedJoin = accreditedOnly
      ? `JOIN active_accreditations aa ON aa.account = dc.author`
      : '';

    const sortCol = sort === 'votes' ? 'accredited_votes' : 'dc.created';
    const safeOrder = order === 'asc' ? 'ASC' : 'DESC';

    // Build parameterized CTE
    const accredCte = activeAccreditationsCteBody();
    // appTag and appLike params come after CTE params
    const appTagIdx = accredCte.nextIdx;
    const appLikeIdx = accredCte.nextIdx + 1;
    const paperAuthorIdx = accredCte.nextIdx + 2;
    const paperPermlinkIdx = accredCte.nextIdx + 3;
    const limitIdx = accredCte.nextIdx + 4;
    const offsetIdx = accredCte.nextIdx + 5;

    const baseParams = [...accredCte.params, config.appTag, `${config.appTag}/%`, paperAuthor, paperPermlink];

    // Recursive CTE to get all discussion comments in the tree
    const query = `
      WITH ${accredCte.sql},
      comment_tree AS (
        -- Base: direct replies to the paper that are discussion comments
        SELECT
          c.author, c.permlink, c.body, c.created,
          c.parent_author, c.parent_permlink, 0 AS depth
        FROM ${T.comments} c
        WHERE c.parent_author = $${paperAuthorIdx} AND c.parent_permlink = $${paperPermlinkIdx}
          AND (c.json_metadata -> $${appTagIdx} ->> 'type') = 'comment'
          AND c.json_metadata ->> 'app' LIKE $${appLikeIdx}

        UNION ALL

        -- Recursive: replies to discussion comments
        SELECT
          c.author, c.permlink, c.body, c.created,
          c.parent_author, c.parent_permlink, ct.depth + 1
        FROM ${T.comments} c
        JOIN comment_tree ct ON c.parent_author = ct.author AND c.parent_permlink = ct.permlink
        WHERE (c.json_metadata -> $${appTagIdx} ->> 'type') = 'comment'
          AND c.json_metadata ->> 'app' LIKE $${appLikeIdx}
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
      WITH ${accredCte.sql},
      comment_tree AS (
        SELECT c.author, c.permlink, c.parent_author, c.parent_permlink, 0 AS depth
        FROM ${T.comments} c
        WHERE c.parent_author = $${paperAuthorIdx} AND c.parent_permlink = $${paperPermlinkIdx}
          AND (c.json_metadata -> $${appTagIdx} ->> 'type') = 'comment'
          AND c.json_metadata ->> 'app' LIKE $${appLikeIdx}
        UNION ALL
        SELECT c.author, c.permlink, c.parent_author, c.parent_permlink, ct.depth + 1
        FROM ${T.comments} c
        JOIN comment_tree ct ON c.parent_author = ct.author AND c.parent_permlink = ct.permlink
        WHERE (c.json_metadata -> $${appTagIdx} ->> 'type') = 'comment'
          AND c.json_metadata ->> 'app' LIKE $${appLikeIdx}
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

    const rows = dataResult.rows.map((r: Record<string, unknown>) => ({
      author: r.author,
      permlink: r.permlink,
      body: r.body,
      created: r.created,
      net_votes: r.accredited_votes as number,
      is_accredited: accreditedSet.has(r.author as string),
      author_reputation: reputationMap.get(r.author as string) ?? 0,
      parent_author: r.parent_author,
      parent_permlink: r.parent_permlink,
    }));

    return { rows, total };
  } catch (err) {
    logger.error({ err }, 'HAF comments query failed');
    return null;
  }
}

// ──────────────────────────────────────────────
// Hive API fallback
// ──────────────────────────────────────────────

function isPevoComment(meta: Record<string, unknown>): boolean {
  const appMeta = meta[config.appTag] as Record<string, unknown> | undefined;
  return appMeta?.type === 'comment' && typeof meta.app === 'string' && (meta.app as string).startsWith(`${config.appTag}/`);
}

async function fetchCommentsFromHiveApi(
  paperAuthor: string,
  paperPermlink: string,
  params: ReturnType<typeof parseCommentParams>,
) {
  const { limit, offset, accreditedOnly } = params;

  try {
    const allComments: Array<Record<string, unknown>> = [];

    async function fetchReplies(author: string, permlink: string, depth: number) {
      if (depth > 10) return; // safety limit for Hive API
      const replies: Array<Record<string, unknown>> = await hiveClient.database.call(
        'get_content_replies',
        [author, permlink],
      );
      for (const reply of replies) {
        const meta = parseMeta(reply.json_metadata);
        if (isPevoComment(meta)) {
          allComments.push(reply);
          await fetchReplies(reply.author as string, reply.permlink as string, depth + 1);
        }
      }
    }

    await fetchReplies(paperAuthor, paperPermlink, 0);

    const authors = [...new Set(allComments.map((c) => c.author as string))];
    const [accreditedSet, reputationMap] = await Promise.all([
      getAccreditedSet(authors),
      getReputationScores(authors),
    ]);

    let filtered = allComments;
    if (accreditedOnly) {
      filtered = allComments.filter((c) => accreditedSet.has(c.author as string));
    }

    const total = filtered.length;
    const paged = filtered.slice(offset, offset + limit);

    const rows = paged.map((c) => ({
      author: c.author,
      permlink: c.permlink,
      body: c.body,
      created: c.created,
      net_votes: (c.net_votes as number) ?? 0,
      is_accredited: accreditedSet.has(c.author as string),
      author_reputation: reputationMap.get(c.author as string) ?? 0,
      parent_author: c.parent_author,
      parent_permlink: c.parent_permlink,
    }));

    return { rows, total };
  } catch (err) {
    logger.error({ err }, 'Hive API comments query failed');
    return { rows: [], total: 0 };
  }
}

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink/comments
// ──────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;
  const params = parseCommentParams(req);

  // Verify paper exists
  if (isHafAvailable()) {
    const exists = await paperExistsInHaf(author, permlink);
    if (exists === false) {
      return sendError(res, 404, 'NOT_FOUND', 'Paper not found');
    }

    if (exists === true) {
      const cacheKey = `comments:${author}:${permlink}:p=${params.page}:l=${params.limit}:s=${params.sort}:o=${params.order}:ao=${params.accreditedOnly}`;
      const result = await hafCache.getOrSet(cacheKey, () =>
        fetchCommentsFromHaf(author, permlink, params),
      );
      if (result) {
        return sendOk(res, result.rows, { page: params.page, limit: params.limit, total: result.total });
      }
    }
  }

  // Hive API fallback — verify paper exists via get_content
  try {
    const post = await hiveClient.database.call('get_content', [author, permlink]);
    if (!post || !post.author || post.parent_permlink !== config.appTag) {
      return sendError(res, 404, 'NOT_FOUND', 'Paper not found');
    }
    const meta = parseMeta(post.json_metadata);
    if (!isPevoAnyPaper(meta)) {
      return sendError(res, 404, 'NOT_FOUND', 'Paper not found');
    }
  } catch (err) {
    logger.warn({ err }, 'Hive API paper existence check failed');
    return sendError(res, 404, 'NOT_FOUND', 'Paper not found');
  }

  const result = await fetchCommentsFromHiveApi(author, permlink, params);
  sendOk(res, result.rows, { page: params.page, limit: params.limit, total: result.total });
});

export default router;

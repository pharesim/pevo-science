import { Router, type Request, type Response } from 'express';
import { getPool, isHafAvailable } from '../db.js';
import { hiveClient } from '../hive.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { parseMeta, isPevoReview } from '../helpers.js';
import { getAccreditedSet } from '../accreditation.js';
import { getReputationScore } from '../reputation.js';
import { logger } from '../logger.js';
import { T, activeAccreditationsCte, accreditedVoteCount } from '../hafsql.js';

const router = Router();

// ──────────────────────────────────────────────
// GET /api/reviews/:author/:permlink
// ──────────────────────────────────────────────

function buildReviewDetail(
  post: Record<string, unknown>,
  meta: Record<string, unknown>,
  parentTitle: string,
) {
  const pevo = (meta[config.appTag] || {}) as Record<string, unknown>;
  const rating = pevo.rating as Record<string, number> | undefined;
  return {
    author: post.author,
    permlink: post.permlink,
    body: post.body,
    rating: rating || { methodology: 0, novelty: 0, clarity: 0, significance: 0 },
    is_anonymous: pevo.is_anonymous ?? false,
    reviewer_attestation_id: pevo.reviewer_attestation_id || null,
    paper: {
      author: post.parent_author,
      permlink: post.parent_permlink,
      title: parentTitle,
    },
    created: post.created,
    net_votes: post.net_votes,
    reviewer_reputation: 0,
    is_accredited: false,
  };
}

async function fetchReviewFromHaf(author: string, permlink: string) {
  const pool = getPool();
  if (!pool) return null;

  try {
    const accredCte = activeAccreditationsCte();
    const result = await pool.query(
      `${accredCte.sql}
       SELECT c.author, c.permlink, c.body, c.json_metadata,
              c.parent_author, c.parent_permlink, c.created,
              ${accreditedVoteCount('c.author', 'c.permlink')} AS net_votes
       FROM ${T.comments} c
       WHERE c.author = $${accredCte.nextIdx} AND c.permlink = $${accredCte.nextIdx + 1}`,
      [...accredCte.params, author, permlink],
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const meta = parseMeta(row.json_metadata);
    if (!isPevoReview(meta)) return null;

    // Fetch parent paper title
    const parentResult = await pool.query(
      `SELECT title FROM ${T.comments} WHERE author = $1 AND permlink = $2`,
      [row.parent_author, row.parent_permlink],
    );
    const parentTitle = parentResult.rows[0]?.title || '';

    return buildReviewDetail(row, meta, parentTitle);
  } catch (err) {
    logger.error({ err }, 'HAF review query failed');
    return null;
  }
}

async function fetchReviewFromHiveApi(author: string, permlink: string) {
  try {
    const post = await hiveClient.database.call('get_content', [author, permlink]);
    if (!post || !post.author) return null;

    const meta = parseMeta(post.json_metadata);
    if (!isPevoReview(meta)) return null;

    // Fetch parent paper for title
    let parentTitle = '';
    try {
      const parent = await hiveClient.database.call('get_content', [post.parent_author, post.parent_permlink]);
      parentTitle = parent?.title || '';
    } catch (err) { logger.warn({ err }, 'Failed to fetch parent paper title for review'); }

    return buildReviewDetail(post, meta, parentTitle);
  } catch (err) {
    logger.error({ err }, 'Hive API review query failed');
    return null;
  }
}

async function enrichReviewDetail(review: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reviewAuthor = review.author as string;
  const [accreditedSet, reputation] = await Promise.all([
    getAccreditedSet([reviewAuthor]),
    getReputationScore(reviewAuthor),
  ]);
  return {
    ...review,
    is_accredited: accreditedSet.has(reviewAuthor),
    reviewer_reputation: reputation.score,
  };
}

router.get('/:author/:permlink', async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;

  // Simple read: Hive API first (single comment + parent title)
  const hiveResult = await fetchReviewFromHiveApi(author, permlink);
  if (hiveResult) return sendOk(res, await enrichReviewDetail(hiveResult));

  // HAF fallback
  if (isHafAvailable()) {
    const hafResult = await fetchReviewFromHaf(author, permlink);
    if (hafResult) return sendOk(res, await enrichReviewDetail(hafResult));
  }

  sendError(res, 404, 'NOT_FOUND', 'Review not found');
});

export default router;

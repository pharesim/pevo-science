import { Router, type Request, type Response } from 'express';
import { getPool } from '../db.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { parseMeta, isPevoReview, pevoString } from '../helpers.js';
import { getAccreditedSet } from '../accreditation.js';
import { getReputationScore } from '../reputation.js';
import { logger } from '../logger.js';
import { T, activeAccreditationsCte, accreditedVoteCount, validReviewWhere, excludeSelfReviewWhere } from '../hafsql.js';

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
    reviewer_attestation_id: pevoString(pevo, 'reviewer_attestation_id'),
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
    // PEvO object-identity gate: a review is only a PEvO review if its author
    // is in `active_accreditations` OR equals `config.hiveAnonAccount`
    // (anon-proxy authoring on behalf of an accredited reviewer). Without
    // this clause an unaccredited Hive account broadcasting a review-shaped
    // comment would surface as a PEvO review. The `|| ''` fallback for an
    // unset HIVE_ANON_ACCOUNT is safe because Hive prohibits empty author
    // names, so `c.author = ''` never matches.
    // SQL-level gate: author must be accredited (or the anon proxy) AND the
    // row must satisfy validReviewWhere (type='review' + well-formed rating
    // object). The JS-side `isPevoReview` post-filter below is
    // defense-in-depth — keeping the two in sync is the parity invariant.
    //
    // Param-index counter pattern (instead of `accredCte.nextIdx + N`
    // arithmetic): every other call site in the codebase derives `$N`
    // refs via `paramIdx++` or literal `'$2'`/`'$3'` strings. Offset
    // arithmetic silently mis-binds if any bind between the lines is
    // added/removed — see the helper's docstring example for the
    // canonical shape. Adding `accreditedVoteCount(...)` as a column
    // here doesn't consume params (it expands to a correlated subquery
    // with no binds), so the counter only advances for actual `$N`
    // refs.
    let paramIdx = accredCte.nextIdx;
    const authorIdx = paramIdx++;
    const permlinkIdx = paramIdx++;
    const anonIdx = paramIdx++;
    const appTagIdx = paramIdx++;
    // INNER JOIN parent paper `p` so `excludeSelfReviewWhere` can read
    // `p.json_metadata -> authors[]` AND so the parent title comes back in
    // one round-trip instead of the prior two-query shape
    // (BACKEND-SELF-REVIEW-EXCLUSION round-1 hold #1). A review whose
    // parent isn't on HAF can't surface meaningfully via this endpoint
    // anyway; INNER JOIN matches the parity with `profile.ts:
    // fetchUserReviewsFromHaf`.
    //
    // The self-review predicate joins the validity gate at the SQL layer
    // so the single-doc endpoint 404s for a self-review for the same
    // reason listing surfaces hide it. Bypassing via direct URL is no
    // longer possible; display↔reputation parity now extends from the
    // listing layer through the single-doc fetch.
    const result = await pool.query(
      `${accredCte.sql}
       SELECT c.author, c.permlink, c.body, c.json_metadata,
              c.parent_author, c.parent_permlink, c.created,
              p.title AS paper_title,
              ${accreditedVoteCount('c.author', 'c.permlink')} AS net_votes
       FROM ${T.comments} c
       JOIN ${T.comments} p ON p.author = c.parent_author AND p.permlink = c.parent_permlink
       WHERE c.author = $${authorIdx} AND c.permlink = $${permlinkIdx}
         AND (c.author IN (SELECT account FROM active_accreditations) OR c.author = $${anonIdx})
         AND ${validReviewWhere({ commentAlias: 'c', appTagParam: `$${appTagIdx}` })}
         AND ${excludeSelfReviewWhere({ paperRowAlias: 'p', appTagParam: `$${appTagIdx}` })}`,
      [...accredCte.params, author, permlink, config.hiveAnonAccount || '', config.appTag],
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const meta = parseMeta(row.json_metadata);
    if (!isPevoReview(meta)) return null;

    const parentTitle = (row.paper_title as string) || '';

    return buildReviewDetail(row, meta, parentTitle);
  } catch (err) {
    logger.error({ err }, 'HAF review query failed');
    return null;
  }
}

async function enrichReviewDetail(review: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reviewAuthor = review.author as string;
  const [accreditedSet, reputation] = await Promise.all([
    getAccreditedSet([reviewAuthor]),
    getReputationScore(reviewAuthor),
  ]);
  // Symmetric chain pre-check: non-accredited reviewer shows score 0 even if
  // a stale batch entry survives in Redis (per BACKEND-REPUTATION-SSOT
  // direction-of-truth: chain is SSoT, batch map is a perf cache).
  const isAccredited = accreditedSet.has(reviewAuthor);
  return {
    ...review,
    is_accredited: isAccredited,
    reviewer_reputation: isAccredited ? reputation.score : 0,
  };
}

router.get('/:author/:permlink', async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;

  const hafResult = await fetchReviewFromHaf(author, permlink);
  if (hafResult) return sendOk(res, await enrichReviewDetail(hafResult));

  sendError(res, 404, 'NOT_FOUND', 'Review not found');
});

export default router;

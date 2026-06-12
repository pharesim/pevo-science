import { Router, type Request, type Response } from 'express';
import { getPool, HafQueryError, isRetriableHafError } from '../db.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { parseMeta, isPevoReview, pevoString } from '../helpers.js';
import { getAccreditedSet } from '../accreditation.js';
import { getReputationScore } from '../reputation.js';
import { logger } from '../logger.js';
import { T, buildRecursiveWith, activeAccreditationsCteBody, authorshipClaimsCteBody, consentStackCteBody, accreditedVoteCount, validReviewWhere, excludeSelfReviewWhere, excludeClaimedSelfWhere, excludeConsentedSelfWhere, validPevoPaperWhere } from '../hafsql.js';

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
    // authorship_claims scoped to the review author (the only claimer the
    // excludeClaimedSelfWhere gate below ever correlates on this surface), so
    // the embedded chain walk is bounded by that one account's claim activity
    // instead of materializing the full claim history per single-review
    // fetch. The consent stack is scoped the same way ({signer}-seeded walk +
    // {signers}-narrowed resolution) for the excludeConsentedSelfWhere
    // sibling. Lets the fetch 404 a credited account's self-review (accepted
    // claimer or Route-2 consented co-author), matching the
    // listing/profile/search/stats surfaces.
    const accredCte = buildRecursiveWith(
      1,
      activeAccreditationsCteBody,
      (idx) => authorshipClaimsCteBody(idx, { claimer: author }),
      (idx) => consentStackCteBody(idx, { signer: author }),
    );
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
    const bridgeIdx = paramIdx++;
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
    //
    // Display↔reputation parity (cross-surface): without validPevoPaperWhere
    // on `p`, a `pevo.review`-shaped reply to a non-paper Hive parent (a
    // peakd blog post, a non-paper comment) would surface here while
    // reputation correctly excludes it via the user_reviews CTE that
    // composes validPevoPaperWhere. The single-doc endpoint is directly
    // URL-addressable, so the gate must compose here too. See
    // `agents/docs/solutions/conventions/cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md`.
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
         AND ${validPevoPaperWhere({ commentAlias: 'p', appTagParam: `$${appTagIdx}`, bridgeAccountParam: `$${bridgeIdx}`, source: 'all' })}
         AND ${excludeSelfReviewWhere({ paperRowAlias: 'p', appTagParam: `$${appTagIdx}` })}
         AND ${excludeClaimedSelfWhere({ authorExpr: 'c.author', paperAuthorExpr: 'p.author', paperPermlinkExpr: 'p.permlink' })}
         AND ${excludeConsentedSelfWhere({ authorExpr: 'c.author', paperAuthorExpr: 'p.author', paperPermlinkExpr: 'p.permlink' })}`,
      [...accredCte.params, author, permlink, config.hiveAnonAccount || '', config.appTag, config.hiveBridgeAccount || ''],
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const meta = parseMeta(row.json_metadata);
    if (!isPevoReview(meta)) return null;

    const parentTitle = (row.paper_title as string) || '';

    return buildReviewDetail(row, meta, parentTitle);
  } catch (err) {
    // Loud-fail on HAF query failure so the route handler can translate to
    // `503 SERVICE_UNAVAILABLE` with `details.retriable: true` rather than
    // collapsing the failure to `null → 404 NOT_FOUND` (which made HAF
    // outage indistinguishable from "review does not exist"). Mirrors the
    // sibling pattern at `fetchPaperDetailFromHaf` in `routes/papers.ts`.
    logger.error({ err }, 'HAF review query failed');
    throw new HafQueryError('fetchReviewFromHaf', { cause: err });
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

  try {
    const hafResult = await fetchReviewFromHaf(author, permlink);
    if (hafResult) return sendOk(res, await enrichReviewDetail(hafResult));

    sendError(res, 404, 'NOT_FOUND', 'Review not found');
  } catch (err) {
    if (err instanceof HafQueryError && isRetriableHafError(err)) {
      // Cause-discriminated retriable envelope (see `isRetriableHafError`
      // in `db.ts`). Deterministic pg failures fall through to the
      // central 500 so SPA retry doesn't loop a dead query.
      return sendError(
        res,
        503,
        'SERVICE_UNAVAILABLE',
        'Review temporarily unavailable. Please retry shortly.',
        { retriable: true },
      );
    }
    throw err;
  }
});

export default router;

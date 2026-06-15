import crypto from 'crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getPool, HafQueryError, isRetriableHafError } from '../db.js';
import { broadcastAdminCustomJson } from '../hive.js';
import { handleBroadcastError } from '../lib/broadcast-error.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import {
  parseMeta,
  isPevoAnyPaper,
  isPevoBridgePaper,
  parsePageLimit,
  parseSort,
  parseOrder,
  extractAbstract,
  pevoString,
  pevoStringArray,
  safePevoMeta,
  type SortField,
} from '../helpers.js';
import {
  makeHeadAuthorsMemo,
  findCanonicalRoot,
  resolveContinuationChain,
  reconstructVersionsFromHaf,
  type HeadAuthorsMemo,
  type PaperVersionEntry,
} from '../lib/chain-walkers.js';
import {
  resolveChainCumulativeAuthors,
  enrichRowsWithChainAuthors,
  type ChainCumulativeAuthorsResult,
} from '../lib/chain-cumulative.js';
import { getAccreditedSet, getAllAccreditedAccounts, getAccreditedOrcidsByAccount, getAccreditedNamesByAccount, getAllEverAccreditedOrcidsWithStatus } from '../accreditation.js';
import { getReputationScore, getReputationScores } from '../reputation.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { validatedCid } from '../lib/ipfs-validation.js';
import {
  normalizeHiveAccount,
  applyAuthorSupersession,
} from '../lib/author-supersession.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { rateLimit, byAccount } from '../middleware/rateLimit.js';
import { HIVE_ACCOUNT_NAME_REGEX } from '../lib/hive-account-name.js';
import { HIVE_PERMLINK_FORMAT_REGEX, HIVE_PERMLINK_MAX_LEN } from '../lib/hive-permlink.js';
import { LINE_TERMINATORS } from '../lib/line-terminators.js';
import { paperDisciplineField } from '../types/disciplines.js';
import type { PaperAuthor } from '../types/domain.js';
import {
  T,
  accreditedVoteCount,
  activeAccreditationsCteBody,
  authorshipClaimsCteBody,
  authorsWithSupersessionSelect,
  consentChainCteBody,
  consentedAuthorsCteBody,
  consentStackCteBody,
  retractedPapersCteBody,
  buildWith, buildRecursiveWith,
  validPevoPaperWhere,
  validReviewWhere,
  excludeSelfReviewWhere,
  excludeClaimedSelfWhere,
  excludeConsentedSelfWhere,
} from '../hafsql.js';
import { validateDisciplineFilter } from '../types/disciplines.js';

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
 *
 * Exported so the cross-channel credited self-vote exclusion (the
 * `creditedSet` skip that must hold across BOTH the native-vote and revote
 * channels) can be exercised directly against a controlled
 * (native + revote + credited-set) rowset.
 */
export async function batchResolveVotes(
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

  // Credited accounts (accepted claimers ∪ Route-1/2 consented authors) must
  // not have their self-vote on the paper they are credited for counted
  // toward the displayed net_votes — mirrors the reputation cycle's
  // accepted_claims + consented_authors gates and the
  // excludeClaimedSelfWhere/excludeConsentedSelfWhere pair on the review
  // surfaces. Both stacks are scoped to the page's paper-key set so the
  // materializations (and their embedded chain walks) are bounded by page
  // size, not total op history — a flood of cheap pending claims or consent
  // ops on unrelated papers cannot inflate this batch's cost.
  const claimsCte = buildRecursiveWith(
    1,
    activeAccreditationsCteBody,
    (idx) => authorshipClaimsCteBody(idx, { papers }),
    (idx) => consentStackCteBody(idx, { papers }),
  );

  const [nativeResult, revoteResult, claimsResult] = await Promise.all([
    // Batch native votes: latest per voter per paper, accredited only, excluding self-votes
    pool.query(
      `SELECT DISTINCT ON (v.author, v.permlink, v.voter)
              v.author, v.permlink, v.voter, v.weight, v.block_num
       FROM ${T.voteOps} v
       WHERE (v.author, v.permlink) IN (${pairValues.join(', ')})
         AND v.voter = ANY(${accreditedParam}::text[])
         AND v.voter != v.author
       -- Same-block tie-breaker: v.id (operation_vote_view has no trx_in_block;
       -- v.id is the monotonic HAF op id) per
       -- agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md Rule 2
       ORDER BY v.author, v.permlink, v.voter, v.block_num DESC, v.id DESC`,
      pairParams,
    ),
    // All revotes for APP_TAG. The `block_num >= $genesis` floor was dropped
    // (matching the 285e7c14 fix on `activeAccreditationsCteBody`): combining
    // `custom_id = $appTag` with `block_num >= $genesis` triggers a BitmapAnd
    // plan that scans tens of millions of operation rows on
    // `hive_operations_block_num_id_idx`. `custom_id` alone is selective enough
    // on Mahdi's HAF (the pevotest namespace has on the order of dozens of
    // revote rows); pre-genesis pevotest custom_jsons do not exist by
    // construction, so the floor was redundant and plan-toxic.
    pool.query(
      `SELECT cj.json::jsonb ->> 'author' AS author,
              cj.json::jsonb ->> 'permlink' AS permlink,
              cj.required_posting_auths ->> 0 AS voter,
              -- {1,9} bounds the digit count for overflow safety: an unbounded match admits a value that overflows ::int and aborts the whole query (max Hive vote weight is 10000).
              CASE WHEN (cj.json::jsonb ->> 'weight') ~ '^-?[0-9]{1,9}$' THEN (cj.json::jsonb ->> 'weight')::int END AS weight,
              cj.block_num
       FROM ${T.customJson} cj
       WHERE cj.custom_id = $1
         AND cj.json::jsonb ->> 'action' = 'revote'`,
      [config.appTag],
    ),
    // Credited accounts per chain post: accepted authorship claims UNION the
    // resolved consented authors (Routes 1/2), one leg for the whole skip
    // set. Decoupled from listing availability: votes are this surface's
    // core data, but the credited-self-vote exclusion is a display-parity
    // refinement whose authoritative enforcement lives in the reputation
    // cycle. The worst-case tail here is the HAF pool's connection-level
    // `SET statement_timeout = 30000` (db.ts), so a credited-set failure
    // costs at most ~30s before this leg settles and degrades to un-excluded
    // displayed votes for one volatile-cache window instead of rejecting the
    // whole listing.
    pool.query(
      `${claimsCte.sql}
       SELECT claimer, paper_author, paper_permlink FROM authorship_claims WHERE status = 'accepted'
       UNION
       SELECT account AS claimer, root_author AS paper_author, root_permlink AS paper_permlink FROM consented_authors`,
      claimsCte.params,
    ).catch((err: unknown) => {
      logger.warn({ err, paper_count: papers.length }, 'batchResolveVotes credited-set query failed; serving votes without the credited-self-vote exclusion');
      return null;
    }),
  ]);

  // (paper_author/paper_permlink::account) keys whose self-vote is dropped.
  const creditedSet = new Set<string>();
  for (const r of claimsResult?.rows ?? []) {
    creditedSet.add(`${r.paper_author}/${r.paper_permlink}::${r.claimer}`);
  }

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
      // Drop a credited account's (accepted claimer or Route-1/2 consented
      // author) self-vote on the paper they are credited for.
      if (creditedSet.has(`${key}::${voter}`)) continue;
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

// skipFailedRequests: a HAF outage emits 503 with `details.retriable: true`
// and the SPA retries on it. Without `skipFailed`, each retry consumes one
// of the legitimate user's 5 slots/hour, and a single outage event burns
// the entire hour budget — when HAF recovers, the user is locked out of
// retract until the rolling-window head ages out. The middleware refunds
// the slot on every >= 400 response (4xx and 5xx). On /retract this is
// safe: the 422 "already retracted" and 404 "paper not found" paths only
// fire for a verified-signature request matching `username === URL author`,
// so the per-account refund is bounded by the attacker's own paper set
// (no unbounded probe surface). The 502 BROADCAST_FAILED and 504
// BROADCAST_TIMEOUT paths carry `verify_before_retry: true` so the SPA
// doesn't auto-retry on them.
const retractLimiter = rateLimit({
  name: 'paper-retract',
  windowMs: 3_600_000,
  max: 5,
  keyFn: byAccount,
  skipFailedRequests: true,
});

/** URL-param shape validator for POST /api/papers/:author/:permlink/retract.
 *  Mounted BEFORE both `verifyHiveSignature` and `retractLimiter` so a spray of
 *  structurally-invalid slugs is rejected without paying ECDSA recovery, the
 *  Postgres point-lookup on `accounts.sessions_invalidated_at`, or the HAF
 *  walker (`fetchPaperDetailFromHaf` runs the forward continuation-chain
 *  resolver, bounded by `hafWalkerWallClockMs`). The route is URL-keyed (the
 *  target is the slug pair, not the authenticated principal), so it differs
 *  from the body-shape validators on `/upgrade`, `/fresh-auth`, `/session-auth`
 *  where the limiter is `byAccount`-keyed and the validator must run AFTER
 *  `verifyHiveSignature` to attribute the error to an authenticated user.
 *  Permlinks are derived from post titles on Hive, so a slug outside the
 *  canonical character class cannot resolve to a real paper — rejecting
 *  up-front is safe. */
function validateRetractParams(req: Request, res: Response, next: NextFunction): void {
  const author = req.params.author;
  const permlink = req.params.permlink;
  if (typeof author !== 'string' || !HIVE_ACCOUNT_NAME_REGEX.test(author)) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Invalid author format');
    return;
  }
  if (
    typeof permlink !== 'string' ||
    permlink.length === 0 ||
    permlink.length > HIVE_PERMLINK_MAX_LEN ||
    !HIVE_PERMLINK_FORMAT_REGEX.test(permlink)
  ) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Invalid permlink format');
    return;
  }
  next();
}
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
  // `discipline` is pre-validated + lowercased by the route handler. Bound
  // as-is into `LOWER(column) = $N`; the `if (discipline)` gate below
  // suppresses the WHERE clause when absent.
  const keyword = req.query.keyword as string | undefined;
  const author = req.query.author as string | undefined;
  const language = req.query.language as string | undefined;
  const includeRetracted = req.query.include_retracted === 'true'; // default false
  const source = req.query.source as string | undefined; // 'native', 'bridge', or omit for both

  // Build CTEs with parameterized appTag. authorship_claims lets the
  // review-agg LATERAL drop a credited claimer's self-review from the
  // displayed avg_rating / review_count, and the consent stack (consent_seed
  // → chain walk → consented_authors) does the same for Route-2 consented
  // co-authors, mirroring the reputation cycle's accepted_claims +
  // consented_authors gates. Both stay UNSCOPED here by design: the page's
  // paper set is computed by this same statement (WHERE + ORDER BY + LIMIT),
  // so no paper-key scope can be bound up front. The accepted cost is ONE
  // resolution of each per listing query — the MATERIALIZED fences pin that
  // (the claims walk is seeded by claims_base, the consent walk by
  // consent_seed, so each is bounded by its op volume, and the per-row
  // LATERAL reads the fenced results instead of re-resolving per rescan).
  // active_accreditations is listed first because consumers reference it
  // earlier in the WITH chain.
  const cte = buildRecursiveWith(
    1,
    activeAccreditationsCteBody,
    retractedPapersCteBody,
    (idx) => authorshipClaimsCteBody(idx),
    (idx) => consentStackCteBody(idx),
  );
  let paramIdx = cte.nextIdx;
  const cteParams: unknown[] = [...cte.params];

  // appTag params for WHERE conditions
  const appTagParam = `$${paramIdx++}`;
  const appLikeParam = `$${paramIdx++}`;
  const bridgeAccountParam = `$${paramIdx++}`;
  cteParams.push(config.appTag, `${config.appTag}/%`, config.hiveBridgeAccount);

  const paperSource: 'native' | 'bridge' | 'all' =
    source === 'native' ? 'native' : source === 'bridge' ? 'bridge' : 'all';
  const typeFilter = validPevoPaperWhere({ commentAlias: 'c', appTagParam, bridgeAccountParam, source: paperSource });

  const conditions: string[] = [
    `c.parent_permlink = ${appTagParam}`,
    "c.parent_author = ''",
    typeFilter,
    `c.json_metadata ->> 'app' LIKE ${appLikeParam}`,
  ];
  const filterParams: unknown[] = [];

  if (discipline) {
    // LOWER() on both sides so case-variant on-chain values match.
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
  // Accreditation gate is unconditional. Bridge papers are posted by the
  // system bridge account, not the original author, so they are exempt from
  // the accredited-only filter — but ONLY when authored by
  // config.hiveBridgeAccount. The bridge arm of validPevoPaperWhere() pins
  // the author; we reuse it as the OR-arm here to share the predicate shape.
  // The legacy `?accredited_only=false` opt-out is silently ignored — Express
  // convention for unknown query params (api-contracts/common.md).
  const bridgeArm = validPevoPaperWhere({ commentAlias: 'c', appTagParam, bridgeAccountParam, source: 'bridge' });
  conditions.push(`(c.author IN (SELECT account FROM active_accreditations) OR ${bridgeArm})`);
  if (!includeRetracted) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM retracted_papers rp WHERE rp.author = c.author AND rp.permlink = c.permlink)`);
  }
  // E3: Hide continuation posts — they are revisions of existing papers, not separate papers
  conditions.push(`(c.json_metadata -> ${appTagParam} -> 'continues') IS NULL`);

  const where = conditions.join(' AND ');

  // anonParam is the pevo.anon account name, referenced only by the rev_agg
  // review-aggregate LATERAL (its accreditation-OR-anon gate on review authors),
  // never in the WHERE clause. The citation arm uses the paper_citation_counts
  // CTE and does not reference anonParam.
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

  // Review count + average review rating from ONE correlated scan of the
  // accredited-review row set. The two aggregates previously lived in two
  // independent correlated subqueries (`review_count` and `avg_rating`) that
  // each re-scanned the SAME `hafsql.comments` rows under the SAME predicate
  // (parent-pair match + validReviewWhere + excludeSelfReviewWhere +
  // accreditation/anon gate) — doubling the per-page-row review-table scans.
  // A single LATERAL subquery returns both, so a 20-row page issues one
  // accredited-review scan per row instead of two.
  //
  // validReviewWhere supplies the type+rating-shape gate (display↔reputation
  // parity); accreditation stays inline as it does at every review-aggregating
  // site (see validReviewWhere docstring). excludeSelfReviewWhere drops
  // self-reviews — the outer paper row `c` IS the paper, so the helper
  // composes against it directly without a JOIN. The rating-shape regex inside
  // validReviewWhere guarantees each dimension is `[1-5]` text, so the
  // `::float` casts cannot crash on attacker-controlled JSON. count(*) over the
  // gated rows yields the review count; round(avg(...),1) over the per-row
  // four-dimension mean yields the average; COALESCE degrades each to 0 when
  // no review row matches (count(*)=0, avg over zero rows = NULL).
  const reviewAggSelect = `COALESCE(rev_agg.review_count, 0) AS review_count,
    COALESCE(rev_agg.avg_rating, 0) AS avg_rating`;
  const reviewAggLateral = `LEFT JOIN LATERAL (
    SELECT
      count(*)::int AS review_count,
      round(avg(
        (
          (r.json_metadata -> ${appTagParam} -> 'rating' ->> 'methodology')::float +
          (r.json_metadata -> ${appTagParam} -> 'rating' ->> 'novelty')::float +
          (r.json_metadata -> ${appTagParam} -> 'rating' ->> 'clarity')::float +
          (r.json_metadata -> ${appTagParam} -> 'rating' ->> 'significance')::float
        ) / 4.0
      )::numeric, 1)::float AS avg_rating
    FROM ${T.comments} r
    WHERE r.parent_author = c.author AND r.parent_permlink = c.permlink
      AND ${validReviewWhere({ commentAlias: 'r', appTagParam })}
      AND ${excludeSelfReviewWhere({ commentAlias: 'r', paperRowAlias: 'c', appTagParam })}
      AND ${excludeClaimedSelfWhere({ authorExpr: 'r.author', paperAuthorExpr: 'c.author', paperPermlinkExpr: 'c.permlink' })}
      AND ${excludeConsentedSelfWhere({ authorExpr: 'r.author', paperAuthorExpr: 'c.author', paperPermlinkExpr: 'c.permlink' })}
      AND (EXISTS (SELECT 1 FROM active_accreditations aa WHERE aa.account = r.author) OR r.author = ${anonParam})
  ) rev_agg ON true`;

  // Citation count: accredited papers that cite this one (native papers only;
  // bridge papers use Semantic Scholar). Sourced from the
  // `paper_citation_counts` CTE (appended to the WITH clause in the data query
  // below) and LEFT JOINed onto the page row, NOT a per-row correlated
  // containment subquery. The prior shape ran one full PEvO-paper scan per
  // output row (N scans per cold-cache page), each constructing a fresh
  // `jsonb_build_array(jsonb_build_object(...))` from the outer row that
  // defeated constant folding and could not use any index. The CTE unnests
  // every accredited paper's `pevo.citations` ONCE and groups by the cited
  // (author, permlink). Empty-citation papers have no CTE row, so the LEFT JOIN
  // yields NULL and COALESCE degrades to 0.
  const citationCountSelect = `COALESCE(pcc.citation_count, 0) AS citation_count`;

  try {
    const limitParam = `$${paramIdx++}`;
    const offsetParam = `$${paramIdx++}`;

    // Single-pass count+data via `count(*) OVER ()`: the window function
    // computes total across all rows matching WHERE in the same scan that
    // materializes the page, eliminating the prior parallel count query
    // (and its duplicate `active_accreditations + retracted_papers` CTE
    // materialization + `accred_ranked` ROW_NUMBER scan). Empty-page case
    // returns zero rows so `dataResult.rows[0]?.total ?? 0` degrades to 0.
    // Matches the shape established at `fetchAccreditationsFromHaf`.
    const dataResult = await pool.query(
      `${cte.sql},
       paper_citation_counts AS (
         -- Inverted citation aggregation (replaces a per-row correlated @>
         -- containment): unnest every accredited PEvO paper's pevo.citations
         -- ONCE and group by the cited (author, permlink), so a page render
         -- scans the corpus a single time instead of once per page row. The
         -- jsonb_typeof array guard is a cascade-fail defense — a chain post
         -- broadcasting a non-array pevo.citations (null, string, object) would
         -- otherwise raise "cannot extract elements from a scalar" and fail the
         -- whole listing (per the pg-jsonb-null-vs-sql-null convention). The
         -- inner DISTINCT collapses a citation listed twice within one citing
         -- paper so it counts the citing paper once, matching the prior @>
         -- containment (which counted citing papers, not citation elements).
         -- The per-element jsonb_typeof(cit -> 'author'/'permlink') = 'string'
         -- guards preserve the old @> containment's JSONB-type sensitivity: the
         -- ->> extraction text-coerces a numeric or boolean citation value, so a
         -- citation {"author":"victim","permlink":123} would otherwise count
         -- against a real paper victim/123 (all-digit permlinks are valid on
         -- Hive) where the type-sensitive @> counted 0. The string-type guards
         -- subsume the prior IS NOT NULL element checks (a string is non-null).
         SELECT cited_author, cited_permlink, count(*)::int AS citation_count
         FROM (
           SELECT DISTINCT
             ci.author AS citing_author,
             ci.permlink AS citing_permlink,
             cit ->> 'author' AS cited_author,
             cit ->> 'permlink' AS cited_permlink
           FROM ${T.comments} ci
           JOIN active_accreditations aa ON aa.account = ci.author
           CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(ci.json_metadata -> ${appTagParam} -> 'citations') = 'array'
               THEN ci.json_metadata -> ${appTagParam} -> 'citations'
               ELSE '[]'::jsonb
             END
           ) cit
           WHERE ci.parent_author = '' AND ci.parent_permlink = ${appTagParam}
             AND (ci.json_metadata -> ${appTagParam} ->> 'type') = 'paper'
             AND ci.json_metadata ->> 'app' LIKE ${appLikeParam}
             AND jsonb_typeof(cit) = 'object'
             AND jsonb_typeof(cit -> 'author') = 'string'
             AND jsonb_typeof(cit -> 'permlink') = 'string'
         ) deduped
         GROUP BY cited_author, cited_permlink
       )
       SELECT
        c.author,
        c.permlink,
        c.title,
        LEFT(c.body, 300) AS abstract,
        c.json_metadata,
        c.created,
        ${voteSelect},
        ${reviewAggSelect},
        ${citationCountSelect},
        ${authorsWithSupersessionSelect('c', appTagParam, { includeAffiliation: false })} AS authors_with_supersession,
        0 AS author_reputation,
        count(*) OVER ()::int AS total
      FROM ${T.comments} c
      LEFT JOIN paper_citation_counts pcc ON pcc.cited_author = c.author AND pcc.cited_permlink = c.permlink
      ${reviewAggLateral}
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
      [...dataParams, limit, offset],
    );

    const total = dataResult.rows[0]?.total ?? 0;
    const authors = dataResult.rows.map((r: Record<string, unknown>) => r.author as string);

    // Use batch reputation scores only (no on-demand HAF computation).
    // Returns 0 for users not yet in the batch — profile page has full scores.
    const paperKeys = dataResult.rows.map((r: Record<string, unknown>) => ({
      author: r.author as string,
      permlink: r.permlink as string,
    }));

    // Parallel: batch reputation + per-row accredited set + full-accredited
    // set + resolved votes + accreditation ORCID maps (used by the
    // cumulative-authors helper for per-row enrichment). `batchResolveVotes`
    // needs `allAccreditedArr`, so it chains on `getAllAccreditedAccounts`
    // within the same Promise.all — total cold-cache latency is bounded by
    // the slowest sibling rather than serialized fetches.
    const allAccreditedPromise = getAllAccreditedAccounts();
    const [batchScores, accreditedSet, voteData, allAccredited, accreditedOrcidsByAccount, accreditationOrcidStatus, accreditedNamesByAccount] = await Promise.all([
      getReputationScores(authors),
      getAccreditedSet(authors),
      allAccreditedPromise.then(set => batchResolveVotes(pool, paperKeys, [...set])),
      allAccreditedPromise,
      getAccreditedOrcidsByAccount(),
      getAllEverAccreditedOrcidsWithStatus(),
      getAccreditedNamesByAccount(),
    ]);

    // Cross-surface cumulative-union enrichment: for each row, fetch the
    // chain-level cumulative `authors` + `accredited_authors` so multi-link
    // papers carry the same dropped-author-preserving projection the detail
    // surface uses. Shared with the profile surface via
    // `enrichRowsWithChainAuthors`. Per-root Redis cache (30 min) absorbs warm
    // pages; cold pages walk in parallel via `Promise.all`. `is_accredited`
    // stays row-author-scoped (singular bool used for filter/sort).
    //
    // Wall-clock budget: each per-row helper threads the same `AbortSignal`
    // bounded by `config.hafWalkerWallClockMs`. The signal stops NEW queries
    // from being dispatched once the budget fires; it does NOT cancel an
    // in-flight `pool.query` — pg v8.x has no `AbortSignal` integration, so
    // the last query a row issued runs to PostgreSQL's `statement_timeout`
    // (30s). Real per-row worst case = `hafWalkerWallClockMs` +
    // `statement_timeout`; `Promise.all` parallelises across rows so the page
    // is bounded by the slowest row's sum, not their total. Mirrors the
    // budget pattern in `fetchPaperDetailFromHaf`, the canonical-root walker,
    // and the `/retract` handler.
    const enrichmentAbort = new AbortController();
    const enrichmentBudget = setTimeout(() => enrichmentAbort.abort(), config.hafWalkerWallClockMs);
    let chainAuthorsByKey: Map<string, ChainCumulativeAuthorsResult>;
    try {
      chainAuthorsByKey = await enrichRowsWithChainAuthors(
        dataResult.rows.map((r: Record<string, unknown>) => ({
          author: r.author as string,
          permlink: r.permlink as string,
        })),
        {
          accreditedAccounts: allAccredited,
          accreditedOrcids: accreditedOrcidsByAccount,
          accreditationOrcidStatus,
          accreditedNames: accreditedNamesByAccount,
          signal: enrichmentAbort.signal,
          logLabel: 'chain cumulative authors enrichment failed',
        },
      );
    } finally {
      clearTimeout(enrichmentBudget);
    }

    const rows = dataResult.rows.map((r: Record<string, unknown>) => {
      const meta = parseMeta(r.json_metadata);
      const pevo = safePevoMeta(meta);
      // Supersession-aware authors from SQL (canonical ORCID resolution,
      // per `hive-schemas.md` § 1.1).
      // The SQL helper LEFT JOINs each author against `active_accreditations`
      // in a single query so the per-author lookup doesn't multiply by
      // result-set size. The `pevoAuthors` raw projection below is kept for
      // the `accredited_authors` filter (which only needs the hive list)
      // and the `is_accredited` check.
      const authorsWithSupersession = Array.isArray(r.authors_with_supersession)
        ? (r.authors_with_supersession as Array<Record<string, unknown>>)
        : [];
      const pevoAuthors: Array<{ hive?: string }> = (pevo.authors || []) as Array<{ hive?: string }>;
      const voteKey = `${r.author}/${r.permlink}`;
      const resolved = voteData.get(voteKey);
      // Bridge identity must be author-pinned. isPevoBridgePaper(meta, author)
      // checks both the metadata type AND author === config.hiveBridgeAccount;
      // the SQL gate already enforces this, so this JS-level check is
      // defense-in-depth for any future call path that bypasses the gate.
      const isBridge = isPevoBridgePaper(meta, r.author as string);
      // Cumulative-union takeover: when `enrichRowsWithChainAuthors` produced a
      // usable result (non-null, non-empty), it is in the map keyed by
      // `author/permlink` with `affiliation` already stripped, so use it for
      // `authors` + `accredited_authors` so multi-link papers reflect the union
      // across chain posts. A missing map entry (chain walk failed, HAF
      // unreachable, empty cumulative) means keep the head-meta projection —
      // same shape as the pre-helper behavior. The takeover gate (`length > 0`)
      // and the `affiliation` strip both live inside the shared helper so the
      // listing and profile surfaces stay in lockstep; the detail surface does
      // not use the helper, preserving its legitimate use of `affiliation` on
      // `PaperDetail.authors[]`.
      const cumulative = chainAuthorsByKey.get(`${r.author}/${r.permlink}`) ?? null;
      const headAccreditedAuthors = pevoAuthors
        .map((a) => normalizeHiveAccount(a.hive))
        .filter((hive): hive is string => hive !== null && allAccredited.has(hive));
      const cumulativeAuthors = cumulative ? cumulative.authors : null;
      return {
        author: r.author,
        permlink: r.permlink,
        title: r.title,
        abstract: r.abstract,
        discipline: paperDisciplineField(pevo.discipline),
        keywords: pevoStringArray(pevo, 'keywords'),
        authors: cumulativeAuthors ?? authorsWithSupersession,
        ipfs_cid: validatedCid(pevoString(pevo, 'ipfs_cid'), {
          author: r.author as string,
          permlink: r.permlink as string,
        }),
        created: r.created,
        net_votes: resolved?.net_votes ?? (r.net_votes as number),
        vote_strength: resolved?.vote_strength ?? null,
        review_count: (r.review_count as number) ?? 0,
        avg_rating: (r.avg_rating as number) ?? 0,
        citation_count: (r.citation_count as number) ?? 0,
        // is_accredited is the row author's accreditation; cumulative-union
        // extends `accredited_authors[]` (the multi-author display set) but
        // is_accredited remains row-author-scoped (the singular bool used
        // for listing filter / sort).
        is_accredited: accreditedSet.has(r.author as string),
        author_reputation: accreditedSet.has(r.author as string)
          ? (batchScores.get(r.author as string) ?? 0)
          : 0,
        accredited_authors: cumulative ? cumulative.accredited_authors : headAccreditedAuthors,
        source_type: isBridge
          ? ((pevo.source as Record<string, unknown>)?.type as 'arxiv' | 'crossref') || 'arxiv'
          : 'native',
        doi: isBridge
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
    // Intentional swallow-to-null: listing contract serves [] on outage;
    // outage indistinguishable from "no papers match this filter" is the
    // accepted cost for listings. Route maps null → 200 [] at the
    // envelope layer (GET `/`). Sibling-resource detail surfaces
    // (`fetchPaperDetailFromHaf`) loud-fail with `HafQueryError` because
    // a single-resource lookup CAN distinguish outage from "no row".
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
  // Cache key uses `discipline ?? ''` so absent/invalid coalesces to the
  // empty fragment `d=`, while the SQL gate uses `discipline ?? undefined`
  // so the `if (discipline)` predicate suppresses the WHERE clause entirely.
  // Same value, two coalesce shapes, on purpose.
  const filterResult = validateDisciplineFilter(req.query.discipline);
  if (filterResult && !filterResult.ok) {
    return sendError(res, 400, 'BAD_REQUEST', filterResult.message);
  }
  const discipline: string | null = filterResult?.ok ? filterResult.value : null;
  const keyword = req.query.keyword || '';
  const author = req.query.author || '';
  const language = req.query.language || '';
  const includeRetracted = req.query.include_retracted === 'true';
  const source = req.query.source || '';
  // Sibling fields (keyword, author, language, source) flow in unvalidated;
  // a `:` in any of them collides with the delimiter and lets a crafted
  // `?keyword=:a=alice` poison-cache against `?author=:a=alice`. sha256-wrap
  // the raw fragments so the namespace is collision-stable. Mirrors
  // search.ts.
  const rawKey = `p=${page}:l=${limit}:s=${sort}:o=${order}:d=${discipline ?? ''}:k=${keyword}:a=${author}:lang=${language}:ir=${includeRetracted}:src=${source}`;
  const cacheKey = `papers:${crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 32)}`;
  const result = await hafCache.getOrSetSWR(cacheKey, () => fetchPapersFromHaf(req, discipline ?? undefined));
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

async function fetchPaperDetailFromHaf(
  author: string,
  permlink: string,
  memo?: HeadAuthorsMemo,
  signal?: AbortSignal,
) {
  const pool = getPool();
  if (!pool) return null;

  try {
    // Fast path: fetch paper content + versions + retraction only.
    // Accreditation-dependent data (votes, reviews, citations) is loaded
    // lazily via the /enrichment endpoint.
    //
    // The WHERE clause uses validPevoPaperWhere() so a spoofed bridge paper
    // (an unaccredited author posting type=bridge_paper) cannot reach the
    // post-fetch isPevoAnyPaper(meta, author) check — bridge identity is
    // enforced at the SQL layer for defense in depth.
    //
    // Wraps the paper SELECT with `activeAccreditationsCteBody` so the
    // `authorsWithSupersessionSelect` projection (canonical ORCID
    // resolution, per `hive-schemas.md` § 1.1)
    // can LEFT JOIN per-author against the `active_accreditations` CTE
    // in-query. Param layout: $1=author, $2=permlink, $3=bridgeAccount,
    // $4=appTag (CTE), $5=authorities (CTE), $6=genesis (CTE). The
    // author+permlink positions stay at $1+$2 to preserve the responder
    // contract with existing tests; the CTE params anchor at $4 via
    // `activeAccreditationsCteBody(4)`. `appTag` ($4) is reused for
    // `parent_permlink`, the detailWhere helper, and the
    // authors-projection's JSON path — same value, single bind position.
    const detailCte = activeAccreditationsCteBody(4);
    const detailWhere = validPevoPaperWhere({ commentAlias: 'c', appTagParam: '$4', bridgeAccountParam: '$3', source: 'all' });
    // Resolve the continuation chain ONCE up-front and hand it to
    // reconstructVersionsFromHaf to avoid duplicate
    // `fetchHeadAuthorizedAuthors` + chain-walk queries (one each from this
    // function and reconstructVersionsFromHaf).
    // The optional `memo` parameter lets the caller share the
    // per-`(author, permlink)` metadata cache with the backward
    // canonical-root walker (see `findCanonicalRoot`).
    // Live detail surface: use the resolved chain as-is. A degraded (partial)
    // walk shows fewer versions but is not negative-cached, so no degraded gate
    // here — only the negative-caching callers gate on it.
    const { chain } = await resolveContinuationChain(author, permlink, memo, signal);
    // Hoist the accreditation lookups so the cumulative-union construction
    // (further down) and the `accredited_authors` rebuild share the same
    // request-scoped fetches. Both helpers cache 10 min via hafCache so
    // the parallel call is typically free; parallelizing with paperResult
    // / fullVersions / retraction avoids serial latency on cold cache.
    const [paperResult, fullVersions, retraction, accreditedAccountSet, accreditedOrcidsByAccount, accreditationOrcidStatus, accreditedNamesByAccount, authorReputation] = await Promise.all([
      // Not buildWith: the CTE params bind AFTER the outer author/permlink/bridge
      // params, and $4 (the appTag) is reused as both the parent_permlink filter and
      // the authorsWithSupersessionSelect / detailWhere appTag slot. A byte-identical
      // buildWith adoption (CTE params first) would renumber every $N in detailWhere
      // and the supersession select; kept manual to preserve the exact param layout
      // on this hot detail query.
      pool.query(
        `WITH ${detailCte.sql}
         SELECT c.author, c.permlink, c.title, c.body, c.json_metadata,
                c.created, c.last_edited,
                ${authorsWithSupersessionSelect('c', '$4', { includeAffiliation: true })} AS authors_with_supersession
         FROM ${T.comments} c
         WHERE c.author = $1 AND c.permlink = $2
           AND c.parent_author = '' AND c.parent_permlink = $4
           AND ${detailWhere}`,
        [author, permlink, config.hiveBridgeAccount, ...detailCte.params],
      ),
      reconstructVersionsFromHaf(author, permlink, chain, memo, signal),
      getRetractionInfo(author, permlink),
      getAllAccreditedAccounts(),
      getAccreditedOrcidsByAccount(),
      getAllEverAccreditedOrcidsWithStatus(),
      getAccreditedNamesByAccount(),
      // List-view (and profile-view) parity on the reputation SSoT:
      // every reputation value displayed in the UI must derive
      // from the same `${appTag}:reputation:batch:${user}` value. Paper
      // detail previously hardcoded `author_reputation: 0`.
      getReputationScore(author),
    ]);

    if (paperResult.rows.length === 0) return null;

    const row = paperResult.rows[0];
    const meta = parseMeta(row.json_metadata);
    if (!isPevoAnyPaper(meta, row.author as string)) return null;

    const detail = buildPaperDetail(row, meta, []);
    // Supersession-aware authors from the SQL LEFT JOIN against
    // `active_accreditations` (per `hive-schemas.md` § 1.1). Overrides
    // `buildPaperDetail`'s raw `pevo.authors || []` so the response carries
    // `orcid_verified` + `orcid_discrepancy`. Continuation-chain papers
    // override this again further down via `buildCumulativeAuthorsForChain`,
    // which populates the same fields from the request-scoped
    // `accreditedOrcidsByAccount` map.
    if (Array.isArray(row.authors_with_supersession)) {
      detail.authors = row.authors_with_supersession as Array<Record<string, unknown>>;
    }
    const versions = fullVersions.map(({ body: _body, json_metadata: _meta, post_author: _pa, post_permlink: _pp, ...entry }) => entry);
    detail.versions = versions.length > 0 ? versions : [{ version_number: 1, block_num: 0, created: detail.created as string, title: detail.title as string, is_content_revision: true }];
    detail.is_retracted = retraction.is_retracted;
    detail.retraction_reason = retraction.retraction_reason ?? null;
    detail.retraction_timestamp = retraction.retraction_timestamp ?? null;

    // E7: Use the (already-resolved) continuation chain to set head
    // author/permlink and use the latest version's content/metadata as
    // the displayed paper. `chain` was hoisted above and reused by
    // reconstructVersionsFromHaf to dedupe HAF queries.
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

        // Cumulative-union display construction
        // (see `agents/docs/ARCHITECTURE.md § 2 "Multi-Author Trust Model"`).
        //   - `detail.authors[]` is the cumulative union of
        //     `pevo.authors[].hive` across all chain posts (in
        //     first-occurrence order); per-hive sub-fields resolve to the
        //     most-recent self-claim or, absent a self-claim, the
        //     most-recent claim across the chain. ORCID is server-
        //     overridden for accredited hives whose claim diverges from
        //     the on-chain accredited ORCID. Drops are forbidden by
        //     construction (the union only grows; no chain post can
        //     remove a hive that another chain post added) — a structural
        //     invariant replaces the prior inversion-prone explicit check.
        //     See `agents/docs/ARCHITECTURE.md` section 2 "Multi-Author
        //     Trust Model".
        //   - `pevo.ipfs_cid` / `pevo.document_hash` / `pevo.ipfs_filename`
        //     apply per-version: each chain post's pointers describe that
        //     version's PDF (alice's v1 has CID_A, bob's v2 may have
        //     CID_B). The default `/api/papers/:author/:permlink` view
        //     reads from the chain head, falling back to the root when
        //     the head doesn't carry the field. `?version=N` reads the
        //     N-th version's metadata via the dedicated
        //     `reconstructVersionsFromHaf` path. All historical CIDs are
        //     preserved on chain (Hive immutability); the pinner agent
        //     retains them per the "Pinner constraint" subsection of the
        //     ARCH spec.
        //   - The risk of bob spoofing his continuation's `ipfs_cid` to a
        //     different paper is treated identically to body-spoof:
        //     accepted risk under the broadcaster-attributed reputation
        //     model with on-chain audit trail and accreditation
        //     revocation as the deterrent.
        //   - Other fields (title, body, abstract, discipline, keywords,
        //     citations, language, supplementary_files) evolve normally
        //     as part of legitimate version progression and are
        //     head-preferred.
        // The accept/resign consent layer (read-time consented-status decay)
        // is a separate dimension layered on top of this cumulative union:
        // the union is monotonic membership, consented-status decays under
        // resign — orthogonal. The union itself stays membership-only; the
        // consented dimension is annotated per request by the SQL read path
        // (`fetchConsentedAccountsForPaper` / `annotateAuthorsWithConsent`,
        // composing the same consent stack the reputation cycle uses). The
        // JS `computeConsentedAuthors` primitive (`consent-ops.ts`) is not
        // imported here; this site uses the SQL-side path exclusively.
        const headMeta = latest.json_metadata;
        if (isPevoAnyPaper(headMeta, latest.post_author)) {
          const rootPevo = safePevoMeta(meta);
          const headPevo = safePevoMeta(headMeta);

          // Build per-link latest pevo metadata for the cumulative-union
          // construction. `fullVersions` carries per-version metadata
          // already (each entry tagged with `post_author` / `post_permlink`);
          // the latest version per chain link is whichever entry came
          // last in the version-ordered scan. Iterating `fullVersions` in
          // its existing block_num-ascending order and overwriting on
          // each post-key collision yields the per-link latest metadata
          // without an extra query.
          const latestMetaByLink = new Map<string, Record<string, unknown>>();
          for (const v of fullVersions) {
            latestMetaByLink.set(
              `${v.post_author}/${v.post_permlink}`,
              v.json_metadata,
            );
          }
          const chainPosts = chain.map((link) => ({
            author: link.author,
            permlink: link.permlink,
            pevo: safePevoMeta(latestMetaByLink.get(`${link.author}/${link.permlink}`) ?? {}),
          }));

          // Route through the shared cumulative-authors helper so the
          // detail, listing, and profile surfaces share one construction.
          // The prebuiltChainPosts shortcut skips the helper's HAF round-trip
          // (detail already has the chain + per-link metadata) and writes
          // through to the per-root Redis cache, warming listing/profile
          // for subsequent requests within the TTL window.
          const cumulativeAuthors = (await resolveChainCumulativeAuthors(
            row.author as string,
            row.permlink as string,
            {
              accreditedAccounts: accreditedAccountSet,
              accreditedOrcids: accreditedOrcidsByAccount,
              accreditationOrcidStatus,
              accreditedNames: accreditedNamesByAccount,
              prebuiltChainPosts: chainPosts,
              memo,
              signal,
            },
          ))?.authors ?? [];

          detail.json_metadata = headMeta;
          detail.authors = cumulativeAuthors;
          detail.discipline = paperDisciplineField(headPevo.discipline);
          detail.keywords = pevoStringArray(headPevo, 'keywords');
          detail.citations = headPevo.citations || [];
          // Per-version display: the IPFS triple (ipfs_cid /
          // ipfs_filename / document_hash) is treated atomically.
          // Either head expresses a per-version triple (any of the
          // three keys is set on head — even to null, '', or a
          // non-string) and the displayed triple is read entirely
          // from head, OR head expresses no opinion (none of the
          // three keys present on head) and the entire triple falls
          // back to root.
          //
          // Why atomic: per-field fallback creates Frankenstein
          // composition (e.g. head's CID + root's filename + root's
          // hash) where the displayed triple never existed on chain
          // in any single version. The block comment above commits
          // to "each post's pointers describe that version's PDF";
          // an atomic triple preserves that invariant.
          //
          // Why sentinel-aware (`'in'` rather than non-null check):
          // a head explicitly clearing the triple (alice's v2 short
          // correction with no PDF, inline body only) is a supported
          // product shape. Distinguishing "head cleared" (key
          // present, value null) from "head omitted" (key absent)
          // preserves that signal end-to-end so a future per-version
          // display surface can read "no PDF for this version" from
          // the chain truthfully — without that distinction, a head
          // explicitly clearing its triple would be indistinguishable
          // from a head that simply didn't restate root's triple, and
          // the displayed CID would silently fall back to root.
          //
          // Note: no current API consumer relies on the head-cleared
          // vs head-omitted distinction (the response surfaces both
          // as `ipfs_cid: null`); the sentinel-aware shape is
          // preemptive future-proofing aligned with the atomic-triple
          // invariant.
          //
          // ipfs_cid is additionally passed through `validatedCid`
          // so attacker-controlled chain values that flow from
          // pevo.ipfs_cid through pevoString to the response are
          // shape-checked at the emit boundary; whitespace, control
          // characters, zero-width spaces, and arbitrary garbage
          // are scrubbed to null with a structured warn.
          const headHasAnyTripleKey =
            'ipfs_cid' in headPevo
            || 'ipfs_filename' in headPevo
            || 'document_hash' in headPevo;
          if (headHasAnyTripleKey) {
            detail.ipfs_cid = validatedCid(pevoString(headPevo, 'ipfs_cid'), {
              author,
              permlink,
            });
            detail.ipfs_filename = pevoString(headPevo, 'ipfs_filename');
            detail.document_hash = pevoString(headPevo, 'document_hash');
          } else {
            detail.ipfs_cid = validatedCid(pevoString(rootPevo, 'ipfs_cid'), {
              author,
              permlink,
            });
            detail.ipfs_filename = pevoString(rootPevo, 'ipfs_filename');
            detail.document_hash = pevoString(rootPevo, 'document_hash');
          }
          detail.language = pevoString(headPevo, 'language') ?? 'en';
          detail.supplementary_files = headPevo.supplementary_files || [];
        }
      }
    }

    // Accreditation: is_accredited + accredited_authors. Use the
    // already-loaded `accreditedAccountSet` (hoisted into the parallel
    // fetch block above) so this rebuild does not re-issue the
    // `getAllAccreditedAccounts` HAF query. `accredited_authors` reads
    // from `detail.authors` (the cumulative-union'd list for chain.length
    // > 1, or `pevo.authors[]` for single-link papers) rather than from
    // `detail.json_metadata`. Reading the union ensures by construction
    // that a head post that drops a chain author from its own
    // `pevo.authors[]` cannot leak the shrunken set into accreditation —
    // the union still carries the dropped author.
    detail.is_accredited = accreditedAccountSet.has(author);
    // Symmetric chain pre-check: non-accredited author shows score 0 even
    // if a stale batch entry survives in Redis (reputation
    // direction-of-truth: chain is SSoT, batch map is a perf cache).
    detail.author_reputation = detail.is_accredited ? authorReputation.score : 0;
    const detailAuthors = (detail.authors as Array<Record<string, unknown>>) || [];
    detail.accredited_authors = detailAuthors
      .map((a) => normalizeHiveAccount(a.hive))
      .filter((hive): hive is string => hive !== null && accreditedAccountSet.has(hive));

    // Citation count
    const pevo = safePevoMeta(meta);
    if (isPevoBridgePaper(meta, row.author as string)) {
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

    // Cache-poisoning defense: if the wall-clock budget tripped during
    // this fetcher's walker calls (`resolveContinuationChain` /
    // `reconstructVersionsFromHaf`), the chain may be partial. The detail
    // object built from a partial chain has wrong `head_author` /
    // `head_permlink` / `versions[]`. Returning it would let `hafCache`
    // cache the bad shape for 30 min. Return null so the cache layer's
    // null-skip rule in `hafCache.getOrSet` leaves the cache cold and the next
    // request retries against (hopefully recovered) HAF. The route handler
    // then surfaces 503 to the client via its own `signal.aborted` check.
    if (signal?.aborted) return null;

    return detail;
  } catch (err) {
    // Re-throw walker-abort errors as null is the cache-poisoning defense
    // above; this catch only fires for actual query failures (pg pool
    // exhausted, statement_timeout, network blip, hosting outage) or for
    // upstream throws from `getAllAccreditedAccounts` /
    // `getAccreditedOrcidsByAccount` / `getAllEverAccreditedOrcidsWithStatus`
    // (all three loud-fail per their docstrings).
    //
    // Tag the error class so the route layer can translate to
    // `503 SERVICE_UNAVAILABLE` with `details.retriable: true`. Pre-fix,
    // this catch returned `null` and the route handler treated `null` as
    // `404 NOT_FOUND`, making HAF outage indistinguishable from
    // "paper does not exist" to clients.
    logger.error({ err }, 'HAF paper detail query failed');
    throw new HafQueryError('fetchPaperDetailFromHaf', { cause: err });
  }
}

// ──────────────────────────────────────────────
// Version history resolution (on-chain edits)
// ──────────────────────────────────────────────

/** Return version metadata only (no bodies). */
async function resolveVersionsFromHaf(
  author: string,
  permlink: string,
  memo?: HeadAuthorsMemo,
  signal?: AbortSignal,
): Promise<PaperVersionEntry[]> {
  const versions = await reconstructVersionsFromHaf(author, permlink, undefined, memo, signal);
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
       AND cj.required_posting_auths ? $2`,
    [config.appTag, config.hiveAdminAccount],
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
    discipline: paperDisciplineField(pevo.discipline),
    keywords: pevoStringArray(pevo, 'keywords'),
    authors: pevo.authors || [],
    ipfs_cid: validatedCid(pevoString(pevo, 'ipfs_cid'), {
      author: post.author as string,
      permlink: post.permlink as string,
    }),
    ipfs_filename: pevoString(pevo, 'ipfs_filename'),
    document_hash: pevoString(pevo, 'document_hash'),
    language: pevoString(pevo, 'language') ?? 'en',
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

// ─── Consented badge (paper detail) ──────────────────────────────

/** TTL upper bound for the per-paper consented-set cache entry. The entry is
 *  VOLATILE tier (no `stable` flag): `block-watcher.ts` clears volatile
 *  entries on every detected new block (~3s), so the badge is at most one
 *  block stale and a consent op landing at block N is reflected by block N+1.
 *  The TTL only matters in environments without a block watcher (dev without
 *  HAF). */
const CONSENTED_SET_TTL_MS = 30_000;

/** Fetch the consented-author set (Routes 1+2 of the consent model) for one
 *  paper root. Composes the SAME CTE stack the reputation cycle consumes
 *  (`consentChainCteBody` + `consentedAuthorsCteBody`), so the badge cannot
 *  drift from cycle credit (single source of truth for credited-set
 *  membership, per the `consent-ops.ts` module header).
 *
 *  Returns the accounts as an array, not a Set: the result round-trips
 *  through the Redis cache tier as JSON, and a Set serializes to `{}`.
 *  Returns null when no HAF pool is configured (the caller fails closed;
 *  `getOrSet` skips caching null) and throws `HafQueryError` on query
 *  failure (propagates uncached to the route's retriable-503 translation). */
async function fetchConsentedAccountsForPaper(author: string, permlink: string): Promise<string[] | null> {
  const pool = getPool();
  if (!pool) return null;
  const cte = buildRecursiveWith(
    1,
    activeAccreditationsCteBody,
    (idx) => consentChainCteBody(idx, { paperAuthor: author, paperPermlink: permlink }),
    (idx) => consentedAuthorsCteBody(idx),
  );
  try {
    const result = await pool.query<{ account: string }>(
      `${cte.sql}
       SELECT account FROM consented_authors`,
      cte.params,
    );
    return result.rows.map((r) => String(r.account));
  } catch (err) {
    throw new HafQueryError('fetchConsentedAccountsForPaper', { cause: err });
  }
}

/** Resolve the per-paper consented set through the shared
 *  `consented-authors:{author}:{permlink}` VOLATILE cache entry. Both
 *  consumers — the paper-detail badge (`annotateAuthorsWithConsent`) and the
 *  enrichment revote-channel skip in `fetchEnrichmentFromHaf` — go through
 *  this wrapper. Cross-surface reuse for the current block holds only when both
 *  resolve the SAME canonical (author, permlink) pair: the badge path
 *  canonicalizes via `findCanonicalRoot` before resolving, while the enrichment
 *  path keys on its caller-supplied pair. On a root-URL request both compute the
 *  same key and the second surface reuses the first's resolution; on a
 *  continuation-post URL they key differently and each fires its own query. The
 *  key always matches the loader's args either way, so a miss costs one extra
 *  query, never a wrong-paper result.
 *  Volatile tier: `block-watcher.ts` drops the entry each block
 *  (at-most-one-block stale; CONSENTED_SET_TTL_MS backstops a stalled
 *  watcher). A null (pool-unavailable) result is never cached (`getOrSet`
 *  null-skip) and a `HafQueryError` propagates uncached. */
function getConsentedAccountsForPaperCached(author: string, permlink: string): Promise<string[] | null> {
  return hafCache.getOrSet(
    `consented-authors:${author}:${permlink}`,
    () => fetchConsentedAccountsForPaper(author, permlink),
    CONSENTED_SET_TTL_MS,
  );
}

/** Annotate each paper-detail author entry with the `consented` flag, keyed
 *  on the entry's normalized `hive` account. Hive-less entries (display-only
 *  credits, unresolved-ORCID slots) are never consented through this surface.
 *  Returns a response COPY: the cached detail object is shared across
 *  requests (the in-memory cache tier stores the live reference) and must
 *  not be mutated. Runs OUTSIDE the stable paper-detail cache entries so the
 *  flag stays at-most-one-block stale while the heavyweight detail payload
 *  keeps its 30-minute stable tier.
 *
 *  Short-circuits that skip the consent fetch entirely (bounding the
 *  fail-closed 503 surface to genuinely multi-author papers):
 *   - bridge papers: the bridge account is the implicitly-consented Route-1
 *     root; imported hive-less credits are not consentable on this surface.
 *   - single-author papers whose sole entry IS the root broadcaster:
 *     Route-1 implicit consent (broadcasting the paper is the consent act).
 *     A later self-resign is not reflected until the entry stops being the
 *     sole-root case; the cycle (which resolves the full demotion stream)
 *     remains authoritative for credit.
 *
 *  Multi-author papers resolve through the volatile-cached consented set.
 *  Returns null when the set is unavailable (no HAF pool): the caller MUST
 *  surface 503 — a HAF flap must never silently demote legitimate
 *  co-authors to claimed-only. */
async function annotateAuthorsWithConsent(
  detail: Record<string, unknown>,
  rootAuthor: string,
  rootPermlink: string,
): Promise<Record<string, unknown> | null> {
  const authors = (Array.isArray(detail.authors) ? detail.authors : []) as PaperAuthor[];
  if (authors.length === 0) return detail;
  const meta = (detail.json_metadata && typeof detail.json_metadata === 'object'
    ? detail.json_metadata
    : {}) as Record<string, unknown>;
  const normalizedRoot = normalizeHiveAccount(rootAuthor);
  const withFlag = (flag: (a: PaperAuthor) => boolean): Record<string, unknown> => ({
    ...detail,
    authors: authors.map((a) => ({ ...a, consented: flag(a) })),
  });

  if (isPevoBridgePaper(meta, rootAuthor)) {
    const bridge = normalizeHiveAccount(config.hiveBridgeAccount);
    return withFlag((a) => bridge !== null && normalizeHiveAccount(a.hive) === bridge);
  }
  if (authors.length === 1 && normalizedRoot !== null && normalizeHiveAccount(authors[0]?.hive) === normalizedRoot) {
    return withFlag(() => true);
  }

  const accounts = await getConsentedAccountsForPaperCached(rootAuthor, rootPermlink);
  if (!accounts) return null;
  const consented = new Set(accounts);
  return withFlag((a) => {
    const hive = normalizeHiveAccount(a.hive);
    return hive !== null && consented.has(hive);
  });
}

router.get('/:author/:permlink', async (req: Request, res: Response) => {
  let author = req.params.author as string;
  let permlink = req.params.permlink as string;
  const requestedVersion = req.query.version ? parseInt(req.query.version as string, 10) : null;

  if (requestedVersion !== null && isNaN(requestedVersion)) {
    return sendError(res, 400, 'BAD_REQUEST', 'version must be an integer');
  }

  // Per-request memo for `fetchHeadAuthorizedAuthors`. Shared between the
  // backward walker (`findCanonicalRoot`) and the forward walker
  // (`resolveContinuationChain` via `fetchPaperDetailFromHaf`) so they do
  // not re-fetch metadata for the same `(author, permlink)`.
  const headAuthorsMemo = makeHeadAuthorsMemo();

  // Per-request wall-clock budget for the chain walkers. Bounds
  // worker-thread starvation under degraded HAF (each per-query
  // statement_timeout=30s × walker hop cap = up to 10/25-minute tail
  // before the depth cap exits). The signal threads through both
  // walkers (`findCanonicalRoot` backward, `resolveContinuationChain`
  // forward via `fetchPaperDetailFromHaf`/`reconstructVersionsFromHaf`)
  // so the budget covers the full per-request walker-chain
  // (cascading helper calls included). On abort the walkers emit
  // `canonical_root_walker_wall_clock_exceeded` or
  // `continuation_chain_wall_clock_exceeded` and stop at the deepest
  // verified node / return the chain so far.
  //
  // **Real worst-case per request = `hafWalkerWallClockMs` + `statement_timeout`.**
  // The signal stops NEW queries from starting; in-flight `pool.query`
  // continues until PostgreSQL's `statement_timeout` (30s) resolves it —
  // pg v8.x does NOT support `AbortSignal` in `pool.query`. At the 3000ms
  // default the per-request ceiling is ~33s rather than 3s, still 18-45×
  // improvement over the pre-fix 10/25-min tail. See `config.ts`'s
  // `hafWalkerWallClockMs` docblock for tuning guidance.
  //
  // Knob: `config.hafWalkerWallClockMs` (`HAF_WALKER_WALL_CLOCK_MS` env).
  // Default 3000ms (typical HAF response 50-200ms × 10-15-query depth).
  const walkerAbort = new AbortController();
  const walkerBudget = setTimeout(() => walkerAbort.abort(), config.hafWalkerWallClockMs);
  try {
    // E4: If this is a continuation post, redirect to the canonical root paper
    const canonicalRoot = await findCanonicalRoot(author, permlink, headAuthorsMemo, walkerAbort.signal);
    if (canonicalRoot) {
      author = canonicalRoot.author;
      permlink = canonicalRoot.permlink;
    }

    if (requestedVersion !== null) {
      const cacheKey = `paper-detail:${author}:${permlink}:v${requestedVersion}`;
      const cached = await hafCache.getOrSet(cacheKey, async () => {
        const versions = await reconstructVersionsFromHaf(author, permlink, undefined, headAuthorsMemo, walkerAbort.signal);
        if (versions.length === 0) return null;

        // Paper identity is established by the first version (original publication).
        // External edits may overwrite json_metadata, so don't check later versions.
        if (!isPevoAnyPaper(versions[0].json_metadata, versions[0].post_author)) return null;

        const target = versions.find((v) => v.version_number === requestedVersion);
        if (!target) return null;

        // Use this version's metadata (IPFS CID, authors, etc.) but fall back to
        // the original publication's PEvO metadata for fields external edits may strip.
        const meta = target.json_metadata;
        const post = { author, permlink, title: target.title, body: target.body, json_metadata: meta, created: target.created, last_edited: target.created };
        const detail = buildPaperDetail(post, meta, []);
        detail.versions = versions.map(({ body: _b, json_metadata: _m, ...entry }) => entry);

        // Supersession (`hive-schemas.md` § 1.1) on the JS-reconstructed
        // authors array: this branch builds `detail` from a version row
        // without running the SQL-side `authorsWithSupersessionSelect`
        // projection, so apply the same rule in JS via the per-request
        // ORCID + attested-name maps (ORCID + name supersession and the
        // name fallback chain).
        const [orcidMapForVersion, nameMapForVersion] = await Promise.all([
          getAccreditedOrcidsByAccount(),
          getAccreditedNamesByAccount(),
        ]);
        detail.authors = applyAuthorSupersession(detail.authors, orcidMapForVersion, nameMapForVersion);

        const retraction = await getRetractionInfo(author, permlink);
        detail.is_retracted = retraction.is_retracted;
        detail.retraction_reason = retraction.retraction_reason ?? null;
        detail.retraction_timestamp = retraction.retraction_timestamp ?? null;

        return detail;
      }, 30 * 60_000, true);

      if (walkerAbort.signal.aborted) {
        return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'HAF walker budget exceeded; please retry', { retriable: true });
      }
      if (cached) {
        // Consent annotation runs per request, outside the stable detail
        // cache entry, so the badge is at most one block stale. Consent ops
        // bind the chain root, so the post-canonical-rewrite identifiers are
        // the correct keys on every branch (incl. ?version=N).
        const annotated = await annotateAuthorsWithConsent(cached, author, permlink);
        if (annotated === null) {
          return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Paper detail temporarily unavailable. Please retry shortly.', { retriable: true });
        }
        return sendOk(res, annotated);
      }
      return sendError(res, 404, 'NOT_FOUND', 'Version not found');
    }

    const cacheKey = `paper-detail:${author}:${permlink}`;
    const cached = await hafCache.getOrSet(cacheKey, async () => {
      const hafResult = await fetchPaperDetailFromHaf(author, permlink, headAuthorsMemo, walkerAbort.signal);
      if (hafResult) return hafResult;

      // If current metadata was stripped by an external edit, reconstruct from
      // version history. The first version establishes paper identity; later
      // versions inherit PEvO metadata when the editing frontend dropped it.
      const versions = await reconstructVersionsFromHaf(author, permlink, undefined, headAuthorsMemo, walkerAbort.signal);
      if (versions.length > 0 && isPevoAnyPaper(versions[0].json_metadata, versions[0].post_author)) {
        const latest = versions[versions.length - 1];
        const meta = latest.json_metadata;
        const post = { author, permlink, title: latest.title, body: latest.body, json_metadata: meta, created: versions[0].created, last_edited: latest.created };
        const detail = buildPaperDetail(post, meta, []);
        detail.versions = versions.map(({ body: _b, json_metadata: _m, ...entry }) => entry);
        detail.metadata_restored = true;

        // Supersession on the metadata-restored fallback. Same shape as
        // the ?version=N branch above.
        const [orcidMapForRestored, nameMapForRestored] = await Promise.all([
          getAccreditedOrcidsByAccount(),
          getAccreditedNamesByAccount(),
        ]);
        detail.authors = applyAuthorSupersession(detail.authors, orcidMapForRestored, nameMapForRestored);

        const retraction = await getRetractionInfo(author, permlink);
        detail.is_retracted = retraction.is_retracted;
        detail.retraction_reason = retraction.retraction_reason ?? null;
        detail.retraction_timestamp = retraction.retraction_timestamp ?? null;

        return detail;
      }

      return null;
    }, 30 * 60_000, true);

    if (walkerAbort.signal.aborted) {
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'HAF walker budget exceeded; please retry', { retriable: true });
    }
    if (cached) {
      // Same per-request consent annotation as the ?version=N branch above;
      // covers the single-post, cumulative-chain, and metadata-restored
      // detail shapes (they share this convergence point).
      const annotated = await annotateAuthorsWithConsent(cached, author, permlink);
      if (annotated === null) {
        return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Paper detail temporarily unavailable. Please retry shortly.', { retriable: true });
      }
      return sendOk(res, annotated);
    }
    sendError(res, 404, 'NOT_FOUND', 'Paper not found');
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
        'Paper detail temporarily unavailable. Please retry shortly.',
        { retriable: true },
      );
    }
    throw err;
  } finally {
    clearTimeout(walkerBudget);
  }
});

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink/enrichment
// ──────────────────────────────────────────────

// Shape of the per-paper authorship-claims projection consumed by the enrichment
// fetcher. Typed so the accepted-claimer self-vote exclusion (the `status ===
// 'accepted'` filter feeding `acceptedClaimers`) reads `status`/`claimer` as
// declared columns rather than untyped `any`: a projection change that drops a
// consumed column surfaces at the use site instead of silently emptying the
// exclusion set and reopening the self-dealing gap.
type ClaimsRow = {
  claimer: string;
  paper_author: string;
  paper_permlink: string;
  author_index: number | null;
  status: string;
  claimed_at: string;
};

async function fetchEnrichmentFromHaf(author: string, permlink: string, signal?: AbortSignal) {
  const pool = getPool();
  if (!pool) return null;

  // Per-request memo for `fetchHeadAuthorizedAuthors`. Threaded into
  // `resolveVersionsFromHaf` so that within a single enrichment request, the
  // forward-walker lookups initiated by `reconstructVersionsFromHaf` share the
  // catch-block negative-cache benefit (third call site for memo threading,
  // paralleling the `?version=N` branch and the metadata-restored fallback
  // in the GET /:author/:permlink handler).
  const headAuthorsMemo = makeHeadAuthorsMemo();

  try {
    const accreditedAccounts = await getAllAccreditedAccounts();
    const accreditedArr = [...accreditedAccounts];
    // Include anonymous posting account so anonymous reviews appear
    const reviewAuthors = config.hiveAnonAccount
      ? [...accreditedArr, config.hiveAnonAccount]
      : accreditedArr;

    // authorship_claims + the consent stack scoped to THIS paper, so the
    // excludeClaimedSelfWhere/excludeConsentedSelfWhere pair can drop a
    // credited account's self-review and self-vote (an accepted claimer's
    // ORCID / name-only slot, or a Route-2 consented co-author — both absent
    // from authors[].hive) from the enrichment lists, mirroring the cycle's
    // two NOT EXISTS gates. Param indices for the reviews query derive from
    // this CTE's nextIdx via the counter below so the prepended CTE params
    // shift them automatically.
    const detailCte = buildRecursiveWith(
      1,
      activeAccreditationsCteBody,
      (idx) => authorshipClaimsCteBody(idx, { paperAuthor: author, paperPermlink: permlink }),
      (idx) => consentChainCteBody(idx, { paperAuthor: author, paperPermlink: permlink }),
      (idx) => consentedAuthorsCteBody(idx),
    );
    let drIdx = detailCte.nextIdx;
    const drAuthorIdx = drIdx++;
    const drPermlinkIdx = drIdx++;
    const drAppTagIdx = drIdx++;
    const drReviewAuthorsIdx = drIdx++;
    const drBridgeIdx = drIdx++;
    // The vote query binds only 3 trailing params (author, permlink, accreditedArr),
    // so accreditedArr lands at drAuthorIdx + 2 — numerically equal to drAppTagIdx
    // by coincidence of the current layout, not by design. Bind it through its own
    // named slot so a future param insertion cannot silently mis-bind it.
    const drVoteAccreditedIdx = drAuthorIdx + 2;

    const [voteResult, reviewsResult, versions, claimsResult, consentedArr] = await Promise.all([
      // Accredited voters (excluding self-votes AND credited-claimer self-votes)
      // — use vote operations to survive payout. Params (after the detailCte CTE
      // params): author, permlink, accreditedArr.
      pool.query(
        `${detailCte.sql}
         SELECT DISTINCT ON (v.voter) v.voter, v.weight, v.timestamp, v.block_num FROM ${T.voteOps} v
         WHERE v.author = $${drAuthorIdx} AND v.permlink = $${drPermlinkIdx}
           AND v.voter = ANY($${drVoteAccreditedIdx}::text[])
           AND v.voter != v.author
           AND ${excludeClaimedSelfWhere({ authorExpr: 'v.voter', paperAuthorExpr: `$${drAuthorIdx}`, paperPermlinkExpr: `$${drPermlinkIdx}` })}
           AND ${excludeConsentedSelfWhere({ authorExpr: 'v.voter', paperAuthorExpr: `$${drAuthorIdx}`, paperPermlinkExpr: `$${drPermlinkIdx}` })}
         -- Same-block tie-breaker: v.id (operation_vote_view has no trx_in_block;
         -- v.id is the monotonic HAF op id) per
         -- agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md Rule 2
         ORDER BY v.voter, v.block_num DESC, v.id DESC`,
        [...detailCte.params, author, permlink, accreditedArr],
      ),
      // Reviews from accredited reviewers (+ anon account) with accredited vote count.
      // Trailing binds after the detailCte params: author, permlink, appTag
      // (drAppTagIdx — reused by the revote-aware net_votes helper's revote arm),
      // reviewAuthors (drReviewAuthorsIdx — the c.author gate on the review row
      // itself, includes the anon proxy), hiveBridgeAccount (drBridgeIdx — the
      // validPevoPaperWhere bridge-author pin). The net_votes voter gate no longer
      // binds an accredited array: the helper reads the active_accreditations CTE.
      // The JOIN against `p` materializes the parent paper row so the
      // excludeSelfReviewWhere helper can read p.json_metadata -> authors[].
      // The JOIN is a single-row lookup keyed on (author, permlink) — the
      // planner folds it into a constant against `c`'s scan.
      //
      // Display↔reputation parity (cross-surface): without validPevoPaperWhere
      // on `p`, a directly-addressed (author, permlink) pair that isn't a
      // PEvO paper-class post (a peakd blog post, a non-paper comment) would
      // surface as an enrichment review-set while reputation correctly
      // excludes such rows via the user_reviews CTE that composes
      // validPevoPaperWhere. The route at /api/papers/<author>/<permlink>/enrichment
      // reaches this fetcher directly without the upstream paper-class gate
      // that `fetchPaperFromHaf` applies, so the gate must compose here. See
      // `agents/docs/solutions/conventions/cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md`.
      pool.query(
        `${detailCte.sql}
         SELECT c.author, c.permlink, c.body, c.json_metadata, c.created,
                -- Revote-aware: each review's displayed net_votes must fold
                -- post-payout revote custom_json into the latest-signal-per-voter
                -- stream, same as the single-review fetch (routes/reviews.ts) and
                -- reputation.ts. The shared helper reads active_accreditations
                -- (in scope via detailCte) for the voter gate and reuses the bound
                -- APP_TAG ref for the revote arm, so no per-row accredited-array
                -- bind is needed. A native-only count here diverged from the same
                -- review's count on its single-doc page once a voter revoted.
                ${accreditedVoteCount('c.author', 'c.permlink', `$${drAppTagIdx}`)} AS net_votes
         FROM ${T.comments} c
         JOIN ${T.comments} p ON p.author = $${drAuthorIdx} AND p.permlink = $${drPermlinkIdx}
         WHERE c.parent_author = $${drAuthorIdx} AND c.parent_permlink = $${drPermlinkIdx}
           AND c.author = ANY($${drReviewAuthorsIdx}::text[])
           AND ${validReviewWhere({ commentAlias: 'c', appTagParam: `$${drAppTagIdx}` })}
           AND ${validPevoPaperWhere({ commentAlias: 'p', appTagParam: `$${drAppTagIdx}`, bridgeAccountParam: `$${drBridgeIdx}`, source: 'all' })}
           AND ${excludeSelfReviewWhere({ paperRowAlias: 'p', appTagParam: `$${drAppTagIdx}` })}
           AND ${excludeClaimedSelfWhere({ authorExpr: 'c.author', paperAuthorExpr: `$${drAuthorIdx}`, paperPermlinkExpr: `$${drPermlinkIdx}` })}
           AND ${excludeConsentedSelfWhere({ authorExpr: 'c.author', paperAuthorExpr: `$${drAuthorIdx}`, paperPermlinkExpr: `$${drPermlinkIdx}` })}
         ORDER BY c.created DESC`,
        [...detailCte.params, author, permlink, config.appTag, reviewAuthors, config.hiveBridgeAccount || ''],
      ),
      // Version history (needed for review outdated computation)
      resolveVersionsFromHaf(author, permlink, headAuthorsMemo, signal),
      // Authorship claims
      (async () => {
        const cte = buildRecursiveWith(1, activeAccreditationsCteBody, (idx) => authorshipClaimsCteBody(idx, { paperAuthor: author, paperPermlink: permlink }));
        return pool.query<ClaimsRow>(
          `${cte.sql}
           SELECT claimer, paper_author, paper_permlink, author_index, status, claimed_at
           FROM authorship_claims
           WHERE paper_author = $${cte.nextIdx}
             AND paper_permlink = $${cte.nextIdx + 1}
             AND status != 'revoked'`,
          [...cte.params, author, permlink],
        );
      })(),
      // Resolved consented set (Routes 1/2) for the JS-side revote-channel
      // skip below — resolved through the shared volatile cache entry keyed by
      // (author, permlink) (`getConsentedAccountsForPaperCached`). When this
      // route's caller-supplied pair is the canonical one the badge also
      // resolves (a root-URL request), the rebuild reuses the badge's per-block
      // resolution instead of re-firing the HAF query; on a continuation-post
      // URL it keys on its own pair and resolves independently. A pool-null
      // return is impossible on this path (the enclosing fetcher already holds
      // the pool); a query failure throws HafQueryError uncached and fails the
      // enrichment like every other leg of this Promise.all (fail-closed,
      // per-request).
      getConsentedAccountsForPaperCached(author, permlink),
    ]);

    const latestVersion = versions.length > 0 ? versions[versions.length - 1].version_number : 1;

    // Always query revote custom_json ops for this paper. The
    // `block_num >= $genesis` floor was dropped to match the 285e7c14 fix on
    // `activeAccreditationsCteBody`: combining `custom_id = $appTag` with
    // `block_num >= $genesis` triggers a BitmapAnd plan that scans tens of
    // millions of operation rows on `hive_operations_block_num_id_idx`. This
    // query runs sequentially after the parallel batch, so its full latency
    // adds to the per-request walker budget; on the live HAF it exhausted the
    // 3000ms budget and surfaced 503 SERVICE_UNAVAILABLE on the enrichment
    // endpoint (reviews, voters, claims all silently empty on the SPA).
    const revoteResult = await pool.query(
      `SELECT cj.required_posting_auths ->> 0 AS voter,
              -- {1,9} bounds the digit count for overflow safety: an unbounded match admits a value that overflows ::int and aborts the whole query (max Hive vote weight is 10000).
              CASE WHEN (cj.json::jsonb ->> 'weight') ~ '^-?[0-9]{1,9}$' THEN (cj.json::jsonb ->> 'weight')::int END AS weight,
              cj.json::jsonb ->> 'version' AS version,
              cj.timestamp AS revote_ts,
              cj.block_num
       FROM ${T.customJson} cj
       WHERE cj.custom_id = $1
         AND cj.json::jsonb ->> 'action' = 'revote'
         AND cj.json::jsonb ->> 'author' = $2
         AND cj.json::jsonb ->> 'permlink' = $3
       ORDER BY cj.block_num DESC`,
      [config.appTag, author, permlink],
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

    // Credited self-vote exclusion. A credited account — an accepted claimer
    // (ORCID / name-only slot) or a Route-1/2 consented author, both absent
    // from or unmatched against authors[].hive — must not have their
    // self-vote on this paper counted toward the displayed net_votes. The
    // native vote SQL query already drops them via the
    // excludeClaimedSelfWhere/excludeConsentedSelfWhere pair, but the revote
    // custom_json channel is resolved in JS and carries no SQL gate — so skip
    // credited accounts in BOTH vote loops below, mirroring batchResolveVotes'
    // creditedSet skip on the listing surface. claimsResult and consentedArr
    // are scoped to this paper, so the account name is the key.
    const acceptedClaimers = new Set<string>();
    for (const r of claimsResult.rows) {
      if (r.status === 'accepted') acceptedClaimers.add(r.claimer);
    }
    const consentedAccounts = new Set<string>(consentedArr ?? []);

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
      // Defense-in-depth: the native SQL already excludes credited accounts,
      // but skip here too so the revote-override branch below cannot
      // reintroduce one.
      if (acceptedClaimers.has(voter) || consentedAccounts.has(voter)) continue;
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
      // Drop a credited account's self-revote: the revote channel has no SQL
      // gate, so without this an accepted claimer's or consented co-author's
      // revote inflates the paper-detail net_votes (the listing path already
      // excludes them via batchResolveVotes).
      if (acceptedClaimers.has(voter) || consentedAccounts.has(voter)) continue;
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

    const authorship_claims = claimsResult.rows.map((r) => ({
      claimer: r.claimer,
      author_index: r.author_index,
      status: r.status,
      claimed_at: r.claimed_at,
    }));

    // Cache-poisoning defense: if the wall-clock budget tripped during
    // the embedded `resolveVersionsFromHaf` walker call, `versions` is
    // empty (the version-history walker bails on abort) and `latestVersion`
    // collapses to 1. The enrichment payload would still serialize but
    // misreports review.outdated booleans against the truncated version
    // chain. Return null so `hafCache.getOrSet` leaves the cache cold;
    // the route surfaces 503 via its own `signal.aborted` check.
    if (signal?.aborted) return null;

    return {
      net_votes,
      vote_strength,
      voters,
      reviews,
      authorship_claims,
    };
  } catch (err) {
    // Loud-fail on HAF query failure so the route handler can translate
    // to `503 SERVICE_UNAVAILABLE` with `details.retriable: true` rather
    // than the pre-fix `null → 404` collapse that masked outage as
    // "paper not found".
    logger.error({ err }, 'HAF enrichment query failed');
    throw new HafQueryError('fetchEnrichmentFromHaf', { cause: err });
  }
}

router.get('/:author/:permlink/enrichment', async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;

  // Per-request wall-clock budget. The route reaches the walker amplifier
  // via `fetchEnrichmentFromHaf → resolveVersionsFromHaf →
  // reconstructVersionsFromHaf → resolveContinuationChain` (forward
  // walker, depth cap 50). Without this wrapper, attacker-posted long
  // chains under degraded HAF can starve worker threads for tens of
  // minutes per request, replicating the DoS amplifier closed on the
  // primary `GET /:author/:permlink` handler.
  const walkerAbort = new AbortController();
  const walkerBudget = setTimeout(() => walkerAbort.abort(), config.hafWalkerWallClockMs);
  try {
    const cacheKey = `paper-enrichment:${author}:${permlink}`;
    const cached = await hafCache.getOrSet(cacheKey, () =>
      fetchEnrichmentFromHaf(author, permlink, walkerAbort.signal),
    5 * 60_000, true);

    if (walkerAbort.signal.aborted) {
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'HAF walker budget exceeded; please retry', { retriable: true });
    }
    if (!cached) return sendError(res, 404, 'NOT_FOUND', 'Paper not found');
    sendOk(res, cached);
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
        'Paper enrichment temporarily unavailable. Please retry shortly.',
        { retriable: true },
      );
    }
    throw err;
  } finally {
    clearTimeout(walkerBudget);
  }
});

// ──────────────────────────────────────────────
// E6: POST /api/papers/:author/:permlink/invalidate
// ──────────────────────────────────────────────

const invalidateLimiter = rateLimit({ name: 'cache-invalidate', windowMs: 60_000, max: 10, keyFn: byAccount });

router.post('/:author/:permlink/invalidate', verifyHiveSignature, invalidateLimiter, async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;

  // Invalidate all cache keys for this paper, including versioned-view
  // keys `paper-detail:{author}:{permlink}:v{N}`. Without the prefix
  // sweep, an edit to `pevo.authors[]` (which gates continuation admit)
  // would serve stale results from versioned views for up to 30 min.
  await Promise.all([
    hafCache.invalidate(`paper-detail:${author}:${permlink}`),
    hafCache.invalidate(`paper-enrichment:${author}:${permlink}`),
    // Versioned keys live under `paper-detail:{author}:{permlink}:v*`.
    // The unversioned key was already handled above; this prefix sweep
    // catches the v1, v2, ... variants.
    hafCache.invalidatePrefix(`paper-detail:${author}:${permlink}:v`),
    // Canonical-root mappings are leaf-keyed (any leaf in any chain whose
    // topology shifts post-edit can resolve differently). The leaf→root
    // function lookup is cheap to recompute, so a broad app-wide prefix
    // flush is safe. Without this, an edit to a mid-chain post's
    // `pevo.continues` pointer or `pevo.authors[]` within Hive's 7-day
    // edit window would refresh the detail cache immediately but leave
    // the canonical-root mapping cached for up to the full TTL.
    hafCache.invalidatePrefix('canonical-root:'),
    // Chain-authors cumulative-union entries are root-keyed. The
    // per-paper invalidate above does not know which root a given paper
    // belongs to (a continuation post invalidates its own detail but the
    // chain-authors entry sits under the root pair), so a broad app-wide
    // prefix flush is the only correct shape. Recompute is cheap and
    // happens lazily on the next listing/profile/detail call per root.
    hafCache.invalidatePrefix('chain-authors:'),
    // Consented-set entries are root-keyed like chain-authors, so the same
    // broad prefix flush applies. They are volatile (dropped on every block
    // tick anyway); this covers environments without a block watcher.
    hafCache.invalidatePrefix('consented-authors:'),
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
           AND cj.required_posting_auths ? $4
         LIMIT 1`,
        [author, permlink, config.appTag, config.hiveAdminAccount],
      );
      return result.rows.length > 0;
    } catch (err) {
      logger.error({ err }, 'HAF retraction check failed');
    }
  }
  return false;
}

// validateRetractParams runs BEFORE verifyHiveSignature: this route's limiter
// is URL-keyed, so a structurally-invalid slug spray must be rejected without
// paying ECDSA recovery. The custody routes mount their body-shape validators
// AFTER verifyHiveSignature because their limiters are byAccount-keyed; that
// asymmetry is intentional and is documented in the validateRetractParams JSDoc.
router.post('/:author/:permlink/retract', validateRetractParams, verifyHiveSignature, retractLimiter, async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;
  const username = req.hiveUsername!;
  const reason = (req.body.reason as string) || '';

  // Canonical-root walker is intentionally NOT invoked here. /cite and /retract
  // operate on the URL's own (author, permlink) — citation targets the URL post
  // directly; retraction authorizes username === URL author then broadcasts on
  // the URL's coords. Canonicalization is a display concern handled by the GET
  // handler. New /api/papers/:author/:permlink/<verb> routes that want canonical
  // resolution must call findCanonicalRoot themselves; do not pattern-match this
  // handler without checking.

  // Per-request wall-clock budget. `fetchPaperDetailFromHaf` calls the
  // forward walker (`resolveContinuationChain`); without this wrapper,
  // attacker-posted long chains under degraded HAF would saturate the
  // pool here too, identical threat model to the primary GET handler.
  const walkerAbort = new AbortController();
  const walkerBudget = setTimeout(() => walkerAbort.abort(), config.hafWalkerWallClockMs);
  let detail: Record<string, unknown> | null;
  try {
    detail = await fetchPaperDetailFromHaf(author, permlink, undefined, walkerAbort.signal) as Record<string, unknown> | null;
  } catch (err) {
    if (err instanceof HafQueryError && isRetriableHafError(err)) {
      // Cause-discriminated retriable envelope. Deterministic pg failures
      // fall through to the central 500 handler.
      return sendError(
        res,
        503,
        'SERVICE_UNAVAILABLE',
        'Retraction temporarily unavailable. Please retry shortly.',
        { retriable: true },
      );
    }
    throw err;
  } finally {
    clearTimeout(walkerBudget);
  }
  if (walkerAbort.signal.aborted) {
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'HAF walker budget exceeded; please retry', { retriable: true });
  }
  if (!detail) {
    return sendError(res, 404, 'NOT_FOUND', 'Paper not found');
  }

  // Authorization: paper author, pevo.admin, or (for bridge papers) registerer or original preprint author
  let authorized = username === author || username === config.hiveAdminAccount;
  if (!authorized) {
    const meta = (detail.json_metadata || {}) as Record<string, unknown>;
    const pevo = (meta[config.appTag] || {}) as Record<string, unknown>;
    if (isPevoBridgePaper(meta, author)) {
      const source = (pevo.source || {}) as Record<string, unknown>;
      const registeredBy = source.registered_by as string | undefined;
      if (registeredBy === username) {
        authorized = true;
      } else {
        const paperAuthors = (pevo.authors || []) as Array<{ hive?: string | null }>;
        // Canonicalize the broadcaster-controlled `authors[i].hive` via
        // `normalizeHiveAccount` before comparing against the chain-validated
        // (always-lowercase) `username`. A `pevo.authors[]` entry posted as
        // `{hive: 'Alice'}` would otherwise byte-mismatch and reject a
        // legitimate original-author's retract request on a bridge paper.
        authorized = paperAuthors.some((a) => normalizeHiveAccount(a.hive) === username);
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
    // Authority attribution: the acting human (paper author self-retract, or an
    // admin). The op is admin-signed, so issued_by names who triggered it.
    issued_by: username,
    timestamp: new Date().toISOString(),
  };

  try {
    const result = await broadcastAdminCustomJson(payload);
    // Invalidate retraction cache so the change is visible immediately
    void hafCache.invalidate('retracted-papers');
    sendOk(res, { message: 'Paper retracted', tx_id: result.id });
  } catch (err) {
    handleBroadcastError(res, err, {
      timeoutMsg: 'Broadcasting paper retraction timed out',
      failMsg: 'Failed to broadcast retraction to Hive',
      logContext: { author, permlink },
      routeLabel: 'papers.retract',
    });
  }
});

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink/cite
// ──────────────────────────────────────────────

const VALID_CITE_FORMATS = new Set(['bibtex', 'ris', 'apa']);

// `LINE_TERMINATORS` is the shared 10-character separator alphabet (CR, LF, VT,
// FF, FS, GS, RS, NEL, LS, PS) imported from `../lib/line-terminators.js`. `bibtexEscape`,
// `risEscape`, and `singleLine` below all flatten it so the citation-export and
// email-digest paths cannot drift to different separator alphabets; see that
// module's docblock for the file-format-injection rationale.

/**
 * Escape a free-form chain-sourced string for safe interpolation into a BibTeX
 * `@article{...}` field value. BibTeX/TeX treats `{` `}` as grouping, `\` as an
 * escape introducer, and `#$%&_^~` as specials; an un-escaped `}` (or a smuggled
 * `} @article{evil,...`) closes the entry early and lets an attacker-controlled
 * title forge additional records. Line terminators (the full LINE_TERMINATORS
 * alphabet, not just CR/LF) are flattened to a space since field values are
 * written one-per-line. Backslash is rewritten first so the escape sequences
 * this helper introduces are not themselves re-escaped. A non-string input (null/undefined or a wrong-typed chain field) coerces
 * to '' so a missing chain field cannot 500 the export at `.replace`.
 */
export function bibtexEscape(s: unknown): string {
  // Flatten line terminators first, then escape every metacharacter in a SINGLE
  // pass. A multi-pass approach (backslash -> braces -> specials) re-processes
  // the braces this helper itself emits for `\textbackslash{}`, double-escaping
  // them into `\textbackslash\{\}`. One pass over the original string avoids
  // touching any character the replacement introduces.
  const v = typeof s === 'string' ? s : '';
  return v.replace(LINE_TERMINATORS, ' ').replace(/[\\{}#$%&_^~]/g, (c) => {
    if (c === '\\') return '\\textbackslash{}';
    return `\\${c}`;
  });
}

/**
 * Escape a free-form chain-sourced string for a single RIS line. RIS is strictly
 * line-oriented (`XX  - value`) with no quoting mechanism, so any embedded line
 * terminator would split one field into multiple records or inject
 * attacker-crafted tag lines (`AU  - Fake`, `ER  -`). Stripping line terminators
 * (the full LINE_TERMINATORS alphabet) to spaces is the only safe option;
 * trailing/leading whitespace is trimmed for a clean record. A non-string input (null/undefined or a wrong-typed chain field)
 * coerces to ''.
 */
export function risEscape(s: unknown): string {
  const v = typeof s === 'string' ? s : '';
  return v.replace(LINE_TERMINATORS, ' ').trim();
}

/**
 * Flatten a free-form chain-sourced string to a single line for plain-text
 * citation output (APA). Prevents a line terminator (the full LINE_TERMINATORS
 * alphabet) in a title or author name from breaking the one-line citation into
 * multiple lines. A non-string input (null/undefined or a wrong-typed chain field) coerces to ''.
 */
export function singleLine(s: unknown): string {
  const v = typeof s === 'string' ? s : '';
  return v.replace(LINE_TERMINATORS, ' ').trim();
}

/**
 * Co-author display names for a citation export. The reliable name source is
 * `detail.authors`, NOT `detail.json_metadata.pevo` — `detail.json_metadata`
 * IS the raw chain metadata (PEvO data lives under `meta[config.appTag]`, read
 * via `safePevoMeta`), so a `.pevo` sub-key is never populated. `detail.authors`
 * carries a total `name` on every build path: the single-link projection
 * (`{name, hive, orcid}` from `safePevoMeta(meta).authors`), the SQL
 * `authorsWithSupersessionSelect` projection (COALESCE researcher_name → name →
 * hive → orcid), and the continuation/cumulative projection
 * (`buildCumulativeAuthorsForChain`, name resolved via `resolveAuthorName` and
 * filtered to entries that have a name). Non-string names are coerced to '' by
 * the escape helpers downstream.
 */
function citeAuthorNames(detail: Record<string, unknown>): string[] {
  const authors = Array.isArray(detail.authors)
    ? (detail.authors as Array<Record<string, unknown>>)
    : [];
  return authors.map((a) => (typeof a.name === 'string' ? a.name : ''));
}

/**
 * DOI for a citation export. Read from `safePevoMeta(detail.json_metadata).source.doi`
 * — the same `meta[config.appTag].source.doi` accessor the listing/detail
 * citation-count path uses. `detail.doi` is never assigned on the live path.
 */
function citeDoi(detail: Record<string, unknown>): string | undefined {
  const pevo = safePevoMeta((detail.json_metadata as Record<string, unknown>) ?? {});
  const doi = (pevo.source as Record<string, unknown>)?.doi;
  return typeof doi === 'string' && doi.length > 0 ? doi : undefined;
}

export function generateBibtex(detail: Record<string, unknown>): string {
  // Chain fields are coerced from their `as string` casts defensively: a
  // wrong-typed or absent title is unreachable today via Hive's chain-string
  // convention, but the cast is otherwise crash-reachable at `.split`.
  const author = typeof detail.author === 'string' ? detail.author : '';
  const title = typeof detail.title === 'string' ? detail.title : '';
  const created = detail.created as string;
  const year = new Date(created).getFullYear();
  const names = citeAuthorNames(detail);
  const firstWord = title.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') || 'paper';
  const key = `${author}_${firstWord}_${year}`;
  const authorStr = names.length > 0
    ? names.join(' and ')
    : author;
  const doi = citeDoi(detail);

  // The cite key is composed from a Hive username, a [a-z]-sanitized title word,
  // and a numeric year, so it cannot already contain BibTeX-breaking chars; the
  // escape is a defensive backstop in case any component widens.
  let bib = `@article{${bibtexEscape(key)},\n`;
  bib += `  title = {${bibtexEscape(title)}},\n`;
  bib += `  author = {${bibtexEscape(authorStr)}},\n`;
  bib += `  year = {${year}},\n`;
  bib += `  publisher = {PEvO (Publish and Evaluate Onchain)},\n`;
  bib += `  url = {https://pevo.science/papers/${author}/${detail.permlink}}`;
  if (doi) bib += `,\n  doi = {${bibtexEscape(doi)}}`;
  bib += `\n}`;
  return bib;
}

export function generateRis(detail: Record<string, unknown>): string {
  const author = typeof detail.author === 'string' ? detail.author : '';
  const title = typeof detail.title === 'string' ? detail.title : '';
  const created = detail.created as string;
  const year = new Date(created).getFullYear();
  const names = citeAuthorNames(detail);
  const doi = citeDoi(detail);

  const lines: string[] = [
    'TY  - JOUR',
    `TI  - ${risEscape(title)}`,
  ];
  if (names.length > 0) {
    for (const name of names) lines.push(`AU  - ${risEscape(name)}`);
  } else {
    lines.push(`AU  - ${risEscape(author)}`);
  }
  lines.push(`PY  - ${year}`);
  lines.push('PB  - PEvO (Publish and Evaluate Onchain)');
  lines.push(`UR  - https://pevo.science/papers/${author}/${detail.permlink}`);
  if (doi) lines.push(`DO  - ${risEscape(doi)}`);
  lines.push('ER  - ');
  return lines.join('\n');
}

export function generateApa(detail: Record<string, unknown>): string {
  const author = typeof detail.author === 'string' ? detail.author : '';
  const title = typeof detail.title === 'string' ? detail.title : '';
  const created = detail.created as string;
  const year = new Date(created).getFullYear();
  const names = citeAuthorNames(detail);

  const authorStr = names.length > 0
    ? names.map((name) => singleLine(name)).join(', ')
    : author;

  return `${singleLine(authorStr)} (${year}). ${singleLine(title)}. PEvO (Publish and Evaluate Onchain). https://pevo.science/papers/${author}/${detail.permlink}`;
}

router.get('/:author/:permlink/cite', async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;
  const format = (req.query.format as string || '').toLowerCase();

  if (!VALID_CITE_FORMATS.has(format)) {
    return sendError(res, 400, 'BAD_REQUEST', 'format must be one of: bibtex, ris, apa');
  }

  // Canonical-root walker is intentionally NOT invoked here. /cite and /retract
  // operate on the URL's own (author, permlink) — citation targets the URL post
  // directly; retraction authorizes username === URL author then broadcasts on
  // the URL's coords. Canonicalization is a display concern handled by the GET
  // handler. New /api/papers/:author/:permlink/<verb> routes that want canonical
  // resolution must call findCanonicalRoot themselves; do not pattern-match this
  // handler without checking.

  // Per-request wall-clock budget — same DoS-amplifier closure as the
  // primary GET handler and /retract. `fetchPaperDetailFromHaf` calls
  // the forward walker via `resolveContinuationChain`.
  const walkerAbort = new AbortController();
  const walkerBudget = setTimeout(() => walkerAbort.abort(), config.hafWalkerWallClockMs);
  let detail: Record<string, unknown> | null;
  try {
    detail = await fetchPaperDetailFromHaf(author, permlink, undefined, walkerAbort.signal) as Record<string, unknown> | null;
  } catch (err) {
    if (err instanceof HafQueryError && isRetriableHafError(err)) {
      // Cause-discriminated retriable envelope. Deterministic pg failures
      // fall through to the central 500 handler.
      return sendError(
        res,
        503,
        'SERVICE_UNAVAILABLE',
        'Citation export temporarily unavailable. Please retry shortly.',
        { retriable: true },
      );
    }
    throw err;
  } finally {
    clearTimeout(walkerBudget);
  }
  if (walkerAbort.signal.aborted) {
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'HAF walker budget exceeded; please retry', { retriable: true });
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

export default router;

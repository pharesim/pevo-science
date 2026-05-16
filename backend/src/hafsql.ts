/**
 * HafSQL query fragments.
 *
 * Since we cannot create views on the public HafSQL database, these
 * functions provide reusable SQL snippets (inline CTEs) for querying
 * PEvO data from the raw hafsql.* tables.
 *
 * All fragments use parameterized queries for config.appTag (defense-in-depth).
 * Each builder function accepts a `startIdx` (the next available $N parameter
 * index) and returns `{ sql, params, nextIdx }`.
 *
 * Real table mapping:
 *   hive.comments_view        → hafsql.comments
 *   hive.votes_view           → hafsql.operation_effective_comment_vote_view
 *   hive.custom_jsons_view    → hafsql.operation_custom_json_view
 *   hive.blocks_view          → hafsql.haf_blocks
 *   hafsql.balances           → account HP for vote weighting
 *   hafsql.accounts           → posting keys for signature verification
 *
 * Key differences from the speculative schema:
 *   - hafsql.comments.json_metadata is already jsonb (no ::jsonb cast needed)
 *   - hafsql.comments has no net_votes, children, or block_num columns
 *   - hafsql.operation_custom_json_view uses custom_id (not id), json is text
 *   - hafsql.operation_effective_comment_vote_view has rshares (numeric)
 *   - hafsql.operation_comment_view has block_num (useful for notifications)
 */

import { config } from './config.js';
import { logger } from './logger.js';

// ─── SQL fragment type ───────────────────────────────────────────

export interface SqlFragment {
  sql: string;
  params: unknown[];
  nextIdx: number;
}

// ─── Tables ───────────────────────────────────────────────────────

export const T = {
  comments: 'hafsql.comments',
  commentOps: 'hafsql.operation_comment_view',
  votes: 'hafsql.operation_effective_comment_vote_view',
  voteOps: 'hafsql.operation_vote_view',
  customJson: 'hafsql.operation_custom_json_view',
  blocks: 'hafsql.haf_blocks',
  accounts: 'hafsql.accounts',
  balances: 'hafsql.balances',
} as const;

// ─── Common CTEs ──────────────────────────────────────────────────

/**
 * CTE body that computes the current accreditation status per account.
 * Replaces `pevo.active_accreditations`.
 *
 * @param startIdx - first available $N parameter index
 * @returns SqlFragment with the CTE body (without WITH keyword)
 */
export function activeAccreditationsCteBody(startIdx = 1): SqlFragment {
  const p = startIdx;
  return {
    sql: `
  accred_ranked AS (
    SELECT
      cj.json::jsonb ->> 'action' AS action,
      cj.json::jsonb ->> 'account' AS account,
      cj.json::jsonb ->> 'name' AS researcher_name,
      cj.json::jsonb ->> 'institution' AS institution,
      cj.json::jsonb ->> 'field' AS field,
      cj.json::jsonb ->> 'method' AS method,
      cj.json::jsonb ->> 'orcid' AS orcid,
      cj.json::jsonb ->> 'timestamp' AS event_timestamp,
      cj.id AS event_id,
      ROW_NUMBER() OVER (PARTITION BY cj.json::jsonb ->> 'account' ORDER BY cj.block_num DESC) AS rn
    FROM ${T.customJson} cj
    WHERE cj.custom_id = $${p}
      AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
      AND cj.required_posting_auths ?| $${p + 1}::text[]
      AND cj.block_num >= $${p + 2}
  ),
  active_accreditations AS (
    SELECT account, researcher_name, institution, field, method, orcid, event_timestamp, event_id
    FROM accred_ranked
    WHERE rn = 1 AND action = 'accredit'
  )`,
    params: [config.appTag, config.accreditationAuthorities, getCachedGenesisBlock()],
    nextIdx: p + 3,
  };
}

/**
 * Full CTE including WITH keyword for standalone use.
 */
export function activeAccreditationsCte(startIdx = 1): SqlFragment {
  const body = activeAccreditationsCteBody(startIdx);
  return { sql: `WITH ${body.sql}`, params: body.params, nextIdx: body.nextIdx };
}

/**
 * CTE body that derives a per-account accreditation status row for every
 * account that has ever been accredited. Distinguishes 'active' from
 * 'revoked' so post-revocation audit visibility can be preserved on
 * forged-ORCID claims (`backend-orcid-claim-mismatch-post-revocation-audit.md`).
 *
 * Composition contract: this CTE MUST be combined with
 * `activeAccreditationsCteBody` in the same WITH block (it depends on
 * `accred_ranked`, which `activeAccreditationsCteBody` materializes).
 *
 * Shape per row:
 *   - account: hive account
 *   - status: 'active' (most-recent action is `accredit`) | 'revoked'
 *     (most-recent action is `revoke`)
 *   - orcid:  for 'active' rows, the ORCID from the most-recent `accredit`
 *             event for the account (the same value `active_accreditations`
 *             carries). For 'revoked' rows, the ORCID from the most-recent
 *             *prior* `accredit` event for the account — looked up via
 *             LATERAL against `accred_ranked` filtered to `action='accredit'`,
 *             ordered by `rn ASC` (lowest rn = most recent due to the DESC
 *             ROW_NUMBER ordering inside `accred_ranked`).
 *
 * **Multi-cycle correctness.** A bad actor can accredit → forge → revoke →
 * re-accredit (operator restored access) → forge again → revoke. After the
 * second revoke, the lookup MUST return the ORCID from the second `accredit`
 * (the one currently being audited), NOT the first. The LATERAL subquery
 * orders by `rn ASC` against `accred_ranked` (which is partitioned by
 * `account` and ordered by `block_num DESC`), so `rn = 1` for the
 * most-recent accredit, `rn = 2` for the next-most-recent, and so on.
 * `LIMIT 1` picks the most-recent accredit. The second-cycle test canary
 * in `papers-cumulative-orcid-audit.test.ts` pins this.
 *
 * Why a separate CTE and not an extension of `active_accreditations`:
 * `active_accreditations` is consumed throughout the codebase as a
 * filtered membership view (`WHERE rn = 1 AND action = 'accredit'`).
 * Including revoked rows there would silently widen every consumer's set,
 * including reputation-cycle filters and vote-eligibility gates. The
 * status CTE is additive and only audit emission consumes it.
 */
export function accreditationStatusCteBody(startIdx = 1): SqlFragment {
  return {
    sql: `
  accreditation_status AS (
    SELECT
      ar.account,
      CASE WHEN ar.action = 'accredit' THEN 'active' ELSE 'revoked' END AS status,
      CASE
        WHEN ar.action = 'accredit' THEN ar.orcid
        ELSE (
          SELECT prior.orcid FROM accred_ranked prior
          WHERE prior.account = ar.account
            AND prior.action = 'accredit'
          ORDER BY prior.rn ASC
          LIMIT 1
        )
      END AS orcid
    FROM accred_ranked ar
    WHERE ar.rn = 1
  )`,
    params: [],
    nextIdx: startIdx,
  };
}

/**
 * CTE body that computes the latest vouch/unvouch action per (voucher, vouchee) pair.
 * Replaces `pevo.active_vouches`.
 *
 * Requires `active_accreditations` CTE to already be in scope (combine with
 * activeAccreditationsCteBody in the same WITH block).
 *
 * @param startIdx - first available $N parameter index
 */
export function activeVouchesCteBody(startIdx = 1): SqlFragment {
  const p = startIdx;
  return {
    sql: `
  vouch_ranked AS (
    SELECT
      cj.json::jsonb ->> 'action' AS action,
      cj.json::jsonb ->> 'voucher' AS voucher,
      cj.json::jsonb ->> 'vouchee' AS vouchee,
      cj.json::jsonb ->> 'relationship' AS relationship,
      cj.json::jsonb ->> 'timestamp' AS event_timestamp,
      ROW_NUMBER() OVER (
        PARTITION BY cj.json::jsonb ->> 'voucher', cj.json::jsonb ->> 'vouchee'
        ORDER BY cj.block_num DESC
      ) AS rn
    FROM ${T.customJson} cj
    WHERE cj.custom_id = $${p}
      AND cj.json::jsonb ->> 'action' IN ('vouch', 'retract_vouch')
      AND cj.block_num >= $${p + 1}
  ),
  active_vouches AS (
    SELECT voucher, vouchee, relationship, event_timestamp
    FROM vouch_ranked
    WHERE rn = 1 AND action = 'vouch'
  )`,
    params: [config.appTag, getCachedGenesisBlock()],
    nextIdx: p + 2,
  };
}

// ─── Retracted papers CTE ────────────────────────────────────────

/**
 * CTE body for retracted papers. Returns (author, permlink) pairs.
 * Use inside a WITH block alongside other CTEs.
 *
 * @param startIdx - first available $N parameter index
 */
export function retractedPapersCteBody(startIdx = 1): SqlFragment {
  const p = startIdx;
  return {
    sql: `
  retracted_papers AS (
    SELECT DISTINCT
      cj.json::jsonb ->> 'author' AS author,
      cj.json::jsonb ->> 'permlink' AS permlink
    FROM ${T.customJson} cj
    WHERE cj.custom_id = $${p}
      AND cj.json::jsonb ->> 'action' = 'retract_paper'
      AND cj.block_num >= $${p + 1}
  )`,
    params: [config.appTag, getCachedGenesisBlock()],
    nextIdx: p + 2,
  };
}

// ─── PEvO content filters ────────────────────────────────────────

/**
 * Canonical SQL fragment that matches a structurally valid PEvO review row.
 *
 * **Why this helper exists.** Each review-aggregating site (paper-detail
 * reviews array, listing `review_count`/`avg_rating`, reputation's
 * `paper_reviews` quality multiplier, reviewer reputation, notifications,
 * search type=review) used to handcraft `(json_metadata -> $appTag ->>
 * 'type') = 'review' AND json_metadata ->> 'app' LIKE '<appTag>/%'`. Two
 * failure modes followed:
 *
 *   1. The `app LIKE` gate excluded valid reviews authored via non-PEvO
 *      Hive clients (peakd, ecency, raw broadcast). Per CLAUDE.md
 *      "accreditation is the trust layer", the authoring client is not
 *      load-bearing — an accredited scientist's review is a PEvO review
 *      regardless of which UI minted it. (Same failure mode as the
 *      discussion-comments fix in commit `d92e605`.)
 *
 *   2. Type-only validation admitted review-shaped replies with missing,
 *      partial, or non-numeric `rating` objects. Downstream callers then
 *      cast those values to `numeric` (paper-quality multipliers in
 *      `reputation.ts`) or defaulted them to `{methodology: 0, ...}` for
 *      display, both of which silently corrupt review aggregates.
 *
 * The display↔reputation parity invariant requires one canonical predicate
 * everywhere: any row surfaced as a review on the page MUST contribute to
 * `review_count`, `avg_rating`, the paper's quality multiplier, and (when
 * the reviewer is in the cycle) the reviewer's `user_reviews`.
 *
 * **Trust-layer note.** This helper does NOT bake in the accreditation
 * predicate (author must be in `active_accreditations` OR equal
 * `config.hiveAnonAccount`). Callers compose accreditation in whatever
 * shape fits their context — `EXISTS`, `IN (SELECT ...)`, `JOIN`, or `=
 * ANY($N::text[])` of a pre-filtered array. The parity invariant holds
 * when both this fragment AND the accreditation predicate are applied at
 * every review-aggregating site.
 *
 * **Rating-shape gate.** The regex form `~ '^[1-5]$'` over `->>` text is
 * portable across HAF readers AND safe against attacker-controlled JSON
 * values. The naive `::numeric` cast on user-supplied JSON (e.g. a string
 * `"five"` or an object `{"score": 4}`) crashes the enclosing query — see
 * the `paper_reviews` quality CTE in `reputation.ts` for the load-bearing
 * site where a malformed rating used to be able to abort a reputation
 * cycle. This regex rejects non-integer, out-of-range, and structurally
 * non-scalar rating values at the SQL gate so downstream casts only see
 * shapes they can consume.
 *
 * The caller allocates the parameter index for the appTag bind and pushes
 * `config.appTag` onto its params array; this helper returns just the SQL
 * fragment string (no params, no nextIdx — its input is a param-string
 * reference the caller has already accounted for).
 *
 * @param opts.commentAlias - SQL alias for the comments row (default 'c').
 *   Notification queries use 'co' (commentOps).
 * @param opts.appTagParam - the caller-allocated `$N` reference for
 *   `config.appTag`.
 *
 * @example
 *   const appTagParam = `$${paramIdx++}`;
 *   params.push(config.appTag);
 *   conditions.push(validReviewWhere({ commentAlias: 'c', appTagParam }));
 */
export function validReviewWhere(opts: {
  commentAlias?: string;
  appTagParam: string;
}): string {
  const alias = opts.commentAlias ?? 'c';
  const appTag = opts.appTagParam;
  // jsonb_typeof(... 'rating') = 'object' is load-bearing: a bare
  // `IS NOT NULL` check passes JSONB null (`'null'::jsonb IS NOT NULL` is
  // TRUE because JSONB has an internal `null` value distinct from SQL
  // NULL), JSONB strings, JSONB arrays, and JSONB numbers — only `=
  // 'object'` narrows the rating to a shape whose `->> 'methodology'` /
  // etc. reads can meaningfully apply. The four regex lines below catch
  // non-object shapes today via NULL propagation; the explicit
  // jsonb_typeof check makes that intent self-documenting so a future
  // maintainer can't delete the regex on the assumption that the
  // (defunct) `IS NOT NULL` line enforces shape.
  return `(
    (${alias}.json_metadata -> ${appTag} ->> 'type') = 'review'
    AND jsonb_typeof(${alias}.json_metadata -> ${appTag} -> 'rating') = 'object'
    AND (${alias}.json_metadata -> ${appTag} -> 'rating' ->> 'methodology')  ~ '^[1-5]$'
    AND (${alias}.json_metadata -> ${appTag} -> 'rating' ->> 'novelty')      ~ '^[1-5]$'
    AND (${alias}.json_metadata -> ${appTag} -> 'rating' ->> 'clarity')      ~ '^[1-5]$'
    AND (${alias}.json_metadata -> ${appTag} -> 'rating' ->> 'significance') ~ '^[1-5]$'
  )`;
}

/**
 * SQL WHERE fragment that excludes self-reviews — reviews where the
 * reviewer is the paper author OR a named co-author of the same paper.
 *
 * **Why this helper exists.** Self-votes are already excluded from every
 * vote-aggregating surface (paper-class via `paper_resolved_votes` at
 * `reputation.ts:551-561`; review-class via `c2.weight != 0 AND
 * lv.voter != v.author` patterns). The principle is settled: an
 * account cannot vote for itself. Self-reviews were the symmetric gap
 * — an accredited paper author (or named co-author who is accredited)
 * could broadcast a review-shaped reply to their own paper and inflate
 * five surfaces: paper-detail review list, listing `review_count` /
 * `avg_rating`, the reputation `paper_reviews.quality` multiplier
 * (load-bearing — pushes the paper's vote-derived score toward 1.0×
 * via a self-5/5/5/5), the reviewer's `user_reviews` cycle universe,
 * and the paper author's "new review" notification on their own post.
 *
 * **What this excludes.**
 *   - The paper author's own review of their paper.
 *   - Reviews whose author appears as a named `.hive` entry in the
 *     paper's `pevo.authors[]` array (the co-author set the
 *     publishing UI records).
 *
 * **What this does NOT exclude.** Accepted authorship-claim claimants.
 * The task acceptance criteria's compromise clause permits this gap:
 * resolving claims requires the `authorship_claims` CTE, which isn't
 * trivially join-able at every callsite (especially the deep CTE
 * chain in `reputation.ts`). The same gap exists in the precedent
 * `paper_resolved_votes` (it pre-dates claims integration). When the
 * vote path picks up claims, this helper should too.
 *
 * **Composition with the paper row.** The helper requires the paper
 * row to be in SQL scope under `paperRowAlias` (with `.author` and
 * `.json_metadata` columns). For sites that don't naturally have the
 * paper row in scope (paper-detail reviews query, profile reviews,
 * search reviews, stats reviews), the caller adds a JOIN against
 * `hafsql.comments` keyed on `c.parent_author = p.author AND
 * c.parent_permlink = p.permlink` before invoking the helper. The
 * JOIN is the SQL equivalent of "look up the paper this review
 * belongs to."
 *
 * @param opts.commentAlias - SQL alias for the review row (must have
 *   `.author`). Optional, defaults to `'c'` to match sibling helpers
 *   (`validReviewWhere`, `validPevoPaperWhere`). Typically 'c', 'r', 'rv', 'c2'.
 * @param opts.paperRowAlias - SQL alias for the parent paper row (must
 *   have `.author` and `.json_metadata`). Typically 'p', 'up', 'up2'.
 * @param opts.appTagParam - the caller-allocated `$N` reference for
 *   `config.appTag`.
 *
 * @example
 *   // Reputation paper_reviews CTE: paper row is `up`, review is `c` (default).
 *   conditions.push(excludeSelfReviewWhere({
 *     paperRowAlias: 'up',
 *     appTagParam: '$3',
 *   }));
 *
 * @example
 *   // Paper-detail reviews query: add a JOIN, then invoke the helper.
 *   //   JOIN hafsql.comments p ON p.author = $1 AND p.permlink = $2
 *   //   WHERE ... AND ${excludeSelfReviewWhere({...paperRowAlias: 'p'})}
 *
 * `commentAlias` defaults to `'c'` to match sibling helpers
 * (`validReviewWhere`, `validPevoPaperWhere`) — reduces parameter-naming
 * asymmetry across the helper set (BACKEND-SELF-REVIEW-EXCLUSION round-1
 * hold #9). The `jsonb_typeof(...) = 'array'` guard before
 * `jsonb_array_elements` defends against a chain post broadcasting a
 * non-array `pevo.authors` (null, string, integer, object) — without it,
 * Postgres raises at runtime and the reputation cycle cascade-fails for
 * every user (BACKEND-SELF-REVIEW-EXCLUSION round-1 hold #2; companion to
 * `pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12`).
 */
export function excludeSelfReviewWhere(opts: {
  commentAlias?: string;
  paperRowAlias: string;
  appTagParam: string;
}): string {
  const r = opts.commentAlias ?? 'c';
  const p = opts.paperRowAlias;
  const tag = opts.appTagParam;
  // `jsonb_typeof(auth) = 'object'` inside the EXISTS predicate is a
  // cascade-fail defense, NOT a co-author admission tightening. It works
  // alongside the outer CASE-WHEN array guard (round-1 hold #2) to defend
  // the helper against malformed `pevo.authors` shapes on chain.
  //
  // What this guard prevents: a chain post whose `authors` element is a
  // JSONB scalar (string, integer, null literal) would otherwise reach the
  // `auth ->> 'hive' = ${r}.author` predicate inside the EXISTS subquery.
  // `->>` only extracts object keys; on a JSONB scalar it returns NULL.
  // `NULL = ${r}.author` evaluates to NULL (not TRUE), the EXISTS subquery
  // yields 0 rows, and NOT EXISTS unconditionally evaluates TRUE. That's
  // not a wrong admit class per se — it falls back to the first conjunct
  // (`${r}.author != ${p}.author`) which still excludes the paper author —
  // but the cleaner shape is to filter non-objects at the element level so
  // the predicate's intent (match author identity by `.hive` key) is
  // self-evident in the SQL and not implicit in `->>`-on-scalar semantics.
  //
  // What this guard does NOT prevent: bare-string author entries in
  // `authors[]` are intentionally NOT treated as co-author identity claims.
  // A paper broadcast with `authors: ["alice","bob"]` (strings, not
  // objects with a `hive` key) does NOT exclude `bob` from reviewing
  // `alice`'s paper as a non-self reviewer — bob falls through to the
  // second conjunct, the EXISTS subquery yields 0 rows (the `'object'`
  // filter rejects the strings), and NOT EXISTS evaluates TRUE so bob is
  // admitted. This is INTENTIONAL: per
  // `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28`,
  // a PEvO `authors[]` entry is a well-formed object with a `hive` key,
  // not a free-text identity claim. Treating bare strings as co-author
  // identity would enable a cheap denial-of-review attack: anyone could
  // broadcast a non-paper post with `authors: [target]` to lock `target`
  // out of reviewing the post's parent paper.
  //
  // Behavioral coverage of both cases lives in `hafsql.test.ts` —
  // (1) non-array top-level shapes, (2) array-of-non-objects shapes.
  return `(
    ${r}.author != ${p}.author
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(${p}.json_metadata -> ${tag} -> 'authors') = 'array'
          THEN ${p}.json_metadata -> ${tag} -> 'authors'
          ELSE '[]'::jsonb
        END
      ) auth
      WHERE jsonb_typeof(auth) = 'object'
        AND auth ->> 'hive' = ${r}.author
    )
  )`;
}

/**
 * Centralized SQL fragment that matches a valid PEvO paper row by type AND
 * (for bridge papers) author identity.
 *
 * **Why this helper exists.** A PEvO paper's identity is established by author
 * vouching, not by a self-asserted metadata flag. Native papers are vouched-for
 * by the post author being in `active_accreditations`; bridge papers are
 * vouched-for by the post author being `config.hiveBridgeAccount`. Any place
 * the codebase filters or admits rows on `(json_metadata -> $appTag ->> 'type')
 * = 'bridge_paper'` (or `IN ('paper', 'bridge_paper')`) without an author
 * predicate is admitting attacker-controlled rows: any Hive account can post a
 * comment with `parent_permlink = '<appTag>'` and `json_metadata.<appTag>.type
 * = 'bridge_paper'` and the type-only filter happily admits it.
 *
 * Routes that touch paper-class content MUST compose against this helper
 * rather than handcrafting the predicate. The ESLint discipline rule
 * `pevo/no-bridge-paper-literal` (defined inline in `eslint.config.mjs`)
 * enforces no direct `'bridge_paper'` string literals — including simple
 * constant-folded forms (concat, no-interp template, literal-array .join()) —
 * in non-allowlisted files.
 *
 * The caller allocates parameter indexes for the appTag and bridgeAccount
 * binds and pushes the values onto its params array; this helper returns just
 * the SQL fragment string (no params, no nextIdx — its inputs are param-string
 * references that the caller has already accounted for).
 *
 * @param opts.commentAlias - SQL alias for the comments row (default 'c').
 * @param opts.appTagParam - the caller-allocated `$N` reference for `config.appTag`.
 * @param opts.bridgeAccountParam - the caller-allocated `$N` reference for `config.hiveBridgeAccount`.
 * @param opts.source - which paper-class to admit. Default 'all'.
 *   - 'native':  only `type = 'paper'` (no author pin needed; native papers
 *                are gated separately by accreditation downstream).
 *   - 'bridge':  only `type = 'bridge_paper' AND author = $bridgeAccount`.
 *   - 'all':     'paper' UNION the pinned 'bridge_paper'.
 *
 * @example
 *   const appTagParam = `$${paramIdx++}`;
 *   const bridgeAccountParam = `$${paramIdx++}`;
 *   params.push(config.appTag, config.hiveBridgeAccount);
 *   conditions.push(validPevoPaperWhere({
 *     commentAlias: 'c',
 *     appTagParam,
 *     bridgeAccountParam,
 *   }));
 */
export function validPevoPaperWhere(opts: {
  commentAlias?: string;
  appTagParam: string;
  bridgeAccountParam: string;
  source?: 'native' | 'bridge' | 'all';
}): string {
  const alias = opts.commentAlias ?? 'c';
  const source = opts.source ?? 'all';
  const typeExpr = `(${alias}.json_metadata -> ${opts.appTagParam} ->> 'type')`;
  const authorExpr = `${alias}.author`;
  const nativeArm = `${typeExpr} = 'paper'`;
  const bridgeArm = `(${authorExpr} = ${opts.bridgeAccountParam} AND ${typeExpr} = 'bridge_paper')`;
  if (source === 'native') return nativeArm;
  if (source === 'bridge') return bridgeArm;
  return `(${nativeArm} OR ${bridgeArm})`;
}

// ─── Authorship claims CTE ──────────────────────────────────────

/**
 * Narrows the set of claim_events materialized by `authorshipClaimsCteBody`.
 * The CASE inside `authorship_claims` correlates on (claimer, paper_author,
 * paper_permlink). Scopes must match that key shape so approve/revoke rows
 * retained for a given claim remain in scope.
 */
export type AuthorshipClaimsScope =
  | { claimer: string }
  | { paperAuthor: string; paperPermlink: string };

/**
 * CTE body for authorship claims. Computes claim status (accepted/pending/revoked)
 * for each (claimer, paper_author, paper_permlink) combination.
 *
 * Auto-accept conditions:
 * - Claimer's verified ORCID matches authors[author_index].orcid in paper metadata
 * - authors[author_index].hive matches the claimer's username
 *
 * Requires `active_accreditations` CTE to be in scope.
 *
 * Claimer derivation:
 *   COALESCE(cj.json::jsonb ->> 'claimer', cj.required_posting_auths ->> 0)
 * This asymmetry is load-bearing, per agents/docs/hive-schemas.md:
 *   - §2.9 claim_authorship    — JSON omits `claimer` (signer IS the claimer;
 *                                 proven by required_posting_auths).
 *   - §2.10 approve_authorship — JSON includes `claimer` explicitly (signer is
 *                                 the approver, not the claimer).
 *   - §2.11 revoke_authorship  — JSON includes `claimer` explicitly (signer is
 *                                 the approver, post author, admin, or the
 *                                 claimer themselves).
 * COALESCE yields the correct claimer for all three actions. The claimer-scope
 * filter below MUST use the identical expression as `claims_base.claimer` so
 * scoped queries see the same row set the unscoped CASE correlates against.
 *
 * @param startIdx - first available $N parameter index
 * @param scope - optional narrowing filter pushed into `claim_events`. Without
 *   a scope the CTE materializes every claim event in PEvO history. Scoping by
 *   claimer or paper key avoids that full scan. The scope key must match the
 *   dimension the caller filters on downstream, since the CASE's EXISTS
 *   subqueries correlate on the same key.
 */
export function authorshipClaimsCteBody(
  startIdx = 1,
  scope?: AuthorshipClaimsScope,
): SqlFragment {
  const p = startIdx;
  let scopeIdx = p + 3;
  let scopeFilter = '';
  const scopeParams: unknown[] = [];
  if (scope) {
    if ('claimer' in scope) {
      scopeFilter = `
      AND COALESCE(cj.json::jsonb ->> 'claimer', cj.required_posting_auths ->> 0) = $${scopeIdx}`;
      scopeParams.push(scope.claimer);
      scopeIdx += 1;
    } else {
      scopeFilter = `
      AND cj.json::jsonb ->> 'paper_author' = $${scopeIdx}
      AND cj.json::jsonb ->> 'paper_permlink' = $${scopeIdx + 1}`;
      scopeParams.push(scope.paperAuthor, scope.paperPermlink);
      scopeIdx += 2;
    }
  }
  return {
    sql: `
  claim_events AS (
    SELECT
      cj.json::jsonb ->> 'action' AS action,
      COALESCE(cj.json::jsonb ->> 'claimer', cj.required_posting_auths ->> 0) AS claimer,
      cj.json::jsonb ->> 'paper_author' AS paper_author,
      cj.json::jsonb ->> 'paper_permlink' AS paper_permlink,
      (cj.json::jsonb ->> 'author_index')::int AS author_index,
      cj.block_num,
      cj.json::jsonb ->> 'timestamp' AS event_timestamp
    FROM ${T.customJson} cj
    WHERE cj.custom_id = $${p}
      AND cj.json::jsonb ->> 'action' IN ('claim_authorship', 'approve_authorship', 'revoke_authorship')
      AND cj.block_num >= $${p + 1}${scopeFilter}
  ),
  claims_base AS (
    SELECT claimer, paper_author, paper_permlink, author_index, block_num, event_timestamp
    FROM claim_events
    WHERE action = 'claim_authorship'
  ),
  approvals AS (
    SELECT claimer, paper_author, paper_permlink, block_num
    FROM claim_events
    WHERE action = 'approve_authorship'
  ),
  revocations AS (
    SELECT claimer, paper_author, paper_permlink, block_num
    FROM claim_events
    WHERE action = 'revoke_authorship'
  ),
  authorship_claims AS (
    SELECT
      cb.claimer,
      cb.paper_author,
      cb.paper_permlink,
      cb.author_index,
      cb.event_timestamp AS claimed_at,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM revocations rv
          WHERE rv.claimer = cb.claimer
            AND rv.paper_author = cb.paper_author
            AND rv.paper_permlink = cb.paper_permlink
            AND rv.block_num > cb.block_num
            AND rv.block_num > COALESCE((
              SELECT MAX(ap.block_num) FROM approvals ap
              WHERE ap.claimer = cb.claimer
                AND ap.paper_author = cb.paper_author
                AND ap.paper_permlink = cb.paper_permlink
            ), 0)
        ) THEN 'revoked'
        WHEN EXISTS (
          SELECT 1 FROM approvals ap
          WHERE ap.claimer = cb.claimer
            AND ap.paper_author = cb.paper_author
            AND ap.paper_permlink = cb.paper_permlink
            AND ap.block_num > cb.block_num
        ) THEN 'accepted'
        WHEN cb.author_index IS NOT NULL AND EXISTS (
          SELECT 1 FROM ${T.comments} c
          JOIN active_accreditations aa ON aa.account = cb.claimer
          WHERE c.author = cb.paper_author
            AND c.permlink = cb.paper_permlink
            AND c.parent_author = ''
            AND (
              (c.json_metadata -> $${p + 2} -> 'authors' -> cb.author_index ->> 'orcid') IS NOT NULL
              AND aa.orcid IS NOT NULL
              AND aa.orcid != ''
              AND (c.json_metadata -> $${p + 2} -> 'authors' -> cb.author_index ->> 'orcid') = aa.orcid
            )
        ) THEN 'accepted'
        WHEN cb.author_index IS NOT NULL AND EXISTS (
          SELECT 1 FROM ${T.comments} c
          WHERE c.author = cb.paper_author
            AND c.permlink = cb.paper_permlink
            AND c.parent_author = ''
            AND (c.json_metadata -> $${p + 2} -> 'authors' -> cb.author_index ->> 'hive') = cb.claimer
        ) THEN 'accepted'
        ELSE 'pending'
      END AS status
    FROM claims_base cb
  )`,
    params: [config.appTag, getCachedGenesisBlock(), config.appTag, ...scopeParams],
    nextIdx: scopeIdx,
  };
}

// ─── Genesis block ──────────────────────────────────────────────

/**
 * The block number of the first accreditation custom_json in this namespace.
 * Nothing PEvO-related exists before this block — use it as a floor for all
 * queries that accept a since_block parameter.
 *
 * Discovered once from HAF on first call, then cached permanently.
 */
let genesisBlock: number | null = null;

export async function getGenesisBlock(pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }): Promise<number> {
  if (genesisBlock !== null) return genesisBlock;

  try {
    const result = await pool.query(
      `SELECT MIN(cj.block_num) AS genesis
       FROM ${T.customJson} cj
       WHERE cj.custom_id = $1
         AND cj.json::jsonb ->> 'action' = 'accredit'`,
      [config.appTag],
    );
    const block = Number(result.rows[0]?.genesis);
    if (block && block > 0) {
      genesisBlock = block;
      logger.info({ genesisBlock }, 'PEvO genesis block discovered');
      return genesisBlock;
    }
  } catch (err) {
    logger.error({ err }, 'Failed to query genesis block');
  }

  // Fallback: use current head block — nothing PEvO-related can exist before now
  try {
    const headResult = await pool.query(`SELECT MAX(block_num) AS head FROM ${T.blocks}`, []);
    const head = Number(headResult.rows[0]?.head);
    if (head && head > 0) {
      genesisBlock = head;
      logger.info({ genesisBlock: head }, 'No accreditations yet — using head block as genesis floor');
      return genesisBlock;
    }
  } catch (headErr) {
    logger.error({ err: headErr }, 'Failed to query head block for genesis fallback');
  }

  return 0;
}

/**
 * Synchronous access to the cached genesis block number.
 * Returns 0 if not yet initialized (getGenesisBlock hasn't been called).
 */
export function getCachedGenesisBlock(): number {
  return genesisBlock ?? 0;
}

// ─── Vote count subquery ─────────────────────────────────────────

/**
 * Subquery that counts accredited upvotes for a given (author, permlink).
 * Returns an int. Use as a scalar subquery in SELECT.
 *
 * Requires `active_accreditations` CTE to be in scope.
 *
 * @param authorExpr - SQL expression for the author (e.g., 'c.author')
 * @param permlinkExpr - SQL expression for the permlink (e.g., 'c.permlink')
 */
export function accreditedVoteCount(authorExpr: string, permlinkExpr: string): string {
  return `(SELECT COALESCE(SUM(CASE WHEN lv.weight > 0 THEN 1 WHEN lv.weight < 0 THEN -1 ELSE 0 END), 0)::int FROM (
    SELECT DISTINCT ON (v.voter) v.weight FROM ${T.voteOps} v
    JOIN active_accreditations aa ON aa.account = v.voter
    WHERE v.author = ${authorExpr} AND v.permlink = ${permlinkExpr}
      AND v.voter != ${authorExpr}
    ORDER BY v.voter, v.block_num DESC
  ) lv WHERE lv.weight != 0)`;
}

/**
 * SQL fragment that projects the `authors[]` array with supersession
 * fields (`orcid_verified`, `orcid_discrepancy`) joined per-author against
 * the `active_accreditations` CTE. Used by the paper-listing and
 * paper-detail endpoints to surface the discrepancy between the
 * chain-stored ORCID and the accreditation-attested ORCID, per
 * `agents/docs/hive-schemas.md` § 1.1 "Canonical SQL pattern".
 *
 * Requires `active_accreditations` CTE to be in scope (combine with
 * `activeAccreditationsCteBody` in the same WITH block).
 *
 * The pattern uses `jsonb_array_elements WITH ORDINALITY` so the per-author
 * lookup happens in a single query rather than a per-paper round-trip,
 * which matters for list endpoints joining many papers' authors at once.
 * `ORDER BY a.ordinality` preserves the chain `authors[]` array order; the
 * outer `COALESCE(..., '[]'::jsonb)` collapses the SQL-NULL that
 * `jsonb_agg` returns for an empty/missing `authors[]` array to a JSON
 * empty array, matching the JS-side `pevo.authors || []` shape.
 *
 * Supersession cases handled naturally by the LEFT JOIN (per `hive-schemas.md`
 * § 1.1 notes):
 *   - `authors[i].hive` empty/absent → no JOIN match → `aa.orcid` NULL →
 *     `orcid_verified` NULL → `orcid_discrepancy` false.
 *   - `authors[i].hive` set but not currently accredited → no JOIN match →
 *     same as above.
 *   - `authors[i].hive` accredited but the accreditation carries NULL
 *     `orcid` → JOIN matches but `aa.orcid` NULL → same as above.
 *   - `authors[i].hive` accredited with a non-NULL accreditation `orcid` →
 *     `orcid_verified = aa.orcid`; `orcid_discrepancy = true` IFF the
 *     chain `orcid` is also non-null AND differs from `aa.orcid`.
 *
 * @param commentAlias - SQL alias for the post row (e.g., 'c', 'p').
 * @param appTagParam - bind-param placeholder for `config.appTag` (e.g., '$3').
 * @returns SQL fragment (parenthesized subselect) suitable for inlining in
 *   a SELECT projection. Aliased by the caller via `AS authors_with_supersession`
 *   or similar; the fragment itself is column-alias-free for placement
 *   flexibility.
 */
export function authorsWithSupersessionSelect(commentAlias: string, appTagParam: string): string {
  return `COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'name',              a.elem ->> 'name',
        'hive',              a.elem ->> 'hive',
        'orcid',             a.elem ->> 'orcid',
        'affiliation',       a.elem ->> 'affiliation',
        'orcid_verified',    aa.orcid,
        'orcid_discrepancy', CASE
                               WHEN aa.orcid IS NOT NULL
                                AND (a.elem ->> 'orcid') IS NOT NULL
                                AND aa.orcid <> (a.elem ->> 'orcid')
                               THEN true
                               ELSE false
                             END
      )
      ORDER BY a.ordinality
    )
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(${commentAlias}.json_metadata -> ${appTagParam} -> 'authors') = 'array'
           THEN ${commentAlias}.json_metadata -> ${appTagParam} -> 'authors'
           ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS a(elem, ordinality)
    LEFT JOIN active_accreditations aa ON aa.account = (a.elem ->> 'hive')
  ), '[]'::jsonb)`;
}

/**
 * Build a combined WITH clause from multiple CTE body fragments.
 * Returns the combined SQL, all params, and the next available parameter index.
 */
export function buildWith(startIdx: number, ...cteBuilders: Array<(idx: number) => SqlFragment>): SqlFragment {
  const allParams: unknown[] = [];
  const cteParts: string[] = [];
  let idx = startIdx;
  for (const builder of cteBuilders) {
    const frag = builder(idx);
    cteParts.push(frag.sql);
    allParams.push(...frag.params);
    idx = frag.nextIdx;
  }
  return { sql: `WITH ${cteParts.join(', ')}`, params: allParams, nextIdx: idx };
}

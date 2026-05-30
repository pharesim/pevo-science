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

// ─── BTRIM whitespace charset (chain orcid normalization) ─────────

/**
 * PostgreSQL `BTRIM(text, chars)` charset for stripping ASCII C-whitespace
 * from broadcaster-controlled chain `orcid` values. Used at every SQL site
 * that compares a chain-supplied ORCID against a chain-validated canonical
 * ORCID (the JS-side mirror is `String.prototype.trim()` in
 * `computeSupersession`).
 *
 * The bytes are: space (0x20), tab (0x09), LF (0x0A), CR (0x0D),
 * vertical-tab (0x0B), form-feed (0x0C). PostgreSQL escape-string syntax
 * does NOT recognize `\v`; `E'\v'` is silently parsed as a literal `v`
 * (0x76) — drop the backslash, pass the next character through. The
 * `\x0B` form is the canonical PostgreSQL hex escape for vertical-tab.
 * (Verified empirically:
 *   `SELECT encode((E' \t\n\r\v\f')::bytea, 'hex')` → `20090a0d760c`
 *   `SELECT encode((E' \t\n\r\x0B\f')::bytea, 'hex')` → `20090a0d0b0c`.)
 *
 * The escaped `\\x0B` form below is the JS-source representation: the
 * template-literal interpolation produces the four-character PostgreSQL
 * sequence `\x0B` in the emitted SQL, which the SQL parser then resolves
 * to byte 0x0B per its hex-escape rules. A bare `\x0B` in the template
 * would be the JS hex escape (the actual 0x0B byte in the SQL string),
 * which works on the wire but is harder to read in the captured-SQL
 * test canaries; the escaped form keeps SQL-string introspection
 * symmetric with how a human would write the literal in psql.
 *
 * Drift between SQL sites would reintroduce the cross-surface split for
 * whitespace-padded chain orcid claims — every BTRIM call against a
 * chain-supplied orcid MUST reference this constant.
 */
export const CHAIN_ORCID_BTRIM_CHARSET = " \\t\\n\\r\\x0B\\f";

/**
 * SQL boolean fragment for the authorship-claim ORCID auto-accept arms:
 * byte-equality of a broadcaster-controlled chain author ORCID against an
 * accreditation-attested ORCID, after BTRIM-stripping ONLY the chain side
 * with `CHAIN_ORCID_BTRIM_CHARSET` (ASCII C-whitespace). The attested side is
 * canonical (sourced from the authority-gated `active_accreditations`), so it
 * stays raw.
 *
 * Single source for the two production auto-accept arms — the read-surface
 * `authorshipClaimsCteBody` and the reputation cycle's
 * `computeReputationBatch.accepted_claims` — so they cannot drift on
 * whitespace normalization. The reputation-cycle canary builds its predicate
 * from this same helper, so a production-side change to the match shape
 * (e.g. dropping the BTRIM wrapper back to a raw `=`) turns the test red.
 *
 * Callers supply the surrounding `IS NOT NULL` / `!= ''` guards; this returns
 * only the equality conjunct.
 */
export function chainOrcidAutoAcceptMatchSql(opts: {
  /** SQL expr for the comment's json_metadata column (e.g. `c.json_metadata`). */
  metadataExpr: string;
  /** SQL placeholder holding the appTag key (e.g. `$3`). */
  appTagParam: string;
  /** SQL expr for the author index into authors[] (e.g. `ce.author_index` or `0`). */
  authorIndexExpr: string;
  /** SQL expr for the attested ORCID, canonical and untrimmed (e.g. `aa.orcid`). */
  attestedOrcidExpr: string;
}): string {
  return `BTRIM(${opts.metadataExpr} -> ${opts.appTagParam} -> 'authors' -> ${opts.authorIndexExpr} ->> 'orcid', E'${CHAIN_ORCID_BTRIM_CHARSET}') = ${opts.attestedOrcidExpr}`;
}

// ─── Common CTEs ──────────────────────────────────────────────────

/**
 * CTE body that computes the current accreditation status per account.
 * Replaces `pevo.active_accreditations`.
 *
 * The `custom_id = $appTag` filter alone is selective enough on Mahdi's HAF
 * (single-digit row count per namespace), so we deliberately do NOT add a
 * `block_num >= genesis` floor. Combining the two via `WHERE ... AND
 * block_num >= ...` triggers a BitmapAnd plan that scans tens of millions
 * of operation rows on the block_num index and runs in seconds; the
 * custom_id index alone runs in low milliseconds. The
 * `required_posting_auths` gate already prevents pre-namespace forgeries.
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
  ),
  active_accreditations AS (
    SELECT account, researcher_name, institution, field, method, orcid, event_timestamp, event_id
    FROM accred_ranked
    WHERE rn = 1 AND action = 'accredit'
  )`,
    params: [config.appTag, config.accreditationAuthorities],
    nextIdx: p + 2,
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
 * Same BitmapAnd avoidance as `activeAccreditationsCteBody` (see its
 * docstring): `custom_id = $appTag` alone is selective enough on Mahdi's
 * HAF that adding a `block_num >= genesis` floor flips the planner to a
 * parallel index scan over tens of millions of operation rows. The
 * `custom_id` index alone runs in low milliseconds.
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
  ),
  active_vouches AS (
    SELECT voucher, vouchee, relationship, event_timestamp
    FROM vouch_ranked
    WHERE rn = 1 AND action = 'vouch'
  )`,
    params: [config.appTag],
    nextIdx: p + 1,
  };
}

// ─── Retracted papers CTE ────────────────────────────────────────

/**
 * CTE body for retracted papers. Returns (author, permlink) pairs.
 * Use inside a WITH block alongside other CTEs.
 *
 * Same BitmapAnd avoidance as `activeAccreditationsCteBody` (see its
 * docstring): `custom_id = $appTag` alone is selective enough on Mahdi's
 * HAF that adding a `block_num >= genesis` floor flips the planner to a
 * parallel index scan over tens of millions of operation rows. The list
 * endpoint joins this CTE via `NOT EXISTS` on every paper, so the cost
 * multiplies. Without the floor, the custom_id index alone runs in low
 * milliseconds.
 *
 * The `required_posting_auths ? $admin` gate is load-bearing: every
 * legitimate retract_paper custom_json is broadcast by the retract
 * handler signing with `config.pevoAdminPostingKey`, so a row whose
 * `required_posting_auths` does not contain `config.hiveAdminAccount`
 * is a forgery and must not suppress the named paper from listings.
 * Singular `?` not `?|` because the admin account is singular by
 * design (see CLAUDE.md).
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
      AND cj.required_posting_auths ? $${p + 1}
  )`,
    params: [config.appTag, config.hiveAdminAccount],
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
  //
  // The `LOWER(TRIM(...)) ~ '^[a-z0-9.-]+$'` canonicalization on the
  // broadcaster-controlled `auth ->> 'hive'` value mirrors the JS-side
  // `normalizeHiveAccount` wrapper and the SQL-side pattern in
  // `authorsWithSupersessionSelect`. The right-hand side (`${r}.author`) is
  // a chain-validated lowercase Hive account name (consensus enforces the
  // `[a-z0-9.-]` charset on the op layer). Without the canonicalization, a
  // broadcaster posting `{hive: 'Alice'}` mid-case in `pevo.authors[]`
  // would byte-mismatch against the lowercase reviewer/voter author column
  // and admit a co-author into the "third-party" review/vote set.
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
        AND LOWER(TRIM(auth ->> 'hive')) ~ '^[a-z0-9.-]+$'
        AND LOWER(TRIM(auth ->> 'hive')) = ${r}.author
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
 * This asymmetry is load-bearing, per the authorship-op schemas in
 * agents/docs/hive-schemas.md (anchored on the op `action` strings):
 *   - claim_authorship   — JSON omits `claimer` (signer IS the claimer;
 *                          proven by required_posting_auths).
 *   - approve_authorship — JSON includes `claimer` explicitly (signer is
 *                          the approver, not the claimer).
 *   - revoke_authorship  — JSON includes `claimer` explicitly (signer is
 *                          the approver, post author, admin, or the
 *                          claimer themselves).
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
  // approve_authorship signer gate (per agents/docs/hive-schemas.md): an
  // approve is only valid when signed by the post author or the bridge account.
  // bridgeIdx binds config.hiveBridgeAccount for that IN-list; scope params
  // follow it.
  const bridgeIdx = p + 3;
  let scopeIdx = p + 4;
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
    // eslint-disable-next-line pevo/no-custom-id-block-num-floor -- authorshipClaimsCteBody: callers pass a `scope` (claimer or paper-key) whose extra JSONB predicates further narrow the row set; pending audit per the BitmapAnd-floor sweep follow-up
    sql: `
  claim_events AS (
    SELECT
      cj.json::jsonb ->> 'action' AS action,
      COALESCE(cj.json::jsonb ->> 'claimer', cj.required_posting_auths ->> 0) AS claimer,
      cj.json::jsonb ->> 'paper_author' AS paper_author,
      cj.json::jsonb ->> 'paper_permlink' AS paper_permlink,
      (cj.json::jsonb ->> 'author_index')::int AS author_index,
      cj.block_num,
      -- On-chain signer of the op. For approve_authorship this is the
      -- approver, which the approvals arm below gates to post author / bridge.
      cj.required_posting_auths ->> 0 AS approver,
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
    SELECT claimer, paper_author, paper_permlink, block_num, approver
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
                AND ap.approver IN (ap.paper_author, $${bridgeIdx})
            ), 0)
        ) THEN 'revoked'
        WHEN EXISTS (
          SELECT 1 FROM approvals ap
          WHERE ap.claimer = cb.claimer
            AND ap.paper_author = cb.paper_author
            AND ap.paper_permlink = cb.paper_permlink
            AND ap.block_num > cb.block_num
            -- approve_authorship signer gate: a self-signed approve (signer =
            -- claimer) is not a valid trust grant; only the post author or
            -- bridge can approve a co-author claim. Mirrors reputation.ts
            -- accepted_claims.
            AND ap.approver IN (ap.paper_author, $${bridgeIdx})
        ) THEN 'accepted'
        WHEN cb.author_index IS NOT NULL AND EXISTS (
          -- ORCID auto-accept arm: the broadcaster-controlled chain ORCID
          -- claim is compared against the on-chain accredited ORCID after
          -- normalizing both sides for ASCII C-whitespace padding. The
          -- BTRIM charset matches \`authorsWithSupersessionSelect\`'s
          -- supersession projection and the JS-side
          -- \`computeSupersession\`'s \`chainOrcid.trim()\` so the four
          -- surfaces (list/detail SQL, chain JS, profile JS) agree on
          -- whitespace-padded claims. Drift between this site and the
          -- supersession projection would reintroduce the cross-site
          -- split — both sites MUST reference the same
          -- \`CHAIN_ORCID_BTRIM_CHARSET\` constant.
          SELECT 1 FROM ${T.comments} c
          JOIN active_accreditations aa ON aa.account = cb.claimer
          WHERE c.author = cb.paper_author
            AND c.permlink = cb.paper_permlink
            AND c.parent_author = ''
            AND (
              (c.json_metadata -> $${p + 2} -> 'authors' -> cb.author_index ->> 'orcid') IS NOT NULL
              AND aa.orcid IS NOT NULL
              AND aa.orcid != ''
              AND ${chainOrcidAutoAcceptMatchSql({ metadataExpr: 'c.json_metadata', appTagParam: `$${p + 2}`, authorIndexExpr: 'cb.author_index', attestedOrcidExpr: 'aa.orcid' })}
            )
        ) THEN 'accepted'
        WHEN cb.author_index IS NOT NULL AND EXISTS (
          -- Hive-username auto-accept arm: canonicalize the broadcaster-
          -- controlled authors[i].hive via LOWER(TRIM(...)) plus the
          -- Hive-account charset regex (mirrors normalizeHiveAccount and
          -- the SQL-side guard in authorsWithSupersessionSelect) before
          -- byte-equality against cb.claimer. The claimer is a chain-
          -- validated lowercase Hive account name; an uppercase mid-case
          -- entry in pevo.authors would otherwise leave a legitimate
          -- co-author's claim pending indefinitely.
          --
          -- Structural-safety note on the missing jsonb_typeof(...) guard:
          -- this arm uses a direct integer subscript (-> cb.author_index)
          -- into the authors array, NOT jsonb_array_elements(...) like
          -- the sibling cascade-fail defenses. The integer-subscript form
          -- is intrinsically fail-soft against malformed shapes: on a
          -- non-array parent, -> N returns NULL; ->> 'hive' on NULL
          -- returns NULL; LOWER(TRIM(NULL)) = NULL; the equality conjunct
          -- evaluates NULL (not TRUE), the EXISTS row is rejected, and
          -- the claim stays pending. There is no array iteration to guard,
          -- so an explicit jsonb_typeof(...) check would be redundant.
          -- A parity-driven refactor that adds the guard here is harmless;
          -- one that erases the LOWER(TRIM(...)) canonicalization (citing
          -- the missing guard as justification) is the failure mode to
          -- defend against.
          SELECT 1 FROM ${T.comments} c
          WHERE c.author = cb.paper_author
            AND c.permlink = cb.paper_permlink
            AND c.parent_author = ''
            AND LOWER(TRIM(c.json_metadata -> $${p + 2} -> 'authors' -> cb.author_index ->> 'hive')) ~ '^[a-z0-9.-]+$'
            AND LOWER(TRIM(c.json_metadata -> $${p + 2} -> 'authors' -> cb.author_index ->> 'hive')) = cb.claimer
        ) THEN 'accepted'
        ELSE 'pending'
      END AS status
    FROM claims_base cb
  )`,
    params: [config.appTag, getCachedGenesisBlock(), config.appTag, config.hiveBridgeAccount, ...scopeParams],
    nextIdx: scopeIdx,
  };
}

// ─── Genesis block ──────────────────────────────────────────────

/**
 * The block number of the first accreditation custom_json in this namespace.
 * Nothing PEvO-related exists before this block — use it as a floor for all
 * queries that accept a since_block parameter.
 *
 * Cached permanently only once the primary query finds a real genesis (the
 * first `accredit` op). Until then each call re-runs the primary query and
 * the HEAD fallback returns a safe floor WITHOUT caching, so the running
 * process captures the real genesis the moment the first accreditation lands.
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

  // Fallback: use current head block — nothing PEvO-related can exist before now.
  // Deliberately NOT cached. Caching HEAD here would pin genesisBlock at
  // boot-time HEAD forever; once the first accreditation lands, the running
  // backend's `cj.block_num >= genesis` predicates would keep filtering above
  // that pinned floor and return zero rows until a restart. Returning HEAD for
  // this call only keeps the safe floor while leaving the primary query to
  // re-run on the next call (one cheap indexed query per call until the first
  // accreditation exists) so genesis is captured the moment it does.
  try {
    const headResult = await pool.query(`SELECT MAX(block_num) AS head FROM ${T.blocks}`, []);
    const head = Number(headResult.rows[0]?.head);
    if (head && head > 0) {
      logger.info({ headFloor: head }, 'No accreditations yet — using head block as genesis floor (not cached)');
      return head;
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
 * **Name-supersession + fallback (per `hive-schemas.md` § 1.1).** The
 * projected `name` is `COALESCE(NULLIF(aa.researcher_name, ''),
 * NULLIF(a.elem ->> 'name', ''), NULLIF(a.elem ->> 'hive', ''),
 * NULLIF(a.elem ->> 'orcid', ''))`. Arm 1 is name-supersession: when the
 * entry's hive is currently accredited (the LEFT JOIN matched) and the
 * accreditation carries a non-empty `researcher_name`, the attested name is
 * authoritative and supersedes the broadcaster-claimed name. The LEFT JOIN
 * is to `active_accreditations` (active-only), so supersession applies only
 * to currently-accredited accounts — matching the JS-side `nameMap`
 * membership in `resolveAuthorName`. Unlike ORCID supersession, name
 * supersession is SILENT: no `name_discrepancy`/`name_verified` field, no
 * audit event — name variation is benign and high-noise. Arms 2-4 are the
 * read-time fallback so `authors[i].name` is satisfiable even when the
 * broadcaster omitted it (a Hive-only or ORCID-only credit still surfaces a
 * display name). Mirrors `resolveAuthorName` in `author-supersession.ts`
 * exactly; both treat only an exactly-empty string as absent (the SQL/JS
 * parity contract). The attested-name source on the JS side
 * (`getAccreditedNamesByAccount`) filters with the same charset-free
 * `NULLIF(researcher_name, '')` test this arm uses — no BTRIM on either side
 * — so a whitespace-only attested name is superseded identically across the
 * SQL and JS surfaces rather than dropped on one. (Contrast the chain `orcid`
 * arms below, which DO BTRIM-strip the broadcaster-controlled chain value; the
 * attested `researcher_name` is authority-gated and stored raw, so no
 * stripping applies to it.)
 *
 * **Degenerate-entry drop (name-total parity).** The subselect's
 * `WHERE COALESCE(NULLIF(aa.researcher_name,''), NULLIF(a.elem ->> 'name',''),
 * NULLIF(a.elem ->> 'hive',''), NULLIF(a.elem ->> 'orcid','')) IS NOT NULL`
 * drops any author entry whose projected `name` would resolve to NULL — a
 * fully-empty `{}` or bare-`{affiliation}` chain entry that names no one,
 * reachable only via malformed broadcaster input. Without it the SQL surface
 * would emit a `{name: null, ...}` object, violating the mandatory-`string`
 * `name` contract on `PaperAuthor`. The drop matches the JS side, where
 * `buildCumulativeAuthorsForChain` skips a no-name/no-orcid/no-normalizable-hive
 * entry (composite key null) and `toPaperSummary`'s post-supersession filter
 * drops an entry whose `resolveAuthorName` returned `undefined`. One residual
 * cosmetic difference remains, malformed-input-only: a `{hive: '  '}`
 * whitespace-only-hive entry resolves `name` to the raw `'  '` here (and on
 * the `applyAuthorSupersession` single-link JS surfaces this projection's
 * counterpart feeds), whereas the multi-link `buildCumulativeAuthorsForChain`
 * drops it (its hive fails normalization and it carries no name/orcid). This
 * single-link-keeps / multi-link-drops split on whitespace-hive is accepted as
 * malformed-input-only; the load-bearing parity (no `name: null` emitted on any
 * surface) holds.
 *
 * The LEFT JOIN canonicalizes the chain `authors[i].hive` via
 * `LOWER(TRIM(...))` AND a Hive-account regex `~ '^[a-z0-9.-]+$'` before
 * keying against `active_accreditations.account`. Hive consensus enforces
 * lowercase account names from `[a-z0-9.-]` at op level, so every
 * accreditation account is regex-conforming by chain rule. Chain
 * `json_metadata` payloads are broadcaster-controlled and may carry
 * mixed-case, whitespace-padded, or otherwise malformed `hive` variants. The
 * regex guard is load-bearing: PostgreSQL `TRIM()` strips only U+0020
 * (space), while JS `String.prototype.trim()` strips the full ECMA-262
 * WhiteSpace set (tab, LF, CR, NBSP, etc.). Without the regex guard, a
 * broadcaster posting `{hive: '\tbob'}` would split-brain across surfaces:
 * SQL `LOWER(TRIM(...))` returns `\tbob` (unchanged), no JOIN match,
 * `orcid_verified=null`; JS `.trim().toLowerCase()` returns `bob`, JOIN
 * matches, `orcid_verified` populated. Rejecting non-conforming inputs at
 * the boundary eliminates the asymmetry — both sides agree such inputs do
 * not name a real account. Matches the JS-side normalization in
 * `normalizeHiveAccount`; the parity is the contract.
 *
 * Chain orcid is wrapped in `BTRIM(..., E'${CHAIN_ORCID_BTRIM_CHARSET}')`
 * (PostgreSQL `BTRIM` with an explicit ASCII C-whitespace character
 * set: space, tab, LF, CR, vertical-tab, form-feed) at BOTH the
 * `NULLIF(..., '')` no-claim guard and the `aa.orcid <> ...` equality
 * check. The charset literal is centralized in
 * `CHAIN_ORCID_BTRIM_CHARSET` (top of this module) so drift between
 * sibling sites is compile-visible — see also the
 * `authorshipClaimsCteBody` ORCID-equality arm, which references the
 * same constant. Default `BTRIM(text)` (no charset argument) strips
 * only U+0020, exactly like `TRIM(text)` — pairing it with the JS-side
 * `chainOrcid.trim()` would create the same SQL/JS whitespace-
 * character-set asymmetry the hive-account path closes via the regex
 * guard. JS `String.prototype.trim()` strips the full ECMA-262
 * WhiteSpace set (tab, LF, CR, NBSP, BOM, U+2028/2029, etc.). The
 * explicit-charset `BTRIM` widens the SQL side to match JS for the
 * common ASCII C-whitespace cases — a broadcaster posting
 * `{orcid: '\tATTESTED'}` for an accredited account whose attested
 * ORCID equals the trimmed value resolves to "no discrepancy" on the
 * SQL list/detail surfaces and the JS chain-detail / `?version=N` /
 * `metadata_restored` / `/api/profile/:username/papers` surfaces alike.
 *
 * **Known residual asymmetry on extended Unicode whitespace.** The
 * BTRIM charset above intentionally covers only ASCII C-whitespace.
 * JS `.trim()` additionally strips the following code points; SQL
 * BTRIM does NOT:
 *   - NBSP    (U+00A0, no-break space)
 *   - BOM     (U+FEFF, byte-order mark / zero-width no-break space)
 *   - U+2028  (line separator)
 *   - U+2029  (paragraph separator)
 * A broadcaster posting `{orcid: ' <attested>'}` for an
 * accredited account therefore surfaces `orcid_discrepancy=false` on
 * the JS-projected surfaces and `orcid_discrepancy=true` on the
 * SQL-projected surfaces. The trade-off is acceptable: ASCII-space-only
 * padding is the realistic copy-paste-from-ORCID-page failure mode;
 * exotic Unicode whitespace is not a known broadcaster input shape on
 * PEvO. See
 * `agents/docs/solutions/conventions/sql-trim-vs-js-trim-whitespace-character-set-asymmetry-2026-05-19.md`
 * for the convention; closing the residual gap is a separate task if it
 * ever surfaces as a real-world issue.
 *
 * Both NULLIF and `<>` sites MUST use the SAME charset — drift between
 * them would reintroduce the `{orcid: '\t<attested>'}` cross-site
 * split: one site would collapse the claim to "absent", the other
 * would compare against the raw `'\t<attested>'`. The
 * `CHAIN_ORCID_BTRIM_CHARSET` constant is the mechanical guard.
 *
 * Parity contract: the JS-side `computeSupersession` uses
 * `chainOrcid.trim()` (broad ECMA-262 whitespace). The two paths
 * converge on ASCII C-whitespace padding (the common case) and diverge
 * only on the extended Unicode set enumerated above. Without this
 * widening, `{orcid: ' '}` (single space) would surface a
 * false-positive discrepancy via the SQL path even on the unwrapped
 * form, because the equality compare runs on the raw value.
 *
 * @param commentAlias - SQL alias for the post row (e.g., 'c', 'p').
 * @param appTagParam - bind-param placeholder for `config.appTag` (e.g., '$3').
 * @param opts.includeAffiliation - when true, the projected jsonb objects
 *   include the chain `affiliation` field. PaperDetail wants it; PaperSummary
 *   omits it per `agents/docs/api-contracts/papers.md`. Defaults to false
 *   (the more restrictive PaperSummary shape) so the list-endpoint default
 *   is contract-correct; the detail endpoint opts in explicitly.
 * @returns SQL fragment (parenthesized subselect) suitable for inlining in
 *   a SELECT projection. Aliased by the caller via `AS authors_with_supersession`
 *   or similar; the fragment itself is column-alias-free for placement
 *   flexibility.
 */
export function authorsWithSupersessionSelect(
  commentAlias: string,
  appTagParam: string,
  opts: { includeAffiliation?: boolean } = {},
): string {
  const includeAffiliation = opts.includeAffiliation ?? false;
  const affiliationField = includeAffiliation
    ? `'affiliation',       a.elem ->> 'affiliation',\n        `
    : '';
  return `COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'name',              COALESCE(
                               NULLIF(aa.researcher_name, ''),
                               NULLIF(a.elem ->> 'name', ''),
                               NULLIF(a.elem ->> 'hive', ''),
                               NULLIF(a.elem ->> 'orcid', '')
                             ),
        'hive',              a.elem ->> 'hive',
        'orcid',             a.elem ->> 'orcid',
        ${affiliationField}'orcid_verified',    aa.orcid,
        'orcid_discrepancy', CASE
                               WHEN aa.orcid IS NOT NULL
                                AND NULLIF(BTRIM(a.elem ->> 'orcid', E'${CHAIN_ORCID_BTRIM_CHARSET}'), '') IS NOT NULL
                                AND aa.orcid <> BTRIM(a.elem ->> 'orcid', E'${CHAIN_ORCID_BTRIM_CHARSET}')
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
    LEFT JOIN active_accreditations aa
      ON LOWER(TRIM(a.elem ->> 'hive')) ~ '^[a-z0-9.-]+$'
     AND aa.account = LOWER(TRIM(a.elem ->> 'hive'))
    WHERE COALESCE(
            NULLIF(aa.researcher_name, ''),
            NULLIF(a.elem ->> 'name', ''),
            NULLIF(a.elem ->> 'hive', ''),
            NULLIF(a.elem ->> 'orcid', '')
          ) IS NOT NULL
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

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
      -- Same-block tie-breaker: cj.id (operation_custom_json_view has no
      -- trx_in_block; cj.id is the monotonic HAF op id) per
      -- agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md Rule 2
      ROW_NUMBER() OVER (PARTITION BY cj.json::jsonb ->> 'account' ORDER BY cj.block_num DESC, cj.id DESC) AS rn
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
 * The `required_posting_auths ? voucher` gate is load-bearing. Both `vouch`
 * and `retract_vouch` encode the acting voucher in the `voucher` field, and a
 * legitimate op is broadcast by that account signing with its own posting
 * authority. A row whose `required_posting_auths` does not contain the named
 * `voucher` is a forgery: an unsigned `vouch` would otherwise mint a forged
 * web-of-trust edge (a direct path to unauthorized auto-accreditation), and an
 * unsigned `retract_vouch` would otherwise supersede a legitimate prior vouch
 * via the latest-block-wins `ROW_NUMBER` ranking. Singular `?` (not `?|`)
 * because exactly one voucher signs each op; mirrors the signer gate in
 * `retractedPapersCteBody` and `activeAccreditationsCteBody`.
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
        -- Same-block tie-breaker: cj.id (operation_custom_json_view has no
        -- trx_in_block; cj.id is the monotonic HAF op id) per
        -- agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md Rule 2
        ORDER BY cj.block_num DESC, cj.id DESC
      ) AS rn
    FROM ${T.customJson} cj
    WHERE cj.custom_id = $${p}
      AND cj.json::jsonb ->> 'action' IN ('vouch', 'retract_vouch')
      AND cj.required_posting_auths ? (cj.json::jsonb ->> 'voucher')
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
 *      discussion-comments fix.)
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
 * vote-aggregating surface (paper-class via the `paper_resolved_votes`
 * CTE in `reputation.ts`; review-class via `c2.weight != 0 AND
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
 * A claimer matched by ORCID, or connected to a name-only slot, is
 * absent from `authors[].hive`, so this helper does not drop their
 * self-review. Both the reputation *cycle* (score path) and the DISPLAY
 * surfaces close that hole with a separate `accepted_claims NOT EXISTS`
 * gate: the cycle inlines it in `reputation.ts` (`paper_resolved_votes`,
 * `paper_reviews`); the display review/vote aggregations compose
 * {@link excludeClaimedSelfWhere}, which references the `authorship_claims`
 * CTE the callsite threads in via `authorshipClaimsCteBody`. So a credited
 * ORCID/name-only claimer's self-review/self-vote is dropped on both paths;
 * this helper remains responsible only for the chain poster + the
 * `authors[].hive` named co-author set.
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
 * asymmetry across the helper set. The `jsonb_typeof(...) = 'array'` guard
 * before `jsonb_array_elements` defends against a chain post broadcasting a
 * non-array `pevo.authors` (null, string, integer, object) — without it,
 * Postgres raises at runtime and the reputation cycle cascade-fails for
 * every user (companion to
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
  // alongside the outer CASE-WHEN array guard to defend the helper against
  // malformed `pevo.authors` shapes on chain.
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
 * Companion to {@link excludeSelfReviewWhere} that closes the residual
 * display-side self-dealing gap: a CREDITED authorship-claim claimer (matched by
 * ORCID, or connected to a name-only slot) is absent from `authors[].hive`, so
 * `excludeSelfReviewWhere` does not drop their self-review or self-vote on the
 * chain post they are credited for. This helper emits the same
 * `accepted_claims NOT EXISTS` gate the reputation cycle uses
 * (`reputation.ts` `paper_resolved_votes` / `paper_reviews`). This helper
 * covers Route 3 only; paired with {@link excludeConsentedSelfWhere} (the
 * Route-1/2 sibling over `consented_authors`), the DISPLAY review/vote
 * aggregations exclude credited self-dealing by the same full credited set
 * (accepted claims ∪ consented authors) as the score path. Compose BOTH
 * helpers at every display aggregation site.
 *
 * **Scope requirement.** The caller MUST compose `authorshipClaimsCteBody` into
 * the query's WITH chain so the `authorship_claims` CTE is in scope; this helper
 * references it by name and filters `status = 'accepted'` inline (the read
 * surface keeps the resolved status column rather than a pre-filtered
 * `accepted_claims` CTE). Scope choice by surface shape:
 *   - In-statement multi-result surfaces (the listing review-agg, search,
 *     stats) compose it UNSCOPED by design: page/result membership is computed
 *     inside the same statement (WHERE + ORDER BY + LIMIT), so no paper-key
 *     scope can be bound up front. The accepted cost is ONE claims resolution
 *     per query, guaranteed by the `AS MATERIALIZED` fence on
 *     `authorship_claims` (see `authorshipClaimsCteBody`'s docblock).
 *   - Batch surfaces whose paper-key set is known up front (the listing vote
 *     batch) pass `{papers}` to bound materialization by the page.
 *   - Single-claimer surfaces (the single-review fetch, profile) pass
 *     `{claimer}`; single-paper surfaces (paper-detail) pass
 *     `{paperAuthor, paperPermlink}`.
 *
 * @param opts.authorExpr - the review/vote author column (e.g. `'r.author'`,
 *   `'c.author'`, `'v.voter'`).
 * @param opts.paperAuthorExpr - the CHAIN post author (e.g. `'c.author'` for a
 *   listing row, or a bound `$N`).
 * @param opts.paperPermlinkExpr - the CHAIN post permlink.
 * @param opts.claimsAlias - alias for the correlated `authorship_claims` row;
 *   defaults to `'ac'`.
 *
 * @example
 *   // Listing review-agg LATERAL: review row `r`, paper row `c`.
 *   AND ${excludeClaimedSelfWhere({ authorExpr: 'r.author', paperAuthorExpr: 'c.author', paperPermlinkExpr: 'c.permlink' })}
 */
export function excludeClaimedSelfWhere(opts: {
  authorExpr: string;
  paperAuthorExpr: string;
  paperPermlinkExpr: string;
  claimsAlias?: string;
}): string {
  const ac = opts.claimsAlias ?? 'ac';
  return `NOT EXISTS (
    SELECT 1 FROM authorship_claims ${ac}
    WHERE ${ac}.paper_author = ${opts.paperAuthorExpr}
      AND ${ac}.paper_permlink = ${opts.paperPermlinkExpr}
      AND ${ac}.claimer = ${opts.authorExpr}
      AND ${ac}.status = 'accepted'
  )`;
}

/**
 * Route-1/2 sibling of {@link excludeClaimedSelfWhere}: drops a review/vote
 * row whose author is in the resolved `consented_authors` set for the paper —
 * the SAME set the reputation cycle's consented self-dealing gates use (the
 * `NOT EXISTS consented_authors` mirror in `computeReputationBatch`'s
 * `paper_resolved_votes` / `paper_reviews`). Since the metadata auto-accept
 * arms were removed, an ORCID- or hive-anchored co-author consents via
 * `author_accept` and has NO accepted-claims row, so the claims gate alone
 * leaves their displayed self-review/self-vote counted (cycle-vs-display
 * drift). Compose BOTH helpers at every display aggregation site.
 *
 * **Scope requirement.** The caller MUST compose the consent stack into the
 * query's WITH chain — `consentChainCteBody` + `consentedAuthorsCteBody`,
 * after `activeAccreditationsCteBody` (the orcid-anchor eligibility joins
 * it) — so the `consented_authors` CTE is in scope. Walk-scope choice by
 * surface shape mirrors the claims precedent:
 *   - Per-paper surfaces (paper-detail votes/reviews) scope the walk with
 *     `{paperAuthor, paperPermlink}`.
 *   - Multi-result surfaces (listing review-agg, search, stats) and
 *     per-account surfaces (profile, the single-review fetch) seed it from
 *     `consentSeedCteBody` via `{rootsFromCte: 'consent_seed'}` (unscoped,
 *     `{signer}`, or `{papers}` per the seed's docblock), bounding the walk
 *     by consent-op volume rather than corpus size.
 */
export function excludeConsentedSelfWhere(opts: {
  authorExpr: string;
  paperAuthorExpr: string;
  paperPermlinkExpr: string;
  consentedAlias?: string;
}): string {
  const ca = opts.consentedAlias ?? 'cca';
  return `NOT EXISTS (
    SELECT 1 FROM consented_authors ${ca}
    WHERE ${ca}.root_author = ${opts.paperAuthorExpr}
      AND ${ca}.root_permlink = ${opts.paperPermlinkExpr}
      AND ${ca}.account = ${opts.authorExpr}
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
 *
 * `claimers` is the multi-claimer variant the reputation cycle uses to scope the
 * shared builder to its target users (`= ANY($N::text[])` over the same COALESCE
 * claimer expression as `claims_base`); it is the dimension that lets the cycle
 * consume this builder instead of hand-rolling an inline accepted_claims copy.
 *
 * `papers` is the multi-paper variant for display batch surfaces (the listing's
 * vote batch resolves one page of papers per call): a composite IN over bound
 * (paper_author, paper_permlink) pairs, bounding `claims_base` — and therefore
 * the embedded chain walk — by the page's paper-key set instead of total claim
 * history, so a flood of cheap pending claims on unrelated papers cannot
 * inflate the batch's materialization cost. An empty array is safe by
 * construction — the builder emits a well-formed `FALSE` filter, so the CTE
 * materializes nothing. Callers may still short-circuit an empty page before
 * querying (as `batchResolveVotes` does), but that early return is an
 * optimization, not the safety mechanism.
 */
export type AuthorshipClaimsScope =
  | { claimer: string }
  | { claimers: string[] }
  | { paperAuthor: string; paperPermlink: string }
  | { papers: Array<{ author: string; permlink: string }> };

/**
 * CTE body for authorship claims — Route 3 of the consent model (name-only
 * slots). Computes claim status (accepted/pending/revoked) for each
 * (claimer, paper_author, paper_permlink) combination.
 *
 * A claim is accepted ONLY via an explicit `approve_authorship` signed by
 * the post author or bridge account, AND only when `author_index` resolves
 * to a NAME-ONLY slot (neither a `hive` nor an `orcid` anchor) in the
 * paper's cumulative-chain author union. There is NO metadata auto-accept:
 * an anchored slot establishes who may consent through Route 2
 * (`author_accept`, resolved by `consentedAuthorsCteBody`), never credit on
 * its own, and never credit through this route.
 *
 * `author_index` resolves against the canonical continuation chain's
 * display-ordered cumulative author union (the Claim Authorship schema in
 * hive-schemas.md defines the author list as the cumulative union across
 * the chain), NOT the root post's current `authors[]` alone — a name-only
 * co-author first credited in a continuation revision is claimable. The
 * builder embeds its own `claims_`-prefixed `consentChainCteBody` backbone
 * seeded from `claims_base`'s paper keys, so the walk cost is bounded by
 * claim cardinality and the names cannot collide with a composing query's
 * unprefixed Route-2 backbone. MUST be composed under `WITH RECURSIVE`
 * (`buildRecursiveWith`). The chain walk also supplies the paper-identity
 * validation the root-only metadata probe used to provide: slots exist only
 * for real PEvO root posts that passed `validPevoPaperWhere` + root-post
 * checks, so a claim citing a fabricated paper resolves no slot and stays
 * pending.
 *
 * No `active_accreditations` dependency remains (it backed the removed
 * ORCID auto-accept arm); composing queries that still include it do so for
 * their own accreditation gates.
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
 * `authorship_claims` is declared `AS MATERIALIZED`: several consumers
 * reference it from a correlated `NOT EXISTS` inside a per-row LATERAL
 * (`excludeClaimedSelfWhere` on the listing review-agg and sibling display
 * surfaces). Without the fence, PG 12+ inlines the single-referenced CTE
 * into that anti-join, so the status-resolution CASE (with its correlated
 * subplans over claim_events/approvals) is re-planned and re-costed per
 * LATERAL rescan — the recursive chain walk underneath stays fenced either
 * way (recursive + multi-referenced CTEs are never inlined), but the
 * inlined status layer re-scans the materialized tuplestores per surviving
 * review row and blows up the planner's cost estimate for the whole
 * statement. The fence resolves claim status exactly once per query and
 * makes every downstream reference a trivial CTE scan.
 *
 * @param startIdx - first available $N parameter index
 * @param scope - optional narrowing filter pushed into `claim_events`. Without
 *   a scope the CTE materializes every claim event in PEvO history. Scoping by
 *   claimer, claimers, paper key, or paper-key list avoids that full scan. The
 *   scope key must match the dimension the caller filters on downstream, since
 *   the CASE's EXISTS subqueries correlate on the same key.
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
  const bridgeIdx = p + 1;
  let scopeIdx = p + 2;
  let scopeFilter = '';
  const scopeParams: unknown[] = [];
  if (scope) {
    if ('claimer' in scope) {
      scopeFilter = `
      AND COALESCE(cj.json::jsonb ->> 'claimer', cj.required_posting_auths ->> 0) = $${scopeIdx}`;
      scopeParams.push(scope.claimer);
      scopeIdx += 1;
    } else if ('claimers' in scope) {
      // Multi-claimer scope (the reputation cycle scopes to its target users).
      // ANY($N::text[]) over the IDENTICAL COALESCE expression as claims_base.claimer
      // so approve/revoke rows for an in-scope claimer stay materialized.
      scopeFilter = `
      AND COALESCE(cj.json::jsonb ->> 'claimer', cj.required_posting_auths ->> 0) = ANY($${scopeIdx}::text[])`;
      scopeParams.push(scope.claimers);
      scopeIdx += 1;
    } else if ('papers' in scope) {
      // Multi-paper scope (display batch surfaces). Composite IN over bound
      // pairs; claim/approve/revoke ops all carry paper_author/paper_permlink
      // on the wire, so the one filter keeps every event kind the CASE
      // correlates on for the in-scope papers. An empty list cannot produce a
      // valid IN-list; callers short-circuit empty pages, and the FALSE arm
      // keeps the fragment well-formed as a backstop.
      if (scope.papers.length === 0) {
        scopeFilter = `
      AND FALSE`;
      } else {
        const pairs: string[] = [];
        for (const paper of scope.papers) {
          pairs.push(`($${scopeIdx}, $${scopeIdx + 1})`);
          scopeParams.push(paper.author, paper.permlink);
          scopeIdx += 2;
        }
        scopeFilter = `
      AND (cj.json::jsonb ->> 'paper_author', cj.json::jsonb ->> 'paper_permlink') IN (${pairs.join(', ')})`;
      }
    } else {
      scopeFilter = `
      AND cj.json::jsonb ->> 'paper_author' = $${scopeIdx}
      AND cj.json::jsonb ->> 'paper_permlink' = $${scopeIdx + 1}`;
      scopeParams.push(scope.paperAuthor, scope.paperPermlink);
      scopeIdx += 2;
    }
  }
  // revoke_authorship signer gate (per the Revoke Authorship schema in
  // hive-schemas.md): a revoke voids a claim only when signed by the post
  // author, the bridge account, the admin account, or the claimer themselves.
  // adminIdx binds config.hiveAdminAccount for that IN-list. Appended AFTER the
  // scope params so the bridge and scope param indices stay fixed.
  const adminIdx = scopeIdx;
  // Internal chain backbone: claims_-prefixed so it cannot collide with a
  // composing query's unprefixed Route-2 backbone; seeded from claims_base
  // so the recursive walk only covers papers someone actually claimed.
  const chain = consentChainCteBody(adminIdx + 1, { rootsFromCte: 'claims_base' }, { namePrefix: 'claims_' });
  return {
    sql: `
  claim_events AS (
    SELECT
      cj.json::jsonb ->> 'action' AS action,
      COALESCE(cj.json::jsonb ->> 'claimer', cj.required_posting_auths ->> 0) AS claimer,
      cj.json::jsonb ->> 'paper_author' AS paper_author,
      cj.json::jsonb ->> 'paper_permlink' AS paper_permlink,
      -- {1,9} also caps the digit count so a forged oversized author_index can't overflow ::int and abort the query.
      CASE WHEN (cj.json::jsonb ->> 'author_index') ~ '^[0-9]{1,9}$' THEN (cj.json::jsonb ->> 'author_index')::int END AS author_index,
      cj.block_num,
      -- On-chain signer of the op. For approve_authorship this is the
      -- approver, which the approvals arm below gates to post author / bridge.
      cj.required_posting_auths ->> 0 AS approver,
      cj.json::jsonb ->> 'timestamp' AS event_timestamp
    FROM ${T.customJson} cj
    WHERE cj.custom_id = $${p}
      AND cj.json::jsonb ->> 'action' IN ('claim_authorship', 'approve_authorship', 'revoke_authorship')${scopeFilter}
  ),
  claims_base AS (
    SELECT claimer, paper_author, paper_permlink, author_index, block_num, event_timestamp
    FROM claim_events
    WHERE action = 'claim_authorship'
  ),
${chain.sql},
  approvals AS (
    SELECT claimer, paper_author, paper_permlink, block_num, approver
    FROM claim_events
    WHERE action = 'approve_authorship'
  ),
  revocations AS (
    SELECT claimer, paper_author, paper_permlink, block_num, approver
    FROM claim_events
    WHERE action = 'revoke_authorship'
  ),
  authorship_claims AS MATERIALIZED (
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
            -- revoke_authorship signer gate: a revoke voids a claim only when
            -- signed by the post author, the bridge account, the admin
            -- account, or the claimer themselves. Without it any Hive account
            -- could broadcast a forged revoke naming a victim's claim and
            -- silently strip it from the read surface. This builder is the
            -- single source of accepted_claims (the reputation cycle and the
            -- read surfaces both consume it), so claims void identically across
            -- them.
            AND rv.approver IN (rv.paper_author, $${bridgeIdx}, $${adminIdx}, rv.claimer)
            AND rv.block_num > COALESCE((
              SELECT MAX(ap.block_num) FROM approvals ap
              WHERE ap.claimer = cb.claimer
                AND ap.paper_author = cb.paper_author
                AND ap.paper_permlink = cb.paper_permlink
                AND ap.approver IN (ap.paper_author, $${bridgeIdx})
            ), 0)
        ) THEN 'revoked'
        WHEN cb.author_index IS NOT NULL AND EXISTS (
          SELECT 1 FROM approvals ap
          WHERE ap.claimer = cb.claimer
            AND ap.paper_author = cb.paper_author
            AND ap.paper_permlink = cb.paper_permlink
            AND ap.block_num > cb.block_num
            -- approve_authorship signer gate: a self-signed approve (signer =
            -- claimer) is not a valid trust grant; only the post author or
            -- bridge can approve a co-author claim. This builder is the single
            -- source of accepted_claims shared by the reputation cycle and the
            -- read surfaces. The self-asserted ap.paper_author read here is
            -- harmless even though the ap.approver IN (ap.paper_author, ...)
            -- gate references it: the approval is correlated to cb (a REAL
            -- claim_authorship op via claims_base) and cb.paper_author is
            -- validated as a real PEvO root post by the chain-slot gate below
            -- (claims_display_slots rows exist only for walked roots that
            -- passed the paper-identity checks), so ap.paper_author must equal
            -- that validated value, making the signer the genuine post author.
            -- (The notification claim_approved/claim_revoked arms lacked this
            -- claim-base correlation and so needed an explicit
            -- claimer-to-recipient gate to close the same self-referential
            -- vector.)
            AND ap.approver IN (ap.paper_author, $${bridgeIdx})
        ) AND EXISTS (
          -- List-final + name-only gate (per the Claim / Approve Authorship
          -- schemas in hive-schemas.md): approval binds the claimer to a slot
          -- NAMED in the paper's cumulative-chain author union; author_index
          -- must resolve to an existing slot in display order. Only a
          -- NAME-ONLY slot (no hive, no orcid anchor) is claimable through
          -- this route — anchored slots register consent via author_accept
          -- (Route 2), and there is no metadata auto-accept. The cycle and
          -- read surfaces accept identically because they share this one
          -- builder; without the gate an unlisted claimer (author_index null
          -- or past the end of the union) could be approved into co-author
          -- status that was never on the paper.
          SELECT 1 FROM claims_display_slots ds
          WHERE ds.root_author = cb.paper_author
            AND ds.root_permlink = cb.paper_permlink
            AND ds.author_index = cb.author_index
            AND ds.slot_key LIKE 'name:%'
        ) THEN 'accepted'
        ELSE 'pending'
      END AS status
    FROM claims_base cb
  )`,
    params: [config.appTag, config.hiveBridgeAccount, ...scopeParams, config.hiveAdminAccount, ...chain.params],
    nextIdx: chain.nextIdx,
  };
}

// ─── Consented authorship (chain backbone + Route 1/2 resolution) ─────────

/**
 * Scope for `consentChainCteBody`. `{ paperAuthor, paperPermlink }` seeds the
 * recursive walk at one root (read surfaces); `{ roots: 'all' }` seeds it at
 * every PEvO root post (`continues` absent) for corpus-wide resolution (the
 * reputation cycle); `{ rootsFromCte }` seeds it at the `(paper_author,
 * paper_permlink)` pairs an EARLIER CTE in the same WITH block emits
 * (`authorshipClaimsCteBody` seeds from `claims_base`, bounding the walk by
 * claim cardinality instead of corpus size).
 */
export type ConsentChainScope =
  | { paperAuthor: string; paperPermlink: string }
  | { roots: 'all' }
  | { rootsFromCte: string };

/**
 * The CTE names `consentChainCteBody` emits, longest-first so the
 * prefix-rewrite regex's alternation cannot match a shorter name inside a
 * longer one (`display_slots` inside `display_slot_occurrences`).
 */
const CONSENT_CHAIN_CTE_NAMES = [
  'display_slot_occurrences',
  'ops_slot_occurrences',
  'chain_node_created',
  'claimed_hive_slots',
  'claimed_orcid_slots',
  'ranked_children',
  'canonical_chain',
  'display_slots',
  'chain_tree',
] as const;

/**
 * SQL expression for one post's contribution to the walk's cumulative
 * admit-set: the normalized `pevo.authors[].hive` entries of the post's
 * CURRENT metadata, with the bridge-paper special case (the bridge account is
 * the sole authorized continuator). Mirrors
 * `extractAuthorizedContinuationAuthors` (`helpers.ts`): LOWER + TRIM
 * (PostgreSQL TRIM strips U+0020 only, matching the JS `trimAsciiSpace`) plus
 * the Hive-consensus charset regex, which rejects entries carrying any other
 * whitespace — keeping the SQL and JS admit-sets in lockstep (see the
 * sql-trim-vs-js-trim convention).
 */
function hiveContributionSql(alias: string, appTagParam: string, bridgeParam: string): string {
  return `CASE WHEN ${alias}.json_metadata -> ${appTagParam} ->> 'type' = 'bridge_paper' AND ${alias}.author = ${bridgeParam}
        THEN ARRAY[${bridgeParam}::text]
        ELSE COALESCE((
          SELECT array_agg(DISTINCT LOWER(TRIM(e ->> 'hive')))
          FROM jsonb_array_elements(${alias}.json_metadata -> ${appTagParam} -> 'authors') e
          WHERE jsonb_typeof(${alias}.json_metadata -> ${appTagParam} -> 'authors') = 'array'
            AND LOWER(TRIM(e ->> 'hive')) ~ '^[a-z0-9.-]+$'
        ), ARRAY[]::text[]) END`;
}

/**
 * CTE bodies for the cumulative continuation-chain walk — the SQL port of the
 * JS walker (`resolveContinuationChain` + `buildCumulativeAuthorsForChain` in
 * `routes/papers.ts`). Foundational infrastructure for consented-authorship
 * credit: all three consent routes resolve against the chain this emits.
 *
 * MUST be composed under `WITH RECURSIVE` (use `buildRecursiveWith`). Emits,
 * in dependency order:
 *
 *   - `chain_tree` — recursive walk over `pevo.continues` pointers. A
 *     candidate continuation is admitted iff its chain author is in the
 *     cumulative union of normalized `authors[].hive` built from its OWN
 *     root-path prefix (the JS walker's author-consent gate), it is a valid
 *     PEvO paper class (`validPevoPaperWhere`), it is not already on its path
 *     (cycle guard — `continues` is broadcaster-controlled and a root's own
 *     pointer can close a loop), and depth < 50 (the JS walker's hop cap).
 *     Because each post carries exactly ONE `continues` pointer, every node
 *     has a unique root-path: the recursion is linear in the number of
 *     admissible posts, with no exponential fan-out. Forks (two admitted
 *     posts continuing the same parent) materialize as siblings here and are
 *     resolved by `canonical_chain`.
 *   - `chain_node_created` — per node, the creation block (MIN op block) and
 *     a same-block op-id tie-breaker from `operation_comment_view`.
 *   - `ranked_children` — sibling rank per parent by creation order. The JS
 *     walker picks the earliest-created admissible continuation
 *     (`ORDER BY co.block_num ASC LIMIT 1`); rank 1 is that choice, with the
 *     monotonic HAF op id as the deterministic same-block tie-break.
 *   - `canonical_chain` — second recursion selecting the rank-1 child at each
 *     hop: exactly the path the JS walker resolves. Slots named only in
 *     orphaned (non-canonical) fork branches are NOT claimable or creditable.
 *   - `display_slots` — the display-ordered cumulative author union over the
 *     canonical chain's CURRENT metadata, two never-merging tracks keyed and
 *     first-occurrence-ordered exactly like `buildCumulativeAuthorsForChain`
 *     (hive-keyed track: normalized hive; hive-less track: normalized orcid,
 *     else normalized name). `author_index` (0-based) is the dense
 *     first-occurrence rank — the resolution domain for name-only
 *     `claim_authorship` ops per the Claim Authorship schema
 *     (hive-schemas.md: the author list is the cumulative union across the
 *     chain).
 *   - `claimed_hive_slots` / `claimed_orcid_slots` — the append-only claimed
 *     set: anchor unions across ALL `operation_comment_view` operations on
 *     canonical-chain posts (broadcasts AND edits), per the Multi-Author
 *     Trust Model's historical-union rule. A native edit that removes an
 *     entry from a post's current metadata does NOT remove the anchor here.
 *     `first_block` is the earliest op block naming the anchor — the
 *     Author Accept temporal lower bound (an accept at or before it is
 *     name-squatting and invalid). Chain orcids are normalized with
 *     `CHAIN_ORCID_BTRIM_CHARSET` (ASCII C-whitespace), matching the
 *     supersession projection.
 *
 * Cost note: the walk is seeded per scope; `{ roots: 'all' }` walks every
 * root's chain once per query. Chains are short (50-hop cap) and each
 * admissible post is visited once, so the cost is linear in the number of
 * PEvO continuation posts. No `block_num` floor on any `custom_json` or
 * comment scan (BitmapAnd avoidance — see `activeAccreditationsCteBody`).
 *
 * @param opts.namePrefix - rewrites every emitted CTE name (and its internal
 *   references) with the prefix, so two chain backbones with different
 *   scopes can coexist in one WITH block (`authorshipClaimsCteBody` embeds
 *   a `claims_`-prefixed copy seeded from `claims_base`, while a composing
 *   query may also carry the unprefixed Route-2 backbone).
 */
export function consentChainCteBody(
  startIdx = 1,
  scope: ConsentChainScope,
  opts?: { namePrefix?: string },
): SqlFragment {
  const p = startIdx; // $p = appTag, $p+1 = bridge account
  const tag = `$${p}`;
  const bridge = `$${p + 1}`;
  const perPaper = 'paperAuthor' in scope;
  const scopeParams: unknown[] = perPaper ? [scope.paperAuthor, scope.paperPermlink] : [];
  const seedFilter = perPaper
    ? `AND c.author = $${p + 2} AND c.permlink = $${p + 3}`
    : 'rootsFromCte' in scope
      ? `AND (c.author, c.permlink) IN (SELECT DISTINCT paper_author, paper_permlink FROM ${scope.rootsFromCte})`
      : `AND (c.json_metadata -> ${tag} -> 'continues') IS NULL`;
  const nextIdx = perPaper ? p + 4 : p + 2;
  const contrib = (alias: string) => hiveContributionSql(alias, tag, bridge);
  const body = `
  chain_tree AS (
    SELECT
      c.author AS root_author, c.permlink AS root_permlink,
      c.author, c.permlink,
      NULL::text AS parent_author, NULL::text AS parent_permlink,
      0 AS depth,
      ARRAY[c.author || '/' || c.permlink] AS visited,
      ${contrib('c')} AS cum_authors
    FROM ${T.comments} c
    WHERE c.parent_author = '' AND c.parent_permlink = ${tag}
      AND ${validPevoPaperWhere({ commentAlias: 'c', appTagParam: tag, bridgeAccountParam: bridge, source: 'all' })}
      ${seedFilter}
    UNION ALL
    SELECT
      p.root_author, p.root_permlink,
      c.author, c.permlink,
      p.author, p.permlink,
      p.depth + 1,
      p.visited || (c.author || '/' || c.permlink),
      p.cum_authors || ${contrib('c')}
    FROM chain_tree p
    JOIN ${T.comments} c
      ON c.parent_author = '' AND c.parent_permlink = ${tag}
     AND c.json_metadata -> ${tag} -> 'continues' ->> 'author' = p.author
     AND c.json_metadata -> ${tag} -> 'continues' ->> 'permlink' = p.permlink
    WHERE p.depth < 50
      AND c.author = ANY(p.cum_authors)
      AND ${validPevoPaperWhere({ commentAlias: 'c', appTagParam: tag, bridgeAccountParam: bridge, source: 'all' })}
      AND NOT (c.author || '/' || c.permlink) = ANY(p.visited)
  ),
  chain_node_created AS (
    -- One LATERAL first-op probe per chain node (creation block + same-block
    -- op-id tie-break in a single indexed scan). LEFT JOIN rather than CROSS
    -- JOIN so a node with no visible op row keeps its NULL annotation (the
    -- ranked_children ordering is NULLS LAST), matching the correlated-
    -- subquery shape this replaces.
    SELECT t.*, fo.block_num AS created_block, fo.id AS created_id
    FROM chain_tree t
    LEFT JOIN LATERAL (
      SELECT o.block_num, o.id FROM ${T.commentOps} o
      WHERE o.author = t.author AND o.permlink = t.permlink
      ORDER BY o.block_num ASC, o.id ASC
      LIMIT 1
    ) fo ON TRUE
  ),
  ranked_children AS (
    SELECT *,
      ROW_NUMBER() OVER (
        PARTITION BY root_author, root_permlink, parent_author, parent_permlink
        ORDER BY created_block ASC NULLS LAST, created_id ASC NULLS LAST
      ) AS sibling_rank
    FROM chain_node_created
    WHERE depth > 0
  ),
  canonical_chain AS (
    SELECT root_author, root_permlink, author, permlink, depth
    FROM chain_node_created WHERE depth = 0
    UNION ALL
    SELECT r.root_author, r.root_permlink, r.author, r.permlink, r.depth
    FROM canonical_chain p
    JOIN ranked_children r
      ON r.root_author = p.root_author AND r.root_permlink = p.root_permlink
     AND r.parent_author = p.author AND r.parent_permlink = p.permlink
     AND r.sibling_rank = 1
  ),
  display_slot_occurrences AS (
    SELECT cc.root_author, cc.root_permlink, cc.depth,
           e.ordinality AS pos, e.value AS entry,
           CASE
             WHEN LOWER(TRIM(e.value ->> 'hive')) ~ '^[a-z0-9.-]+$'
               THEN 'hive:' || LOWER(TRIM(e.value ->> 'hive'))
             WHEN BTRIM(COALESCE(e.value ->> 'orcid', ''), E'${CHAIN_ORCID_BTRIM_CHARSET}') != ''
               THEN 'orcid:' || LOWER(BTRIM(e.value ->> 'orcid', E'${CHAIN_ORCID_BTRIM_CHARSET}'))
             WHEN TRIM(COALESCE(e.value ->> 'name', '')) != ''
               THEN 'name:' || LOWER(TRIM(e.value ->> 'name'))
             ELSE NULL
           END AS slot_key
    FROM canonical_chain cc
    JOIN ${T.comments} c ON c.author = cc.author AND c.permlink = cc.permlink
    CROSS JOIN LATERAL jsonb_array_elements(c.json_metadata -> ${tag} -> 'authors') WITH ORDINALITY AS e(value, ordinality)
    WHERE jsonb_typeof(c.json_metadata -> ${tag} -> 'authors') = 'array'
  ),
  display_slots AS (
    SELECT root_author, root_permlink, slot_key,
           (ROW_NUMBER() OVER (PARTITION BY root_author, root_permlink
                               ORDER BY MIN(depth * 1000000 + pos)) - 1)::int AS author_index
    FROM display_slot_occurrences
    WHERE slot_key IS NOT NULL
    GROUP BY root_author, root_permlink, slot_key
  ),
  ops_slot_occurrences AS (
    SELECT cc.root_author, cc.root_permlink, o.block_num, e.value AS entry
    FROM canonical_chain cc
    JOIN ${T.commentOps} o ON o.author = cc.author AND o.permlink = cc.permlink
    CROSS JOIN LATERAL jsonb_array_elements(o.json_metadata -> ${tag} -> 'authors') AS e(value)
    WHERE jsonb_typeof(o.json_metadata -> ${tag} -> 'authors') = 'array'
  ),
  claimed_hive_slots AS (
    SELECT root_author, root_permlink, LOWER(TRIM(entry ->> 'hive')) AS hive, MIN(block_num) AS first_block
    FROM ops_slot_occurrences
    WHERE LOWER(TRIM(entry ->> 'hive')) ~ '^[a-z0-9.-]+$'
    GROUP BY 1, 2, 3
  ),
  claimed_orcid_slots AS (
    SELECT root_author, root_permlink, BTRIM(entry ->> 'orcid', E'${CHAIN_ORCID_BTRIM_CHARSET}') AS orcid, MIN(block_num) AS first_block
    FROM ops_slot_occurrences
    WHERE BTRIM(COALESCE(entry ->> 'orcid', ''), E'${CHAIN_ORCID_BTRIM_CHARSET}') != ''
    GROUP BY 1, 2, 3
  )`;
  const prefix = opts?.namePrefix;
  const sql = prefix
    ? body.replace(new RegExp(`\\b(${CONSENT_CHAIN_CTE_NAMES.join('|')})\\b`, 'g'), `${prefix}$1`)
    : body;
  return {
    sql,
    params: [config.appTag, config.hiveBridgeAccount, ...scopeParams],
    nextIdx,
  };
}

/**
 * CTE bodies for the consented-author set — Routes 1 and 2 of the consent
 * model (ARCHITECTURE.md "Consented vs claimed authorship") plus their
 * demotions. Route 3 (name-only claim + approve) stays in
 * `authorshipClaimsCteBody`; the full credit union is Routes 1 ∪ 2 ∪ 3.
 *
 * Requires `consentChainCteBody` (canonical_chain / claimed_*_slots) AND
 * `activeAccreditationsCteBody` (active_accreditations, for the
 * attested-ORCID anchor) to be composed EARLIER in the same WITH block.
 *
 * Emits:
 *   - `consent_ops_raw` — `author_accept` / `author_resign` ops (subject =
 *     the chain signer per the implicit signer-binding rule: the payload has
 *     no subject field, so an op only ever counts for its own signer) UNION
 *     `revoke_authorship` ops re-keyed to subject = payload `claimer` (the
 *     author/admin/bridge demotion backstop, which applies to a co-author
 *     consented via either route).
 *   - `route2_stream` — ops joined to signer eligibility. A signer is
 *     eligible iff a claimed slot anchors them: a hive slot equal to the
 *     signer, OR an orcid slot equal to the signer's authority-attested
 *     ORCID (latest accredit/revoke wins via active_accreditations; an
 *     account with no live attested ORCID is NOT eligible through an orcid
 *     slot — a broadcaster-claimed ORCID never anchors). The ORCID anchor
 *     additionally excludes bridge papers: a bridge slot's ORCID is external
 *     preprint metadata, not an accredited-poster-vouched slot, so it never
 *     admits an attested account into credit (bridge papers stay
 *     single-consented via the Route-1 bridge-account arm until the verified
 *     bridge-claim flow lands). Accept validity
 *     additionally requires the accept block to be strictly after the slot's
 *     first-appearance block (anti-name-squat; resigns carry no temporal
 *     rule). Revoke rows are valid only when signed by the real root author,
 *     the bridge account, the admin account, or the subject themself.
 *   - `route2_latest` — latest valid op wins per (paper, account), ordered
 *     by `(block_num, id)` descending (the monotonic HAF op id is the
 *     intra-block key).
 *   - `consented_authors` — Route 1 (the root broadcaster, implicitly
 *     consented via the post signature, gated on membership in the claimed
 *     hive set — or being the bridge account on a bridge paper — and
 *     demotable by a later resign/revoke like any consented author) UNION
 *     Route 2 (eligible signers whose latest valid op is an accept).
 *
 * `consented_authors` is declared `AS MATERIALIZED` for the same reason
 * `authorship_claims` is (see `authorshipClaimsCteBody`'s docblock): display
 * surfaces reference it from a correlated `NOT EXISTS` inside a per-row
 * LATERAL (`excludeConsentedSelfWhere` on the listing review-agg and sibling
 * surfaces), and without the fence PG 12+ inlines the single-referenced CTE
 * into that anti-join, re-evaluating the Route-1/2 resolution per LATERAL
 * rescan. The fence resolves the consented set exactly once per query; the
 * reputation cycle references it from multiple CTEs and was already
 * materialized, so the keyword is a no-op there.
 *
 * @param scope - optional `{ signers }` narrows the resolved accounts to the
 *   given set (the reputation cycle's target users). The chain walk itself is
 *   scoped by `consentChainCteBody`, not here.
 */
export function consentedAuthorsCteBody(
  startIdx = 1,
  scope?: { signers: string[] },
): SqlFragment {
  const p = startIdx; // $p = appTag, $p+1 = bridge, $p+2 = admin
  const tag = `$${p}`;
  const bridge = `$${p + 1}`;
  const admin = `$${p + 2}`;
  const signersFilter = scope ? `AND se.signer = ANY($${p + 3}::text[])` : '';
  const scopeParams: unknown[] = scope ? [scope.signers] : [];
  return {
    sql: `
  consent_ops_raw AS (
    SELECT cj.required_posting_auths ->> 0 AS signer,
           cj.json::jsonb ->> 'action' AS action,
           cj.json::jsonb ->> 'root_author' AS r_author,
           cj.json::jsonb ->> 'root_permlink' AS r_permlink,
           cj.required_posting_auths ->> 0 AS subject,
           cj.block_num, cj.id
    FROM ${T.customJson} cj
    WHERE cj.custom_id = ${tag}
      AND cj.json::jsonb ->> 'action' IN ('author_accept', 'author_resign')
    UNION ALL
    SELECT cj.required_posting_auths ->> 0,
           'demote_revoke',
           cj.json::jsonb ->> 'paper_author',
           cj.json::jsonb ->> 'paper_permlink',
           cj.json::jsonb ->> 'claimer',
           cj.block_num, cj.id
    FROM ${T.customJson} cj
    WHERE cj.custom_id = ${tag}
      AND cj.json::jsonb ->> 'action' = 'revoke_authorship'
  ),
  consent_signer_eligibility AS (
    SELECT root_author, root_permlink, signer, MIN(first_block) AS first_block
    FROM (
      SELECT root_author, root_permlink, hive AS signer, first_block FROM claimed_hive_slots
      UNION ALL
      SELECT o.root_author, o.root_permlink, aa.account AS signer, o.first_block
      FROM claimed_orcid_slots o
      JOIN active_accreditations aa
        ON aa.orcid IS NOT NULL AND aa.orcid != '' AND aa.orcid = o.orcid
      -- Bridge papers are excluded from the Route-2 ORCID anchor: a bridge
      -- slot ORCID is external preprint metadata (self-asserted upstream),
      -- not a slot vouched-for by an accountable accredited PEvO poster.
      -- Admitting an attested account here would let it author_accept into
      -- credit by ORCID-equality alone, bypassing the verified bridge-claim
      -- flow. Bridge papers stay single-consented (the bridge account, via the
      -- Route-1 arm of consented_authors) until that flow lands. The hive-slot
      -- anchor above needs no such guard: a bridge slot carries no hive name.
      WHERE NOT EXISTS (
        SELECT 1 FROM ${T.comments} bp
        WHERE bp.author = o.root_author AND bp.permlink = o.root_permlink
          AND ${validPevoPaperWhere({ commentAlias: 'bp', appTagParam: tag, bridgeAccountParam: bridge, source: 'bridge' })}
      )
    ) anchors
    GROUP BY 1, 2, 3
  ),
  route2_stream AS (
    SELECT se.root_author, se.root_permlink, se.signer AS account, ops.action, ops.block_num, ops.id
    FROM consent_ops_raw ops
    JOIN consent_signer_eligibility se
      ON se.root_author = ops.r_author AND se.root_permlink = ops.r_permlink
     AND se.signer = ops.subject
    WHERE ((ops.action IN ('author_accept', 'author_resign')
            AND ops.signer = se.signer
            AND (ops.action = 'author_resign' OR ops.block_num > se.first_block))
       OR (ops.action = 'demote_revoke'
            AND (ops.signer = ops.r_author OR ops.signer = ${bridge} OR ops.signer = ${admin} OR ops.signer = ops.subject)))
      ${signersFilter}
  ),
  route2_latest AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY root_author, root_permlink, account
                                 ORDER BY block_num DESC, id DESC) AS rn
    FROM route2_stream
  ),
  consented_authors AS MATERIALIZED (
    SELECT cc.root_author, cc.root_permlink, cc.root_author AS account
    FROM canonical_chain cc
    JOIN ${T.comments} rc ON rc.author = cc.root_author AND rc.permlink = cc.root_permlink
    WHERE cc.depth = 0
      ${scope ? `AND cc.root_author = ANY($${p + 3}::text[])` : ''}
      AND (EXISTS (SELECT 1 FROM claimed_hive_slots s
                    WHERE s.root_author = cc.root_author AND s.root_permlink = cc.root_permlink
                      AND s.hive = cc.root_author)
           OR (rc.json_metadata -> ${tag} ->> 'type' = 'bridge_paper' AND rc.author = ${bridge}))
      AND NOT EXISTS (SELECT 1 FROM route2_latest rl
                       WHERE rl.root_author = cc.root_author AND rl.root_permlink = cc.root_permlink
                         AND rl.account = cc.root_author AND rl.rn = 1 AND rl.action != 'author_accept')
    UNION
    SELECT root_author, root_permlink, account
    FROM route2_latest WHERE rn = 1 AND action = 'author_accept'
  )`,
    params: [config.appTag, config.hiveBridgeAccount, config.hiveAdminAccount, ...scopeParams],
    nextIdx: scope ? p + 4 : p + 3,
  };
}

/**
 * Scope narrowing shared by `consentSeedCteBody` and the `consentStackCteBody`
 * composer that wraps it. This is the SEED scope, distinct from
 * `ConsentChainScope` (which scopes the down-walk) and `AuthorshipClaimsScope`.
 *   - `{ signer }` — single-account surfaces (profile, the single-review fetch).
 *   - `{ papers }` — page-bounded batch surfaces (the listing vote batch); an
 *     empty list emits the seed's FALSE backstop.
 */
export type ConsentSeedScope =
  | { signer: string }
  | { papers: Array<{ author: string; permlink: string }> };

/**
 * CTE body for the display-surface Route-2 walk seed: the distinct root
 * papers cited by any `author_accept` / `author_resign` op. Feeds
 * `consentChainCteBody({ rootsFromCte: 'consent_seed' })` so a display
 * exclusion's chain walk is bounded by consent-op volume, not corpus size.
 *
 * Why this seed is exclusion-complete: a paper with NO accept op has no
 * Route-2 consented member, so its consented set is at most the Route-1 root
 * broadcaster — whose self-review/self-vote every display surface already
 * drops via the poster gates (`excludeSelfReviewWhere`, `voter != author`).
 * Skipping such papers is cycle-parity for the exclusion's purpose, not an
 * approximation. `revoke_authorship` ops are not in the seed: a revoke only
 * shrinks the consented set, and a paper reachable only through a revoke has
 * no accept to demote. Resigns are seeded for symmetry with the reputation
 * cycle's `consent_seed` (reputation.ts), which seeds the same walk scoped
 * to its batch's target users.
 *
 * @param scope - optional narrowing:
 *   - `{ signer }` — only ops signed by the account (single-account
 *     surfaces: profile, the single-review fetch, where the excluded
 *     reviewer/voter is one known account).
 *   - `{ papers }` — only ops citing the given root papers (page-bounded
 *     batch surfaces: the listing vote batch). An empty list emits a
 *     well-formed `FALSE` filter (empty seed, empty consented set).
 *   Omit for in-statement multi-result surfaces (listing review-agg, search,
 *   stats), where result membership is computed in the same statement.
 */
export function consentSeedCteBody(
  startIdx = 1,
  scope?: ConsentSeedScope,
): SqlFragment {
  const p = startIdx; // $p = appTag
  let nextIdx = p + 1;
  let scopeFilter = '';
  const scopeParams: unknown[] = [];
  if (scope && 'signer' in scope) {
    scopeFilter = `
      AND cj.required_posting_auths ->> 0 = $${nextIdx}`;
    scopeParams.push(scope.signer);
    nextIdx += 1;
  } else if (scope && 'papers' in scope) {
    if (scope.papers.length === 0) {
      scopeFilter = `
      AND FALSE`;
    } else {
      const pairs: string[] = [];
      for (const paper of scope.papers) {
        pairs.push(`($${nextIdx}, $${nextIdx + 1})`);
        scopeParams.push(paper.author, paper.permlink);
        nextIdx += 2;
      }
      scopeFilter = `
      AND (cj.json::jsonb ->> 'root_author', cj.json::jsonb ->> 'root_permlink') IN (${pairs.join(', ')})`;
    }
  }
  return {
    sql: `
  consent_seed AS (
    SELECT DISTINCT cj.json::jsonb ->> 'root_author' AS paper_author,
           cj.json::jsonb ->> 'root_permlink' AS paper_permlink
    FROM ${T.customJson} cj
    WHERE cj.custom_id = $${p}
      AND cj.json::jsonb ->> 'action' IN ('author_accept', 'author_resign')${scopeFilter}
  )`,
    params: [config.appTag, ...scopeParams],
    nextIdx,
  };
}

/** Compose the display-surface consent stack — `consentSeedCteBody` →
 *  `consentChainCteBody({ rootsFromCte: 'consent_seed' })` →
 *  `consentedAuthorsCteBody` — as ONE builder. Byte-equivalent to listing
 *  the three builders sequentially in `buildWith`/`buildRecursiveWith`
 *  (the internal joiner matches the builders' `', '` CTE separator) with
 *  identical param order and `nextIdx`, so the SQL-shape canaries see no
 *  emission change; the equivalence is pinned per scope shape in
 *  `hafsql.test.ts`. Two classes of site are NOT this composer's callers:
 *  (1) sites with a CUSTOM seed CTE (the reputation cycle's batch-activity
 *  seed, the pending-consents `pending_seed` up-walk) compose
 *  `consentChainCteBody` + `consentedAuthorsCteBody` directly on their own
 *  seed; (2) the per-paper badge/detail sites
 *  (`fetchConsentedAccountsForPaper` and the per-paper detail chain in
 *  `papers.ts`) seed `consentChainCteBody({ paperAuthor, paperPermlink })`
 *  directly with NO `consent_seed` CTE at all, so they are not 3-tuple
 *  composer sites either.
 *
 *  One scope value fans out to the members that consume it:
 *   - `{ signer }` — single-account surfaces: seeds from the account's own
 *     consent ops and narrows the resolved set to that account
 *     (`{ signers: [signer] }`).
 *   - `{ papers }` — page-bounded batch surfaces: seeds from the page's
 *     paper keys, resolution unscoped (an empty list emits the seed's
 *     FALSE backstop).
 *   - omitted — in-statement multi-result surfaces (listing/search/stats):
 *     unscoped seed and resolution, one fenced resolution per query. */
export function consentStackCteBody(
  startIdx = 1,
  scope?: ConsentSeedScope,
): SqlFragment {
  const seed = consentSeedCteBody(startIdx, scope);
  const chain = consentChainCteBody(seed.nextIdx, { rootsFromCte: 'consent_seed' });
  const consented = consentedAuthorsCteBody(
    chain.nextIdx,
    scope && 'signer' in scope ? { signers: [scope.signer] } : undefined,
  );
  return {
    sql: `${seed.sql}, ${chain.sql}, ${consented.sql}`,
    params: [...seed.params, ...chain.params, ...consented.params],
    nextIdx: consented.nextIdx,
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
    -- Same-block tie-breaker: v.id (operation_vote_view has no trx_in_block;
    -- v.id is the monotonic HAF op id) per
    -- agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md Rule 2
    ORDER BY v.voter, v.block_num DESC, v.id DESC
  ) lv WHERE lv.weight != 0)`;
}

/**
 * Time-decay multiplier for an aged contribution (paper / review / citation),
 * emitted as a CASE expression valued in [decay_floor, 1.0]: full weight (1.0)
 * inside the grace window, then linear decay toward `decay_floor` past it.
 *
 * The created column differs per call site (`up.created` / `ur.created` /
 * `cpq.citing_created`); the cycle-reference and weights aliases default to the
 * `cr` / `w` CROSS JOINs the *_scores CTEs share. Requires `cycle_ref` (ref_ts)
 * and the weights row (decay_grace_months, decay_floor, decay_rate) in scope.
 *
 * Self-flooring by construction, so call sites must NOT wrap this in an outer
 * GREATEST(decay_floor, ...): the grace arm returns 1.0 (>= decay_floor, which
 * `sanitizeReputationWeights` clamps to [0, 1] at load time), and the decay arm
 * already floors via GREATEST. Sharing one helper keeps paper/review/citation
 * aging from silently desyncing on a one-site edit.
 *
 * @param createdExpr - SQL expression for the contribution's created timestamp
 * @param opts.weightsAlias - alias of the weights row (default 'w')
 * @param opts.cycleRefAlias - alias of the cycle_ref row (default 'cr')
 */
export function decayMultiplierSql(
  createdExpr: string,
  opts: { weightsAlias?: string; cycleRefAlias?: string } = {},
): string {
  const w = opts.weightsAlias ?? 'w';
  const cr = opts.cycleRefAlias ?? 'cr';
  const months = `EXTRACT(EPOCH FROM (${cr}.ref_ts - ${createdExpr})) / (86400.0 * 30)`;
  return `(CASE WHEN ${months} <= ${w}.decay_grace_months THEN 1.0 ELSE GREATEST(${w}.decay_floor, 1.0 - ((${months} - ${w}.decay_grace_months) * ${w}.decay_rate)) END)`;
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

/**
 * `buildWith` variant emitting `WITH RECURSIVE`. Required whenever the CTE
 * list contains a self-referential member (`consentChainCteBody`'s
 * `chain_tree` / `canonical_chain`); PostgreSQL applies the RECURSIVE
 * keyword to the whole list, so non-recursive members compose unchanged. A
 * separate builder (rather than always emitting RECURSIVE from `buildWith`)
 * keeps the SQL strings of existing non-recursive queries byte-stable for
 * their shape canaries.
 */
export function buildRecursiveWith(startIdx: number, ...cteBuilders: Array<(idx: number) => SqlFragment>): SqlFragment {
  const base = buildWith(startIdx, ...cteBuilders);
  return { ...base, sql: base.sql.replace(/^WITH /, 'WITH RECURSIVE ') };
}

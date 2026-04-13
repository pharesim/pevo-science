/**
 * HafSQL query fragments.
 *
 * Since we cannot create views on the public HafSQL database, these
 * functions provide reusable SQL snippets that replace the speculative
 * `pevo.*` views from docs/haf-views.sql.
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
      cj.json::jsonb ->> 'timestamp' AS event_timestamp,
      cj.id AS event_id,
      ROW_NUMBER() OVER (PARTITION BY cj.json::jsonb ->> 'account' ORDER BY cj.block_num DESC) AS rn
    FROM ${T.customJson} cj
    WHERE cj.custom_id = $${p}
      AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
      AND cj.required_posting_auths ?| $${p + 1}::text[]
  ),
  active_accreditations AS (
    SELECT account, researcher_name, institution, field, method, event_timestamp, event_id
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
      AND cj.json::jsonb ->> 'action' IN ('vouch', 'unvouch')
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
  )`,
    params: [config.appTag],
    nextIdx: p + 1,
  };
}

// ─── PEvO content filters ────────────────────────────────────────

/**
 * WHERE clause fragment to identify PEvO papers in hafsql.comments.
 * Uses `c.` as the table alias.
 *
 * @param startIdx - first available $N parameter index
 */
export function isPevoPaperSql(startIdx = 1): SqlFragment {
  const p = startIdx;
  return {
    sql: `
  c.parent_author = '' AND c.parent_permlink = $${p}
  AND (c.json_metadata -> $${p} ->> 'type') = 'paper'
  AND c.json_metadata ->> 'app' LIKE $${p + 1}`,
    params: [config.appTag, `${config.appTag}/%`],
    nextIdx: p + 2,
  };
}

/** WHERE clause fragment to identify PEvO bridge papers in hafsql.comments */
export function isPevoBridgePaperSql(startIdx = 1): SqlFragment {
  const p = startIdx;
  return {
    sql: `
  c.parent_author = '' AND c.parent_permlink = $${p}
  AND (c.json_metadata -> $${p} ->> 'type') = 'bridge_paper'
  AND c.json_metadata ->> 'app' LIKE $${p + 1}`,
    params: [config.appTag, `${config.appTag}/%`],
    nextIdx: p + 2,
  };
}

/** WHERE clause fragment to identify any PEvO paper (native or bridge) in hafsql.comments */
export function isPevoAnyPaperSql(startIdx = 1): SqlFragment {
  const p = startIdx;
  return {
    sql: `
  c.parent_author = '' AND c.parent_permlink = $${p}
  AND (c.json_metadata -> $${p} ->> 'type') IN ('paper', 'bridge_paper')
  AND c.json_metadata ->> 'app' LIKE $${p + 1}`,
    params: [config.appTag, `${config.appTag}/%`],
    nextIdx: p + 2,
  };
}

/** WHERE clause fragment to identify PEvO reviews in hafsql.comments */
export function isPevoReviewSql(startIdx = 1): SqlFragment {
  const p = startIdx;
  return {
    sql: `
  (c.json_metadata -> $${p} ->> 'type') = 'review'
  AND c.json_metadata ->> 'app' LIKE $${p + 1}`,
    params: [config.appTag, `${config.appTag}/%`],
    nextIdx: p + 2,
  };
}

/** WHERE clause fragment to identify PEvO discussion comments in hafsql.comments */
export function isPevoCommentSql(startIdx = 1): SqlFragment {
  const p = startIdx;
  return {
    sql: `
  (c.json_metadata -> $${p} ->> 'type') = 'comment'
  AND c.json_metadata ->> 'app' LIKE $${p + 1}`,
    params: [config.appTag, `${config.appTag}/%`],
    nextIdx: p + 2,
  };
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
  return `(SELECT count(*)::int FROM ${T.votes} v
    JOIN active_accreditations aa ON aa.account = v.voter
    WHERE v.author = ${authorExpr} AND v.permlink = ${permlinkExpr} AND v.rshares > 0
      AND v.voter != ${authorExpr})`;
}

/**
 * Subquery that sums accredited rshares for a given (author, permlink).
 */
export function accreditedRshares(authorExpr: string, permlinkExpr: string): string {
  return `COALESCE((SELECT sum(v.rshares) FROM ${T.votes} v
    JOIN active_accreditations aa ON aa.account = v.voter
    WHERE v.author = ${authorExpr} AND v.permlink = ${permlinkExpr} AND v.rshares > 0
      AND v.voter != ${authorExpr}), 0)`;
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Merge multiple SqlFragments sequentially, adjusting parameter indices.
 * Useful when combining CTEs in a single WITH block.
 */
export function mergeFragments(...fragments: SqlFragment[]): SqlFragment {
  const allParams: unknown[] = [];
  const sqlParts: string[] = [];
  for (const f of fragments) {
    allParams.push(...f.params);
    sqlParts.push(f.sql);
  }
  const lastFrag = fragments[fragments.length - 1];
  return { sql: sqlParts.join(', '), params: allParams, nextIdx: lastFrag?.nextIdx ?? 1 };
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

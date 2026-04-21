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

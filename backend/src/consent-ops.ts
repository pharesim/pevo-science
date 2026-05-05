/**
 * Multi-author trust model: vouched-set computation helpers.
 *
 * Round 1 of the Phase 2 implementation of `backend-coauthor-trust-model`.
 * Ships the read-time vouched-set computation as a fetch + pure compute
 * split. Round 2 wires it into `resolveContinuationChain`'s admit gate.
 *
 * Spec: `agents/docs/ARCHITECTURE.md` section 2 "Multi-Author Trust Model"
 *   - "Vouched vs claimed authorship": a claimed author is **vouched** iff
 *     they broadcast the root post OR their latest valid `author_accept`
 *     op has not been superseded by a later `author_resign`.
 *   - "Author Accept (custom_json)" / "Author Resign (custom_json)":
 *     wire format + validity rules (signer-binding, temporal-ordering for
 *     accept, latest-op-wins per `(block_num, trx_in_block)`).
 *
 * Convention: `agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md`
 *   - Rule 2: use `(block_num, trx_in_block)` for op ordering.
 *     `hafsql.operation_custom_json_view` does NOT expose `trx_in_block`,
 *     but its `id` column is the HAF operation id (monotonic per chain;
 *     within a block, higher `id` = later op). Using `id` as the same-block
 *     tie-breaker is operationally equivalent. See [TODO Architect] in the
 *     round-1 signal block of `backend-coauthor-trust-model.md` for the
 *     ARCH.md/convention-doc spec update.
 *   - Rule 5: signer-to-payload-subject binding. The `author_accept` /
 *     `author_resign` payload schema has no subject identity field; the
 *     chain signer IS the implicit accepter/resigner. The validity rule
 *     degenerates to "the op only counts for the signer themselves" — no
 *     way to mint a third party's consent.
 *   - Rule 6: reject pre-broadcast ops where `block_num` predates the
 *     actor's eligibility. For `author_accept`, the accept op MUST be
 *     strictly later than the first block in which the accepter's handle
 *     was claimed in `pevo.authors[]`. (Resign ops have no temporal-ordering
 *     rule per ARCH.md "Author Resign" validity.)
 */

import { config } from './config.js';
import { getPool } from './db.js';
import { logger } from './logger.js';
import { T, getCachedGenesisBlock } from './hafsql.js';

export interface ConsentOp {
  /** required_posting_auths[0] — the implicit accepting/resigning author. */
  signer: string;
  action: 'author_accept' | 'author_resign';
  rootAuthor: string;
  rootPermlink: string;
  blockNum: number;
  /**
   * HAF operation id. Monotonic per chain; within a block, higher id = later
   * op. Stored as a string because the value (e.g. `455756464590425874`)
   * exceeds `Number.MAX_SAFE_INTEGER`. Use `BigInt(opId)` for comparison.
   */
  opId: string;
}

/**
 * Fetch consent ops (`author_accept` / `author_resign`) for a paper from
 * HAF. Returns ops in arbitrary order; `computeVouchedAuthors` is
 * responsible for ordering. Returns `[]` if HAF is unavailable — callers
 * can safely compute the vouched-set from an empty op list (which yields
 * just the root broadcaster, matching ARCH.md rule 1).
 */
export async function fetchConsentOpsForPaper(
  rootAuthor: string,
  rootPermlink: string,
): Promise<ConsentOp[]> {
  const pool = getPool();
  if (!pool) return [];

  const sql = `
    SELECT
      cj.required_posting_auths ->> 0 AS signer,
      cj.json::jsonb ->> 'action' AS action,
      cj.json::jsonb ->> 'root_author' AS root_author,
      cj.json::jsonb ->> 'root_permlink' AS root_permlink,
      cj.block_num AS block_num,
      cj.id::text AS op_id
    FROM ${T.customJson} cj
    WHERE cj.custom_id = $1
      AND cj.block_num >= $2
      AND cj.json::jsonb ->> 'action' IN ('author_accept', 'author_resign')
      AND cj.json::jsonb ->> 'root_author' = $3
      AND cj.json::jsonb ->> 'root_permlink' = $4
  `;
  const params = [
    config.appTag,
    getCachedGenesisBlock(),
    rootAuthor,
    rootPermlink,
  ];

  try {
    const result = await pool.query(sql, params);
    return result.rows.map((row): ConsentOp => ({
      signer: String(row.signer ?? '').trim().toLowerCase(),
      action: row.action as 'author_accept' | 'author_resign',
      rootAuthor: String(row.root_author ?? ''),
      rootPermlink: String(row.root_permlink ?? ''),
      blockNum: Number(row.block_num),
      opId: String(row.op_id),
    }));
  } catch (err) {
    logger.error(
      {
        err,
        root_author: rootAuthor,
        root_permlink: rootPermlink,
        event: 'consent_ops.fetch_failed',
        route: 'consent-ops',
      },
      'consent-ops fetch failed',
    );
    return [];
  }
}

/**
 * Compare two consent ops for descending recency. Latest = highest
 * `(blockNum, opId)` per the convention's same-block tie-break rule.
 */
function compareOpsDesc(a: ConsentOp, b: ConsentOp): number {
  if (a.blockNum !== b.blockNum) return b.blockNum - a.blockNum;
  const aOp = BigInt(a.opId);
  const bOp = BigInt(b.opId);
  if (aOp === bOp) return 0;
  return aOp < bOp ? 1 : -1;
}

/**
 * Compute the vouched-author set for a paper from claimed-set context plus
 * the consent op history. Pure function — no I/O.
 *
 * @param rootBroadcaster - the chain-level author of the root post.
 *   Implicitly vouched per ARCH.md "Vouched vs claimed authorship" rule 1.
 *   The implicit-vouched flag fires only if the broadcaster also appears
 *   in `claimedAuthors`; otherwise the broadcaster isn't a claimed author
 *   of the paper and `pevo.authors[]` is the source of truth for credit.
 *   (For native papers the broadcaster is always in `pevo.authors[]`; this
 *   defensive check covers degenerate metadata where they aren't listed.)
 * @param claimedAuthors - the historical union of `pevo.authors[].hive`
 *   across all admitted operations on the paper's continuation chain.
 *   Lowercased Hive handles. The caller is responsible for case-folding
 *   and chain-walk computation (round 2 integration site).
 * @param firstClaimBlockByAuthor - per-author `block_num` of the earliest
 *   admitted operation that listed them in `pevo.authors[]`. Used to
 *   reject pre-broadcast `author_accept` ops per the temporal-ordering
 *   rule (rejects name-squatting under a colliding handle).
 * @param consentOps - all `author_accept` / `author_resign` ops for this
 *   paper, in any order.
 */
export function computeVouchedAuthors(
  rootBroadcaster: string,
  claimedAuthors: Set<string>,
  firstClaimBlockByAuthor: Map<string, number>,
  consentOps: ConsentOp[],
): Set<string> {
  const vouched: Set<string> = new Set();
  const root = rootBroadcaster.trim().toLowerCase();
  if (claimedAuthors.has(root)) vouched.add(root);

  // Group ops by signer (= accepting/resigning author per implicit binding).
  const opsBySigner = new Map<string, ConsentOp[]>();
  for (const op of consentOps) {
    const signer = op.signer.trim().toLowerCase();
    if (signer.length === 0) continue;
    if (!opsBySigner.has(signer)) opsBySigner.set(signer, []);
    opsBySigner.get(signer)!.push(op);
  }

  for (const [signer, ops] of opsBySigner) {
    if (signer === root) continue; // already handled by rule 1
    if (!claimedAuthors.has(signer)) continue; // not a claimed author — op is inert

    const firstClaimBlock = firstClaimBlockByAuthor.get(signer);
    if (firstClaimBlock === undefined) continue; // claimed but no first-claim block — defensive: treat as not vouched

    // Filter accepts by temporal-ordering rule. ARCH.md "Author Accept"
    // validity: block_num MUST be strictly greater than the earliest
    // first-claim block. Resigns have no temporal-ordering rule.
    const validOps = ops.filter((op) => {
      if (op.action === 'author_accept') return op.blockNum > firstClaimBlock;
      return true;
    });
    if (validOps.length === 0) continue;

    // Latest valid op wins per (blockNum, opId) descending.
    validOps.sort(compareOpsDesc);
    const latest = validOps[0];
    if (latest.action === 'author_accept') vouched.add(signer);
    // 'author_resign' (or no valid ops) → not vouched.
  }

  return vouched;
}

/**
 * Convenience orchestrator: fetch consent ops then compute the vouched
 * set. Round 2's integration site (`resolveContinuationChain` in
 * `routes/papers.ts`) calls this once per paper-detail request.
 */
export async function getVouchedAuthors(
  rootAuthor: string,
  rootPermlink: string,
  claimedAuthors: Set<string>,
  firstClaimBlockByAuthor: Map<string, number>,
): Promise<Set<string>> {
  const consentOps = await fetchConsentOpsForPaper(rootAuthor, rootPermlink);
  return computeVouchedAuthors(
    rootAuthor,
    claimedAuthors,
    firstClaimBlockByAuthor,
    consentOps,
  );
}

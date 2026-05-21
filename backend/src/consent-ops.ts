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

export type ConsentAction = 'author_accept' | 'author_resign';

export interface ConsentOp {
  /** required_posting_auths[0] — the implicit accepting/resigning author. */
  signer: string;
  action: ConsentAction;
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

/** Round-4 hold #8: type-guard for the `action` field on the SQL row.
 *  The query's `IN ('author_accept', 'author_resign')` predicate filters
 *  the result set, but TS sees no relationship between the predicate and
 *  the row shape. If the SQL filter is ever relaxed or the view changes
 *  shape, an unrecognized `action` string would silently propagate and
 *  fall through `=== 'author_accept'` checks (treated as resign). The
 *  guard centralizes the membership test. */
function isConsentAction(value: unknown): value is ConsentAction {
  return value === 'author_accept' || value === 'author_resign';
}

/** Round-4 hold #4: hard cap on the consent-op row set per paper. The
 *  threat-model concern is `author_accept` / `author_resign` spam by a
 *  malicious claimed co-author: Hive enforces account-level rate limits
 *  but no per-paper cap, so an adversary can grow a paper's consent-op
 *  history unbounded. With LIMIT applied + ORDER BY id DESC, the latest
 *  ops are retained when the cap fires, which is the operationally
 *  relevant slice (latest valid op wins per `computeVouchedAuthors`). The
 *  threshold is sized for the cumulative-union task's expected chain
 *  length (a multi-author paper with weekly version bumps over the
 *  beta phase; well below 1000 in any plausible scenario). */
const FETCH_CONSENT_OPS_LIMIT = 1000;

/**
 * Fetch consent ops (`author_accept` / `author_resign`) for a paper from
 * HAF. Returns ops in arbitrary order; `computeVouchedAuthors` is
 * responsible for ordering. Returns `[]` if HAF is unavailable — callers
 * can safely compute the vouched-set from an empty op list (which yields
 * just the root broadcaster, matching ARCH.md rule 1).
 *
 * Round-4 hold #4: capped at `FETCH_CONSENT_OPS_LIMIT` rows per paper to
 * bound memory + sort cost under spam. The `ORDER BY cj.id DESC` clause
 * ensures the latest ops are retained when the cap fires (latest-op-wins
 * is the only ordering `computeVouchedAuthors` cares about). When the cap
 * is reached the helper currently does not surface a "more ops exist"
 * signal to the caller; round-2 integration may want a warning event.
 *
 * Round-5 hold #2: signer-filter pushed down into the SQL WHERE. Without
 * it, the LIMIT 1000 + ORDER BY cj.id DESC admitted a de-vouch attack:
 * any Hive account can post a fee-less `custom_json {action:
 * 'author_accept', root_author: P, root_permlink: P}` against any
 * paper. The op fails the consent-action validity check at
 * `computeVouchedAuthors` (signer not in claimed-set), but it still
 * counts against the LIMIT. An attacker spamming 1000+ such ops pushes
 * legitimate co-authors' `author_accept` ops below the cut: the latest
 * 1000 rows by `cj.id` DESC are all attacker-signed, and the legitimate
 * co-author's accept is invisible to the computation → de-vouched.
 * Filtering by `cj.required_posting_auths ->> 0 IN (claimed_set)` at
 * the SQL layer ensures the LIMIT bounds attacker-signed rows OUT of
 * the row set entirely; the cap only fires on legitimate signer spam,
 * which is bounded by the claimed-set's cardinality (a few co-authors
 * per paper) under Hive's per-account rate limit.
 *
 * Per HAF Rule 5
 * (`agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md`):
 * the `required_posting_auths[0]` IS the consent op's implicit
 * accepter/resigner (the chain signer is the actor). Filtering by
 * signer membership at the SQL is therefore equivalent to the
 * `claimedAuthors.has(signer)` check at `computeVouchedAuthors:221` —
 * any signer outside the claimed-set produces an inert op no matter
 * what the broadcast surface allows.
 *
 * Round-4 hold #16: this fetch runs against the HAF Pool which currently
 * has no per-query `statement_timeout`. The follow-up task
 * `architect-haf-unavailability-vouched-set-policy` handles policy for
 * timeouts and HAF-unavailability at the integration site (round 2).
 * Until then, slow HAF can hold the paper-detail thread for the duration
 * of the upstream pool's connection-level timeout. The bounded LIMIT +
 * ORDER BY means a worst-case scan is bounded by the cap.
 */
export async function fetchConsentOpsForPaper(
  rootAuthor: string,
  rootPermlink: string,
  claimedAuthors: ReadonlySet<string>,
): Promise<ConsentOp[]> {
  const pool = getPool();
  if (!pool) return [];

  // Round-5 hold #2: empty claimed-set produces no possible vouched
  // signers; short-circuit the SQL entirely. Avoids issuing a query with
  // an empty `IN ()` clause (which is invalid SQL on most dialects) and
  // matches the semantic at `computeVouchedAuthors`: no claimed authors
  // means no vouchable consent ops.
  if (claimedAuthors.size === 0) return [];

  // Build the `IN ($k, $k+1, ...)` placeholder list for the claimed-set
  // signer filter. Parameterized to prevent SQL injection from any
  // upstream caller that didn't pre-validate handle shape.
  const claimedArray = Array.from(claimedAuthors);
  const claimedPlaceholders = claimedArray
    .map((_, idx) => `$${idx + 5}`)
    .join(', ');

  // eslint-disable-next-line pevo/no-custom-id-block-num-floor -- fetchConsentOps: per-paper lookup further narrowed by `root_author`, `root_permlink`, and the `claimedPlaceholders` signer IN-list; pending audit per the BitmapAnd-floor sweep follow-up
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
      AND cj.required_posting_auths ->> 0 IN (${claimedPlaceholders})
    ORDER BY cj.id DESC
    LIMIT ${FETCH_CONSENT_OPS_LIMIT}
  `;
  const params = [
    config.appTag,
    getCachedGenesisBlock(),
    rootAuthor,
    rootPermlink,
    ...claimedArray,
  ];

  try {
    const result = await pool.query(sql, params);
    return result.rows.flatMap((row): ConsentOp[] => {
      // Defensive narrowing: even though the WHERE filter restricts the
      // action to the two consent values, we re-validate at the row
      // boundary so a future SQL change can't silently corrupt the
      // typed result.
      if (!isConsentAction(row.action)) return [];
      return [{
        signer: String(row.signer ?? '').trim().toLowerCase(),
        action: row.action,
        rootAuthor: String(row.root_author ?? ''),
        rootPermlink: String(row.root_permlink ?? ''),
        blockNum: Number(row.block_num),
        opId: String(row.op_id),
      }];
    });
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
  const consentOps = await fetchConsentOpsForPaper(rootAuthor, rootPermlink, claimedAuthors);
  return computeVouchedAuthors(
    rootAuthor,
    claimedAuthors,
    firstClaimBlockByAuthor,
    consentOps,
  );
}

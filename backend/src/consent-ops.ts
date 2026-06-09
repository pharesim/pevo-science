/**
 * Multi-author trust model: consented-set computation helpers.
 *
 * Read-time consented-set computation as a fetch + pure-compute split
 * (`fetchConsentOpsForPaper` + `computeConsentedAuthors`). The SQL twin —
 * `consentedAuthorsCteBody` in `hafsql.ts` — is the single source of truth
 * for credited-set membership consumed by the reputation cycle and the read
 * surfaces; these JS primitives provide the unit-testable resolution logic
 * and the per-paper fetch path for surfaces that resolve in JS.
 *
 * Spec: `agents/docs/ARCHITECTURE.md` section 2 "Multi-Author Trust Model"
 *   - "Consented vs claimed authorship": a claimed author is **consented**
 *     iff they broadcast the root post OR their latest valid `author_accept`
 *     op has not been superseded by a later `author_resign` (or a
 *     `revoke_authorship` backstop, resolved at the SQL layer).
 *   - "Author Accept (custom_json)" / "Author Resign (custom_json)":
 *     wire format + validity rules (signer-binding, temporal-ordering for
 *     accept, latest-op-wins per `(block_num, id)`).
 *
 * Eligibility anchors (route 2): a claimed slot anchors a signer when the
 * slot's `hive` equals the signer, OR the slot's `orcid` equals the signer's
 * authority-attested ORCID (latest accredit/revoke wins). A null attested
 * ORCID never matches an orcid-anchored slot: a broadcaster-claimed ORCID
 * only establishes who may consent, never credit, and only the on-chain
 * attestation proves the signer owns the ORCID.
 *
 * Convention: `agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md`
 *   - Rule 2: use `(block_num, trx_in_block)` for op ordering.
 *     `hafsql.operation_custom_json_view` does NOT expose `trx_in_block`,
 *     but its `id` column is the HAF operation id (monotonic per chain;
 *     within a block, higher `id` = later op). Using `id` as the same-block
 *     tie-breaker is operationally equivalent.
 *   - Rule 5: signer-to-payload-subject binding. The `author_accept` /
 *     `author_resign` payload schema has no subject identity field; the
 *     chain signer IS the implicit accepter/resigner. The validity rule
 *     degenerates to "the op only counts for the signer themselves" — no
 *     way to mint a third party's consent.
 *   - Rule 6: reject pre-broadcast ops where `block_num` predates the
 *     actor's eligibility. For `author_accept`, the accept op MUST be
 *     strictly later than the first block in which a slot anchoring the
 *     accepter appeared in `pevo.authors[]`. (Resign ops have no
 *     temporal-ordering rule per ARCH.md "Author Resign" validity.)
 */

import { config } from './config.js';
import { getPool } from './db.js';
import { logger } from './logger.js';
import { T } from './hafsql.js';

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

/**
 * One claimed author slot from the paper's cumulative chain union (the
 * append-only union of `pevo.authors[]` entries across all operations on
 * admitted chain posts). Anchors are pre-normalized by the caller:
 * `hive` via `normalizeHiveAccount` (lowercase + ASCII-space trim + charset
 * guard), `orcid` via ASCII-C-whitespace trim (the
 * `CHAIN_ORCID_BTRIM_CHARSET` family — NOT full-Unicode `.trim()`, which
 * diverges from the SQL twin on exotic whitespace; see the
 * sql-trim-vs-js-trim convention).
 */
export interface ClaimedSlot {
  /** Normalized hive anchor, or null when the slot carries none. */
  hive: string | null;
  /** Normalized chain orcid anchor, or null when the slot carries none. */
  orcid: string | null;
  /**
   * Earliest admitted operation block that named this slot — the
   * `author_accept` temporal lower bound (Rule 6).
   */
  firstAppearanceBlock: number;
}

/**
 * Discriminated fetch result: "no ops" and "HAF unavailable" are different
 * answers. The consented layer fails closed (ARCHITECTURE.md "Consented-set
 * computation"): a caller seeing `haf_unavailable` must surface 503, never
 * degrade to a root-only consented set, and must never cache the sentinel.
 */
export type ConsentOpsFetchResult =
  | { status: 'ok'; ops: ConsentOp[] }
  | { status: 'haf_unavailable' };

/** Type-guard for the `action` field on the SQL row. The query's
 *  `IN ('author_accept', 'author_resign')` predicate filters the result
 *  set, but TS sees no relationship between the predicate and the row
 *  shape. If the SQL filter is ever relaxed or the view changes shape, an
 *  unrecognized `action` string would silently propagate and fall through
 *  `=== 'author_accept'` checks (treated as resign). The guard centralizes
 *  the membership test. */
function isConsentAction(value: unknown): value is ConsentAction {
  return value === 'author_accept' || value === 'author_resign';
}

/** Hard cap on the consent-op row set per paper. The threat-model concern
 *  is `author_accept` / `author_resign` spam by a malicious claimed
 *  co-author: Hive enforces account-level rate limits but no per-paper cap,
 *  so an adversary can grow a paper's consent-op history unbounded. With
 *  LIMIT applied + ORDER BY id DESC, the latest ops are retained when the
 *  cap fires, which is the operationally relevant slice (latest valid op
 *  wins per `computeConsentedAuthors`). The threshold is sized for the
 *  cumulative-union chain length (a multi-author paper with weekly version
 *  bumps over the beta phase; well below 1000 in any plausible scenario). */
const FETCH_CONSENT_OPS_LIMIT = 1000;

/**
 * Fetch consent ops (`author_accept` / `author_resign`) for a paper from
 * HAF. Returns ops in arbitrary order; `computeConsentedAuthors` is
 * responsible for ordering. Returns `{ status: 'haf_unavailable' }` when the
 * pool is absent or the query throws — fail-closed, distinguishable from a
 * legitimate empty op list (`{ status: 'ok', ops: [] }`).
 *
 * Capped at `FETCH_CONSENT_OPS_LIMIT` rows per paper to bound memory + sort
 * cost under spam. The `ORDER BY cj.id DESC` clause ensures the latest ops
 * are retained when the cap fires (latest-op-wins is the only ordering
 * `computeConsentedAuthors` cares about).
 *
 * Signer-filter pushed down into the SQL WHERE. Without it, the LIMIT +
 * ORDER BY cj.id DESC admits a de-consent attack: any Hive account can post
 * a fee-less `custom_json {action: 'author_accept', root_author: P,
 * root_permlink: P}` against any paper. The op fails the eligibility check
 * at `computeConsentedAuthors` (signer anchored by no slot), but it still
 * counts against the LIMIT. An attacker spamming 1000+ such ops pushes
 * legitimate co-authors' `author_accept` ops below the cut: the latest 1000
 * rows by `cj.id` DESC are all attacker-signed, and the legitimate
 * co-author's accept is invisible to the computation. Filtering by
 * `cj.required_posting_auths ->> 0 IN (eligible set)` at the SQL layer
 * ensures the LIMIT bounds attacker-signed rows OUT of the row set
 * entirely; the cap only fires on legitimate signer spam, which is bounded
 * by the eligible set's cardinality (a few co-authors per paper) under
 * Hive's per-account rate limit.
 *
 * Per HAF Rule 5
 * (`agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md`):
 * the `required_posting_auths[0]` IS the consent op's implicit
 * accepter/resigner (the chain signer is the actor). Filtering by signer
 * membership at the SQL is therefore equivalent to the eligibility check at
 * `computeConsentedAuthors` — any signer outside the eligible set produces
 * an inert op no matter what the broadcast surface allows.
 *
 * @param eligibleSigners - accounts that could possibly be consented for
 *   this paper: the claimed slots' hive anchors plus any account whose
 *   authority-attested ORCID matches a claimed slot's orcid anchor. The
 *   caller resolves the orcid-to-account dimension (it requires the
 *   attestation map); `getConsentedAuthors` derives the set internally.
 */
export async function fetchConsentOpsForPaper(
  rootAuthor: string,
  rootPermlink: string,
  eligibleSigners: ReadonlySet<string>,
): Promise<ConsentOpsFetchResult> {
  const pool = getPool();
  if (!pool) return { status: 'haf_unavailable' };

  // An empty eligible set produces no possible consented signers;
  // short-circuit the SQL entirely. Avoids issuing a query with an empty
  // `IN ()` clause (invalid SQL on most dialects) and matches the semantic
  // at `computeConsentedAuthors`: no eligible signers means no resolvable
  // consent ops. This is a real "no ops" answer, not an availability fault.
  if (eligibleSigners.size === 0) return { status: 'ok', ops: [] };

  // Build the `IN ($k, $k+1, ...)` placeholder list for the eligible-signer
  // filter. Parameterized to prevent SQL injection from any upstream caller
  // that didn't pre-validate handle shape.
  const signersArray = Array.from(eligibleSigners);
  const signerPlaceholders = signersArray
    .map((_, idx) => `$${idx + 4}`)
    .join(', ');

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
      AND cj.json::jsonb ->> 'action' IN ('author_accept', 'author_resign')
      AND cj.json::jsonb ->> 'root_author' = $2
      AND cj.json::jsonb ->> 'root_permlink' = $3
      AND cj.required_posting_auths ->> 0 IN (${signerPlaceholders})
    ORDER BY cj.id DESC
    LIMIT ${FETCH_CONSENT_OPS_LIMIT}
  `;
  const params = [
    config.appTag,
    rootAuthor,
    rootPermlink,
    ...signersArray,
  ];

  try {
    const result = await pool.query(sql, params);
    const ops = result.rows.flatMap((row): ConsentOp[] => {
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
    return { status: 'ok', ops };
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
    // Fail closed: an error is an availability fault, not an empty history.
    // Returning ops: [] here would silently demote every non-root co-author.
    return { status: 'haf_unavailable' };
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
 * The slots anchoring a signer, per the route-2 eligibility rule: a slot
 * anchors the signer when its `hive` equals the signer, OR its `orcid`
 * equals the signer's authority-attested ORCID. A signer with a null or
 * absent attested ORCID is never anchored through an orcid slot — the
 * attestation, not a broadcaster claim, proves ORCID ownership. The
 * consented identity resolves atomically from one attestation lookup (the
 * caller-supplied map entry), never per-field.
 */
function slotsAnchoring(
  signer: string,
  claimedSlots: readonly ClaimedSlot[],
  attestedOrcid: string | null | undefined,
): ClaimedSlot[] {
  return claimedSlots.filter((slot) =>
    (slot.hive !== null && slot.hive === signer)
    || (slot.orcid !== null && slot.orcid !== ''
        && attestedOrcid != null && attestedOrcid !== ''
        && slot.orcid === attestedOrcid),
  );
}

/**
 * Compute the consented-author set for a paper from the claimed slot union
 * plus the consent op history. Pure function — no I/O.
 *
 * @param rootBroadcaster - the chain-level author of the root post.
 *   Implicitly consented per ARCH.md "Consented vs claimed authorship"
 *   rule 1. The implicit-consent flag fires only if the broadcaster is also
 *   anchored by some claimed slot; otherwise the broadcaster isn't a claimed
 *   author of the paper and `pevo.authors[]` is the source of truth for
 *   credit. (For native papers the broadcaster is always in
 *   `pevo.authors[]`; this defensive check covers degenerate metadata where
 *   they aren't listed.)
 * @param claimedSlots - the historical union of `pevo.authors[]` slots
 *   across all admitted operations on the paper's continuation chain, with
 *   pre-normalized anchors (see `ClaimedSlot`). The caller is responsible
 *   for case-folding and chain-walk computation.
 * @param attestedOrcidBySigner - per-account authority-attested ORCID,
 *   latest accredit/revoke wins; `null` (or an absent key) means the account
 *   has no live attested ORCID and cannot anchor through an orcid slot.
 * @param consentOps - all `author_accept` / `author_resign` ops for this
 *   paper, in any order.
 */
export function computeConsentedAuthors(
  rootBroadcaster: string,
  claimedSlots: readonly ClaimedSlot[],
  attestedOrcidBySigner: ReadonlyMap<string, string | null>,
  consentOps: ConsentOp[],
): Set<string> {
  const consented: Set<string> = new Set();
  const root = rootBroadcaster.trim().toLowerCase();
  if (slotsAnchoring(root, claimedSlots, attestedOrcidBySigner.get(root)).length > 0) {
    consented.add(root);
  }

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
    const anchors = slotsAnchoring(signer, claimedSlots, attestedOrcidBySigner.get(signer));
    if (anchors.length === 0) continue; // no slot anchors the signer — op is inert

    // Rule 6 lower bound: the earliest first-appearance block among the
    // slots anchoring this signer. A signer anchored by several slots is
    // eligible from the earliest of them.
    const firstClaimBlock = Math.min(...anchors.map((s) => s.firstAppearanceBlock));

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
    if (latest.action === 'author_accept') consented.add(signer);
    // 'author_resign' (or no valid ops) → not consented.
  }

  return consented;
}

/** Result of `getConsentedAuthors` — propagates the fetch's fail-closed
 *  discriminant so integration sites apply the 503 policy explicitly. */
export type ConsentedAuthorsResult =
  | { status: 'ok'; consented: Set<string> }
  | { status: 'haf_unavailable' };

/**
 * Convenience orchestrator: derive the eligible-signer set from the claimed
 * slots + attestation map, fetch consent ops, then compute the consented
 * set. Propagates `haf_unavailable` — callers MUST fail closed on it (503,
 * never a degraded root-only set, never cached).
 */
export async function getConsentedAuthors(
  rootAuthor: string,
  rootPermlink: string,
  claimedSlots: readonly ClaimedSlot[],
  attestedOrcidBySigner: ReadonlyMap<string, string | null>,
): Promise<ConsentedAuthorsResult> {
  // Eligible signers: every hive anchor, plus every account whose attested
  // ORCID matches some slot's orcid anchor.
  const eligible = new Set<string>();
  const slotOrcids = new Set(
    claimedSlots.flatMap((s) => (s.orcid !== null && s.orcid !== '' ? [s.orcid] : [])),
  );
  for (const slot of claimedSlots) {
    if (slot.hive !== null) eligible.add(slot.hive);
  }
  for (const [account, orcid] of attestedOrcidBySigner) {
    if (orcid != null && orcid !== '' && slotOrcids.has(orcid)) eligible.add(account);
  }

  const fetched = await fetchConsentOpsForPaper(rootAuthor, rootPermlink, eligible);
  switch (fetched.status) {
    case 'ok':
      return {
        status: 'ok',
        consented: computeConsentedAuthors(
          rootAuthor,
          claimedSlots,
          attestedOrcidBySigner,
          fetched.ops,
        ),
      };
    case 'haf_unavailable':
      return { status: 'haf_unavailable' };
    default: {
      const exhaustive: never = fetched;
      throw new Error(`Unhandled consent fetch status: ${JSON.stringify(exhaustive)}`);
    }
  }
}

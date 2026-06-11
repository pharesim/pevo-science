import { Router, type Request, type Response } from 'express';
import { getPool, HafQueryError, isRetriableHafError } from '../db.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { hafCache } from '../cache.js';
import {
  T,
  CHAIN_ORCID_BTRIM_CHARSET,
  activeAccreditationsCteBody,
  authorshipClaimsCteBody,
  buildRecursiveWith,
  consentChainCteBody,
  consentedAuthorsCteBody,
} from '../hafsql.js';

const router = Router();

/** Spam-defense bound on the Route-2 pending-consents seed: at most this many
 *  naming posts (newest-first by post creation) enter `pending_seed`'s up-walk
 *  per request. Unbounded, any Hive account could cheaply spam-name a victim
 *  across many posts and push the victim's own pending query into the HAF
 *  pool's statement_timeout on every request (re-fired each volatile-cache
 *  drop). Over-cap semantics are truncated-but-served: the seed is a candidate
 *  superset feeding the authoritative down-walk, not the authoritative record,
 *  so posts beyond the cap fall out of discovery rather than failing closed. */
const NAMING_POSTS_SEED_CAP = 500;

/** TTL upper bound for the per-user pending-authorships cache entry. VOLATILE
 *  tier (no `stable` flag): `block-watcher.ts` drops volatile entries on
 *  every detected new block (~3s), so the discovery surface is at most one
 *  block stale — a claim approval or consent op landing at block N is
 *  reflected by block N+1. The TTL only matters in environments without a
 *  block watcher (dev without HAF). */
const PENDING_AUTHORSHIPS_TTL_MS = 30_000;

/** A Route-3 name-only claim by the authenticated user that awaits the root
 *  author's `approve_authorship` (`authorship_claims.status = 'pending'`). */
interface PendingClaimRow {
  paper_author: string;
  paper_permlink: string;
  author_index: number;
  claimed_at: string;
}

/** A paper whose claimed-slot set anchors the authenticated user (hive slot
 *  or attested-ORCID slot) while the user has no valid consent action yet —
 *  awaiting their `author_accept` (Route 2). */
interface PendingConsentRow {
  paper_author: string;
  paper_permlink: string;
}

/** Compose the Route-3 pending-claims statement: the user's own
 *  `claim_authorship` claims still awaiting the root author's approval.
 *  `authorshipClaimsCteBody` is claimer-scoped, so the embedded chain walk is
 *  bounded by this user's claim cardinality, and the final filter selects the
 *  same dimension the scope pushed down. Exported for the real-Postgres
 *  FROM-redirect regression (the SQL semantics live in the CTE stack; a
 *  result mock cannot exercise them). */
export function composePendingClaimsQuery(claimer: string): { sql: string; params: unknown[] } {
  const cte = buildRecursiveWith(
    1,
    activeAccreditationsCteBody,
    (idx) => authorshipClaimsCteBody(idx, { claimer }),
  );
  const claimerIdx = cte.nextIdx;
  return {
    sql: `${cte.sql}
   SELECT paper_author, paper_permlink, author_index, claimed_at
   FROM authorship_claims
   WHERE claimer = $${claimerIdx} AND status = 'pending'
   ORDER BY claimed_at DESC`,
    params: [...cte.params, claimer],
  };
}

/** Compose the Route-2 pending-consents statement: papers whose claimed-slot
 *  set anchors the user (a hive slot equal to the username, or an orcid slot
 *  equal to the user's authority-attested ORCID) where the user has no valid
 *  consent-stream action yet. Exported for the real-Postgres FROM-redirect
 *  regression.
 *
 *  Composition is hand-written `WITH RECURSIVE` in the reputation cycle's
 *  splicing style because the chain walk must be seeded by the papers that
 *  NAME this user — a seed no builder scope provides:
 *
 *   - `my_attested_orcid` — the user's authority-attested ORCID (from
 *     `active_accreditations`; a broadcaster-claimed ORCID never anchors).
 *   - `naming_posts` — PEvO top-level posts where ANY historical operation's
 *     `pevo.authors[]` names the user's hive account or attested ORCID
 *     (append-only ops-union rule: an edit that removed the entry does not
 *     un-anchor it). Anchor normalization matches the chain-walk slot
 *     builders: LOWER + TRIM for hive, `CHAIN_ORCID_BTRIM_CHARSET` btrim for
 *     orcid (sql-trim-vs-js-trim convention). Bounded to the newest
 *     `NAMING_POSTS_SEED_CAP` posts as a spam defense (see the constant's
 *     docblock); over-cap is truncated-but-served, never fail-closed.
 *   - `seed_walk` / `pending_seed` — each naming post walked UP its
 *     `pevo.continues` pointers to the chain root (50-hop cap mirrors the
 *     down-walk; a pointer cycle terminates at the cap and yields no root).
 *     The seed is a candidate SUPERSET: the authoritative down-walk
 *     (`consentChainCteBody`) re-derives admission, canonical-path selection,
 *     and slots, so naming posts on orphaned forks produce no eligibility.
 *   - `consent_signer_eligibility` minus the user's `route2_latest` rows —
 *     anchored-and-eligible papers where the user has NO valid consent
 *     action. An accept, a resign, or a revoke naming them all clear the
 *     slot from the pending list; an invalid pre-claim accept (Rule 6
 *     name-squat window) does not, because `route2_stream` never admits it.
 *     The user's own root papers are excluded (Route-1 implicit consent). */
export function composePendingConsentsQuery(username: string): { sql: string; params: unknown[] } {
  const accredCte = activeAccreditationsCteBody(1);
  let paramIdx = accredCte.nextIdx;
  const tagIdx = paramIdx++;
  const userIdx = paramIdx++;
  const chainCte = consentChainCteBody(paramIdx, { rootsFromCte: 'pending_seed' });
  const consentedCte = consentedAuthorsCteBody(chainCte.nextIdx, { signers: [username] });
  const sql = `WITH RECURSIVE
  ${accredCte.sql},
  my_attested_orcid AS (
    SELECT aa.orcid
    FROM active_accreditations aa
    WHERE aa.account = $${userIdx} AND aa.orcid IS NOT NULL AND aa.orcid != ''
  ),
  naming_posts AS (
    SELECT c.author, c.permlink, c.json_metadata -> $${tagIdx} -> 'continues' AS continues
    FROM ${T.comments} c
    WHERE c.parent_author = '' AND c.parent_permlink = $${tagIdx}
      AND EXISTS (
        SELECT 1
        FROM ${T.commentOps} o
        CROSS JOIN LATERAL jsonb_array_elements(o.json_metadata -> $${tagIdx} -> 'authors') AS e(value)
        WHERE o.author = c.author AND o.permlink = c.permlink
          AND jsonb_typeof(o.json_metadata -> $${tagIdx} -> 'authors') = 'array'
          AND (LOWER(TRIM(e.value ->> 'hive')) = $${userIdx}
               OR (BTRIM(COALESCE(e.value ->> 'orcid', ''), E'${CHAIN_ORCID_BTRIM_CHARSET}') != ''
                   AND BTRIM(e.value ->> 'orcid', E'${CHAIN_ORCID_BTRIM_CHARSET}') IN (SELECT orcid FROM my_attested_orcid)))
      )
    ORDER BY c.created DESC
    LIMIT ${NAMING_POSTS_SEED_CAP}
  ),
  seed_walk AS (
    SELECT np.author, np.permlink, np.continues, 0 AS hops
    FROM naming_posts np
    UNION ALL
    SELECT c.author, c.permlink, c.json_metadata -> $${tagIdx} -> 'continues', sw.hops + 1
    FROM seed_walk sw
    JOIN ${T.comments} c
      ON c.author = sw.continues ->> 'author'
     AND c.permlink = sw.continues ->> 'permlink'
     AND c.parent_author = '' AND c.parent_permlink = $${tagIdx}
    WHERE jsonb_typeof(sw.continues) = 'object' AND sw.hops < 50
  ),
  pending_seed AS (
    SELECT DISTINCT author AS paper_author, permlink AS paper_permlink
    FROM seed_walk
    WHERE continues IS NULL OR jsonb_typeof(continues) != 'object'
  ),
  ${chainCte.sql},
  ${consentedCte.sql}
  SELECT e.root_author AS paper_author, e.root_permlink AS paper_permlink
  FROM consent_signer_eligibility e
  WHERE e.signer = $${userIdx}
    AND e.root_author != $${userIdx}
    AND NOT EXISTS (
      SELECT 1 FROM route2_latest rl
      WHERE rl.root_author = e.root_author
        AND rl.root_permlink = e.root_permlink
        AND rl.account = $${userIdx}
    )
  ORDER BY e.root_author, e.root_permlink`;
  // Spread order MUST match the capture order of the fragments above.
  return {
    sql,
    params: [...accredCte.params, config.appTag, username, ...chainCte.params, ...consentedCte.params],
  };
}

/** Route-3 pending claims for the claimer. Returns null when no HAF pool is
 *  configured (the caller fails closed; null is never cached) and throws
 *  `HafQueryError` on query failure. */
async function fetchPendingClaimsFromHaf(claimer: string): Promise<PendingClaimRow[] | null> {
  const pool = getPool();
  if (!pool) return null;
  const { sql, params } = composePendingClaimsQuery(claimer);
  try {
    const result = await pool.query<PendingClaimRow>(sql, params);
    return result.rows;
  } catch (err) {
    throw new HafQueryError('fetchPendingClaimsFromHaf', { cause: err });
  }
}

/** Route-2 pending consents for the user. Same null / throw contract as
 *  `fetchPendingClaimsFromHaf`. */
async function fetchPendingConsentsFromHaf(username: string): Promise<PendingConsentRow[] | null> {
  const pool = getPool();
  if (!pool) return null;
  const { sql, params } = composePendingConsentsQuery(username);
  try {
    const result = await pool.query<PendingConsentRow>(sql, params);
    return result.rows;
  } catch (err) {
    throw new HafQueryError('fetchPendingConsentsFromHaf', { cause: err });
  }
}

/**
 * GET /api/me/authorships/pending
 *
 * Claimer-scoped discovery surface for the consent model: the authenticated
 * user's name-only claims awaiting the root author's approval (Route 3) and
 * the anchored slots awaiting the user's own `author_accept` (Route 2).
 * Auth via `verifyHiveSignature` (the user proving they are the claimer);
 * the response is scoped to `req.hiveUsername` — there is no path parameter
 * to cross-check. Fail-closed: a HAF outage surfaces 503, never an empty
 * 200 (indistinguishable from "nothing pending").
 */
router.get('/authorships/pending', verifyHiveSignature, async (req: Request, res: Response) => {
  // Middleware composition (verifyHiveSignature above) guarantees the
  // username; the structured guard keeps the invariant compile-checked
  // rather than relying on a bare non-null assertion.
  if (!req.hiveUsername) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
  }
  const username = req.hiveUsername.toLowerCase();
  try {
    const data = await hafCache.getOrSet(
      `me:authorships-pending:${username}`,
      async () => {
        const [claims, consents] = await Promise.all([
          fetchPendingClaimsFromHaf(username),
          fetchPendingConsentsFromHaf(username),
        ]);
        // null = HAF pool unavailable. Returning null skips the cache write
        // (the fail-closed sentinel is resolved at the route, never cached).
        if (claims === null || consents === null) return null;
        return { pending_claims: claims, pending_consents: consents };
      },
      PENDING_AUTHORSHIPS_TTL_MS,
    );
    if (!data) {
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Pending authorships temporarily unavailable. Please retry shortly.', { retriable: true });
    }
    return sendOk(res, data);
  } catch (err) {
    if (err instanceof HafQueryError && isRetriableHafError(err)) {
      // Cause-discriminated retriable envelope, matching the paper-detail
      // translation: deterministic pg failures fall through to the central
      // 500 handler.
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Pending authorships temporarily unavailable. Please retry shortly.', { retriable: true });
    }
    throw err;
  }
});

export default router;

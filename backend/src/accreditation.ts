import { getPool } from './db.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { hafCache } from './cache.js';
import { T, buildWith, activeAccreditationsCteBody, accreditationStatusCteBody } from './hafsql.js';

export type AccreditationStatus = 'active' | 'revoked';

/**
 * Batch-check accreditation status for multiple accounts.
 * Returns a Set of accredited usernames.
 *
 * Strategy: HAF SQL batch query. Logs and returns an empty set if HAF is
 * unavailable or the query fails.
 *
 * **Error contract:** safe-fail. HAF outage produces a conservative
 * false-negative (every user appears non-accredited until HAF recovers),
 * which renders correctly in display surfaces — non-accredited users get
 * score 0 and the "not accredited" badge, no crash.
 *
 * This is INTENTIONALLY asymmetric with `getAllAccreditedAccounts()`
 * (which re-throws on HAF error). The split matters:
 *
 * - `getAccreditedSet` feeds per-request display enrichment
 *   (stats.ts, papers.ts, profile.ts, comments.ts, reviews.ts). A 500
 *   on every read during a HAF outage is worse UX than gating scores to
 *   zero, so safe-fail.
 *
 * - `getAllAccreditedAccounts` feeds the batch job's `scoredUsers` set.
 *   Silent empty-set there is catastrophic: the cycle advances over
 *   empty cycles and prev_scores rehydrates from empty state, collapsing
 *   voter weights to 1.0 for subsequent cycles. So loud-fail.
 *
 * Reader-class divergence under HAF outage is the accepted cost:
 * batch-fed surfaces 500, display-fed surfaces 200 with everyone marked
 * non-accredited. The chain remains the SSoT — readers gate on chain
 * accreditation and short-circuit to score 0 for non-accredited users.
 */
export async function getAccreditedSet(usernames: string[]): Promise<Set<string>> {
  if (usernames.length === 0) return new Set();

  // Fast path: if the full accredited set is already cached, filter locally
  const cachedAll = await hafCache.get<string[]>('accredited_accounts_all');
  if (cachedAll !== undefined) {
    const allSet = new Set(cachedAll);
    return new Set(usernames.filter((u) => allSet.has(u)));
  }

  // Try HAF first — efficient single batch query
  const pool = getPool();
  if (pool) {
    try {
      const unique = [...new Set(usernames)];

      // Compose the shared membership CTE (sanction-aware + live-threshold WoT,
      // self-contained per its docstring) and filter its output to the requested
      // accounts. Using the shared builder instead of an inline `ranked` copy is
      // what keeps the membership rule in ONE place — a below-threshold WoT
      // account, a sanctioned account, and a legacy-revoked account all resolve
      // identically here and in `getAllAccreditedAccounts`.
      const cte = buildWith(1, activeAccreditationsCteBody);
      const userStart = cte.nextIdx;
      const userPlaceholders = unique.map((_, i) => `$${userStart + i}`).join(', ');
      const result = await pool.query(
        `${cte.sql}
         SELECT account FROM active_accreditations WHERE account IN (${userPlaceholders})`,
        [...cte.params, ...unique],
      );

      return new Set(result.rows.map((r: { account: string }) => r.account));
    } catch (err) {
      logger.error({ err }, 'HAF batch accreditation check failed');
    }
  }

  return new Set();
}

/**
 * Load the latest authority-signed `accredit` op for `account`, returning its
 * full payload metadata INCLUDING `evidence_hash`, `method`/`orcid`, and
 * `issued_by` — fields the membership `active_accreditations` view does not all
 * carry. Used by the self-service metadata edit to merge new
 * name/institution/field over the current op while PRESERVING
 * method/orcid/evidence_hash/issued_by (the edit carries the prior evidence and
 * origin attribution forward; it does not fabricate a new hash, nor flip a WoT
 * accreditation's `issued_by` to the admin account).
 *
 * Error contract: returns `null` ONLY for a genuine "no accredit op for this
 * account" (the caller maps that to a not-accredited 403). THROWS when HAF is
 * unavailable (no pool) or the query errors, so the caller can distinguish a
 * transient outage (-> 503 retriable, fail closed: no broadcast) from a real
 * no-op. This is the single-account analogue of `getAccreditedOrcidsByAccount`'s
 * throw-on-outage / null-on-empty split, and lets the metadata-edit handler use
 * this one read as its upstream HAF-reachability gate.
 */
export async function getLatestAccreditOp(account: string): Promise<{
  name: string;
  institution: string;
  field: string;
  method: string;
  orcid: string;
  evidence_hash: string;
  issued_by: string;
} | null> {
  const pool = getPool();
  if (!pool) throw new Error('HAF pool unavailable for latest-accredit-op read');

  try {
    const result = await pool.query<{ json: string | Record<string, unknown> }>(
      `SELECT cj.json FROM ${T.customJson} cj
       WHERE cj.custom_id = $1
         AND cj.json::jsonb ->> 'account' = $2
         AND cj.json::jsonb ->> 'action' = 'accredit'
         AND cj.required_posting_auths ?| $3::text[]
       ORDER BY cj.block_num DESC, cj.id DESC
       LIMIT 1`,
      [config.appTag, account, config.accreditationAuthorities],
    );
    if (result.rows.length === 0) return null;
    const raw = result.rows[0].json;
    const p = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
    return {
      name: str(p.name),
      institution: str(p.institution),
      field: str(p.field),
      method: str(p.method, 'manual'),
      orcid: str(p.orcid),
      evidence_hash: str(p.evidence_hash),
      issued_by: str(p.issued_by),
    };
  } catch (err) {
    logger.error({ err, account }, 'HAF latest-accredit-op read failed');
    throw err;
  }
}

/**
 * User-facing 403 string for the ever-sanctioned refusal on the self-service
 * accredit paths (email /verify, ORCID callback, signup-verify). Deliberately
 * generic: it does NOT leak the moderation reason or even the word "sanction".
 * Emdash-free per project convention. Only a deliberate admin accredit
 * (POST /api/admin/accreditation/grant) lifts a sanction.
 */
export const SANCTIONED_ACCREDIT_MESSAGE =
  'This account is not eligible for accreditation at this time. Please contact the platform operators if you believe this is an error.';

/**
 * Whether `account` currently carries an un-lifted sanction (a `type:"sanction"`
 * revoke at or after its most-recent authority-pinned `accredit`, or with no
 * authority accredit at all). A sanction is sticky and lifted ONLY by a later
 * authority `accredit` (email/orcid/manual) — a `wot` auto-accredit does NOT
 * lift it. This is the same suppression predicate `activeAccreditationsCteBody`
 * applies, scoped to one account.
 *
 * Used by the WoT auto-accreditation path (`broadcastWotAccreditation`) to
 * refuse re-admitting a sanctioned account on vouch support. A sanctioned
 * account is already absent from `getAccreditedSet`, so this read is what
 * distinguishes "suppressed by sanction" (refuse the broadcast) from "never
 * enrolled / below threshold" (proceed to enroll).
 *
 * **Fail-closed.** If HAF is unavailable or the query throws, returns `true`
 * (assume sanctioned) so an indeterminate sanction state can never let an
 * auto-accreditation slip through.
 */
export async function hasUnliftedSanction(account: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return true;

  try {
    const result = await pool.query<{ sanction_block: string | null; auth_block: string | null }>(
      `WITH acct_ops AS (
        SELECT
          cj.json::jsonb ->> 'action' AS action,
          cj.json::jsonb ->> 'method' AS method,
          cj.json::jsonb ->> 'type' AS revoke_type,
          cj.block_num AS block_num
        FROM ${T.customJson} cj
        WHERE cj.custom_id = $1
          AND cj.json::jsonb ->> 'account' = $2
          AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
          AND cj.required_posting_auths ?| $3::text[]
      )
      SELECT
        (SELECT MAX(block_num) FROM acct_ops WHERE action = 'revoke' AND revoke_type = 'sanction') AS sanction_block,
        -- Authority-pinned = any non-wot accredit (only a wot op is vouch-derived);
        -- matches activeAccreditationsCteBody's auth_accredit definition.
        (SELECT MAX(block_num) FROM acct_ops WHERE action = 'accredit' AND method IS DISTINCT FROM 'wot') AS auth_block`,
      [config.appTag, account, config.accreditationAuthorities],
    );
    const row = result.rows[0];
    if (!row || row.sanction_block === null) return false;
    const sanctionBlock = Number(row.sanction_block);
    const authBlock = row.auth_block === null ? null : Number(row.auth_block);
    return authBlock === null || sanctionBlock >= authBlock;
  } catch (err) {
    logger.error({ err, account }, 'HAF un-lifted sanction check failed — failing closed');
    return true;
  }
}

/**
 * Map of every accredited account to their on-chain ORCID (or `null` when
 * the accreditation attestation does not carry an ORCID). Cached for 10
 * minutes alongside `getAllAccreditedAccounts` so callers that need both
 * the membership check and the ORCID payload do not re-run the CTE.
 *
 * Used by `fetchPaperDetailFromHaf`'s cumulative-union construction to
 * server-override a chain post's claimed `orcid` for a hive when the
 * accredited record names a different ORCID — closes the direct-Keychain
 * spoof where a vouched co-author broadcasts a false ORCID for an
 * accredited peer (`agents/docs/ARCHITECTURE.md § 2 "Multi-Author Trust Model"`).
 *
 * **Error contract.** Throws on HAF unavailable; the route layer translates
 * to 503 SERVICE_UNAVAILABLE with `details.retriable: true` (see
 * `fetchPaperDetailFromHaf` and sibling enrichment/retract/cite handlers in
 * `routes/papers.ts`). Distinguishes "HAF returned 0 accredited" (legitimate
 * empty population, cached) from "HAF query failed" (re-thrown) so the
 * retriable-outage signal survives intact instead of caching an empty map.
 *
 * `pool === null` (dev environment without HAF connected) returns an empty
 * map — that is a startup condition, not a transient outage.
 */
export async function getAccreditedOrcidsByAccount(): Promise<Map<string, string | null>> {
  // Early-return on pool === null BEFORE entering hafCache.getOrSet. If we
  // populated the cache with an empty array here, the degraded result would
  // persist for the full 10-min TTL — and if HAF recovers mid-window, the
  // ORCID server-overrides per rule "accredited ORCID is authoritative"
  // would be silently suppressed until cache expiry (exactly the moment
  // when spoof detection should re-engage). Skipping the cache write keeps
  // the recovery edge clean: the next request after HAF connects re-tries
  // the underlying query and populates the cache correctly. See
  // agents/docs/ARCHITECTURE.md § 2 "Multi-Author Trust Model".
  if (getPool() === null) return new Map();
  const arr = await hafCache.getOrSet<Array<{ account: string; orcid: string | null }>>(
    'accredited_account_orcids',
    async () => {
      const pool = getPool();
      if (!pool) return [];

      try {
        const cte = buildWith(1, activeAccreditationsCteBody);
        const result = await pool.query(
          `${cte.sql}
           SELECT account, orcid FROM active_accreditations`,
          cte.params,
        );
        return result.rows.map((r: { account: string; orcid: string | null }) => ({
          account: r.account,
          orcid: typeof r.orcid === 'string' && r.orcid.length > 0 ? r.orcid : null,
        }));
      } catch (err) {
        logger.error({ err }, 'HAF accredited-orcid lookup failed');
        throw err;
      }
    },
    10 * 60_000,
    true,
  );
  const map = new Map<string, string | null>();
  for (const { account, orcid } of arr) map.set(account, orcid);
  return map;
}

/**
 * Map of every currently-accredited account to its accreditation-attested
 * display name (`active_accreditations.researcher_name`). The JS-side source
 * for name-supersession: an accredited author's attested name is the
 * authoritative display name and supersedes the broadcaster-claimed
 * `pevo.authors[i].name`, exactly as `getAccreditedOrcidsByAccount` is the
 * source for ORCID supersession.
 *
 * Only accounts with a NON-EMPTY attested name are included — an
 * exactly-empty `researcher_name` carries no authority and would shadow the
 * broadcaster claim with nothing. "Non-empty" here means exactly-empty-string
 * absent (`NULLIF(researcher_name, '')`), with NO whitespace trimming — the
 * same charset-free emptiness test the SQL-side name-supersession arm in
 * `authorsWithSupersessionSelect` applies (`NULLIF(aa.researcher_name, '')`),
 * and the stored value is the raw attested name unchanged. A whitespace-only
 * attested name is therefore present on BOTH surfaces alike (no trim mutation,
 * no surface-specific drop); `resolveAuthorName`'s length check honors it as
 * the resolved name. Aligning on exact-empty (rather than trimming one side)
 * is what keeps the two surfaces in lockstep per the SQL/JS parity doctrine.
 * Callers treat a missing key as "no attested name, keep the broadcaster
 * value" (the name-resolution fallback in `resolveAuthorName`). This is the
 * active-only analogue of
 * `getAccreditedOrcidsByAccount`: name-supersession applies only to
 * currently-accredited accounts, so revoked accounts are intentionally
 * absent (the LEFT JOIN to `active_accreditations` on the SQL side has the
 * same active-only semantics — the two surfaces stay in lockstep per the
 * SQL/JS parity doctrine).
 *
 * **Error contract.** Mirrors `getAccreditedOrcidsByAccount`: throws on HAF
 * query failure (re-thrown so the route layer translates to 503-retriable
 * rather than caching an empty map mid-outage and silently dropping
 * name-supersession until cache expiry). `pool === null` (dev without HAF)
 * returns an empty map without caching — a startup condition, not a
 * transient outage.
 */
export async function getAccreditedNamesByAccount(): Promise<Map<string, string>> {
  if (getPool() === null) return new Map();
  const arr = await hafCache.getOrSet<Array<{ account: string; researcher_name: string }>>(
    'accredited_account_names',
    async () => {
      const pool = getPool();
      if (!pool) return [];

      try {
        const cte = buildWith(1, activeAccreditationsCteBody);
        const result = await pool.query(
          `${cte.sql}
           SELECT account, researcher_name FROM active_accreditations
           WHERE NULLIF(researcher_name, '') IS NOT NULL`,
          cte.params,
        );
        return result.rows.map((r: { account: string; researcher_name: string }) => ({
          account: r.account,
          researcher_name: r.researcher_name,
        }));
      } catch (err) {
        logger.error({ err }, 'HAF accredited-name lookup failed');
        throw err;
      }
    },
    10 * 60_000,
    true,
  );
  const map = new Map<string, string>();
  for (const { account, researcher_name } of arr) map.set(account, researcher_name);
  return map;
}

/**
 * Get the full set of all accredited accounts, cached for 10 minutes.
 * Used by reputation queries to filter votes without re-running the
 * expensive ACTIVE_ACCREDITATIONS_CTE on every call.
 *
 * **Error contract:** loud-fail. Distinguishes "HAF returned 0 accredited"
 * (legitimate empty population — cached) from "HAF query failed"
 * (re-thrown so callers can fail loudly instead of caching an empty set
 * on outage). The batch
 * job's outer catch must observe an HAF outage and bail without advancing
 * cycle:last; otherwise the batch advances over empty cycles,
 * prev_scores rehydrates from empty state, and voter weights collapse to
 * 1.0 for subsequent cycles. Throwing also surfaces visibly in request
 * handlers (loud 500s) instead of silently rendering empty data.
 *
 * This is INTENTIONALLY asymmetric with `getAccreditedSet()`
 * (display-fed, safe-fail). See its docstring for the rationale of the
 * split. Future implementers adding a new reader should pick the helper
 * matching their failure-mode tolerance — do not assume symmetric error
 * contracts.
 *
 * `pool === null` (dev environment without HAF connected) still returns the
 * empty set — that is a startup condition, not a transient outage.
 */
export async function getAllAccreditedAccounts(): Promise<Set<string>> {
  const arr = await hafCache.getOrSet<string[]>('accredited_accounts_all', async () => {
    const pool = getPool();
    if (!pool) return [];

    try {
      const cte = buildWith(1, activeAccreditationsCteBody);
      const result = await pool.query(
        `${cte.sql}
         SELECT account FROM active_accreditations`,
        cte.params,
      );
      return result.rows.map((r: { account: string }) => r.account);
    } catch (err) {
      logger.error({ err }, 'HAF full accreditation set query failed');
      throw err;
    }
  }, 10 * 60_000, true);
  return new Set(arr);
}

/**
 * Map of every account that has ever been accredited to its current
 * accreditation status (`active` or `revoked`) plus the ORCID from the
 * most-recent `accredit` event for that account.
 *
 * **Why this exists.** `getAccreditedOrcidsByAccount` is active-only — it
 * drops revoked accounts. The `orcid_claim_mismatch` audit primitive
 * (per `agents/docs/ARCHITECTURE.md` § 2 "Multi-Author Trust Model") is
 * gated by the active-only lookup, so once a bad actor is revoked the
 * audit goes silent on subsequent forged-ORCID broadcasts targeting them.
 * Operators want visibility *during* the post-revocation triage window —
 * exactly when the active-only lookup goes silent. This helper supplies
 * the revoked-arm anchor so the audit can fire across both arms.
 *
 * This helper preserves audit visibility by carrying revoked accounts
 * (with their last-attested ORCID) alongside active ones. Callers in
 * `papers.ts` consume the merged map and split server-override behavior:
 * `status === 'active'` overrides the broadcaster's claim (existing rule
 * #3 behavior), `status === 'revoked'` does NOT override (the broadcaster's
 * claim passes through) but still emits the audit event with the
 * `accreditationStatus: 'revoked'` distinguisher so operators can prioritize
 * active-spoof over post-revocation residual.
 *
 * **Multi-cycle correctness.** Same SQL CTE (`accreditation_status`)
 * handles accredit → revoke → re-accredit → revoke chains correctly: the
 * lookup returns the ORCID from the most-recent `accredit` (the one the
 * second revoke retired), not the first. See the CTE's docstring in
 * `hafsql.ts`.
 *
 * **Error contract.** Throws on HAF unavailable; the route layer translates
 * to 503 SERVICE_UNAVAILABLE with `details.retriable: true` (see
 * `fetchPaperDetailFromHaf` and sibling enrichment/retract/cite handlers in
 * `routes/papers.ts`). Distinguishes "HAF returned 0" (legitimate empty
 * population, cached) from "HAF query failed" (re-thrown). Audit emission
 * silently degrading to "no rows" on HAF outage would mask the visibility
 * this loud-fail path preserves.
 *
 * `pool === null` (dev environment without HAF connected) returns an empty
 * map — that is a startup condition, not a transient outage.
 *
 * **Name discipline.** The "AllEverAccredited" prefix signals that this
 * map carries both `active` and `revoked` rows (unlike
 * `getAccreditedOrcidsByAccount`, which is active-only). Side-by-side
 * imports in `papers.ts` previously made it easy to grab the wrong helper
 * during autocomplete — the explicit `AllEver` keeps the semantic
 * distinction visible at the call site.
 */
export async function getAllEverAccreditedOrcidsWithStatus(): Promise<
  Map<string, { orcid: string | null; status: AccreditationStatus }>
> {
  const arr = await hafCache.getOrSet<
    Array<{ account: string; orcid: string | null; status: AccreditationStatus }>
  >(
    'accreditation_orcid_status',
    async () => {
      const pool = getPool();
      if (!pool) return [];

      try {
        // `accreditation_status` depends on `accred_ranked` (materialized
        // by `activeAccreditationsCteBody`), so the WITH block must
        // include both. Params come from the active-accreditations CTE
        // alone (the status CTE adds no params); `buildWith` threads the
        // running param index from the first builder into the second.
        const cte = buildWith(1, activeAccreditationsCteBody, accreditationStatusCteBody);
        const result = await pool.query(
          `${cte.sql}
           SELECT account, orcid, status FROM accreditation_status`,
          cte.params,
        );
        return result.rows.map(
          (r: { account: string; orcid: string | null; status: AccreditationStatus }) => ({
            account: r.account,
            orcid: typeof r.orcid === 'string' && r.orcid.length > 0 ? r.orcid : null,
            status: r.status,
          }),
        );
      } catch (err) {
        logger.error({ err }, 'HAF accreditation-status lookup failed');
        throw err;
      }
    },
    10 * 60_000,
    true,
  );
  const map = new Map<string, { orcid: string | null; status: AccreditationStatus }>();
  for (const { account, orcid, status } of arr) {
    map.set(account, { orcid, status });
  }
  return map;
}


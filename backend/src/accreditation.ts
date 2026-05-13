import { getPool } from './db.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { hafCache } from './cache.js';
import { T, activeAccreditationsCteBody, getCachedGenesisBlock } from './hafsql.js';

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
 *   voter weights to 1.0 for subsequent cycles
 *   (BACKEND-REPUTATION-SSOT round-1 hold #9). So loud-fail.
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

      // $1 = appTag, $2 = whitelist, $3 = genesis, $4+ = usernames
      const userPlaceholders = unique.map((_, i) => `$${i + 4}`).join(', ');
      const result = await pool.query(
        `WITH ranked AS (
          SELECT
            cj.json::jsonb ->> 'action' AS action,
            cj.json::jsonb ->> 'account' AS account,
            ROW_NUMBER() OVER (PARTITION BY cj.json::jsonb ->> 'account' ORDER BY cj.block_num DESC) AS rn
          FROM ${T.customJson} cj
          WHERE cj.custom_id = $1
            AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
            AND cj.required_posting_auths ?| $2::text[]
            AND cj.block_num >= $3
            AND cj.json::jsonb ->> 'account' IN (${userPlaceholders})
        )
        SELECT account FROM ranked WHERE rn = 1 AND action = 'accredit'`,
        [config.appTag, config.accreditationAuthorities, getCachedGenesisBlock(), ...unique],
      );

      return new Set(result.rows.map((r: { account: string }) => r.account));
    } catch (err) {
      logger.error({ err }, 'HAF batch accreditation check failed');
    }
  }

  return new Set();
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
 * accredited peer (`backend-multi-author-cumulative-union.md` rule #3).
 *
 * Distinguishes "HAF returned 0 accredited" (legitimate empty population —
 * cached) from "HAF query failed" (re-thrown so callers can fail loudly
 * instead of caching an empty map on outage).
 *
 * `pool === null` (dev environment without HAF connected) returns an empty
 * map — that is a startup condition, not a transient outage.
 */
export async function getAccreditedOrcidsByAccount(): Promise<Map<string, string | null>> {
  const arr = await hafCache.getOrSet<Array<{ account: string; orcid: string | null }>>(
    'accredited_account_orcids',
    async () => {
      const pool = getPool();
      if (!pool) return [];

      try {
        const cte = activeAccreditationsCteBody();
        const result = await pool.query(
          `WITH ${cte.sql}
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
 * Get the full set of all accredited accounts, cached for 10 minutes.
 * Used by reputation queries to filter votes without re-running the
 * expensive ACTIVE_ACCREDITATIONS_CTE on every call.
 *
 * **Error contract:** loud-fail. Distinguishes "HAF returned 0 accredited"
 * (legitimate empty population — cached) from "HAF query failed"
 * (re-thrown so callers can fail loudly instead of caching an empty set
 * on outage). Per BACKEND-REPUTATION-SSOT round-1 hold #9: the batch
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
      const cte = activeAccreditationsCteBody();
      const result = await pool.query(
        `WITH ${cte.sql}
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


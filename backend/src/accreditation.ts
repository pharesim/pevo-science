import { getPool } from './db.js';
import { hiveClient } from './hive.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { hafCache } from './cache.js';
import { T, activeAccreditationsCteBody, getCachedGenesisBlock } from './hafsql.js';

/**
 * Batch-check accreditation status for multiple accounts.
 * Returns a Set of accredited usernames.
 *
 * Strategy: HAF SQL first (single batch query), Hive API fallback
 * (queries pevo.admin account history for custom_json ops).
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
      logger.error({ err }, 'HAF batch accreditation check failed, trying Hive API');
    }
  }

  // Hive API fallback: query pevo.admin account history for accreditation custom_json ops
  return getAccreditedSetFromHiveApi(usernames);
}

/**
 * Get the full set of all accredited accounts, cached for 10 minutes.
 * Used by reputation queries to filter votes without re-running the
 * expensive ACTIVE_ACCREDITATIONS_CTE on every call.
 */
export async function getAllAccreditedAccounts(): Promise<Set<string>> {
  const arr = await hafCache.getOrSet<string[]>('accredited_accounts_all', async () => {
    const pool = getPool();
    if (!pool) {
      // Hive API fallback: scan admin history for all accreditations
      const set = await getAccreditedSetFromHiveApi([]);
      return [...set];
    }

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
      return [];
    }
  }, 10 * 60_000, true);
  return new Set(arr);
}

/**
 * Fallback: scan all whitelist accounts' histories for accreditation custom_json ops.
 * Less efficient than HAF but works without a database connection.
 * Merges results — latest action per account by block number wins (first seen = most recent
 * when scanning backwards).
 */
async function getAccreditedSetFromHiveApi(usernames: string[]): Promise<Set<string>> {
  const unique = new Set(usernames);
  const fetchAll = unique.size === 0; // when empty, scan for all accreditations

  // latestAction: account -> 'accredit' | 'revoke' (first seen across all authority scans wins)
  const latestAction = new Map<string, string>();

  for (const authority of config.accreditationAuthorities) {
    try {
      let start = -1;
      const batchSize = 1000;
      let scanned = 0;
      const maxScan = 5000;

      while (scanned < maxScan) {
        const history: Array<[number, { op: unknown[] }]> = await hiveClient.database.call(
          'get_account_history',
          [authority, start, Math.min(batchSize, start === -1 ? batchSize : start + 1)],
        );

        if (history.length === 0) break;

        for (const [, entry] of history) {
          const op = entry.op;
          if (op[0] !== 'custom_json') continue;

          const opData = op[1] as { id?: string; json?: string };
          if (opData.id !== config.appTag) continue;

          try {
            const payload = JSON.parse(opData.json || '{}');
            if (payload.action !== 'accredit' && payload.action !== 'revoke') continue;
            if (!fetchAll && !unique.has(payload.account)) continue;

            if (!latestAction.has(payload.account)) {
              latestAction.set(payload.account, payload.action);
            }
          } catch (err) { logger.debug({ err }, 'Skipping malformed custom_json in accreditation scan'); }
        }

        if (!fetchAll && latestAction.size >= unique.size) break;

        scanned += history.length;
        const oldestIdx = history[0][0];
        if (oldestIdx <= 0) break;
        start = oldestIdx - 1;
      }
    } catch (err) {
      logger.error({ err, authority }, 'Hive API accreditation check failed for authority');
    }
  }

  const accredited = new Set<string>();
  for (const [account, action] of latestAction) {
    if (action === 'accredit') accredited.add(account);
  }
  return accredited;
}

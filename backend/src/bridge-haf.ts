/**
 * Shared HAF on-chain duplicate lookup for bridge papers.
 *
 * Single source of truth for the two-query duplicate check used by both the
 * route's pre-enqueue check (`checkExistingBridge` in `routes/bridge.ts`) and
 * the worker's pre-broadcast reconciliation (`checkExistingOnChain` in
 * `bridge-worker.ts`). The two copies previously re-derived the same pair of
 * HAF `SELECT`s and had already drifted in column projection; keeping the
 * query shape here means a change to `validPevoPaperWhere` predicates, a
 * parameter position, or a column projection lands in one place.
 *
 * Returns the matched bridge post — a superset both callers project from (the
 * route uses `title`/`created`, the worker uses only `author`/`permlink`) — or
 * `null` when nothing matches OR HAF is not configured (the dev-without-HAF
 * fallback, fail-open exactly as the inlined copies were).
 *
 * On a HAF query error this THROWS rather than swallowing: each caller wraps
 * the call in its own try/catch to apply its fail-closed policy (the route
 * returns 503/retriable on `/register` and fail-open on `/check`; the worker
 * reschedules). Keeping the catch at the call site preserves each caller's
 * exact log vocabulary and fail-closed mapping — this helper deliberately
 * unifies only the query shape, which is what drifted. See
 * `agents/docs/solutions/conventions/read-then-write-races-on-haf-backed-routes-2026-05-15.md`.
 */

import { getPool, isHafConfigured } from './db.js';
import { config } from './config.js';
import { T, validPevoPaperWhere } from './hafsql.js';

export interface BridgeDuplicateRow {
  author: string;
  permlink: string;
  title: string | null;
  created: Date | null;
}

/**
 * Run the source-field (DOI/arXiv) lookup and the deterministic-permlink
 * fallback, both pinned to the bridge account so a spoofer cannot preempt a
 * canonical import by posting the same source under their own account.
 *
 * @throws when the HAF query fails — callers translate this into their own
 *   fail-closed signal.
 */
export async function findBridgeDuplicate(
  parsed: { type: 'arxiv' | 'doi'; id: string },
  permlink: string,
): Promise<BridgeDuplicateRow | null> {
  const pool = getPool();
  if (!pool || !isHafConfigured()) return null;
  const sourceField = parsed.type === 'doi' ? 'doi' : 'arxiv_id';

  const bridgePaperWhere = validPevoPaperWhere({
    commentAlias: 'c',
    appTagParam: '$2',
    bridgeAccountParam: '$5',
    source: 'bridge',
  });
  const result = await pool.query<BridgeDuplicateRow>(
    `SELECT c.author, c.permlink, c.title, c.created
       FROM ${T.comments} c
      WHERE c.parent_author = '' AND c.parent_permlink = $2
        AND ${bridgePaperWhere}
        AND c.json_metadata ->> 'app' LIKE $3
        AND (c.json_metadata -> $2 -> 'source' ->> $4) = $1
      LIMIT 1`,
    [parsed.id, config.appTag, `${config.appTag}/%`, sourceField, config.hiveBridgeAccount],
  );
  if (result.rows.length > 0) return result.rows[0];

  const permlinkBridgeWhere = validPevoPaperWhere({
    commentAlias: 'c',
    appTagParam: '$2',
    bridgeAccountParam: '$4',
    source: 'bridge',
  });
  const permlinkResult = await pool.query<BridgeDuplicateRow>(
    `SELECT c.author, c.permlink, c.title, c.created
       FROM ${T.comments} c
      WHERE c.parent_author = '' AND c.parent_permlink = $2
        AND c.permlink = $1
        AND ${permlinkBridgeWhere}
        AND c.json_metadata ->> 'app' LIKE $3
      LIMIT 1`,
    [permlink, config.appTag, `${config.appTag}/%`, config.hiveBridgeAccount],
  );
  if (permlinkResult.rows.length > 0) return permlinkResult.rows[0];

  return null;
}

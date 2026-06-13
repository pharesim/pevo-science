/**
 * Web of Trust (WoT) service.
 *
 * Handles vouch status queries, WoT threshold checking, auto-accreditation
 * broadcasting, and cascading revocation when vouchers lose their own
 * accreditation.
 */
import pg from 'pg';
import { getPool } from './db.js';
import { broadcastAdminCustomJson, BroadcastTimeoutError } from './hive.js';
import { config } from './config.js';
import { getAccreditedSet } from './accreditation.js';
import { seedAccreditationBonus, invalidateOnRevocation } from './reputation.js';
import { logger } from './logger.js';
import { hafCache } from './cache.js';
import { T, activeAccreditationsCteBody, activeVouchesCteBody, buildWith } from './hafsql.js';
import type { AccreditationMethod } from './types/domain.js';

const DEFAULT_WOT_THRESHOLD = 3;
const MAX_REVOCATION_DEPTH = 20;

const WOT_THRESHOLD_TTL = 30 * 60_000;

/**
 * Aggregate wall-clock budget for a single top-level `cascadeRevocation` call
 * (and its recursive descendants). With a per-broadcast 30s timeout and K
 * cascades, a pathological degraded Hive node could block K*30s otherwise.
 * Exceeding this budget surfaces a `PartialCascadeError` so the caller can
 * log / alert / queue the pending list for manual follow-up.
 */
export const CASCADE_BUDGET_MS = 60_000;

/**
 * Result of `broadcastWotAccreditation` (the Web-of-Trust auto-accreditation
 * broadcast). A tagged union so the caller branches explicitly on outcome
 * instead of conflating "skipped because not eligible" with "broadcast timed
 * out and we have no idea whether it landed". See
 * BE-WOT-BROADCAST-TIMEOUT-HANDLING.
 */
export type WotAccreditationResult =
  | { ok: true; txId: string }
  | { ok: false; reason: 'timeout' | 'chain_error' | 'skipped'; err?: Error };

/**
 * Thrown by `cascadeRevocation` when the aggregate wall-clock budget is
 * exceeded. Carries the lists of completed and pending vouchees so the caller
 * (route handler / operator) can log or queue for manual re-revocation.
 *
 * `rootRevocation` is the top-level revoked account that triggered the
 * cascade. `completed` holds vouchees whose revocation broadcast succeeded
 * this run. `pending` holds vouchees whose revocation was identified as
 * needed but was not attempted (or failed mid-flight) before the budget was
 * exhausted.
 */
export class PartialCascadeError extends Error {
  public readonly completed: string[];
  public readonly pending: string[];
  public readonly rootRevocation: string;
  constructor(params: { completed: string[]; pending: string[]; rootRevocation: string }) {
    super(
      `Cascade revocation budget exceeded for root ${params.rootRevocation}: ` +
        `${params.completed.length} completed, ${params.pending.length} pending`,
    );
    this.name = 'PartialCascadeError';
    this.completed = params.completed;
    this.pending = params.pending;
    this.rootRevocation = params.rootRevocation;
  }
}

async function loadWotThreshold(): Promise<number> {
  const pool = getPool();
  if (!pool) return DEFAULT_WOT_THRESHOLD;

  let client: pg.PoolClient | undefined;
  try {
    // Use a short timeout — this scans the massive operation_custom_json_view
    // table with text→jsonb casts. Fail fast and use default threshold.
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 5000');

    const result = await client.query(
      `SELECT json FROM ${T.customJson}
       WHERE custom_id = $1
         AND json::jsonb ->> 'action' = 'update_params'
         AND required_posting_auths ?| $2::text[]
       ORDER BY block_num DESC
       LIMIT 1`,
      [config.appTag, config.accreditationAuthorities],
    );
    await client.query('COMMIT');
    client.release();

    if (result.rows.length === 0) return DEFAULT_WOT_THRESHOLD;

    const payload = typeof result.rows[0].json === 'string'
      ? JSON.parse(result.rows[0].json)
      : result.rows[0].json;

    // `??` only short-circuits null/undefined: a `min_accreditations_for_wot`
    // of 0 (or a non-integer string from a malformed broadcast) would otherwise
    // pass through and, at threshold 0, auto-accredit every account on its
    // first vouch. Require a positive integer; fall back to the default
    // otherwise.
    const n = payload.params?.min_accreditations_for_wot;
    return Number.isInteger(n) && n >= 1 ? n : DEFAULT_WOT_THRESHOLD;
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    logger.warn({ err }, 'WoT threshold query failed, using default');
    return DEFAULT_WOT_THRESHOLD;
  }
}

/**
 * Get the current WoT threshold from on-chain platform params.
 * Falls back to the default (3) if not configured.
 */
export async function getWotThreshold(): Promise<number> {
  return hafCache.getOrSet<number>('wot_threshold', loadWotThreshold, WOT_THRESHOLD_TTL, true);
}

/** Warm the WoT threshold cache at startup via periodic refresh. */
export async function startWotThresholdCache(): Promise<void> {
  await hafCache.registerPeriodicRefresh('wot_threshold', loadWotThreshold, WOT_THRESHOLD_TTL);
  logger.info('WoT threshold cache loaded');
}

export interface VouchInfo {
  voucher: string;
  relationship: string;
  timestamp: string;
}

/**
 * Re-exported from the canonical declaration in `types/domain.ts` so this module
 * and its tests keep a stable `./wot.js` import path while a single declaration
 * owns the method enumeration. The closed set of accreditation methods an
 * `accredit` custom_json can carry: WoT auto-grant, email-verified,
 * ORCID-verified, manual operator grant. It is a literal union (not a bare
 * `string`) so `shouldRevokeOnRetract`'s `=== 'wot'` discriminant is
 * compiler-visible: a caller comparing against a method outside the set becomes a
 * type error rather than a silent always-false.
 */
export type { AccreditationMethod };

export interface VouchStatus {
  username: string;
  vouch_count: number;
  threshold: number;
  vouches: VouchInfo[];
  eligible: boolean;
  /**
   * The account's OWN active-accreditation method (the most-recent `accredit`
   * event's `method`), or `null` if the account is not currently accredited.
   * Carried so the retract path can decide whether to revoke from the SAME
   * snapshot that verified the retraction. See `shouldRevokeOnRetract` for the
   * revoke-gating rationale.
   */
  accreditation_method: AccreditationMethod | null;
}

/**
 * Whether the retract path should revoke this account's accreditation: it is
 * accredited via the Web of Trust (`method = 'wot'`) AND has fallen below the
 * vouch threshold. Derived purely from a single `VouchStatus` snapshot so the
 * verification and the threshold/method check read one consistent view of HAF.
 * An account accredited by email/ORCID/manual (or not at all) is never revoked
 * here, even below threshold — only WoT auto-accreditations track the vouch
 * count.
 */
export function shouldRevokeOnRetract(status: VouchStatus): boolean {
  return status.accreditation_method === 'wot' && !status.eligible;
}

/**
 * Cache key for a vouchee's `getVouchStatus` entry. Spelled in one place so the
 * read site (`getVouchStatus`'s getOrSet) and the bust sites (the vouch-poll
 * loop and the retract handler) cannot drift apart — a divergent literal would
 * silently no-op the invalidation and re-introduce the stale-status bug.
 */
export function vouchStatusCacheKey(vouchee: string): string {
  return `vouch_status:${vouchee}`;
}

/**
 * SQL for the combined vouch-status read: one row carrying BOTH the account's
 * own active-accreditation `method` (a scalar subquery) AND its accredited-only
 * voucher list (`json_agg`). Exported so the real-planner regression runs this
 * exact SELECT against a synthetic graph rather than a hand-rewritten copy.
 *
 * Shape invariants this SELECT must preserve (the retract path depends on them):
 *  - The `json_agg(...) FILTER (WHERE av.voucher IS NOT NULL)` over the
 *    `LEFT`-less inner JOIN yields one row even for an account with ZERO
 *    accredited vouchers, with `vouches = []` (the COALESCE collapses the
 *    aggregate-over-empty-set NULL to an empty array). There is no `GROUP BY`:
 *    the scalar subquery plus a single bare aggregate produce exactly one group.
 *    So `self_method` survives the all-vouches-retracted case the retract path
 *    must revoke on.
 *  - The scalar subquery and the aggregate read the same `active_accreditations`
 *    snapshot, so a caller reusing this status to decide a revoke
 *    (`shouldRevokeOnRetract`) never straddles a separate read's ingestion lag.
 *  - The inner `JOIN active_accreditations aa ON aa.account = av.voucher` keeps
 *    only accredited vouchers, so `vouches.length` equals the accredited-voucher
 *    recount the cascade discovery query expresses as
 *    `COUNT(DISTINCT av_all.voucher) FILTER (WHERE aa_voucher IS NOT NULL)`;
 *    `active_vouches` carries one row per (voucher, vouchee) edge, so no DISTINCT
 *    is needed here.
 *
 * Expects `active_accreditations` and `active_vouches` CTEs in scope (combine
 * with `buildWith(1, activeAccreditationsCteBody, activeVouchesCteBody)` in
 * production; the real-Postgres regression substitutes fixture CTEs of the same
 * shape).
 *
 * @param usernameParam - `$N` placeholder bound to the account being read (used
 *   in both the self-method subquery and the vouches WHERE filter).
 */
export function vouchStatusSelect(usernameParam: string): string {
  return `SELECT
           (SELECT method FROM active_accreditations WHERE account = ${usernameParam}) AS self_method,
           COALESCE(
             json_agg(
               json_build_object(
                 'voucher', av.voucher,
                 'relationship', av.relationship,
                 'timestamp', av.event_timestamp
               ) ORDER BY av.event_timestamp ASC
             ) FILTER (WHERE av.voucher IS NOT NULL),
             '[]'
           ) AS vouches
         FROM active_vouches av
         JOIN active_accreditations aa ON aa.account = av.voucher
         WHERE av.vouchee = ${usernameParam}`;
}

/**
 * Get the vouch status for a user from HAF.
 */
export async function getVouchStatus(username: string): Promise<VouchStatus | null> {
  return hafCache.getOrSet<VouchStatus | null>(vouchStatusCacheKey(username), async () => {
    const pool = getPool();
    if (!pool) return null;

    try {
      const threshold = await getWotThreshold();

      // One read carries BOTH the account's accredited vouchers AND its own
      // active-accreditation method via `vouchStatusSelect` (see that builder's
      // docblock for the single-snapshot / aggregate-over-empty-set invariants
      // the retract path depends on).
      const cte = buildWith(1, activeAccreditationsCteBody, activeVouchesCteBody);
      const usernameParam = `$${cte.nextIdx}`;
      const result = await pool.query<{ self_method: string | null; vouches: VouchInfo[] }>(
        `${cte.sql}
         ${vouchStatusSelect(usernameParam)}`,
        [...cte.params, username],
      );

      const row = result.rows[0];
      const vouches: VouchInfo[] = row?.vouches ?? [];

      return {
        username,
        vouch_count: vouches.length,
        threshold,
        vouches,
        eligible: vouches.length >= threshold,
        // The `method` column is free text in HAF; narrow it to the closed
        // accreditation-method union at this single read site so the rest of the
        // codebase (notably `shouldRevokeOnRetract`'s `=== 'wot'` discriminant)
        // sees the literal type. An off-enum value would compare unequal to every
        // arm and fall through to non-revocable, the same as `null`.
        accreditation_method: (row?.self_method ?? null) as AccreditationMethod | null,
      };
    } catch (err) {
      logger.error({ err }, 'Failed to get vouch status');
      return null;
    }
  }, 60_000);
}

/**
 * Check if a vouchee has reached the WoT threshold and auto-accredit them.
 * Called after a new vouch is observed.
 *
 * Returns a tagged union surfacing the broadcast outcome so the caller can
 * distinguish "not eligible / already accredited / admin key missing"
 * (`reason: 'skipped'`) from an actual broadcast failure
 * (`reason: 'timeout'` or `reason: 'chain_error'`). A timeout outcome means
 * the broadcast MAY have landed on chain — the caller should surface a
 * degraded-state warning rather than retry blindly.
 */
export async function broadcastWotAccreditation(vouchee: string): Promise<WotAccreditationResult> {
  if (!config.pevoAdminPostingKey) {
    logger.warn('PEVO_ADMIN_POSTING_KEY not configured — cannot broadcast WoT accreditation');
    return { ok: false, reason: 'skipped' };
  }

  const status = await getVouchStatus(vouchee);
  if (!status || !status.eligible) return { ok: false, reason: 'skipped' };

  // Check if already accredited
  const accreditedSet = await getAccreditedSet([vouchee]);
  if (accreditedSet.has(vouchee)) return { ok: false, reason: 'skipped' };

  const pool = getPool();
  if (!pool) return { ok: false, reason: 'skipped' };

  try {
    const now = new Date().toISOString();
    const evidenceHash = `wot:${status.vouches.map((v) => v.voucher).sort().join(',')}`;

    const payload = {
      action: 'accredit',
      account: vouchee,
      name: vouchee, // WoT doesn't provide full name — use Hive username
      institution: 'Web of Trust',
      field: '',
      method: 'wot',
      evidence_hash: evidenceHash,
      timestamp: now,
    };

    const result = await broadcastAdminCustomJson(payload);

    logger.info({ vouchee, txId: result.id }, 'WoT auto-accreditation broadcast');
    await seedAccreditationBonus(vouchee);
    return { ok: true, txId: result.id };
  } catch (err) {
    if (err instanceof BroadcastTimeoutError) {
      logger.error(
        { err, vouchee },
        'WoT accreditation broadcast timed out — outcome ambiguous, may or may not have landed',
      );
      return { ok: false, reason: 'timeout', err };
    }
    logger.error({ err, vouchee }, 'Failed to broadcast WoT accreditation');
    return { ok: false, reason: 'chain_error', err: err as Error };
  }
}

/**
 * SQL body for the single discovery query `cascadeRevocation` fires per cascade
 * level. Returns the set of vouchees that (a) were vouched by the revoked
 * account, (b) are currently WoT-accredited, and (c) would fall below the
 * threshold once the revoked account is excluded from their accredited-voucher
 * set. Collapses the previous 1+2K round-trips per level (one find +
 * per-vouchee accreditation check + per-vouchee recount) into a single query
 * whose cost is amortized across all K vouchees.
 *
 * Expects `active_accreditations` and `active_vouches` CTEs in scope (combine
 * with `buildWith(1, activeAccreditationsCteBody, activeVouchesCteBody)` in
 * production; the real-Postgres regression substitutes fixture CTEs of the same
 * shape).
 *
 * The `JOIN active_accreditations aa_target ... aa_target.method = 'wot'` clause
 * folds the per-vouchee accreditation check into the discovery; the
 * COUNT/FILTER aggregate folds the per-vouchee recount. Only accredited voucher
 * rows contribute to the count (the `aa_voucher.account IS NOT NULL` guard) — the
 * same accredited-only counting `getVouchStatus` expresses with its INNER
 * `JOIN active_accreditations aa ON aa.account = av.voucher`.
 *
 * The `av_all`/`aa_voucher` joins are LEFT (not INNER) with a NULL-skipping
 * HAVING. A vouchee whose only accredited, non-revoked voucher is the revoked
 * account, so that removing it drops the remaining accredited-voucher count to
 * zero, still forms a GROUP (the LEFT JOIN keeps the av_target row even when no
 * surviving voucher matches) and is selected, since 0 < threshold. INNER joins
 * would silently drop that cascade-terminal vouchee (zero remaining accredited
 * vouchers -> no joined rows -> no group), the exact account the cascade
 * mechanism exists to catch. The FILTER's `aa_voucher.account IS NOT NULL` guard
 * skips the LEFT-JOIN NULL row so it does not count toward the survivor total;
 * COUNT(DISTINCT ...) collapses duplicate voucher rows.
 *
 * DIVERGENCE from the retract-path recount (do NOT assume they share a HAVING):
 * this FILTER carries an extra `av_all.voucher != <revoked>` conjunct that
 * excludes the revoked root from the survivor count, because a `revoke`
 * cascade is triggered when the root's OWN accreditation is revoked while its
 * vouch edges may still stand in `active_vouches` — the SQL must subtract that
 * now-unaccredited voucher itself. The retract path takes the opposite shape:
 * it has no per-voucher exclusion at all. There the route's `pollForRetraction`
 * first verifies the retracting edge is already GONE from `active_vouches`, so
 * `getVouchStatus` counts the vouchee's CURRENT accredited vouchers honestly and
 * `shouldRevokeOnRetract` compares that count to the threshold in JS. Excluding
 * nobody is what makes a fabricated retraction (a voucher claiming a withdrawal
 * they never broadcast) unable to drop a victim below threshold.
 *
 * @param revokedParam - `$N` placeholder bound to the revoked account (used in
 *   both the WHERE filter and the recount FILTER's exclusion).
 * @param thresholdParam - `$N` placeholder bound to the WoT threshold.
 */
export function cascadeDiscoverySelect(revokedParam: string, thresholdParam: string): string {
  return `SELECT av_target.vouchee
       FROM active_vouches av_target
       JOIN active_accreditations aa_target
         ON aa_target.account = av_target.vouchee AND aa_target.method = 'wot'
       LEFT JOIN active_vouches av_all ON av_all.vouchee = av_target.vouchee
       LEFT JOIN active_accreditations aa_voucher ON aa_voucher.account = av_all.voucher
       WHERE av_target.voucher = ${revokedParam}
       GROUP BY av_target.vouchee
       HAVING COUNT(DISTINCT av_all.voucher) FILTER (
         WHERE aa_voucher.account IS NOT NULL AND av_all.voucher != ${revokedParam}
       ) < ${thresholdParam}`;
}

/**
 * Build the admin `revoke_accreditation` custom_json payload for an account.
 * Shared by `cascadeRevocation` (accreditation-revocation cascade) and
 * `revokeVoucheeIfBelowThreshold` (retract path) so the wire shape stays in one
 * place. `timestamp` is stamped per call, so this MUST be invoked fresh at each
 * broadcast site rather than hoisted to a constant.
 */
function buildRevocationPayload(account: string) {
  return {
    action: 'revoke' as const,
    account,
    reason: 'WoT threshold no longer met',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Check if revoking a voucher's accreditation should cascade to their vouchees.
 * For each vouchee that drops below the WoT threshold and was WoT-accredited,
 * broadcast a revocation.
 *
 * Semantics:
 * - Per-vouchee broadcast timeouts or chain errors are logged at `error` and
 *   the loop continues to the next vouchee (the missed revocation shows up in
 *   the operator's error log and can be re-attempted manually — no silent
 *   drop).
 * - The cascade aborts with `PartialCascadeError` once the aggregate wall-
 *   clock budget (`CASCADE_BUDGET_MS`, 60s) is exceeded, carrying the list of
 *   completed (successfully revoked) and pending (identified-but-not-
 *   attempted / failed) vouchees.
 * - The top-level caller should catch `PartialCascadeError` and surface the
 *   partial state; nested recursive calls propagate the error upward so the
 *   top-level cascade decides what to persist.
 */
export async function cascadeRevocation(
  revokedAccount: string,
  depth = 0,
  deadlineMs?: number,
): Promise<string[]> {
  // Top-level call establishes the deadline; recursive calls inherit it.
  const effectiveDeadline = deadlineMs ?? Date.now() + CASCADE_BUDGET_MS;

  if (depth >= MAX_REVOCATION_DEPTH) {
    logger.warn({ revokedAccount, depth }, 'Cascading revocation depth limit reached');
    return [];
  }
  if (!config.pevoAdminPostingKey) {
    logger.warn('PEVO_ADMIN_POSTING_KEY not configured — cannot cascade revocations');
    return [];
  }

  const pool = getPool();
  if (!pool) return [];

  const completed: string[] = [];
  const pending: string[] = [];

  try {
    const threshold = await getWotThreshold();

    // Single discovery query per cascade level (see `cascadeDiscoverySelect`).
    const findCte = buildWith(1, activeAccreditationsCteBody, activeVouchesCteBody);
    const revokedParam = `$${findCte.nextIdx}`;
    const thresholdParam = `$${findCte.nextIdx + 1}`;
    const result = await pool.query<{ vouchee: string }>(
      `${findCte.sql}
       ${cascadeDiscoverySelect(revokedParam, thresholdParam)}`,
      [...findCte.params, revokedAccount, threshold],
    );

    for (const [i, row] of result.rows.entries()) {
      const vouchee = row.vouchee;

      // Aggregate budget check — abort cascade if we've blown through the
      // wall-clock cap. Everything not yet attempted lands in `pending`.
      if (Date.now() >= effectiveDeadline) {
        // Remaining vouchees in this level's result set (including `vouchee`)
        // are pending.
        const remainingRows = result.rows.slice(i);
        for (const r of remainingRows) pending.push(r.vouchee);
        // Dedupe before surfacing: a vouchee reachable via two voucher edges
        // (diamond graph) can already sit in `pending` from a nested fold, and
        // the operator follow-up list serializes `pending` verbatim. Order-
        // preserving Set dedup keeps each account once.
        throw new PartialCascadeError({
          completed,
          pending: [...new Set(pending)],
          rootRevocation: revokedAccount,
        });
      }

      // Revoke the vouchee's WoT accreditation
      const payload = buildRevocationPayload(vouchee);

      try {
        // Invalidate the batch entry BEFORE broadcasting. If the broadcast
        // times out (chain outcome ambiguous), we'd otherwise leak a stale
        // positive score for a chain-revoked user (per BACKEND-REPUTATION-SSOT
        // round-1 hold #7). Cost of an erroneous DEL on broadcast failure is
        // one cycle of zero score for a still-accredited user, recovered at
        // the next batch cycle via getAllAccreditedAccounts() reseeding.
        // Cost of NOT DEL'ing on a successful timeout is a permanent stale
        // entry until manual cleanup.
        await invalidateOnRevocation(vouchee);

        const txResult = await broadcastAdminCustomJson(payload);

        logger.info({ vouchee, revokedAccount, txId: txResult.id }, 'WoT cascading revocation broadcast');
        completed.push(txResult.id);

        // Recursively cascade — the revoked vouchee may have vouched for others.
        // The current vouchee's revocation already landed (it is in `completed`);
        // a nested failure must not re-count it. Handle both nested-error classes
        // here so the re-throw never reaches this iteration's outer catch, whose
        // `pending.push(vouchee)` would double-count the already-completed vouchee.
        try {
          const nested = await cascadeRevocation(vouchee, depth + 1, effectiveDeadline);
          completed.push(...nested);
        } catch (nestedErr) {
          // A nested cascadeRevocation throws ONLY PartialCascadeError: its own
          // outer catch converts every other failure (a HAF error in the nested
          // discovery query, a missing admin key, etc.) into `return []` rather
          // than a throw, so no non-budget error can surface to this catch. A
          // swallowed nested failure drops that subtree's vouchees from this
          // result; the recursive call logs the failed account, and an operator
          // recovers it by re-running the cascade for that logged parent. The
          // guard below is exhaustive at runtime and also keeps nestedErr typed
          // for the fold.
          if (!(nestedErr instanceof PartialCascadeError)) throw nestedErr;
          // Budget blown in the nested cascade. The current vouchee's broadcast
          // already landed (it is in `completed`); fold the nested progress into
          // our aggregate and re-throw.
          completed.push(...nestedErr.completed);
          pending.push(...nestedErr.pending);
          // Same-level vouchees after the current index were identified but
          // never attempted once the nested cascade blew the budget. Fold
          // them into pending, symmetric with the deadline-check branch's
          // slice(i). Use slice(i + 1) (not slice(i)) because the vouchee at
          // i was already broadcast above and is recorded in `completed`.
          for (const r of result.rows.slice(i + 1)) {
            pending.push(r.vouchee);
          }
          // Dedupe before surfacing: the nested fold (`nestedErr.pending`)
          // and this same-level slice can both name a vouchee reachable via
          // two voucher edges (diamond graph), and a broadcast-timeout earlier
          // in the loop can re-add a row covered by the slice. Order-preserving
          // Set dedup keeps each account once in the operator follow-up list.
          throw new PartialCascadeError({
            completed,
            pending: [...new Set(pending)],
            rootRevocation: depth === 0 ? revokedAccount : nestedErr.rootRevocation,
          });
        }
      } catch (err) {
        if (err instanceof PartialCascadeError) {
          // Budget-exhaustion surfaced from this iteration or a nested call —
          // propagate upward without swallowing.
          throw err;
        }
        if (err instanceof BroadcastTimeoutError) {
          logger.error(
            { err, vouchee, rootRevocation: revokedAccount },
            'WoT cascading revocation timed out — vouchee un-revoked, manual follow-up required',
          );
          pending.push(vouchee);
          continue;
        }
        logger.error(
          { err, vouchee, rootRevocation: revokedAccount },
          'Failed to broadcast cascading revocation',
        );
        pending.push(vouchee);
      }
    }

    return completed;
  } catch (err) {
    if (err instanceof PartialCascadeError) {
      // Let the top-level caller handle partial state. Only the top-level
      // cascade (depth === 0) is expected to log or persist the partial
      // state; intermediate levels bubble up.
      if (depth === 0) {
        logger.error(
          {
            err,
            rootRevocation: err.rootRevocation,
            completed: err.completed,
            pending: err.pending,
          },
          'Cascade revocation budget exceeded — partial state surfaced to caller',
        );
      }
      throw err;
    }
    logger.error({ err, revokedAccount }, 'Cascade revocation check failed');
    return [];
  }
}

/**
 * Outcome of re-evaluating a single vouchee after one of its vouches is
 * withdrawn (the `/api/wot/retract` path).
 */
export type VoucheeRevocationOutcome =
  | { outcome: 'revoked'; txId: string }
  | { outcome: 'skipped' }
  | { outcome: 'timeout' }
  | { outcome: 'chain_error' };

/**
 * Re-evaluate the VOUCHEE that just lost a vouch and revoke its accreditation if
 * it has fallen below the WoT threshold.
 *
 * This is the retract-path counterpart to cascadeRevocation. cascadeRevocation
 * handles the case where an account's own accreditation was revoked, walking
 * that account's vouchees; a retract instead removes a single voucher→vouchee
 * edge, so the account to re-evaluate is the vouchee, not the voucher. Calling
 * cascadeRevocation(voucher) on retract re-evaluated the wrong accounts (the
 * voucher's still-active vouchees) and never the one that actually lost a vouch.
 *
 * The revoke decision is taken from `status` — the SAME `VouchStatus` snapshot
 * the route's `pollForRetraction` already returned after verifying the
 * retracting voucher's edge is gone from `active_vouches`. Reusing that one
 * snapshot (rather than re-reading via a second discovery query) closes a race:
 * a fresh vouch landing between the verification read and an independent recount
 * read could straddle HAF's ~3s ingestion lag and revoke an account that is
 * actually at-threshold on-chain. `shouldRevokeOnRetract` gates on both the
 * threshold (`!status.eligible`, where `vouches` are accredited-only) and the
 * account's own `method = 'wot'` accreditation, so a fabricated retraction
 * cannot drop a victim (the poll guarantees the edge is genuinely gone first)
 * and an email/ORCID accreditation is never revoked. No recursion: a single
 * withdrawn edge can drop at most this one vouchee, and revoking a WoT
 * accreditation does not retroactively unwind that account's own outbound
 * vouches (those stand until separately retracted).
 *
 * On a positive result the reputation batch entry is invalidated BEFORE the
 * broadcast — mirroring cascadeRevocation's ambiguous-timeout leak guard so a
 * timed-out-but-landed revocation cannot leave a stale positive score.
 */
export async function revokeVoucheeIfBelowThreshold(
  status: VouchStatus,
): Promise<VoucheeRevocationOutcome> {
  const vouchee = status.username;

  if (!config.pevoAdminPostingKey) {
    logger.warn('PEVO_ADMIN_POSTING_KEY not configured — cannot revoke vouchee on retract');
    return { outcome: 'skipped' };
  }

  if (!shouldRevokeOnRetract(status)) return { outcome: 'skipped' };

  const payload = buildRevocationPayload(vouchee);

  try {
    await invalidateOnRevocation(vouchee);

    const txResult = await broadcastAdminCustomJson(payload);
    logger.info({ vouchee, txId: txResult.id }, 'WoT vouchee revocation on retract broadcast');
    return { outcome: 'revoked', txId: txResult.id };
  } catch (err) {
    if (err instanceof BroadcastTimeoutError) {
      logger.error(
        { err, vouchee },
        'WoT vouchee revocation on retract timed out — outcome ambiguous, manual follow-up required',
      );
      return { outcome: 'timeout' };
    }
    logger.error({ err, vouchee }, 'Failed to broadcast WoT vouchee revocation on retract');
    return { outcome: 'chain_error' };
  }
}

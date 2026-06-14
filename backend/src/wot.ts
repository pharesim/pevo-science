/**
 * Web of Trust (WoT) service.
 *
 * Handles vouch status queries, WoT threshold checking, and auto-accreditation
 * broadcasting. WoT standing is LIVE: a member that falls below the vouch
 * threshold loses accreditation with NO `revoke` op (membership is recomputed
 * from the live vouch graph in `activeAccreditationsCteBody`), and recovering
 * vouches restores it automatically. There is no threshold-drop revoke and no
 * revocation cascade — those were the op-pinned representation this module
 * replaced.
 */
import pg from 'pg';
import { getPool } from './db.js';
import { broadcastAdminCustomJson, BroadcastTimeoutError } from './hive.js';
import { config } from './config.js';
import { getAccreditedSet, hasUnliftedSanction } from './accreditation.js';
import { seedAccreditationBonus } from './reputation.js';
import { logger } from './logger.js';
import { hafCache } from './cache.js';
import { T, activeAccreditationsCteBody, activeVouchesCteBody, buildWith } from './hafsql.js';
import type { AccreditationMethod } from './types/domain.js';

const DEFAULT_WOT_THRESHOLD = 3;

const WOT_THRESHOLD_TTL = 30 * 60_000;

/**
 * Result of `broadcastWotAccreditation` (the Web-of-Trust auto-accreditation
 * broadcast). A tagged union so the caller branches explicitly on outcome
 * instead of conflating "skipped because not eligible" with "broadcast timed
 * out and we have no idea whether it landed". `reason: 'sanctioned'` is the
 * ever-sanctioned refusal: vouches cannot re-admit an account with an un-lifted
 * sanction (only a deliberate authority `accredit` lifts it).
 */
export type WotAccreditationResult =
  | { ok: true; txId: string }
  | { ok: false; reason: 'timeout' | 'chain_error' | 'skipped' | 'sanctioned'; err?: Error };

async function loadWotThreshold(): Promise<number> {
  const pool = getPool();
  if (!pool) return DEFAULT_WOT_THRESHOLD;

  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Defensive cap only: with the operations-first plan below this query
    // returns in ~15ms, but a degraded HAF should still fail fast to the
    // default rather than hang.
    await client.query('SET LOCAL statement_timeout = 5000');

    // The row match is wrapped in an `AS MATERIALIZED` CTE as an optimization
    // fence so the planner resolves the small `custom_id`-indexed candidate set
    // FIRST, then sorts and limits it. Without the fence, `ORDER BY block_num
    // DESC LIMIT 1` lets the planner walk the 100M+-row blocks index backward
    // in a nested loop (block_num is a function over the operation id, not a
    // stored column) probing the near-empty update_params set — an ~18s scan
    // that trips the 5s cap and silently degrades the live threshold to the
    // default. The `custom_id` filter alone is selective (a handful of
    // admin-signed app ops); materializing lets that index scan win. Do NOT add
    // a `block_num >=` floor to narrow further — it flips the planner to a
    // BitmapAnd against the full view (see the pevo/no-custom-id-block-num-floor lint
    // rule and the activeAccreditationsCteBody docstring).
    const result = await client.query(
      `WITH candidates AS MATERIALIZED (
         SELECT json, block_num, id FROM ${T.customJson}
         WHERE custom_id = $1
           AND json::jsonb ->> 'action' = 'update_params'
           AND required_posting_auths ?| $2::text[]
       )
       SELECT json FROM candidates
       -- Latest-op-wins tiebreaker per Rule 2 (custom_json design rules,
       -- agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md):
       -- order by (block_num, id), not block_num alone — operation_custom_json_view
       -- omits trx_in_block, so the monotonic HAF op id breaks same-block ties.
       -- (Projecting id into the CTE does not weaken the AS MATERIALIZED fence —
       -- the inner CTE has no ORDER BY/LIMIT, so its plan is unchanged.)
       ORDER BY block_num DESC, id DESC
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
 * `string`) so a `=== 'wot'` discriminant is compiler-visible: a caller
 * comparing against a method outside the set becomes a type error rather than a
 * silent always-false.
 */
export type { AccreditationMethod };

export interface VouchStatus {
  username: string;
  vouch_count: number;
  threshold: number;
  vouches: VouchInfo[];
  eligible: boolean;
  /**
   * The account's OWN op-pinned accreditation method (the most-recent `accredit`
   * event's `method`, from `accred_pinned`), or `null` if the account has no
   * current, not-sanctioned `accredit` op. Op-pinned (not live-threshold-gated)
   * so it reports `'wot'` for an enrolled-but-below-threshold account; the
   * `eligible` flag carries the live-standing signal. Informational on the
   * GET /api/wot/:username response.
   */
  accreditation_method: AccreditationMethod | null;
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
 * own op-pinned accreditation `method` (a scalar subquery) AND its accredited-only
 * voucher list (`json_agg`). Exported so the real-planner regression runs this
 * exact SELECT against a synthetic graph rather than a hand-rewritten copy.
 *
 * Voucher eligibility joins `accred_pinned` — the op-pinned, not-sanctioned
 * accredited set (every account with a current `accredit` op, INCLUDING a
 * below-threshold WoT account). This is the SAME set `activeAccreditationsCteBody`
 * counts vouches against for its live WoT-threshold gate, so the `eligible` flag
 * computed from `vouches.length` here (the broadcast trigger) and the membership
 * filter can never disagree: a voucher counts iff it holds a current attestation.
 * Counting the live-gated `active_accreditations` instead would diverge (a
 * below-threshold WoT voucher would count toward membership but not here) and
 * would also be recursive.
 *
 * Shape invariants this SELECT must preserve:
 *  - The `json_agg(...) FILTER (WHERE av.voucher IS NOT NULL)` over the
 *    `LEFT`-less inner JOIN yields one row even for an account with ZERO
 *    accredited vouchers, with `vouches = []` (the COALESCE collapses the
 *    aggregate-over-empty-set NULL to an empty array). There is no `GROUP BY`:
 *    the scalar subquery plus a single bare aggregate produce exactly one group.
 *  - `active_vouches` carries one row per (voucher, vouchee) edge, so no DISTINCT
 *    is needed for `vouches.length` to equal the accredited-voucher count.
 *
 * Expects `accred_pinned` (from `activeAccreditationsCteBody`) and `active_vouches`
 * (from `activeVouchesCteBody`) CTEs in scope (combine with
 * `buildWith(1, activeAccreditationsCteBody, activeVouchesCteBody)` in
 * production; the real-Postgres regression substitutes fixture CTEs of the same
 * shape).
 *
 * @param usernameParam - `$N` placeholder bound to the account being read (used
 *   in both the self-method subquery and the vouches WHERE filter).
 */
export function vouchStatusSelect(usernameParam: string): string {
  return `SELECT
           (SELECT method FROM accred_pinned WHERE account = ${usernameParam}) AS self_method,
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
         JOIN accred_pinned aa ON aa.account = av.voucher
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
        // accreditation-method union at this single read site so any consumer
        // comparing against a method literal (e.g. a `=== 'wot'` discriminant)
        // sees the literal type rather than a bare `string`. An off-enum value
        // compares unequal to every arm, the same as `null`.
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
 * (`reason: 'skipped'`) and "refused because the account is sanctioned"
 * (`reason: 'sanctioned'`) from an actual broadcast failure
 * (`reason: 'timeout'` or `reason: 'chain_error'`). A timeout outcome means
 * the broadcast MAY have landed on chain — the caller should surface a
 * degraded-state warning rather than retry blindly.
 *
 * The broadcast enrolls a vouchee into WoT membership (writes the `method='wot'`
 * accredit op). Once enrolled, live-threshold membership tracks the vouch graph
 * with no further broadcasts — a drop below threshold de-accredits and a recovery
 * re-accredits automatically, so this only fires on the FIRST threshold crossing
 * (the already-accredited check skips an enrolled account that currently meets
 * the threshold).
 */
export async function broadcastWotAccreditation(vouchee: string): Promise<WotAccreditationResult> {
  if (!config.pevoAdminPostingKey) {
    logger.warn('PEVO_ADMIN_POSTING_KEY not configured — cannot broadcast WoT accreditation');
    return { ok: false, reason: 'skipped' };
  }

  const status = await getVouchStatus(vouchee);
  if (!status || !status.eligible) return { ok: false, reason: 'skipped' };

  // Check if already accredited (live membership). An enrolled account that
  // currently meets the threshold is already accredited and needs no re-broadcast.
  const accreditedSet = await getAccreditedSet([vouchee]);
  if (accreditedSet.has(vouchee)) return { ok: false, reason: 'skipped' };

  // Ever-sanctioned guard: a sanctioned account is absent from getAccreditedSet
  // for the SAME reason a never-enrolled account is (both fail the membership
  // filter), so the set check above cannot tell them apart. Vouches must not
  // re-admit an un-lifted sanction — only a deliberate authority `accredit`
  // lifts it. Refuse the auto-accreditation broadcast for a sanctioned account.
  if (await hasUnliftedSanction(vouchee)) {
    logger.info({ vouchee }, 'WoT auto-accreditation refused — account has an un-lifted sanction');
    return { ok: false, reason: 'sanctioned' };
  }

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
      // System marker: WoT auto-accreditation is not a human admin action.
      issued_by: 'wot',
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
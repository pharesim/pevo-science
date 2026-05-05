/**
 * Web of Trust (WoT) service.
 *
 * Handles vouch status queries, WoT threshold checking, auto-accreditation
 * broadcasting, and cascading revocation when vouchers lose their own
 * accreditation.
 */
import pg from 'pg';
import { getPool } from './db.js';
import { broadcastJsonWithTimeout, BroadcastTimeoutError } from './hive.js';
import { config } from './config.js';
import { getAccreditedSet } from './accreditation.js';
import { seedAccreditationBonus, invalidateOnRevocation } from './reputation.js';
import { logger } from './logger.js';
import { hafCache } from './cache.js';
import { T, activeAccreditationsCteBody, activeVouchesCteBody, buildWith, getCachedGenesisBlock } from './hafsql.js';

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
         AND block_num >= $2
       ORDER BY block_num DESC
       LIMIT 1`,
      [config.appTag, getCachedGenesisBlock()],
    );
    await client.query('COMMIT');
    client.release();

    if (result.rows.length === 0) return DEFAULT_WOT_THRESHOLD;

    const payload = typeof result.rows[0].json === 'string'
      ? JSON.parse(result.rows[0].json)
      : result.rows[0].json;

    return payload.params?.min_accreditations_for_wot ?? DEFAULT_WOT_THRESHOLD;
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

export interface VouchStatus {
  username: string;
  vouch_count: number;
  threshold: number;
  vouches: VouchInfo[];
  eligible: boolean;
}

/**
 * Get the vouch status for a user from HAF.
 */
export async function getVouchStatus(username: string): Promise<VouchStatus | null> {
  return hafCache.getOrSet<VouchStatus | null>(`vouch_status:${username}`, async () => {
    const pool = getPool();
    if (!pool) return null;

    try {
      const threshold = await getWotThreshold();

      const cte = buildWith(1, activeAccreditationsCteBody, activeVouchesCteBody);
      const result = await pool.query(
        `${cte.sql}
         SELECT av.voucher, av.relationship, av.event_timestamp
         FROM active_vouches av
         JOIN active_accreditations aa ON aa.account = av.voucher
         WHERE av.vouchee = $${cte.nextIdx}
         ORDER BY av.event_timestamp ASC`,
        [...cte.params, username],
      );

      const vouches: VouchInfo[] = result.rows.map((r: Record<string, unknown>) => ({
        voucher: r.voucher as string,
        relationship: r.relationship as string,
        timestamp: r.event_timestamp as string,
      }));

      return {
        username,
        vouch_count: vouches.length,
        threshold,
        vouches,
        eligible: vouches.length >= threshold,
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
    const { PrivateKey } = await import('@hiveio/dhive');

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

    const result = await broadcastJsonWithTimeout(
      {
        id: config.appTag,
        required_auths: [],
        required_posting_auths: [config.hiveAdminAccount],
        json: JSON.stringify(payload),
      },
      PrivateKey.fromString(config.pevoAdminPostingKey),
    );

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

    // Find all vouchees that were vouched by the revoked account
    const findCte = buildWith(1, activeAccreditationsCteBody, activeVouchesCteBody);
    const result = await pool.query(
      `${findCte.sql}
       SELECT av.vouchee
       FROM active_vouches av
       WHERE av.voucher = $${findCte.nextIdx}`,
      [...findCte.params, revokedAccount],
    );

    const { PrivateKey } = await import('@hiveio/dhive');

    for (const [i, row] of result.rows.entries()) {
      const vouchee = row.vouchee as string;

      // Aggregate budget check — abort cascade if we've blown through the
      // wall-clock cap. Everything not yet attempted lands in `pending`.
      if (Date.now() >= effectiveDeadline) {
        // Remaining vouchees in this level's result set (including `vouchee`)
        // are pending.
        const remainingRows = result.rows.slice(i);
        for (const r of remainingRows) pending.push(r.vouchee as string);
        throw new PartialCascadeError({ completed, pending, rootRevocation: revokedAccount });
      }

      // Check if this vouchee was WoT-accredited
      const accredCte = activeAccreditationsCteBody();
      const accredResult = await pool.query(
        `WITH ${accredCte.sql}
         SELECT method FROM active_accreditations WHERE account = $${accredCte.nextIdx}`,
        [...accredCte.params, vouchee],
      );
      if (accredResult.rows.length === 0) continue;
      if (accredResult.rows[0].method !== 'wot') continue;

      // Recount vouches excluding the revoked account
      const countCte = buildWith(1, activeAccreditationsCteBody, activeVouchesCteBody);
      const vouchCount = await pool.query(
        `${countCte.sql}
         SELECT COUNT(*)::int AS cnt
         FROM active_vouches av
         JOIN active_accreditations aa ON aa.account = av.voucher
         WHERE av.vouchee = $${countCte.nextIdx}
           AND av.voucher != $${countCte.nextIdx + 1}`,
        [...countCte.params, vouchee, revokedAccount],
      );

      const remaining = vouchCount.rows[0]?.cnt ?? 0;
      if (remaining >= threshold) continue;

      // Revoke the vouchee's WoT accreditation
      const payload = {
        action: 'revoke',
        account: vouchee,
        reason: 'WoT threshold no longer met',
        timestamp: new Date().toISOString(),
      };

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

        const txResult = await broadcastJsonWithTimeout(
          {
            id: config.appTag,
            required_auths: [],
            required_posting_auths: [config.hiveAdminAccount],
            json: JSON.stringify(payload),
          },
          PrivateKey.fromString(config.pevoAdminPostingKey),
        );

        logger.info({ vouchee, revokedAccount, txId: txResult.id }, 'WoT cascading revocation broadcast');
        completed.push(txResult.id);

        // Recursively cascade — the revoked vouchee may have vouched for others.
        // Propagate PartialCascadeError upward so the top-level call has the
        // full completed/pending picture. Non-budget errors from the nested
        // call fall through to the outer catch of this iteration.
        try {
          const nested = await cascadeRevocation(vouchee, depth + 1, effectiveDeadline);
          completed.push(...nested);
        } catch (nestedErr) {
          if (nestedErr instanceof PartialCascadeError) {
            // Fold nested progress into our aggregate and re-throw.
            completed.push(...nestedErr.completed);
            pending.push(...nestedErr.pending);
            throw new PartialCascadeError({
              completed,
              pending,
              rootRevocation: depth === 0 ? revokedAccount : nestedErr.rootRevocation,
            });
          }
          throw nestedErr;
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

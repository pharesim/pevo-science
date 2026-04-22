/**
 * Web of Trust (WoT) service.
 *
 * Handles vouch status queries, WoT threshold checking, auto-accreditation
 * broadcasting, and cascading revocation when vouchers lose their own
 * accreditation.
 */
import pg from 'pg';
import { getPool } from './db.js';
import { hiveClient, broadcastJsonWithTimeout } from './hive.js';
import { config } from './config.js';
import { getAccreditedSet } from './accreditation.js';
import { logger } from './logger.js';
import { hafCache } from './cache.js';
import { T, activeAccreditationsCteBody, activeVouchesCteBody, buildWith, getCachedGenesisBlock } from './hafsql.js';

const DEFAULT_WOT_THRESHOLD = 3;
const MAX_REVOCATION_DEPTH = 20;

const WOT_THRESHOLD_TTL = 30 * 60_000;

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
 */
export async function checkAndAccreditViaWot(vouchee: string): Promise<string | null> {
  if (!config.pevoAdminPostingKey) {
    logger.warn('PEVO_ADMIN_POSTING_KEY not configured — cannot broadcast WoT accreditation');
    return null;
  }

  const status = await getVouchStatus(vouchee);
  if (!status || !status.eligible) return null;

  // Check if already accredited
  const accreditedSet = await getAccreditedSet([vouchee]);
  if (accreditedSet.has(vouchee)) return null;

  // Get vouchee's info from vouches (use the most common relationship context)
  const pool = getPool();
  if (!pool) return null;

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
    return result.id;
  } catch (err) {
    logger.error({ err, vouchee }, 'Failed to broadcast WoT accreditation');
    return null;
  }
}

/**
 * Check if revoking a voucher's accreditation should cascade to their vouchees.
 * For each vouchee that drops below the WoT threshold and was WoT-accredited,
 * broadcast a revocation.
 */
export async function cascadeRevocation(revokedAccount: string, depth = 0): Promise<string[]> {
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

    const revokedTxIds: string[] = [];
    const { PrivateKey } = await import('@hiveio/dhive');

    for (const row of result.rows) {
      const vouchee = row.vouchee as string;

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
        revokedTxIds.push(txResult.id);

        // Recursively cascade — the revoked vouchee may have vouched for others
        const nested = await cascadeRevocation(vouchee, depth + 1);
        revokedTxIds.push(...nested);
      } catch (err) {
        logger.error({ err, vouchee }, 'Failed to broadcast cascading revocation');
      }
    }

    return revokedTxIds;
  } catch (err) {
    logger.error({ err, revokedAccount }, 'Cascade revocation check failed');
    return [];
  }
}

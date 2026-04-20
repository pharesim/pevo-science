/**
 * IPFS orphan cleanup job.
 *
 * Runs every 30 minutes. For each row in `pending_ipfs_uploads` older than 24h:
 * - If a PEvO post references the CID → drop the DB row (and Redis key)
 * - If no post references it → unpin from Kubo, then drop the DB row (and Redis key)
 *
 * Postgres is the authoritative record of in-flight pins. Redis is a hot cache
 * for the download proxy's known-CID check only; keys there have a 24h TTL and
 * may be missing on eviction or flush, which is fine.
 */

import { getRedis } from './redis.js';
import { getPool, isHafAvailable } from './db.js';
import { getAppPool } from './app-db.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { T } from './hafsql.js';

const CLEANUP_INTERVAL_MS = 30 * 60_000; // 30 minutes
const MAX_AGE_MS = 24 * 60 * 60_000; // 24 hours

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Check if a CID is referenced by any PEvO post in HAF.
 * Checks both `pevo.ipfs_cid` and `pevo.supplementary_files[].cid`.
 */
async function cidReferencedInHaf(cid: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;

  const result = await pool.query(
    `SELECT 1 FROM ${T.comments} c
     WHERE c.json_metadata @> $1::jsonb
        OR c.json_metadata @> $2::jsonb
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(c.json_metadata->'image') img
          WHERE img LIKE '%' || $3 || '%'
        )
     LIMIT 1`,
    [
      JSON.stringify({ pevo: { ipfs_cid: cid } }),
      JSON.stringify({ pevo: { supplementary_files: [{ cid }] } }),
      cid,
    ],
  );

  return result.rowCount !== null && result.rowCount > 0;
}

/** Unpin a CID from the local Kubo node. */
async function unpinFromKubo(cid: string): Promise<void> {
  const response = await fetch(
    `${config.ipfsApiUrl}/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`,
    { method: 'POST', signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) {
    const text = await response.text();
    // "not pinned" is not an error — the pin may have already been removed
    if (!text.includes('not pinned')) {
      throw new Error(`Kubo unpin failed: ${response.status} ${text}`);
    }
  }
}

/** Process all expired pending CIDs. */
async function runCleanup(): Promise<void> {
  const appPool = getAppPool();
  if (!appPool) {
    logger.debug('IPFS cleanup skipped — app DB not configured');
    return;
  }

  if (!isHafAvailable()) {
    logger.debug('IPFS cleanup skipped — HAF not available');
    return;
  }

  const redis = getRedis();
  const ageSeconds = Math.floor(MAX_AGE_MS / 1000);

  const { rows } = await appPool.query<{ cid: string; uploader_account: string }>(
    `SELECT cid, uploader_account
       FROM pending_ipfs_uploads
      WHERE created_at < NOW() - ($1 || ' seconds')::interval`,
    [String(ageSeconds)],
  );

  let processed = 0;
  let unpinned = 0;

  for (const row of rows) {
    try {
      const referenced = await cidReferencedInHaf(row.cid);
      if (referenced) {
        await appPool.query(`DELETE FROM pending_ipfs_uploads WHERE cid = $1`, [row.cid]);
        if (redis) await redis.del(`${config.appTag}:ipfs:pending:${row.cid}`).catch(() => {});
        logger.debug({ cid: row.cid }, 'IPFS CID confirmed on-chain — tracking removed');
      } else {
        await unpinFromKubo(row.cid);
        await appPool.query(`DELETE FROM pending_ipfs_uploads WHERE cid = $1`, [row.cid]);
        if (redis) await redis.del(`${config.appTag}:ipfs:pending:${row.cid}`).catch(() => {});
        unpinned++;
        logger.info({ cid: row.cid, uploader: row.uploader_account }, 'Unpinned orphaned IPFS CID');
      }
      processed++;
    } catch (err) {
      logger.warn({ err, cid: row.cid }, 'IPFS cleanup error processing CID');
    }
  }

  if (processed > 0) {
    logger.info({ processed, unpinned }, 'IPFS orphan cleanup completed');
  }
}

export function startIpfsCleanup(): void {
  if (cleanupTimer) return;
  logger.info('IPFS orphan cleanup job started (every 30m)');
  cleanupTimer = setInterval(() => {
    runCleanup().catch((err) => {
      logger.error({ err }, 'IPFS cleanup job failed');
    });
  }, CLEANUP_INTERVAL_MS);
}

export function stopIpfsCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

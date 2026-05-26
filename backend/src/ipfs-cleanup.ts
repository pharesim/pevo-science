/**
 * IPFS orphan cleanup job.
 *
 * Runs every 30 minutes. For each row in `pending_ipfs_uploads` older than 24h:
 * - If a PEvO post references the CID → drop the DB row (and Redis key)
 * - If no post references it → unpin from the backend that created the pin
 *   (Kubo or Pinata, per the row's `pin_backend`), then drop the DB row (and
 *   Redis key). Dispatching to the wrong backend would fire pin/rm at a node
 *   that never held the pin and silently leak the live one.
 *
 * Postgres is the authoritative record of in-flight pins. Redis is a hot cache
 * for the download proxy's known-CID check only; keys there have a 24h TTL and
 * may be missing on eviction or flush, which is fine.
 */

import { getRedis } from './redis.js';
import { getPool, isHafConfigured } from './db.js';
import { getAppPool } from './app-db.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { cidReferencedByAppTag, toPinBackend, unpinFromIpfs } from './lib/ipfs-shared.js';

const CLEANUP_INTERVAL_MS = 30 * 60_000; // 30 minutes
const MAX_AGE_MS = 24 * 60 * 60_000; // 24 hours

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Cleanup-side CID-in-use check: is this CID still referenced by a PEvO post on
 * chain? Delegates the tags-scoped containment query to the shared
 * `cidReferencedByAppTag` (lib/ipfs-shared.ts) — same definition the gateway's
 * CID-known check consumes — and only owns the HAF-pool null-guard here. A false
 * result routes the expired pending-upload row to the unpin branch in
 * `runCleanup`, so the shared query's tags-scope / appTag-namespace /
 * image-SRF-guard invariants are what stand between this and unpinning a live
 * on-chain-referenced file.
 */
async function cidReferencedInHaf(cid: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  return cidReferencedByAppTag(pool, cid);
}

/** Process all expired pending CIDs. Exported for the backend-dispatch test. */
export async function runCleanup(): Promise<void> {
  const appPool = getAppPool();
  if (!appPool) {
    logger.debug('IPFS cleanup skipped — app DB not configured');
    return;
  }

  if (!isHafConfigured()) {
    logger.debug('IPFS cleanup skipped — HAF not available');
    return;
  }

  const redis = getRedis();
  const ageSeconds = Math.floor(MAX_AGE_MS / 1000);

  const { rows } = await appPool.query<{ cid: string; uploader_account: string; pin_backend: string }>(
    `SELECT cid, uploader_account, pin_backend
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
        // Route the unpin to the backend that created the pin — a Pinata-origin
        // pin cannot be released by a Kubo pin/rm and vice versa. toPinBackend
        // throws on an out-of-domain value rather than letting it fall through
        // to Pinata; the throw is caught below, which logs and skips the DELETE
        // so the row survives for an operator instead of being misrouted and
        // reaped.
        await unpinFromIpfs(row.cid, toPinBackend(row.pin_backend));
        await appPool.query(`DELETE FROM pending_ipfs_uploads WHERE cid = $1`, [row.cid]);
        if (redis) await redis.del(`${config.appTag}:ipfs:pending:${row.cid}`).catch(() => {});
        unpinned++;
        logger.info({ cid: row.cid, uploader: row.uploader_account, backend: row.pin_backend }, 'Unpinned orphaned IPFS CID');
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

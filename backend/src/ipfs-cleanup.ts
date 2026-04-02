/**
 * IPFS orphan cleanup job (I5b).
 *
 * Runs every 30 minutes. For each `ipfs:pending:*` key older than 24h:
 * - If a PEvO post references the CID (in ipfs_cid or supplementary_files) → delete the key
 * - If no post references it → unpin from Kubo and delete the key
 */

import { getRedis } from './redis.js';
import { getPool, isHafAvailable } from './db.js';
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
  const redis = getRedis();
  if (!redis) return;

  if (!isHafAvailable()) {
    logger.debug('IPFS cleanup skipped — HAF not available');
    return;
  }

  let cursor = '0';
  const now = Date.now();
  let processed = 0;
  let unpinned = 0;

  do {
    const [nextCursor, keys] = await redis.scan(
      cursor, 'MATCH', 'ipfs:pending:*', 'COUNT', '100',
    );
    cursor = nextCursor;

    for (const key of keys) {
      try {
        const raw = await redis.get(key);
        if (!raw) continue;

        const data = JSON.parse(raw) as { cid: string; uploader: string; timestamp: number };
        if (now - data.timestamp < MAX_AGE_MS) continue; // not old enough

        const referenced = await cidReferencedInHaf(data.cid);
        if (referenced) {
          await redis.del(key);
          logger.debug({ cid: data.cid }, 'IPFS CID confirmed on-chain — tracking removed');
        } else {
          await unpinFromKubo(data.cid);
          await redis.del(key);
          unpinned++;
          logger.info({ cid: data.cid, uploader: data.uploader }, 'Unpinned orphaned IPFS CID');
        }
        processed++;
      } catch (err) {
        logger.warn({ err, key }, 'IPFS cleanup error processing key');
      }
    }
  } while (cursor !== '0');

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

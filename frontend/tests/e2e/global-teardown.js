/**
 * Playwright global-teardown — unpins IPFS CIDs that the suite created.
 *
 * Why this exists: E2E uploads go through the real backend pinning proxy but
 * the spec intercepts the final Hive broadcast, so CIDs never land in HAF.
 * The backend's 24h orphan cleanup would eventually unpin them, but in the
 * meantime test pins pile up on the shared dev Kubo node. We unpin per-CID
 * (captured via the keychain fixture's response listener) instead of flushing
 * `ipfs:pending:*`, which would also kill dev uploads on the shared Redis.
 *
 * The DB reset lives in global-setup, not here — leaving rows after a failed
 * run is intentional so they can be inspected.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';
import { readCapturedCids, resetCapturedCids } from './fixtures/captured-cids.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = resolve(__dirname, '..', '..');
const REPO_ROOT = resolve(FRONTEND_ROOT, '..');

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const contents = readFileSync(path, 'utf8');
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function unpinFromKubo(ipfsApiUrl, cid) {
  const response = await fetch(
    `${ipfsApiUrl}/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`,
    { method: 'POST', signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) {
    const text = await response.text();
    // "not pinned" means someone already unpinned it — treat as success
    if (text.includes('not pinned')) return;
    throw new Error(`Kubo unpin ${response.status}: ${text}`);
  }
}

export default async function globalTeardown() {
  loadEnvFile(resolve(FRONTEND_ROOT, '.env.test'));
  loadEnvFile(resolve(REPO_ROOT, '.env'));

  const cids = readCapturedCids();
  if (cids.length === 0) {
    resetCapturedCids();
    return;
  }

  const ipfsApiUrl = process.env.IPFS_API_URL;
  const redisUrl = process.env.REDIS_URL;
  const appTag = process.env.APP_TAG;

  if (!ipfsApiUrl) {
    console.warn(
      `[e2e teardown] IPFS_API_URL not set — skipping unpin for ${cids.length} CID(s). ` +
        'Backend orphan cleanup will remove them within 24h.',
    );
    resetCapturedCids();
    return;
  }

  let redis = null;
  if (redisUrl && appTag) {
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    });
    redis.on('error', () => {}); // swallow — we'll fall through to log on use
    try {
      await redis.connect();
    } catch (err) {
      console.warn(`[e2e teardown] Redis connect failed: ${err.message}`);
      redis = null;
    }
  } else if (!redisUrl) {
    console.warn('[e2e teardown] REDIS_URL not set. skipping redis key deletion.');
  } else {
    console.warn('[e2e teardown] APP_TAG not set. skipping redis key deletion to avoid wrong-prefix deletes.');
  }

  let unpinned = 0;
  let unpinFailed = 0;
  let redisDeleted = 0;
  let redisFailed = 0;

  for (const cid of cids) {
    try {
      await unpinFromKubo(ipfsApiUrl, cid);
      unpinned++;
    } catch (err) {
      unpinFailed++;
      console.warn(`[e2e teardown] unpin ${cid} failed: ${err.message}`);
    }

    if (redis) {
      try {
        const removed = await redis.del(`${appTag}:ipfs:pending:${cid}`);
        if (removed > 0) redisDeleted++;
      } catch (err) {
        redisFailed++;
        console.warn(`[e2e teardown] redis del ${cid} failed: ${err.message}`);
      }
    }
  }

  if (redis) {
    await redis.quit().catch(() => {});
  }

  console.log(
    `[e2e teardown] IPFS cleanup: ${unpinned}/${cids.length} unpinned` +
      (unpinFailed ? ` (${unpinFailed} failed)` : '') +
      (redis ? `, ${redisDeleted} redis keys deleted` : '') +
      (redisFailed ? ` (${redisFailed} redis failed)` : ''),
  );

  resetCapturedCids();
}

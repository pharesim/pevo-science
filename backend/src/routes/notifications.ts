import { Router, type Request, type Response } from 'express';
import { getPool } from '../db.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { hafCache } from '../cache.js';
import { fetchNotificationsFromHaf, type NotificationBatch } from '../notification-queries.js';
import { getGenesisBlock } from '../hafsql.js';
import { getLastBlock } from '../block-watcher.js';

const router = Router();

// Fixed look-back window for the cached HAF computation. The cached query is
// computed relative to `chainHead - NOTIFICATION_WINDOW_BLOCKS` (clamped to
// genesis) rather than the caller's `since_block`, so the result is shareable
// across every poll and SPA tab for the same `(account, limit)`. ~100k blocks
// is roughly 3.5 days at Hive's 3s block cadence — wide enough to cover a
// client's catch-up after an offline gap without paying the genesis-to-head
// scan on every poll.
const NOTIFICATION_WINDOW_BLOCKS = 100_000;

// TTL for the shared notification computation. Block-watcher's volatile sweep
// runs on every ~3s block tick; flagging this entry `stable: true` keeps it out
// of that sweep so one HAF computation serves the next minute of polls.
const NOTIFICATION_CACHE_TTL_MS = 60_000;

// ──────────────────────────────────────────────
// GET /api/notifications
// ──────────────────────────────────────────────

router.get('/', verifyHiveSignature, async (req: Request, res: Response) => {
  const account = req.hiveUsername!;
  let sinceBlock = parseInt(req.query.since_block as string, 10);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));

  if (isNaN(sinceBlock) || sinceBlock < 0 || sinceBlock > 2_000_000_000) {
    return sendError(res, 400, 'BAD_REQUEST', 'since_block query parameter is required and must be a non-negative integer');
  }

  // Clamp to namespace genesis — no PEvO data exists before the first accreditation
  const pool = getPool();
  let genesis = 0;
  if (pool) {
    genesis = await getGenesisBlock(pool);
    if (genesis > 0 && sinceBlock < genesis) {
      sinceBlock = genesis - 1;
    }
  }

  // Floor for the cached window computation. Move forward from the chain head
  // when the block-watcher has observed one; otherwise fall back to the genesis
  // floor so a cold backend (watcher not yet ticked, e.g. fresh boot or tests)
  // still produces a valid, shareable computation. Never dip below genesis - 1.
  const head = getLastBlock();
  const genesisFloor = genesis > 0 ? genesis - 1 : 0;
  const windowFloor = head > 0
    ? Math.max(genesisFloor, head - NOTIFICATION_WINDOW_BLOCKS)
    : genesisFloor;

  // Cache key omits `since_block` so every poll within the TTL shares one HAF
  // computation. The poll-specific `since_block` is re-applied in-app below.
  const cacheKey = `notifications:${account}:${limit}`;
  const windowResult = await hafCache.getOrSet(
    cacheKey,
    () => fetchNotificationsFromHaf(account, windowFloor, limit),
    NOTIFICATION_CACHE_TTL_MS,
    true,
  );

  if (windowResult) {
    return sendOk(res, applySinceBlockFilter(windowResult, sinceBlock));
  }

  sendOk(res, { events: [], latest_block: sinceBlock, has_more: false });
});

/**
 * Re-apply the poll-specific `since_block` cursor to a window-relative batch
 * computed against `windowFloor`. The cached batch holds events in
 * `(windowFloor, head]`; the SPA's cursor advances past `windowFloor`, so the
 * in-app filter restores the contract's `(since_block, head]` range. Ordering
 * and payload shape are preserved from the cached batch; `latest_block` and
 * `has_more` are recomputed over the filtered subset so the SPA's forward
 * pagination stays internally consistent (it re-polls with `since_block =
 * latest_block`). When the filter empties the batch, `latest_block` falls back
 * to the caller's `since_block` so the cursor does not regress.
 */
function applySinceBlockFilter(batch: NotificationBatch, sinceBlock: number): NotificationBatch {
  const events = batch.events.filter((e) => e.block_num > sinceBlock);
  const latestBlock = events.length > 0
    ? Math.max(...events.map((e) => e.block_num))
    : sinceBlock;
  return {
    events,
    latest_block: latestBlock,
    has_more: events.length >= batch.events.length && batch.has_more,
  };
}

export default router;

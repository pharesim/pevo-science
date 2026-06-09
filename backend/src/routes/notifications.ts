import { Router, type Request, type Response } from 'express';
import { getPool } from '../db.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { hafCache } from '../cache.js';
import {
  fetchNotificationsFromHaf,
  computeNotificationWindowFloor,
  filterEventsAfter,
  NOTIFICATION_WINDOW_FETCH_CAP,
  type NotificationBatch,
  type NotificationEvent,
} from '../notification-queries.js';
import { getGenesisBlock } from '../hafsql.js';
import { getLastBlock } from '../block-watcher.js';

const router = Router();

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

  // Floor for the cached window computation (shared with the digest path).
  const windowFloor = computeNotificationWindowFloor(getLastBlock(), genesis);

  // Cache key omits `since_block` so every poll within the TTL shares one HAF
  // computation. The poll-specific `since_block` is re-applied in-app below.
  const cacheKey = `notifications:${account}:${limit}`;
  const windowResult = await hafCache.getOrSet(
    cacheKey,
    () => fetchNotificationsFromHaf(account, windowFloor, NOTIFICATION_WINDOW_FETCH_CAP, 'desc'),
    NOTIFICATION_CACHE_TTL_MS,
    true,
  );

  if (windowResult) {
    return sendOk(res, applySinceBlockFilter(windowResult, sinceBlock, limit));
  }

  sendOk(res, { events: [], latest_block: sinceBlock, has_more: false });
});

/**
 * Re-apply the poll-specific `since_block` cursor to the cached newest-first
 * window batch, delivering whole Hive blocks only.
 *
 * The batch (from `fetchNotificationsFromHaf(..., 'desc')`) holds the NEWEST
 * NOTIFICATION_WINDOW_FETCH_CAP events above `windowFloor` in ascending
 * `block_num` order, with the partial cap-boundary (oldest) block already
 * dropped by the shared fetch. Here we filter to events strictly after
 * `since_block` (the shared `>` cursor), then pack COMPLETE blocks from the
 * oldest undelivered block forward until adding the next whole block would
 * exceed `limit`, always including at least the oldest undelivered block in
 * full. A single Hive block holding more than `limit` events is therefore
 * delivered atomically (the response may exceed `limit`) rather than split.
 *
 * Whole-block delivery is what lets the client advance its cursor to
 * `latest_block` on every poll with NO rewind step: because `latest_block` is
 * always a fully-delivered block, advancing to it can never skip an intra-block
 * event. When the filter is empty, `latest_block` echoes `since_block` so a
 * forward cursor never regresses.
 *
 * `has_more` is purely `filtered.length > delivered.length` — undelivered events
 * ABOVE the cursor remain in this batch. It deliberately does NOT OR-in
 * `batch.has_more`: under newest-first, `batch.has_more` means OLDER events exist
 * below the window floor, which a forward cursor cannot re-fetch and which the
 * email digest covers; OR-ing it would park a caught-up cursor at
 * `has_more: true` forever. The authoritative client-facing contract is the
 * `has_more` / `latest_block` bullets in
 * `agents/docs/api-contracts/notifications.md`; keep this consistent with it.
 */
function applySinceBlockFilter(batch: NotificationBatch, sinceBlock: number, limit: number): NotificationBatch {
  const filtered = filterEventsAfter(batch.events, sinceBlock);
  if (filtered.length === 0) {
    return { events: [], latest_block: sinceBlock, has_more: false };
  }

  // `filtered` is ascending, so events of one block are contiguous. Take the
  // first (oldest undelivered) block in full unconditionally; add each later
  // whole block only while it still fits within `limit`.
  const delivered: NotificationEvent[] = [];
  let i = 0;
  while (i < filtered.length) {
    const blockNum = filtered[i].block_num;
    let j = i;
    while (j < filtered.length && filtered[j].block_num === blockNum) j++;
    const blockSize = j - i;
    if (delivered.length > 0 && delivered.length + blockSize > limit) break;
    for (let k = i; k < j; k++) delivered.push(filtered[k]);
    i = j;
  }

  return {
    events: delivered,
    latest_block: delivered[delivered.length - 1].block_num,
    has_more: filtered.length > delivered.length,
  };
}

export default router;

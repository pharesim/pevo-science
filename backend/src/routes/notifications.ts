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
    () => fetchNotificationsFromHaf(account, windowFloor, NOTIFICATION_WINDOW_FETCH_CAP),
    NOTIFICATION_CACHE_TTL_MS,
    true,
  );

  if (windowResult) {
    return sendOk(res, applySinceBlockFilter(windowResult, sinceBlock, limit));
  }

  sendOk(res, { events: [], latest_block: sinceBlock, has_more: false });
});

/**
 * Re-apply the poll-specific `since_block` cursor to a window-relative batch
 * computed against `windowFloor` and capped at NOTIFICATION_WINDOW_FETCH_CAP.
 * The cached batch holds ascending events in `(windowFloor, head]`; the SPA's
 * cursor advances past `windowFloor`, so the in-app filter restores the
 * contract's `(since_block, head]` range. After the cursor filter the result is
 * sliced to the response `limit` (oldest-first forward pagination: the SPA
 * re-polls with `since_block = latest_block`, which is the highest block among
 * the delivered events). When the filter empties the batch, `latest_block`
 * falls back to the caller's `since_block` so the cursor does not regress.
 *
 * `has_more` is true when in-window events beyond the delivered slice remain —
 * either the cursor filter left more than `limit` events (undelivered, in this
 * batch) or the internal fetch hit its cap (newer events exist beyond the
 * batch). The prior form (`events.length >= batch.events.length && batch.has_more`)
 * forced `has_more` to false whenever the cursor removed any event, starving a
 * follow-up poll while undelivered in-window events still existed.
 */
function applySinceBlockFilter(batch: NotificationBatch, sinceBlock: number, limit: number): NotificationBatch {
  const filtered = filterEventsAfter(batch.events, sinceBlock);
  const events = filtered.slice(0, limit);
  const latestBlock = events.length > 0
    ? Math.max(...events.map((e) => e.block_num))
    : sinceBlock;
  return {
    events,
    latest_block: latestBlock,
    has_more: filtered.length > events.length || batch.has_more,
  };
}

export default router;

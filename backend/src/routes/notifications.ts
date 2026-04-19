import { Router, type Request, type Response } from 'express';
import { getPool } from '../db.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { fetchNotificationsFromHaf } from '../notification-queries.js';
import { getGenesisBlock } from '../hafsql.js';

const router = Router();

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
  if (pool) {
    const genesis = await getGenesisBlock(pool);
    if (genesis > 0 && sinceBlock < genesis) {
      sinceBlock = genesis - 1;
    }
  }

  const cacheKey = `notifications:${account}:${sinceBlock}:${limit}`;
  const result = await hafCache.getOrSet(cacheKey, () =>
    fetchNotificationsFromHaf(account, sinceBlock, limit),
  );
  if (result) {
    return sendOk(res, result);
  }

  sendOk(res, { events: [], latest_block: sinceBlock, has_more: false });
});

export default router;

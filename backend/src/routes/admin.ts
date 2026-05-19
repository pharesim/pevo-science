import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { validate, accreditationVerifySchema } from '../validation.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { logger } from '../logger.js';
import { hashTokenForLogs } from '../lib/log-pii.js';
import { broadcastAttemptsKey } from './accreditation.js';

const router = Router();

// ──────────────────────────────────────────────
// POST /api/admin/accreditation/reset-broadcast-counter
//
// Operator manual-reset lever: clears an inflated `/api/accreditation/verify`
// broadcast-attempts counter when the in-process pending-decrement queue
// cannot converge (process restart between flap and drain, 24h TTL expiry,
// or queue overflow), or when a user reports persistent
// BROADCAST_ATTEMPT_LIMIT_EXCEEDED despite no actual broadcast having fired.
//
// Auth: admin Hive signature against `config.hiveAdminAccount` (singular).
// ──────────────────────────────────────────────

router.post(
  '/accreditation/reset-broadcast-counter',
  verifyHiveSignature,
  validate(accreditationVerifySchema),
  async (req: Request, res: Response) => {
    const username = req.hiveUsername!;
    if (username !== config.hiveAdminAccount) {
      // Hash the would-be target token before logging so an unauthorized
      // probe doesn't leak the plaintext token to operator logs.
      logger.warn(
        {
          event: 'accreditation.admin.reset_broadcast_counter_forbidden',
          attempted_by: username,
          token_hash: hashTokenForLogs(req.body.token as string),
        },
        'admin reset-broadcast-counter rejected — caller is not the configured admin account',
      );
      return sendError(res, 403, 'FORBIDDEN', `Only ${config.hiveAdminAccount} can reset broadcast counters`);
    }

    const token = req.body.token as string;
    const key = broadcastAttemptsKey(token);
    const redis = getRedis();

    if (!redis || !isRedisAvailable()) {
      // Without Redis there is no counter key to delete; the in-memory
      // fallback is per-process and the operator likely doesn't know
      // which container holds the inflated counter. Surface 503 so the
      // operator can retry once Redis is back, matching the auto-recovery
      // queue's same-fail-open semantics. Pair the body's `retriable:true`
      // with a `Retry-After: 30` header to match the sibling /verify 503
      // paths' floor — SPAs read the header to schedule backoff.
      logger.warn(
        {
          event: 'accreditation.admin.reset_broadcast_counter_redis_unavailable',
          admin_username: username,
          token_hash: hashTokenForLogs(token),
        },
        'admin reset-broadcast-counter: Redis unavailable; counter unchanged',
      );
      res.set('Retry-After', '30');
      return sendError(
        res,
        503,
        'SERVICE_UNAVAILABLE',
        'Redis unavailable; counter unchanged. Retry once Redis recovers, or wait for the 24h TTL.',
        { retriable: true },
      );
    }

    let priorValue: number | null = null;
    try {
      // Atomic GETDEL (Redis 6.2+) reads + deletes in a single command so the
      // `prior_value` returned to the operator matches the value that was
      // actually cleared, even if a concurrent /verify INCR lands between
      // the read and the delete.
      const raw = await redis.getdel(key);
      priorValue = raw === null ? null : Number(raw);
    } catch (err) {
      logger.error(
        {
          err,
          event: 'accreditation.admin.reset_broadcast_counter_failed',
          admin_username: username,
          token_hash: hashTokenForLogs(token),
        },
        'admin reset-broadcast-counter failed',
      );
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to reset broadcast counter');
    }

    // Operator audit trail: every reset is logged with admin account, hashed
    // token, prior counter value (null if the counter was already absent),
    // and a timestamp injected by pino.
    logger.info(
      {
        event: 'accreditation.admin.reset_broadcast_counter',
        admin_username: username,
        token_hash: hashTokenForLogs(token),
        prior_value: priorValue,
      },
      'admin reset broadcast counter',
    );

    sendOk(res, {
      token_hash: hashTokenForLogs(token),
      prior_value: priorValue,
    });
  },
);

export default router;

import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { validate, accreditationVerifySchema } from '../validation.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { logger } from '../logger.js';
import { hashTokenForLogs } from '../lib/log-pii.js';

const router = Router();

function broadcastAttemptsKey(token: string): string {
  return `${config.appTag}:pending_accred_broadcast_attempts:${token}`;
}

// ──────────────────────────────────────────────
// POST /api/admin/accreditation/reset-broadcast-counter
// Manual-reset runbook lever for BE-VERIFY-CAP-REDIS-FLAP-RECOVERY.
// Auth: admin Hive signature against config.hiveAdminAccount (singular per
// project_admin_is_singular memory). Operator-facing escape hatch when an
// `/api/accreditation/verify` broadcast-attempts counter is inflated due to
// a Redis flap and a user reports persistent BROADCAST_ATTEMPT_LIMIT_EXCEEDED.
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
          event: 'admin_reset_broadcast_counter_forbidden',
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
      // queue's same-fail-open semantics.
      logger.warn(
        {
          event: 'admin_reset_broadcast_counter_redis_unavailable',
          admin_username: username,
          token_hash: hashTokenForLogs(token),
        },
        'admin reset-broadcast-counter: Redis unavailable; counter unchanged',
      );
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
      const raw = await redis.get(key);
      priorValue = raw === null ? null : Number(raw);
      await redis.del(key);
    } catch (err) {
      logger.error(
        {
          err,
          event: 'admin_reset_broadcast_counter_failed',
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
        event: 'admin_reset_broadcast_counter',
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

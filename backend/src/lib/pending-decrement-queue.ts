/**
 * In-process queue for retrying `/api/accreditation/verify` broadcast-attempt
 * counter DECRs after a Redis flap.
 *
 * When `decrementBroadcastAttempts` cannot land its DECR (Redis unavailable
 * mid-request, or `redis.decr` throws), the route enqueues
 * `(token, attemptId, key)` here. A periodic drainer
 * (`config.verifyDecrementQueueDrainMs`, default 30s) retries DECR on Redis
 * when available, returning the counter to its pre-INCR value.
 *
 * Bounded blast radius:
 *   - In-process state. No cross-process / cross-container persistence.
 *   - Process restart loses pending decrements (acceptable; counter recovers
 *     via the 24h Redis TTL anchored to the verification token's lifetime).
 *   - Queue depth is capped (`QUEUE_DEPTH_CAP`) with overflow log to bound
 *     memory; in practice queue should rarely exceed single digits.
 *
 * Idempotency: the queue is keyed on `attemptId`. A duplicate enqueue for
 * the same `attemptId` overwrites the prior entry rather than double-counting.
 *
 * The drain emits a structured `accreditation.verify.decrement_queue_drain`
 * log line per cycle so operators can correlate counter drift with Redis
 * incidents.
 */

import { config } from '../config.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { logger } from '../logger.js';
import { hashTokenForLogs } from './log-pii.js';

const QUEUE_DEPTH_CAP = 1000;

interface PendingDecrementEntry {
  token: string;
  attemptId: string;
  queuedAt: number;
  /** Redis key to DECR. Captured at enqueue time so the drainer doesn't
   * need to re-derive it (and stays insulated from key-naming changes
   * between enqueue and drain). */
  key: string;
}

const queue = new Map<string, PendingDecrementEntry>();
let drainTimer: NodeJS.Timeout | null = null;
let overflowReported = false;

/**
 * Enqueue a pending DECR for retry on the next drain cycle. Idempotent on
 * `attemptId` — repeated enqueues for the same attempt overwrite the prior
 * entry (queue size stays at one entry per attempt).
 *
 * Returns `true` when the entry was enqueued, `false` when the queue cap
 * is full and the entry was dropped (overflow).
 */
export function enqueueDecrement(entry: { token: string; attemptId: string; key: string }): boolean {
  if (!queue.has(entry.attemptId) && queue.size >= QUEUE_DEPTH_CAP) {
    if (!overflowReported) {
      overflowReported = true;
      logger.warn(
        {
          event: 'accreditation.verify.decrement_queue_overflow',
          queue_depth: queue.size,
          token_hash: hashTokenForLogs(entry.token),
        },
        'pending-decrement queue overflow — entry dropped; counter relies on 24h TTL',
      );
    }
    return false;
  }
  overflowReported = false;
  queue.set(entry.attemptId, {
    token: entry.token,
    attemptId: entry.attemptId,
    queuedAt: Date.now(),
    key: entry.key,
  });
  return true;
}

/**
 * Drain pending decrements: for each queued entry, attempt DECR on Redis.
 * On success, remove from queue. On Redis unavailable or per-entry retry
 * failure, leave entries queued for the next cycle.
 *
 * Emits a structured `accreditation.verify.decrement_queue_drain` log per
 * cycle.
 */
export async function drainQueue(): Promise<void> {
  const initialDepth = queue.size;
  if (initialDepth === 0) return;

  const redis = getRedis();
  if (!redis || !isRedisAvailable()) {
    logger.debug(
      {
        event: 'accreditation.verify.decrement_queue_drain',
        queue_depth: queue.size,
        drained: 0,
        skipped_redis_unavailable: true,
      },
      'pending-decrement drain skipped — Redis unavailable',
    );
    return;
  }

  let drained = 0;
  for (const entry of [...queue.values()]) {
    try {
      const after = await redis.decr(entry.key);
      if (after < 0) {
        // Mirror decrementBroadcastAttempts: a parallel deleteToken (success
        // path) may have raced ahead and dropped the key. DEL keeps the
        // namespace clean and matches the "counter scoped to the token's
        // life" invariant.
        await redis.del(entry.key);
      }
      queue.delete(entry.attemptId);
      drained++;
    } catch (err) {
      logger.warn(
        {
          err,
          event: 'accreditation.verify.decrement_queue_retry_failed',
          token_hash: hashTokenForLogs(entry.token),
        },
        'pending-decrement retry failed — entry remains queued for next cycle',
      );
      // Stop draining the rest: if Redis just flipped to unavailable, the
      // remaining entries will fail the same way. Try them on the next cycle.
      break;
    }
  }

  logger.info(
    {
      event: 'accreditation.verify.decrement_queue_drain',
      queue_depth: queue.size,
      drained,
      initial_depth: initialDepth,
    },
    'pending-decrement queue drained',
  );
}

/**
 * Start the periodic drain timer. Idempotent — repeated calls don't
 * stack timers. Drain interval is `config.verifyDecrementQueueDrainMs`.
 *
 * The timer is `unref()`'d so it doesn't keep the process alive on its own
 * (mirrors the `cleanupInterval` pattern in middleware/verifyHiveSignature.ts).
 */
export function startDecrementQueueDrainer(): void {
  if (drainTimer) return;
  drainTimer = setInterval(() => {
    drainQueue().catch((err) => {
      logger.error(
        { err, event: 'accreditation.verify.decrement_queue_drain_threw' },
        'pending-decrement drain cycle threw',
      );
    });
  }, config.verifyDecrementQueueDrainMs);
  drainTimer.unref();
}

export function stopDecrementQueueDrainer(): void {
  if (drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
}

/**
 * Test-only seam. Exposes queue introspection and the drain runner for
 * deterministic test-driven coverage (drain success, Redis-unavailable
 * skip, idempotent enqueue, overflow). NOT for production import.
 */
export const __test_seams = {
  getQueueDepth: () => queue.size,
  hasAttempt: (attemptId: string) => queue.has(attemptId),
  clearQueue: () => {
    queue.clear();
    overflowReported = false;
  },
  drainQueue,
} as const;

/**
 * Coverage for `lib/pending-decrement-queue.ts` — the in-process pending-
 * decrement queue introduced by BE-VERIFY-CAP-REDIS-FLAP-RECOVERY.
 *
 * Carve-out justification (per root CLAUDE.md): the Redis-unavailable drain
 * path is exercised against the real Redis client by toggling
 * `isRedisAvailable` via `vi.spyOn(redisModule, ...)`. No Redis pool / HAF
 * mocking. The real `redis.decr` runs in the success-path drain spec.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { config } from '../../src/config.js';
import { getRedis } from '../../src/redis.js';
import * as redisModule from '../../src/redis.js';
import { logger } from '../../src/logger.js';
import {
  enqueueDecrement,
  __test_seams as queueTestSeams,
} from '../../src/lib/pending-decrement-queue.js';

function counterKey(token: string): string {
  return `${config.appTag}:pending_accred_broadcast_attempts:${token}`;
}

describe('pending-decrement-queue', () => {
  beforeEach(() => {
    queueTestSeams.clearQueue();
  });

  afterEach(() => {
    queueTestSeams.clearQueue();
  });

  it('enqueueDecrement records an entry and returns true', () => {
    const token = `pdq-enq-${crypto.randomBytes(8).toString('hex')}`;
    const attemptId = crypto.randomBytes(8).toString('hex');
    const ok = enqueueDecrement({ token, attemptId, key: counterKey(token) });
    expect(ok).toBe(true);
    expect(queueTestSeams.getQueueDepth()).toBe(1);
    expect(queueTestSeams.hasAttempt(attemptId)).toBe(true);
  });

  it('idempotent on attemptId — duplicate enqueue keeps depth at 1', () => {
    const token = `pdq-idem-${crypto.randomBytes(8).toString('hex')}`;
    const attemptId = crypto.randomBytes(8).toString('hex');
    enqueueDecrement({ token, attemptId, key: counterKey(token) });
    enqueueDecrement({ token, attemptId, key: counterKey(token) });
    enqueueDecrement({ token, attemptId, key: counterKey(token) });
    expect(queueTestSeams.getQueueDepth()).toBe(1);
  });

  it('drainQueue retries DECR on Redis when available; drained entries leave the queue', async () => {
    const redis = getRedis();
    if (!redis) {
      // No Redis configured → drain is a no-op for the Redis-side counter.
      // Skip this spec; the Redis-unavailable behavior is covered separately.
      return;
    }
    const token = `pdq-drain-${crypto.randomBytes(8).toString('hex')}`;
    const key = counterKey(token);
    // Seed the counter at 1 so drain's DECR brings it to 0.
    await redis.set(key, '1');
    const attemptId = crypto.randomBytes(8).toString('hex');
    enqueueDecrement({ token, attemptId, key });
    expect(queueTestSeams.getQueueDepth()).toBe(1);

    await queueTestSeams.drainQueue();

    expect(queueTestSeams.getQueueDepth()).toBe(0);
    expect(await redis.get(key)).toBe('0');
    await redis.del(key);
  });

  it('drainQueue triggers `if (after < 0) DEL` race-recovery — counter pre-deleted by sibling path stays absent', async () => {
    // Mirrors the route's `if (after < 0) redis.del(key)` defensive floor:
    // when a parallel deleteToken raced ahead and dropped the counter
    // before drain ran, the DECR creates the key at -1 and the DEL re-clears
    // it. Removing the DEL leaves "-1" stranded.
    const redis = getRedis();
    if (!redis) return;
    const token = `pdq-race-${crypto.randomBytes(8).toString('hex')}`;
    const key = counterKey(token);
    await redis.del(key);
    expect(await redis.get(key)).toBeNull();

    const attemptId = crypto.randomBytes(8).toString('hex');
    enqueueDecrement({ token, attemptId, key });
    await queueTestSeams.drainQueue();

    expect(await redis.get(key)).toBeNull();
    expect(queueTestSeams.getQueueDepth()).toBe(0);
  });

  it('drainQueue skips when Redis is unavailable; entries remain queued and a debug-level skip is logged', async () => {
    const redis = getRedis();
    if (!redis) return; // Real Redis required to exercise the toggle.
    const token = `pdq-noredis-${crypto.randomBytes(8).toString('hex')}`;
    const attemptId = crypto.randomBytes(8).toString('hex');
    enqueueDecrement({ token, attemptId, key: counterKey(token) });

    const isAvailableSpy = vi.spyOn(redisModule, 'isRedisAvailable').mockReturnValue(false);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger);

    try {
      await queueTestSeams.drainQueue();

      // Entry stays queued — the next drain cycle will retry once Redis
      // recovers. This is the load-bearing fail-open behavior.
      expect(queueTestSeams.getQueueDepth()).toBe(1);
      expect(queueTestSeams.hasAttempt(attemptId)).toBe(true);
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'accred_verify_decrement_queue_drain',
          skipped_redis_unavailable: true,
        }),
        expect.stringContaining('Redis unavailable'),
      );
    } finally {
      isAvailableSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it('drainQueue emits structured drain log with queue_depth + drained on a successful cycle', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `pdq-drainlog-${crypto.randomBytes(8).toString('hex')}`;
    const key = counterKey(token);
    await redis.set(key, '1');
    const attemptId = crypto.randomBytes(8).toString('hex');
    enqueueDecrement({ token, attemptId, key });

    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    try {
      await queueTestSeams.drainQueue();

      // Mutation-sensitive call-shape: a future mutation that drops the
      // queue_depth or drained field silently regresses operator
      // observability of drain cycles.
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'accred_verify_decrement_queue_drain',
          queue_depth: 0,
          drained: 1,
          initial_depth: 1,
        }),
        expect.stringContaining('drained'),
      );
    } finally {
      infoSpy.mockRestore();
      await redis.del(key);
    }
  });

  it('drainQueue stops draining on a per-entry failure and leaves remaining entries queued for the next cycle', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token1 = `pdq-fail1-${crypto.randomBytes(8).toString('hex')}`;
    const token2 = `pdq-fail2-${crypto.randomBytes(8).toString('hex')}`;
    enqueueDecrement({ token: token1, attemptId: 'a1', key: counterKey(token1) });
    enqueueDecrement({ token: token2, attemptId: 'a2', key: counterKey(token2) });

    const decrSpy = vi
      .spyOn(redis, 'decr')
      .mockRejectedValueOnce(new Error('redis flap mid-drain'));
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    try {
      await queueTestSeams.drainQueue();
      // First entry's DECR rejected → drainer warns + stops; both entries
      // remain queued so the next cycle can retry.
      expect(queueTestSeams.getQueueDepth()).toBe(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'accred_verify_decrement_queue_retry_failed',
          token_hash: expect.stringMatching(/^[0-9a-f]{12}$/),
        }),
        expect.stringContaining('retry failed'),
      );
    } finally {
      decrSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('overflow at QUEUE_DEPTH_CAP — 1001st distinct entry is dropped and a single overflow warn fires', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      // Fill to cap.
      for (let i = 0; i < 1000; i++) {
        const ok = enqueueDecrement({ token: `pdq-of-${i}`, attemptId: `aid-${i}`, key: counterKey(`pdq-of-${i}`) });
        expect(ok).toBe(true);
      }
      expect(queueTestSeams.getQueueDepth()).toBe(1000);

      // 1001st distinct entry → dropped.
      const ok = enqueueDecrement({
        token: 'pdq-of-overflow',
        attemptId: 'aid-overflow',
        key: counterKey('pdq-of-overflow'),
      });
      expect(ok).toBe(false);
      expect(queueTestSeams.getQueueDepth()).toBe(1000);

      const overflowCalls = warnSpy.mock.calls.filter(
        ([payload]) =>
          payload != null &&
          typeof payload === 'object' &&
          (payload as Record<string, unknown>).event === 'accred_verify_decrement_queue_overflow',
      );
      expect(overflowCalls.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('VERIFY_DECREMENT_QUEUE_DRAIN_MS env var wires through to config.verifyDecrementQueueDrainMs', async () => {
    const original = process.env.VERIFY_DECREMENT_QUEUE_DRAIN_MS;
    try {
      process.env.VERIFY_DECREMENT_QUEUE_DRAIN_MS = '15000';
      vi.resetModules();
      const fresh = await import('../../src/config.js');
      expect(fresh.config.verifyDecrementQueueDrainMs).toBe(15000);
    } finally {
      if (original === undefined) {
        delete process.env.VERIFY_DECREMENT_QUEUE_DRAIN_MS;
      } else {
        process.env.VERIFY_DECREMENT_QUEUE_DRAIN_MS = original;
      }
      vi.resetModules();
    }
  });
});

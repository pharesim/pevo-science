/**
 * Coverage for `/api/admin/accreditation/reset-broadcast-counter` — the
 * operator manual-reset lever for BE-VERIFY-CAP-REDIS-FLAP-RECOVERY.
 *
 * Carve-out justification (per root CLAUDE.md): `verifyHiveSignature` is
 * mocked via `MOCK_VERIFY_SIGNATURE` so the test can drive both
 * authenticated-but-not-admin and authenticated-and-admin paths
 * deterministically. Real Redis runs underneath — `redis.del` and
 * `redis.get` are NOT mocked in the happy path. The 503-when-Redis-
 * unavailable spec uses `vi.spyOn(redisModule, 'isRedisAvailable')`
 * to simulate the flap; the real client still exists.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { getRedis } from '../../src/redis.js';
import * as redisModule from '../../src/redis.js';
import { logger } from '../../src/logger.js';

const app = createApp();

function counterKey(token: string): string {
  return `${config.appTag}:pending_accred_broadcast_attempts:${token}`;
}

describe('POST /api/admin/accreditation/reset-broadcast-counter', () => {
  let createdKeys: string[] = [];

  beforeEach(() => {
    createdKeys = [];
  });

  afterEach(async () => {
    const redis = getRedis();
    if (redis && createdKeys.length > 0) {
      await redis.del(...createdKeys);
    }
  });

  it('returns 401 without auth headers (no X-Hive-Username)', async () => {
    const res = await request(app)
      .post('/api/admin/accreditation/reset-broadcast-counter')
      .send({ token: 'irrelevant' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 400 when token is missing', async () => {
    const res = await request(app)
      .post('/api/admin/accreditation/reset-broadcast-counter')
      .set('X-Hive-Username', config.hiveAdminAccount)
      .set('X-Hive-Signature', 'mock')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 403 when caller is not the admin account', async () => {
    // 64-hex token so the no-raw-leak assertion below is load-bearing.
    const token = crypto.randomBytes(32).toString('hex');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      const res = await request(app)
        .post('/api/admin/accreditation/reset-broadcast-counter')
        .set('X-Hive-Username', 'not-the-admin')
        .set('X-Hive-Signature', 'mock')
        .send({ token });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      // The forbidden-attempt warn fires with attempted_by + token_hash, not
      // the raw token. Mutation-sensitive: a regression that logs the raw
      // token to operator logs would burn the verification credential for
      // the 24h log-retention window.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'admin_reset_broadcast_counter_forbidden',
          attempted_by: 'not-the-admin',
          token_hash: expect.stringMatching(/^[0-9a-f]{12}$/),
        }),
        expect.stringContaining('rejected'),
      );
      // Filter to the route's structured emissions before stringifying — the
      // overall warnSpy.mock.calls also contains pino-http req/res completion
      // logs whose ServerResponse → IncomingMessage cycle breaks JSON.stringify.
      const routeCalls = warnSpy.mock.calls.filter(
        ([payload]) =>
          payload != null &&
          typeof payload === 'object' &&
          typeof (payload as Record<string, unknown>).event === 'string' &&
          ((payload as Record<string, unknown>).event as string).startsWith('admin_reset_'),
      );
      const flat = JSON.stringify(routeCalls);
      expect(flat).not.toMatch(new RegExp(token));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns 200 + audit log when admin resets a real counter; counter key is deleted; prior value reflects pre-DEL state', async () => {
    const redis = getRedis();
    if (!redis) return; // Real Redis required.

    const token = crypto.randomBytes(32).toString('hex');
    const key = counterKey(token);
    createdKeys.push(key);
    // Seed the counter at 3 (the cap) to simulate a flap-inflated counter.
    await redis.set(key, '3');

    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    try {
      const res = await request(app)
        .post('/api/admin/accreditation/reset-broadcast-counter')
        .set('X-Hive-Username', config.hiveAdminAccount)
        .set('X-Hive-Signature', 'mock')
        .send({ token });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.data.token_hash).toMatch(/^[0-9a-f]{12}$/);
      expect(res.body.data.prior_value).toBe(3);
      // Counter is gone after the reset.
      expect(await redis.get(key)).toBeNull();
      // Audit log fires with admin_username + token_hash + prior_value;
      // a mutation that drops any of those fields silently regresses the
      // operator audit trail.
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'admin_reset_broadcast_counter',
          admin_username: config.hiveAdminAccount,
          token_hash: expect.stringMatching(/^[0-9a-f]{12}$/),
          prior_value: 3,
        }),
        expect.stringContaining('reset broadcast counter'),
      );
      // Filter to the route's structured emission (excluding pino-http
      // req/res completion logs whose circular cycle breaks JSON.stringify).
      const routeCalls = infoSpy.mock.calls.filter(
        ([payload]) =>
          payload != null &&
          typeof payload === 'object' &&
          (payload as Record<string, unknown>).event === 'admin_reset_broadcast_counter',
      );
      const flat = JSON.stringify(routeCalls);
      expect(flat).not.toMatch(new RegExp(token));
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('returns 200 with prior_value=null when the counter key is absent', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = crypto.randomBytes(32).toString('hex');
    // No seed — counter doesn't exist.

    const res = await request(app)
      .post('/api/admin/accreditation/reset-broadcast-counter')
      .set('X-Hive-Username', config.hiveAdminAccount)
      .set('X-Hive-Signature', 'mock')
      .send({ token });

    expect(res.status).toBe(200);
    expect(res.body.data.prior_value).toBeNull();
  });

  it('returns 503 when Redis is unavailable; counter is unchanged', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = crypto.randomBytes(32).toString('hex');
    const key = counterKey(token);
    createdKeys.push(key);
    await redis.set(key, '2');

    const isAvailableSpy = vi.spyOn(redisModule, 'isRedisAvailable').mockReturnValue(false);
    try {
      const res = await request(app)
        .post('/api/admin/accreditation/reset-broadcast-counter')
        .set('X-Hive-Username', config.hiveAdminAccount)
        .set('X-Hive-Signature', 'mock')
        .send({ token });

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.body.error.details).toEqual({ retriable: true });
    } finally {
      isAvailableSpy.mockRestore();
    }

    // Counter unchanged because the reset short-circuited.
    expect(await redis.get(key)).toBe('2');
  });
});

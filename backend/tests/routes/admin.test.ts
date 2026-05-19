/**
 * Coverage for `/api/admin/accreditation/reset-broadcast-counter` — the
 * operator manual-reset lever that clears an inflated broadcast-attempts
 * counter when the in-process pending-decrement queue cannot converge.
 *
 * Carve-out justification (per root CLAUDE.md):
 *
 * (a) Cryptographic signature verification is bypassed by
 *     `MOCK_VERIFY_SIGNATURE`; only the header-presence gate and the
 *     username-extraction behavior are exercised by the mock. The focus of
 *     this file is the admin-equality check, counter-reset logic
 *     (`redis.getdel` atomicity, `prior_value` propagation), 503/500
 *     branching on Redis state, and the operator audit log — NOT the Hive
 *     signature algorithm. Driving both authenticated-but-not-admin and
 *     authenticated-and-admin paths against real signed requests would
 *     require per-test keypairs without exercising any algorithm code that
 *     isn't already covered elsewhere.
 *
 *     Real Redis runs underneath: `redis.getdel`, `redis.set`, `redis.get`
 *     all hit the real client on the happy and absent-key paths. The 503
 *     Redis-unavailable spec uses `vi.spyOn(redisModule, 'isRedisAvailable')`
 *     to simulate the flap; the real client still exists. The 500 spec
 *     stubs `redis.getdel` to reject for that one call, then restores.
 *
 * (c) The real-path companion that exercises `verifyHiveSignature` with
 *     genuine Hive-signed requests lives at
 *     `backend/tests/middleware/verifyHiveSignature-authmethod.test.ts`
 *     (both branches of the middleware: Keychain-shaped signatures and
 *     JWT-shaped session tokens). That suite covers the cryptographic
 *     verification risk class so this file's `MOCK_VERIFY_SIGNATURE`
 *     bypass cannot hide a regression in signature checking from the
 *     codebase as a whole.
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
import { broadcastAttemptsKey } from '../../src/routes/accreditation.js';

const app = createApp();

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
          event: 'accreditation.admin.reset_broadcast_counter_forbidden',
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
          ((payload as Record<string, unknown>).event as string).startsWith(
            'accreditation.admin.reset_broadcast_counter',
          ),
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
    const key = broadcastAttemptsKey(token);
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
          event: 'accreditation.admin.reset_broadcast_counter',
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
          (payload as Record<string, unknown>).event ===
            'accreditation.admin.reset_broadcast_counter',
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

  it('returns 503 + Retry-After: 30 when Redis is unavailable; counter is unchanged', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = crypto.randomBytes(32).toString('hex');
    const key = broadcastAttemptsKey(token);
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
      // SPAs read `retry-after` to schedule backoff; sibling /verify 503
      // paths pair retriable:true with Retry-After: 30 and this endpoint
      // must match. Header is lowercased by supertest.
      expect(res.headers['retry-after']).toBe('30');
    } finally {
      isAvailableSpy.mockRestore();
    }

    // Counter unchanged because the reset short-circuited.
    expect(await redis.get(key)).toBe('2');
  });

  it('returns 500 + INTERNAL_ERROR when redis.getdel rejects mid-reset; structured failure log fires', async () => {
    // The 500 branch is reachable in production via ioredis reconnect
    // landing during the operation window (Redis evicted to read-only,
    // transient connection drop). A regression that swallows the error
    // and returns 200 with stale `prior_value` would silently mislead the
    // operator audit log.
    const redis = getRedis();
    if (!redis) return;
    const token = crypto.randomBytes(32).toString('hex');

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const getdelSpy = vi
      .spyOn(redis, 'getdel')
      .mockRejectedValueOnce(new Error('redis flap mid-reset'));

    try {
      const res = await request(app)
        .post('/api/admin/accreditation/reset-broadcast-counter')
        .set('X-Hive-Username', config.hiveAdminAccount)
        .set('X-Hive-Signature', 'mock')
        .send({ token });

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      // Failure log pins the structured discriminator so an operator
      // dashboard filter on the route's failure event continues to match.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'accreditation.admin.reset_broadcast_counter_failed',
          admin_username: config.hiveAdminAccount,
          token_hash: expect.stringMatching(/^[0-9a-f]{12}$/),
        }),
        expect.stringContaining('failed'),
      );
    } finally {
      getdelSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

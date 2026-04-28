/**
 * Route-level integration coverage for the argon2-semaphore → HTTP-response
 * translation contract on `POST /api/custody/upgrade` (custody.ts:168).
 *
 * See `auth-argon-error-translation.test.ts` for the full carve-out
 * justification (a/b/c). This file exercises the same three-class
 * translation contract on the custody-upgrade route.
 *
 * `verifyHiveSignature` is NOT mocked. The route requires authentication,
 * which we satisfy via a legitimate Bearer JWT signed with
 * `config.sessionSecret` (the middleware's first authentication path,
 * verifyHiveSignature.ts:79). This is the same JWT issued by the real
 * `/api/auth/login` and `/api/auth/session` routes — there is no test-only
 * shortcut and no mock injection of the middleware itself.
 *
 * `getAppPool()` IS mocked so the row the route reads has `custody = 'light'`,
 * `password_hash` non-null, and `upgraded_at = null` deterministically (the
 * three guards the handler walks before reaching `runWithArgon2Slot` at
 * custody.ts:210). Per-IP rate limiter (`upgradeLimiter`, max=1/hr keyed by
 * account) is bypassed by using a unique `username` per test, which keys the
 * limiter to a fresh bucket each call.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const {
  MockArgonSemaphoreError,
  MockArgonQueueFullError,
  MockShuttingDownError,
  MockArgonAbortError,
  MockRunWithArgon2Slot,
} = vi.hoisted(() => {
  abstract class ArgonSemaphoreError extends Error {}
  class ArgonQueueFullError extends ArgonSemaphoreError {
    constructor(message = 'argon2 semaphore queue full') {
      super(message);
      this.name = 'ArgonQueueFullError';
    }
  }
  class ShuttingDownError extends ArgonSemaphoreError {
    constructor(message = 'argon2 semaphore shutting down') {
      super(message);
      this.name = 'ShuttingDownError';
    }
  }
  class ArgonAbortError extends ArgonSemaphoreError {
    constructor(message = 'argon2 slot aborted') {
      super(message);
      this.name = 'AbortError';
    }
  }
  return {
    MockArgonSemaphoreError: ArgonSemaphoreError,
    MockArgonQueueFullError: ArgonQueueFullError,
    MockShuttingDownError: ShuttingDownError,
    MockArgonAbortError: ArgonAbortError,
    MockRunWithArgon2Slot: vi.fn(),
  };
});

vi.mock('../../src/lib/argon2-semaphore.js', () => ({
  runWithArgon2Slot: MockRunWithArgon2Slot,
  ArgonSemaphoreError: MockArgonSemaphoreError,
  ArgonQueueFullError: MockArgonQueueFullError,
  ShuttingDownError: MockShuttingDownError,
  ArgonAbortError: MockArgonAbortError,
  MAX_CONCURRENT_ARGON2_OPS: 4,
  MAX_QUEUE_DEPTH: 50,
  getArgon2QueueDepth: () => 0,
  getArgon2InFlight: () => 0,
  drainArgon2Queue: () => {},
}));

const appQueryMock = vi.fn();

vi.mock('../../src/app-db.js', () => ({
  getAppPool: () => ({ query: appQueryMock }),
}));

vi.mock('../../src/db.js', () => ({
  getPool: () => null,
  isHafAvailable: () => false,
  closeHafPool: async () => {},
}));

vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
}));

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { SERVICE_UNAVAILABLE_MESSAGE } = await import('../../src/lib/argon2-error-handler.js');

const app = createApp();

// Mint a real Bearer JWT for the given username with `custody: 'light'` so
// the upgrade route's `if (custody !== 'light')` guard passes. Each test
// uses a unique username so the per-account upgradeLimiter (max=1/hr) does
// not poison subsequent tests in the same run.
function authHeader(username: string): string {
  const token = jwt.sign({ sub: username, custody: 'light' }, config.sessionSecret, { expiresIn: '5m' });
  return `Bearer ${token}`;
}

// Seeds the account row + the optional sessions-invalidation lookup the
// middleware performs on Bearer-authed requests. The middleware's
// `SELECT sessions_invalidated_at FROM accounts WHERE username = $1` runs
// FIRST (verifyHiveSignature.ts:91), then the route's own SELECT runs.
function seedUpgradeAccount() {
  // 1. Middleware session-invalidation lookup (no invalidation marker).
  appQueryMock.mockResolvedValueOnce({ rows: [{ sessions_invalidated_at: null }] });
  // 2. Route's own account lookup with the three guards passed.
  appQueryMock.mockResolvedValueOnce({
    rows: [{
      password_hash: '$argon2id$placeholder',
      posting_key_enc: Buffer.from('placeholder'),
      upgraded_at: null,
    }],
  });
}

describe('POST /api/custody/upgrade — argon2 error → HTTP translation', () => {
  it('ArgonQueueFullError → 503 SERVICE_UNAVAILABLE + Retry-After: 5 + generic body', async () => {
    appQueryMock.mockReset();
    seedUpgradeAccount();
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockArgonQueueFullError());

    const res = await request(app)
      .post('/api/custody/upgrade')
      .set('Authorization', authHeader('upgrade-queuefull'))
      .send({ password: 'AnyPassword1' });

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error?.message).toBe(SERVICE_UNAVAILABLE_MESSAGE);
    expect(res.headers['retry-after']).toBe('5');
  });

  it('ShuttingDownError → 503 SERVICE_UNAVAILABLE + Retry-After: 30 + generic body', async () => {
    appQueryMock.mockReset();
    seedUpgradeAccount();
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockShuttingDownError());

    const res = await request(app)
      .post('/api/custody/upgrade')
      .set('Authorization', authHeader('upgrade-shutdown'))
      .send({ password: 'AnyPassword1' });

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error?.message).toBe(SERVICE_UNAVAILABLE_MESSAGE);
    expect(res.headers['retry-after']).toBe('30');
  });

  it('ArgonAbortError → silent (no response written, request hangs until socket close)', async () => {
    appQueryMock.mockReset();
    seedUpgradeAccount();
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockArgonAbortError());

    let outcome: 'response' | 'timeout' | 'other-error';
    try {
      await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', authHeader('upgrade-abort'))
        .send({ password: 'AnyPassword1' })
        .timeout({ deadline: 250 });
      outcome = 'response';
    } catch (err) {
      const e = err as { code?: string; timeout?: number; message?: string };
      if (e.code === 'ECONNABORTED' || typeof e.timeout === 'number' || /Timeout/i.test(e.message ?? '')) {
        outcome = 'timeout';
      } else {
        outcome = 'other-error';
      }
    }
    expect(outcome).toBe('timeout');
  });
});

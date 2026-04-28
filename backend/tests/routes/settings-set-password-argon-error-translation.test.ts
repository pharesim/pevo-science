/**
 * Route-level integration coverage for the argon2-semaphore → HTTP-response
 * translation contract on `POST /api/settings/set-password` (settings.ts:342).
 *
 * See `auth-argon-error-translation.test.ts` for the full carve-out
 * justification (a/b/c). This file exercises the same three-class
 * translation contract on the set-password route, which lives in a
 * separate router file (settings.ts) and was not previously covered by any
 * route-level test for the argon2-error path.
 *
 * `verifyHiveSignature` is NOT mocked. The route requires authentication;
 * we satisfy it via a legitimate Bearer JWT signed with `config.sessionSecret`.
 *
 * `getAppPool()` IS mocked so the row the route reads has `password_hash =
 * NULL` AND `orcid` non-null (the two preconditions for set-password
 * eligibility) — set-password is restricted to ORCID-verified accounts that
 * have not yet opted into password login. With both guards passed, the
 * handler reaches `runWithArgon2Slot(hash)` at settings.ts:388 and the
 * mocked semaphore throws.
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
const { SERVICE_UNAVAILABLE_MESSAGE } = await import('../../src/lib/argon-error-handler.js');

const app = createApp();

function authHeader(username: string): string {
  const token = jwt.sign({ sub: username, custody: 'self' }, config.sessionSecret, { expiresIn: '5m' });
  return `Bearer ${token}`;
}

// Seeds: middleware session-invalidation lookup, then the route's own
// SELECT. The set-password row needs `password_hash = NULL` AND `orcid`
// non-null so both eligibility guards (settings.ts:365 and :379) pass and
// the handler reaches runWithArgon2Slot.
function seedSetPasswordAccount() {
  appQueryMock.mockResolvedValueOnce({ rows: [{ sessions_invalidated_at: null }] });
  appQueryMock.mockResolvedValueOnce({
    rows: [{ id: 1, password_hash: null, orcid: '0000-0000-0000-0000' }],
  });
}

const ROUTE_BODY = { password: 'AnyPassword1' };

describe('POST /api/settings/set-password — argon2 error → HTTP translation', () => {
  it('ArgonQueueFullError → 503 SERVICE_UNAVAILABLE + Retry-After: 5 + generic body', async () => {
    appQueryMock.mockReset();
    seedSetPasswordAccount();
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockArgonQueueFullError());

    const res = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', authHeader('setpw-queuefull'))
      .send(ROUTE_BODY);

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error?.message).toBe(SERVICE_UNAVAILABLE_MESSAGE);
    expect(res.headers['retry-after']).toBe('5');
  });

  it('ShuttingDownError → 503 SERVICE_UNAVAILABLE + Retry-After: 30 + generic body', async () => {
    appQueryMock.mockReset();
    seedSetPasswordAccount();
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockShuttingDownError());

    const res = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', authHeader('setpw-shutdown'))
      .send(ROUTE_BODY);

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error?.message).toBe(SERVICE_UNAVAILABLE_MESSAGE);
    expect(res.headers['retry-after']).toBe('30');
  });

  it('ArgonAbortError → silent (no response written, request hangs until socket close)', async () => {
    appQueryMock.mockReset();
    seedSetPasswordAccount();
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockArgonAbortError());

    let outcome: 'response' | 'timeout' | 'other-error';
    try {
      await request(app)
        .post('/api/settings/set-password')
        .set('Authorization', authHeader('setpw-abort'))
        .send(ROUTE_BODY)
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

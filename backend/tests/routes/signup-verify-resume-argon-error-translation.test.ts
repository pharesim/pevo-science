/**
 * Route-level integration coverage for the argon2-semaphore → HTTP-response
 * translation contract on `POST /api/auth/resume-signup` (signup-verify.ts).
 *
 * See `auth-argon-error-translation.test.ts` for the full carve-out
 * justification (a/b/c). This file exercises the same three-class
 * translation contract on the resume-signup route, which lives in a
 * separate router file (signup-verify.ts) and was not previously covered
 * by any route-level test.
 *
 * `verifyHiveSignature` is NOT mocked. `/resume-signup` is unauthenticated
 * (the resume flow authenticates via email + password inside the handler),
 * so the middleware does not apply and there is nothing to mock.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

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
const { SERVICE_UNAVAILABLE_MESSAGE } = await import('../../src/lib/argon2-error-handler.js');

const app = createApp();

// Drives the route past every pre-argon2 guard (email present, password
// present, row exists, verify_token starts with 'confirmed:', password_hash
// non-null) so the handler reaches `runWithArgon2Slot(verify)` at
// signup-verify.ts:146 and the mocked semaphore throws.
function seedConfirmedRow() {
  appQueryMock.mockResolvedValueOnce({
    rows: [{
      id: 1,
      password_hash: '$argon2id$placeholder',
      verify_token: 'confirmed:abc',
    }],
  });
}

const ROUTE_BODY = { email: 'resume@mit.edu', password: 'AnyPassword1' };

describe('POST /api/auth/resume-signup — argon2 error → HTTP translation', () => {
  it('ArgonQueueFullError → 503 SERVICE_UNAVAILABLE + Retry-After: 5 + generic body', async () => {
    appQueryMock.mockReset();
    seedConfirmedRow();
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockArgonQueueFullError());

    const res = await request(app).post('/api/auth/resume-signup').send(ROUTE_BODY);

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error?.message).toBe(SERVICE_UNAVAILABLE_MESSAGE);
    expect(res.headers['retry-after']).toBe('5');
  });

  it('ShuttingDownError → 503 SERVICE_UNAVAILABLE + Retry-After: 30 + generic body', async () => {
    appQueryMock.mockReset();
    seedConfirmedRow();
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockShuttingDownError());

    const res = await request(app).post('/api/auth/resume-signup').send(ROUTE_BODY);

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error?.message).toBe(SERVICE_UNAVAILABLE_MESSAGE);
    expect(res.headers['retry-after']).toBe('30');
  });

  it('ArgonAbortError → silent (no response written, request hangs until socket close)', async () => {
    appQueryMock.mockReset();
    seedConfirmedRow();
    MockRunWithArgon2Slot.mockReset();
    MockRunWithArgon2Slot.mockRejectedValueOnce(new MockArgonAbortError());

    let outcome: 'response' | 'timeout' | 'other-error';
    try {
      await request(app)
        .post('/api/auth/resume-signup')
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

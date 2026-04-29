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

import { describe, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {
  assertArgon2AbortIsSilent,
  assert503QueueFull,
  assert503Shutdown,
} from '../support/argon2-error-mocks.js';

// See `auth-argon-error-translation.test.ts` for the hoist-pattern
// rationale.
const { mockRunWithArgon2Slot, argon2SemaphoreMockFactory } = await vi.hoisted(
  async () =>
    (await import('../support/argon2-error-mocks.js')).buildArgon2RouteMockKit(),
);

const { dbStubFactory, redisStubFactory } = await import(
  '../support/argon2-error-mocks.js'
);

const appQueryMock = vi.fn();

vi.mock('../../src/app-db.js', () => ({
  getAppPool: () => ({ query: appQueryMock }),
}));

vi.mock('../../src/lib/argon2-semaphore.js', () => argon2SemaphoreMockFactory());
vi.mock('../../src/db.js', () => dbStubFactory());
vi.mock('../../src/redis.js', () => redisStubFactory());

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const {
  ArgonQueueFullError,
  ShuttingDownError,
  ArgonAbortError,
} = await import('../../src/lib/argon2-semaphore.js');

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
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonQueueFullError());

    const res = await request(app)
      .post('/api/custody/upgrade')
      .set('Authorization', authHeader('upgrade-queuefull'))
      .send({ password: 'AnyPassword1' });

    assert503QueueFull(res);
  });

  it('ShuttingDownError → 503 SERVICE_UNAVAILABLE + Retry-After: 30 + generic body', async () => {
    appQueryMock.mockReset();
    seedUpgradeAccount();
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ShuttingDownError());

    const res = await request(app)
      .post('/api/custody/upgrade')
      .set('Authorization', authHeader('upgrade-shutdown'))
      .send({ password: 'AnyPassword1' });

    assert503Shutdown(res);
  });

  it('ArgonAbortError → silent (no response written, request hangs until socket close)', async () => {
    appQueryMock.mockReset();
    seedUpgradeAccount();
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonAbortError());

    const reqPromise = request(app)
      .post('/api/custody/upgrade')
      .set('Authorization', authHeader('upgrade-abort'))
      .send({ password: 'AnyPassword1' })
      .timeout({ deadline: 250 });

    await assertArgon2AbortIsSilent(reqPromise, mockRunWithArgon2Slot);
  });
});

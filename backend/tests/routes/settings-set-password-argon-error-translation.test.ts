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
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonQueueFullError());

    const res = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', authHeader('setpw-queuefull'))
      .send(ROUTE_BODY);

    assert503QueueFull(res);
  });

  it('ShuttingDownError → 503 SERVICE_UNAVAILABLE + Retry-After: 30 + generic body', async () => {
    appQueryMock.mockReset();
    seedSetPasswordAccount();
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ShuttingDownError());

    const res = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', authHeader('setpw-shutdown'))
      .send(ROUTE_BODY);

    assert503Shutdown(res);
  });

  it('ArgonAbortError → silent (no response written, request hangs until socket close)', async () => {
    appQueryMock.mockReset();
    seedSetPasswordAccount();
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonAbortError());

    const reqPromise = request(app)
      .post('/api/settings/set-password')
      .set('Authorization', authHeader('setpw-abort'))
      .send(ROUTE_BODY)
      .timeout({ deadline: 250 });

    await assertArgon2AbortIsSilent(reqPromise);
  });
});

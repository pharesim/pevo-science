/**
 * Route-level integration coverage for the argon2-semaphore → HTTP-response
 * translation contract on `POST /api/auth/signup` — specifically the
 * new-email (non-duplicate) branch at auth.ts:441 which calls
 * `runWithArgon2Slot(() => argon2.hash(password, ARGON2_OPTIONS))` directly.
 *
 * Companion to `auth-signup-dup-saturated.test.ts` (which covers the
 * dup-email burn `.catch()` rethrow at auth.ts:401/407 under
 * `ArgonQueueFullError` / `ShuttingDownError`). This file closes the
 * symmetric coverage gap called out as item 1 of the architect hold block:
 *   - The new-email argon2.hash branch was uncovered for ALL THREE error
 *     classes.
 *   - `ArgonAbortError` on `/signup` was uncovered for ANY branch (the
 *     dup-saturated file covers only queue-full + shutdown on the dup
 *     branch).
 * Together with the dup-saturated tests, /signup now has end-to-end
 * coverage for every {branch × error class} cell in its argon2 site
 * matrix. A mutation that drops the rethrow from one site reopens the
 * timing/status-code oracle along the dup-vs-new axis.
 *
 * ── vi.mock carve-out justification ──
 *
 * Same as `auth-argon-error-translation.test.ts` (see that file's header
 * for the (a)/(b)/(c) clauses). `verifyHiveSignature` is NOT mocked
 * because `/signup` is unauthenticated. `getAppPool()` is mocked so the
 * dup-email lookup returns empty rows (driving the route past the
 * dup-email branches and through the accreditation gate to the new-email
 * argon2.hash call). `redis.js` is stubbed to no-redis so the in-memory
 * rate limiter and replay cache fallbacks engage (the per-IP signup
 * limiter would otherwise need Redis state cleanup between tests).
 */

import { describe, it, vi } from 'vitest';
import request from 'supertest';
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
const {
  ArgonQueueFullError,
  ShuttingDownError,
  ArgonAbortError,
} = await import('../../src/lib/argon2-semaphore.js');

const app = createApp();

// Seed for the new-email branch: the dup-email lookup returns NO rows so
// the handler skips the dup-burn and reaches the accreditation gate. The
// MIT institutional-email branch passes the gate and the route proceeds
// to the argon2.hash call at auth.ts:441 (the site under test).
function seedNewEmailRow(): void {
  appQueryMock.mockResolvedValueOnce({ rows: [] });
}

// Each test uses a unique email (and therefore unique IP-keyed limiter
// bucket effectively, given the in-memory limiter's default 10/hr per IP
// is not exhausted by 3 sequential test runs).
const SIGNUP_BODY = (emailLocal: string) => ({
  email: `${emailLocal}@mit.edu`,
  password: 'AnyPassword1',
  full_name: 'Test User',
  institution: 'MIT',
  field: 'CS',
});

describe('POST /api/auth/signup — new-email argon error → HTTP translation (auth.ts:441)', () => {
  it('ArgonQueueFullError → 503 SERVICE_UNAVAILABLE + Retry-After: 5 + generic body', async () => {
    appQueryMock.mockReset();
    seedNewEmailRow();
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonQueueFullError());

    const res = await request(app)
      .post('/api/auth/signup')
      .send(SIGNUP_BODY('signup-newemail-queuefull'));

    assert503QueueFull(res);
  });

  it('ShuttingDownError → 503 SERVICE_UNAVAILABLE + Retry-After: 30 + generic body', async () => {
    appQueryMock.mockReset();
    seedNewEmailRow();
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ShuttingDownError());

    const res = await request(app)
      .post('/api/auth/signup')
      .send(SIGNUP_BODY('signup-newemail-shutdown'));

    assert503Shutdown(res);
  });

  it('ArgonAbortError → silent (no response written, request hangs until socket close)', async () => {
    appQueryMock.mockReset();
    seedNewEmailRow();
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonAbortError());

    const reqPromise = request(app)
      .post('/api/auth/signup')
      .send(SIGNUP_BODY('signup-newemail-abort'))
      .timeout({ deadline: 250 });

    await assertArgon2AbortIsSilent(reqPromise);
  });
});

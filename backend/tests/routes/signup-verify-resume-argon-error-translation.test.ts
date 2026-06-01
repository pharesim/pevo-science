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
 *
 * SYMMETRIC BRANCH COVERAGE (item 1 of the architect hold block):
 * `/resume-signup` has FOUR argon2 sites (signup-verify.ts):
 *   - :119 — burnSentinel on unknown-email (rows empty).
 *   - :130 — burnSentinel on non-confirmed verify_token (lifecycle other
 *     than 'confirmed:').
 *   - :140 — burnSentinel on confirmed-but-no-password_hash (ORCID-only).
 *   - :146 — direct runWithArgon2Slot(verify) on the confirmed +
 *     password_hash branch.
 * Per timing-equalization-sub-branch-oracles convention, all four MUST
 * collapse to identical wire output under saturation/shutdown/abort. A
 * mutation that drops the rethrow from one site reopens the lifecycle-
 * state oracle along the status-code axis. All four cases run
 * unconditionally (no `if (res.status === 200)` guards).
 */

import { describe, it, vi } from 'vitest';
import request from 'supertest';
// See `auth-argon-error-translation.test.ts` for the hoist-pattern
// rationale (vi.mock factories cannot reference module-scope imports;
// vi.hoisted dynamic-import is the only path to the shared support
// module's `buildArgon2RouteMockKit`). Assertion helpers are pre-bound on
// the kit (kit-bind task).
const {
  mockRunWithArgon2Slot,
  argon2SemaphoreMockFactory,
  assertArgon2AbortIsSilent,
  assert503QueueFull,
  assert503Shutdown,
} = await vi.hoisted(
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

const ROUTE_BODY = { email: 'resume@mit.edu', password: 'AnyPassword1' };

// Per-branch seed for each of the four argon2 sites.
type BranchCase = {
  name: string;
  seed: () => void;
};

const branches: BranchCase[] = [
  {
    name: 'unknown-email branch (burnSentinel)',
    seed: () => appQueryMock.mockResolvedValueOnce({ rows: [] }),
  },
  {
    name: 'non-confirmed verify_token branch (burnSentinel)',
    seed: () =>
      appQueryMock.mockResolvedValueOnce({
        // verify_token does NOT start with 'confirmed:' → non-confirmed guard fires.
        rows: [{ id: 1, password_hash: '$argon2id$placeholder', verify_token: 'pending-abc' }],
      }),
  },
  {
    name: 'confirmed-but-no-password_hash branch (burnSentinel)',
    seed: () =>
      appQueryMock.mockResolvedValueOnce({
        // ORCID-only: confirmed verify_token but password_hash is null.
        rows: [{ id: 1, password_hash: null, verify_token: 'confirmed:abc' }],
      }),
  },
  {
    name: 'confirmed + password_hash branch (`/resume-signup` handler in signup-verify.ts, runWithArgon2Slot)',
    seed: () =>
      appQueryMock.mockResolvedValueOnce({
        rows: [{ id: 1, password_hash: '$argon2id$placeholder', verify_token: 'confirmed:abc' }],
      }),
  },
];

// Per-IP rate limiter on /resume-signup is `signup-resume`, max=5/hr keyed by
// req.ip. The 4 branches × 3 tests = 12 calls per file run, well above the
// 5/hr cap. Each test uses a unique synthetic X-Forwarded-For so the
// limiter sees a fresh bucket per call. The Express `trust proxy = 1`
// setting in app.ts is what makes XFF resolve to req.ip.
let xffCounter = 0;
function nextIp(): string {
  xffCounter += 1;
  return `10.0.${Math.floor(xffCounter / 256)}.${xffCounter % 256}`;
}

describe.each(branches)(
  'POST /api/auth/resume-signup — argon error → HTTP translation: $name',
  (branch) => {
    it('ArgonQueueFullError → 503 SERVICE_UNAVAILABLE + Retry-After: 5 + generic body', async () => {
      appQueryMock.mockReset();
      branch.seed();
      mockRunWithArgon2Slot.mockReset();
      mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonQueueFullError());

      const res = await request(app)
        .post('/api/auth/resume-signup')
        .set('X-Forwarded-For', nextIp())
        .send(ROUTE_BODY);

      assert503QueueFull(res);
    });

    it('ShuttingDownError → 503 SERVICE_UNAVAILABLE + Retry-After: 30 + generic body', async () => {
      appQueryMock.mockReset();
      branch.seed();
      mockRunWithArgon2Slot.mockReset();
      mockRunWithArgon2Slot.mockRejectedValueOnce(new ShuttingDownError());

      const res = await request(app)
        .post('/api/auth/resume-signup')
        .set('X-Forwarded-For', nextIp())
        .send(ROUTE_BODY);

      assert503Shutdown(res);
    });

    it('ArgonAbortError → silent (no response written, request hangs until socket close)', async () => {
      appQueryMock.mockReset();
      branch.seed();
      mockRunWithArgon2Slot.mockReset();
      mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonAbortError());

      const reqPromise = request(app)
        .post('/api/auth/resume-signup')
        .set('X-Forwarded-For', nextIp())
        .send(ROUTE_BODY)
        .timeout({ deadline: 250 });

      await assertArgon2AbortIsSilent(reqPromise);
    });
  },
);

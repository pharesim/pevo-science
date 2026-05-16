/**
 * Route-level integration coverage for the argon2-semaphore → HTTP-response
 * translation contract on `POST /api/custody/session-auth` (custody.ts).
 *
 * Pins convention `route-level-error-class-coverage-after-helper-extraction-
 * 2026-04-29.md`: the new mint route's catch chain propagates three argon2
 * error subclasses (`ArgonQueueFullError` / `ShuttingDownError` /
 * `ArgonAbortError`) via `handleArgonError`. The library-level handler tests
 * (`tests/lib/argon2-error-handler.test.ts`) lock the translation contract
 * against a mocked Express response; this file locks it end-to-end through
 * routing + middleware + body parsing + header serialization.
 *
 * See `auth-argon-error-translation.test.ts` for the full carve-out
 * justification (a/b/c). This file exercises the same three-class
 * translation contract on the new session-auth route which has its own
 * password-verify argon2 site at custody.ts (the `runWithArgon2Slot` call
 * inside the try-block).
 *
 * ── vi.mock carve-out justification (per root CLAUDE.md "Running Tests") ──
 *
 * (a) IMPRACTICALITY OF REAL QUEUE-SATURATION: identical to
 *     `auth-argon-error-translation.test.ts` and
 *     `settings-set-password-argon-error-translation.test.ts`. The
 *     `runWithArgon2Slot` mock throws the three error subclasses
 *     synchronously rather than saturating the real MAX_QUEUE_DEPTH=50
 *     queue or triggering the irreversible singleton drain. `getAppPool()`
 *     is mocked so we seed an `accounts` row deterministically (the
 *     route's middleware-then-handler reads it twice: once for the
 *     `sessions_invalidated_at` check by verifyHiveSignature, once for
 *     the `password_hash` + `upgraded_at` columns inside the handler).
 *
 * (b) `verifyHiveSignature` is NOT mocked. The route requires a real JWT
 *     with `custody: 'light'` to pass the auth gate; we satisfy it via
 *     `jwt.sign` with the real `config.sessionSecret`. The middleware's
 *     session-invalidation lookup hits the appQueryMock seeded below.
 *
 * (c) REAL-PATH COMPANION: `custody-session-auth.test.ts` exercises the
 *     same route against real argon2 + real Postgres + real Redis with
 *     happy-path / wrong-password / null-hash / custody-gate / kind-
 *     isolation branches. The full integrated mint path (including the
 *     route's catch chain reaching `handleArgonError` on a real argon2
 *     abort) is observed there; this file complements that coverage by
 *     pinning the three injectable error subclasses the real path cannot
 *     trigger deterministically.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
// See `auth-argon-error-translation.test.ts` for the hoist-pattern
// rationale. Assertion helpers are pre-bound on the kit (kit-bind task).
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

// Mock the chain-broadcast surface. The session-auth route does NOT
// broadcast (it only mints a fresh-auth proof and returns), but the
// custody router imports `broadcastSendOperationsWithTimeout` at module
// load time. Keeping the hive.js mock here ensures (a) the import graph
// resolves cleanly under the argon2-semaphore mock above, and (b) the
// `sendOperationsMock` assertion below has a deterministic handle to
// confirm the route's argon-error catch path did NOT fall through to a
// broadcast (which would indicate the catch missed an error subclass).
const { sendOperationsMock } = vi.hoisted(() => ({
  sendOperationsMock: vi.fn(),
}));
vi.mock('../../src/hive.js', async () => {
  const { MockBroadcastTimeoutError } = await import('../support/broadcast-mocks.js');
  return {
    hiveClient: {
      database: { getAccounts: vi.fn().mockResolvedValue([]) },
      broadcast: { sendOperations: (...args: unknown[]) => sendOperationsMock(...args) },
    },
    broadcastSendOperationsWithTimeout: (...args: unknown[]) => sendOperationsMock(...args),
    BroadcastTimeoutError: MockBroadcastTimeoutError,
    DEFAULT_BROADCAST_TIMEOUT_MS: 30_000,
  };
});

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const {
  ArgonQueueFullError,
  ShuttingDownError,
  ArgonAbortError,
} = await import('../../src/lib/argon2-semaphore.js');

const app = createApp();

function authHeader(username: string): string {
  const token = jwt.sign({ sub: username, custody: 'light' }, config.sessionSecret, { expiresIn: '5m' });
  return `Bearer ${token}`;
}

// Seeds the two row reads the route + middleware do before hitting argon2:
//   1. verifyHiveSignature → SELECT sessions_invalidated_at FROM accounts ...
//      (returns null so the JWT remains valid).
//   2. /session-auth handler → SELECT password_hash, upgraded_at FROM accounts ...
//      (returns a non-null password_hash so the route reaches
//      `runWithArgon2Slot(argon2.verify(...))` instead of falling into the
//      null-hash branch which would burn a sentinel and short-circuit
//      before the mocked `runWithArgon2Slot` can throw the injected error).
function seedSessionAuthAccount() {
  appQueryMock.mockResolvedValueOnce({ rows: [{ sessions_invalidated_at: null }] });
  appQueryMock.mockResolvedValueOnce({
    rows: [{ password_hash: '$argon2id$placeholder', upgraded_at: null }],
  });
}

describe('POST /api/custody/session-auth — argon2 error → HTTP translation', () => {
  it('ArgonQueueFullError → 503 SERVICE_UNAVAILABLE + Retry-After: 5 + generic body', async () => {
    appQueryMock.mockReset();
    seedSessionAuthAccount();
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonQueueFullError());
    sendOperationsMock.mockReset();

    const res = await request(app)
      .post('/api/custody/session-auth')
      .set('Authorization', authHeader('sa-queuefull'))
      .send({ password: 'AnyPassword1' });

    assert503QueueFull(res);
    // The route's catch chain handled the argon error cleanly; the broadcast
    // surface (cross-imported in the router) MUST NOT have been invoked. A
    // mutation that fell through past `handleArgonError` could in principle
    // reach unintended code paths; this assertion pins the catch's scope.
    expect(sendOperationsMock).not.toHaveBeenCalled();
  });

  it('ShuttingDownError → 503 SERVICE_UNAVAILABLE + Retry-After: 30 + generic body', async () => {
    appQueryMock.mockReset();
    seedSessionAuthAccount();
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ShuttingDownError());
    sendOperationsMock.mockReset();

    const res = await request(app)
      .post('/api/custody/session-auth')
      .set('Authorization', authHeader('sa-shutdown'))
      .send({ password: 'AnyPassword1' });

    assert503Shutdown(res);
    expect(sendOperationsMock).not.toHaveBeenCalled();
  });

  it('ArgonAbortError → silent (no response written, request hangs until socket close)', async () => {
    appQueryMock.mockReset();
    seedSessionAuthAccount();
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonAbortError());
    sendOperationsMock.mockReset();

    const reqPromise = request(app)
      .post('/api/custody/session-auth')
      .set('Authorization', authHeader('sa-abort'))
      .send({ password: 'AnyPassword1' })
      .timeout({ deadline: 250 });

    await assertArgon2AbortIsSilent(reqPromise);
    expect(sendOperationsMock).not.toHaveBeenCalled();
  });
});

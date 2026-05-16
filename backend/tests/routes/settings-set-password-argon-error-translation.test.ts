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
 * ── vi.mock carve-out justification (per root CLAUDE.md "Running Tests"
 * + `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`) ──
 *
 * (a) IMPRACTICALITY OF REAL ARGON2 SATURATION + REAL REDIS:
 *     - `runWithArgon2Slot` mock throws `ArgonQueueFullError` /
 *       `ShuttingDownError` / `ArgonAbortError` synchronously rather than
 *       requiring 50 concurrent stuck argon2 hashes (MAX_QUEUE_DEPTH=50)
 *       AND a real SIGTERM-drain mid-test (which would poison every
 *       subsequent test in the same Vitest worker — `drainArgon2Queue`
 *       on the singleton is irreversible, see argon2-semaphore.ts:362-369).
 *       The mock injects the exact errors the production handler is required
 *       to catch; the route-level translation is what's under test, not the
 *       semaphore's saturation logic (covered by `tests/lib/argon2-semaphore.test.ts`).
 *     - `getAppPool()` mock seeds DB rows deterministically without writing
 *       to the real `accounts` table during a test run.
 *     - `redis.js` mock (via `redisStubFactory`) forces the in-memory
 *       fallback tier of the fresh-auth primitive (`getRedis()` returns null
 *       / `isRedisAvailable()` returns false), so each test mints + consumes
 *       its proof through the memStore path. This is one of the
 *       carve-out-eligible mock targets (shared pool/cache helpers per the
 *       mock-target scope clause). Mocking `redis.js` is what gates the
 *       per-test determinism: with a real Redis the mint side would persist
 *       proofs across cases and the saturation arm couldn't be re-driven
 *       deterministically.
 *
 * (b) `verifyHiveSignature` is NOT mocked. The route requires
 *     authentication; we satisfy it via a legitimate Bearer JWT signed with
 *     `config.sessionSecret`. Cryptographic verification still runs on the
 *     real Bearer JWT path — only the argon2 slot helper, the DB pool, and
 *     the Redis pool helper are mocked.
 *
 * (c) REAL-PATH COMPANION: `settings-set-password-fresh-auth.test.ts` is the
 *     real-path companion for this transform-axis file. The companion
 *     exercises the integrated fresh-auth + UPDATE path against real Redis
 *     + real `getAppPool` + real argon2, covering the wiring-axis risk class
 *     that this transform-axis test pins (fresh-auth proof storage,
 *     single-use, TTL, target binding, real DB state-C → state-B
 *     transition). The risk classes are complementary: the mocked file
 *     pins the argon2-failure → HTTP translation; the real-path companion
 *     pins the wired storage + handler behavior.
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

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const {
  ArgonQueueFullError,
  ShuttingDownError,
  ArgonAbortError,
} = await import('../../src/lib/argon2-semaphore.js');
const {
  issueFreshAuthToken,
  setPasswordFreshAuthTarget,
} = await import('../../src/lib/fresh-auth.js');

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

// Per BACKEND-SETTINGS-SET-PASSWORD-FRESH-AUTH the route now requires a
// valid ORCID-mechanism fresh-auth proof before it pays the argon2 hash.
// Mint one inline per case: this test mocks `redis.js` to force the
// in-memory fallback tier of the fresh-auth primitive, so issuance writes
// to the memStore backup and consume reads it. The proof binding
// (username + per-user target hash) is enforced; this is the canonical
// shape the route validates against.
async function mintProof(username: string): Promise<string> {
  const issued = await issueFreshAuthToken(
    username,
    'orcid',
    setPasswordFreshAuthTarget(username),
  );
  return issued.token;
}

describe('POST /api/settings/set-password — argon2 error → HTTP translation', () => {
  it('ArgonQueueFullError → 503 SERVICE_UNAVAILABLE + Retry-After: 5 + generic body', async () => {
    appQueryMock.mockReset();
    seedSetPasswordAccount();
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonQueueFullError());

    const username = 'setpw-queuefull';
    const proof = await mintProof(username);
    const res = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', authHeader(username))
      .send({ password: 'AnyPassword1', fresh_auth_proof: proof });

    assert503QueueFull(res);
  });

  it('ShuttingDownError → 503 SERVICE_UNAVAILABLE + Retry-After: 30 + generic body', async () => {
    appQueryMock.mockReset();
    seedSetPasswordAccount();
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ShuttingDownError());

    const username = 'setpw-shutdown';
    const proof = await mintProof(username);
    const res = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', authHeader(username))
      .send({ password: 'AnyPassword1', fresh_auth_proof: proof });

    assert503Shutdown(res);
  });

  it('ArgonAbortError → silent (no response written, request hangs until socket close)', async () => {
    appQueryMock.mockReset();
    seedSetPasswordAccount();
    mockRunWithArgon2Slot.mockReset();
    mockRunWithArgon2Slot.mockRejectedValueOnce(new ArgonAbortError());

    const username = 'setpw-abort';
    const proof = await mintProof(username);
    const reqPromise = request(app)
      .post('/api/settings/set-password')
      .set('Authorization', authHeader(username))
      .send({ password: 'AnyPassword1', fresh_auth_proof: proof })
      .timeout({ deadline: 250 });

    await assertArgon2AbortIsSilent(reqPromise);
  });
});

/**
 * /api/bridge/register registerLimiter slot-refund canaries.
 *
 * Pins the `skipFailedRequests: true` setting on `registerLimiter` (per-IP,
 * 10/hour cap) so that retriable error responses (409 LOCK_HELD when a
 * sibling /register holds the per-permlink lock; 503 SERVICE_UNAVAILABLE
 * when the HAF duplicate-check throws) refund the per-IP slot. Without
 * the refund, SPA auto-retry loops on `details.retriable: true` burn the
 * full 10/hour budget against the originating IP during a single
 * LOCK_HELD cascade or HAF outage; legitimate registrations from that IP
 * then 429 for the remainder of the rolling window. Successful 2xx
 * responses still consume a slot so the per-IP abuse cap is preserved.
 *
 * Mirrors the sibling `Hive getAccounts throws then recovers: 503 refunds
 * limiter slot so the retry succeeds` canary against `upgradeLimiter` in
 * `backend/tests/routes/custody-upgrade.test.ts` (transient-failure-then-
 * recovery → retry succeeds) and the per-IP precedent set by
 * `accreditationVerifyLimiter` in `backend/src/routes/accreditation.ts`.
 *
 * Carve-out justification (root CLAUDE.md test-mock carve-out clauses a/b/c):
 *   (a) Real-path impracticality: driving 10 deterministic HAF-503
 *       responses against a real HAF pool is slow + non-deterministic; the
 *       postgres-pool `query`-throws stub used by the sibling bridge
 *       HAF-outage specs is the canonical pattern for this surface.
 *       Driving 10 LOCK_HELD 409s against real Redis requires sustained
 *       slow-broadcast contention against the live Hive node, also slow
 *       and non-deterministic; a FakeRedis with a broadcast gate is the
 *       canonical pattern (matches `bridge-haf-lag-locks.test.ts`).
 *   (b) Mock targets: `getPool`/`getAppPool` (shared pool helpers), `getRedis`
 *       (FakeRedis stub), `broadcastSendOperationsWithTimeout` (Hive RPC
 *       client), `lookupPreprint` / `resolveToCanonical` (external arXiv /
 *       Crossref fetchers), `getAccreditedSet` (accreditation lookup).
 *       `verifyHiveSignature` is NOT mocked here — requests are signed
 *       end-to-end via the sibling `support/sign-request.ts` helper. This
 *       test's focus IS rate-limiter slot accounting under retriable error
 *       paths, but cryptographic verification is preserved real-path
 *       because every spec issues an authenticated /register call.
 *   (c) Real-path companion: the rate-limit primitive's slot-refund
 *       semantics have real-Redis coverage in
 *       `backend/tests/middleware/rateLimit.test.ts` (the
 *       `skipFailedRequests + atomic Lua check` section under the single
 *       outer `describe('rateLimit middleware')`, exercising
 *       INCR-then-DECR-on-statusCode>=400 against the live Redis
 *       container resolved via `getRedis()` against `REDIS_URL`). That
 *       suite is the canonical home for the rateLimit middleware refund
 *       mechanics; this file pins the route-level wiring (that
 *       `registerLimiter` opts in, and that the refund branch fires on
 *       the two retriable error envelopes the route emits).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';

const TEST_PRIVATE_KEY = PrivateKey.fromSeed('pevo-bridge-register-skip-failed-seed');
const TEST_PUBLIC_KEY = TEST_PRIVATE_KEY.createPublic().toString();
const TEST_BRIDGE_KEY = PrivateKey.fromSeed('pevo-bridge-register-skip-failed-bridge-key').toString();

vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js');
  return {
    ...actual,
    config: {
      ...actual.config,
      hiveBridgeAccount: 'pevotest.bridge',
      pevoBridgePostingKey: TEST_BRIDGE_KEY,
    },
  };
});

// Hive client + broadcast mocks. `sendOperationsImpl` is the swappable
// implementation; tests reassign it to control timing (slow-broadcast for
// the LOCK_HELD-cascade spec).
let sendOperationsImpl: (...args: unknown[]) => Promise<{ id: string }> = async () => ({ id: 'mock-tx-id' });
const sendOperations = vi.fn().mockImplementation((...args: unknown[]) => sendOperationsImpl(...args));
vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: {
      getAccounts: vi.fn().mockImplementation((names: string[]) =>
        Promise.resolve(
          names.map((name) => ({
            name,
            posting: { key_auths: [[TEST_PUBLIC_KEY, 1]] },
          })),
        ),
      ),
    },
    broadcast: {
      sendOperations: (...args: unknown[]) => sendOperations(...args),
    },
  },
  broadcastSendOperationsWithTimeout: (...args: unknown[]) => sendOperations(...args),
  BroadcastTimeoutError: class extends Error {},
  DEFAULT_BROADCAST_TIMEOUT_MS: 30_000,
}));

// Bridge module mock — short-circuit identifier resolution + metadata fetch.
// `resolveToCanonical` supports a small bank of distinct identifiers so the
// per-IP-abuse-cap canary can drive different permlinks without colliding
// on the per-permlink lock.
const { MOCK_META } = vi.hoisted(() => ({
  MOCK_META: {
    title: 'A deterministic test paper',
    authors: ['Alice Example'],
    abstract: 'Abstract.',
    doi: null,
    arxiv_id: '2301.99999',
    source_type: 'arxiv',
    source_url: 'https://arxiv.org/abs/2301.99999',
    publication_date: '2023-01-20',
    license: null,
  },
}));
vi.mock('../../src/bridge.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/bridge.js')>('../../src/bridge.js');
  return {
    ...actual,
    resolveToCanonical: vi.fn().mockImplementation(async (identifier: string) => {
      // arXiv-shaped identifiers in the 2301.NNNNN bank used by the
      // distinct-permlink success-cap canary.
      const m = identifier.match(/^2301\.(\d{5})$/);
      if (m) return { type: 'arxiv', id: identifier };
      return actual.resolveToCanonical(identifier);
    }),
    lookupPreprint: vi.fn().mockImplementation(async (identifier: string) => {
      if (/^2301\.\d{5}$/.test(identifier)) return { ...MOCK_META, arxiv_id: identifier, source_url: `https://arxiv.org/abs/${identifier}` };
      return MOCK_META;
    }),
  };
});

const accreditedSet = new Set<string>();
vi.mock('../../src/accreditation.js', () => ({
  getAccreditedSet: vi.fn().mockImplementation(async (names: string[]) =>
    new Set(names.filter((n) => accreditedSet.has(n))),
  ),
  getAllAccreditedAccounts: vi.fn().mockResolvedValue(new Set<string>()),
}));

// Postgres pool mock — `pgQueryImpl` is swappable so the HAF-503 canary can
// install a throwing responder. Default: no rows (no existing duplicate).
let pgQueryImpl: (...args: unknown[]) => Promise<{ rows: unknown[] }> = async () => ({ rows: [] });
const pgQuery = vi.fn().mockImplementation((...args: unknown[]) => pgQueryImpl(...args));
vi.mock('../../src/db.js', () => ({
  getPool: () => ({ query: pgQuery }),
  isHafConfigured: () => true,
  closeHafPool: async () => {},
}));

// In-memory Redis stub — same surface as `bridge-haf-lag-locks.test.ts`.
// EX TTL is intentionally not honored in real time; specs release locks
// explicitly via the route's finally on every exit path.
class FakeRedis {
  store = new Map<string, string>();
  status = 'ready';
  setnxBlockedCount = new Map<string, number>();

  async set(key: string, value: string, ...args: unknown[]) {
    let nx = false;
    for (const a of args) {
      if (typeof a === 'string' && a.toUpperCase() === 'NX') nx = true;
    }
    if (nx && this.store.has(key)) {
      this.setnxBlockedCount.set(key, (this.setnxBlockedCount.get(key) ?? 0) + 1);
      return null;
    }
    this.store.set(key, value);
    return 'OK';
  }

  async get(key: string) {
    return this.store.get(key) ?? null;
  }

  async del(key: string) {
    return this.store.delete(key) ? 1 : 0;
  }

  // Maps a fake SHA back to its script body so `evalsha` can dispatch the
  // same way `eval` does. Warmed by `script('LOAD', body)`, which the global
  // `tests/setup.ts` `loadAllScripts(getRedis())` call invokes for every
  // shared script. Without a working `script`/`evalsha` pair the middleware's
  // `evalScript` (EVALSHA-first) would throw and fall through to its
  // in-process `memStore`, leaving the limiter counter invisible to a
  // FakeRedis-key probe.
  loadedScripts = new Map<string, string>();

  async script(cmd: string, body: string) {
    if (cmd.toUpperCase() === 'LOAD') {
      const sha = `fakesha:${this.loadedScripts.size}:${body.length}`;
      this.loadedScripts.set(sha, body);
      return sha;
    }
    return 'OK';
  }

  async evalsha(sha: string, numKeys: number, ...rest: string[]) {
    const body = this.loadedScripts.get(sha);
    if (body === undefined) {
      // Mirror real Redis: unknown SHA → NOSCRIPT so `evalScript` reloads + retries.
      throw new Error('NOSCRIPT No matching script. Please use EVAL.');
    }
    return this.eval(body, numKeys, ...rest);
  }

  // Dispatch on the script body so the rate-limit middleware's Redis path is
  // exercised for real (rather than throwing and falling through to the
  // middleware's in-memory `memStore`). This makes the per-IP slot counter
  // observable as a FakeRedis key, so the malformed-body-pre-limiter canary
  // can assert `rateLimitCount(...) → null` (key absent ⇒ limiter never
  // touched) the same way the `custody-limiter-cpu-amplification` sibling
  // does — distinguishing "never INCR'd" from "INCR'd then refunded to 0".
  // Two scripts reach here:
  //   * RATE_LIMIT_CHECK_AND_CONSUME — INCR; if count > max, DECR + return
  //     {0, pttl} (429); else PEXPIRE + return {1, 0} (pass). TTL is not
  //     honored in real time (specs clear `store` in beforeEach), matching
  //     the lock TTL note above.
  //   * BRIDGE_RELEASE_LOCK_LUA — compare-token DEL (the original CAS form).
  async eval(lua: string, _numKeys: number, ...rest: string[]) {
    const [key, ...args] = rest;
    if (lua.includes("redis.call('INCR'")) {
      const max = Number(args[0]);
      const windowMs = Number(args[1]);
      const count = (parseInt(this.store.get(key) ?? '0', 10) || 0) + 1;
      this.store.set(key, String(count));
      if (count > max) {
        this.store.set(key, String(count - 1));
        return [0, windowMs];
      }
      return [1, 0];
    }
    // BRIDGE_RELEASE_LOCK_LUA: compare-token DEL. args[0] is the expected nonce.
    const expected = args[0];
    const current = this.store.get(key);
    if (current === expected) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }

  async pttl(_key: string) {
    return 30_000;
  }

  async expire(_key: string, _ttl: number) {
    return 1;
  }

  // Atomic INCR — required by the RATE_LIMIT_CHECK_AND_CONSUME Lua path's
  // in-memory fallback, AND by the slot-refund DECR. The rate-limit
  // middleware's Lua-path codeflow throws on `evalScript` returning a
  // non-tuple and falls back to the in-memory branch, which uses pure
  // JS counters in `memStore` — so the FakeRedis incr/decr paths matter
  // only for the slot-refund DECR fired in the Lua path's success
  // branch. Match real Redis: counter goes negative if you DECR below
  // zero (no clamp). Slot accounting is bound by `max`, not by the
  // counter itself.
  async incr(key: string) {
    const v = (parseInt(this.store.get(key) ?? '0', 10) || 0) + 1;
    this.store.set(key, String(v));
    return v;
  }

  async decr(key: string) {
    const v = (parseInt(this.store.get(key) ?? '0', 10) || 0) - 1;
    this.store.set(key, String(v));
    return v;
  }

  async ttl(_key: string) {
    return 60;
  }

  async pexpire(_key: string, _ttl: number) {
    return 1;
  }

  async exists(key: string) {
    return this.store.has(key) ? 1 : 0;
  }

  async sadd(key: string, value: string) {
    const set = new Set(JSON.parse(this.store.get(key) ?? '[]'));
    const had = set.has(value);
    set.add(value);
    this.store.set(key, JSON.stringify([...set]));
    return had ? 0 : 1;
  }

  async smembers(key: string) {
    return JSON.parse(this.store.get(key) ?? '[]');
  }

  async keys(_pattern: string) {
    return [...this.store.keys()];
  }
}

const fakeRedis = new FakeRedis();
vi.mock('../../src/redis.js', () => ({
  getRedis: () => fakeRedis,
  isRedisAvailable: () => true,
  disconnectRedis: async () => {},
}));

// app-db is NOT mocked: the route's enqueue path requires a real Postgres
// pool against the bridge_import_queue table. Tests clean up their own
// rows in afterAll via cleanupQueueRowsFor.

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { getAppPool, closeAppPool } = await import('../../src/app-db.js');
const { signRequestBound: signRequestBoundShared } = await import('../support/sign-request.js');

const app = createApp();

async function cleanupQueueRowsFor(usernamePrefix: string): Promise<void> {
  const pool = getAppPool();
  if (!pool) return;
  await pool.query(
    `DELETE FROM bridge_import_queue WHERE username LIKE $1`,
    [`${usernamePrefix}%`],
  );
}

async function tableAvailable(): Promise<boolean> {
  const pool = getAppPool();
  if (!pool) return false;
  try {
    await pool.query(`SELECT 1 FROM bridge_import_queue LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

function signRequestBound(method: string, fullPath: string, body: Record<string, unknown>, timestamp: string): string {
  return signRequestBoundShared(TEST_PRIVATE_KEY, method, fullPath, body, timestamp);
}

// Read the per-(limiter-name, key) rate-limit slot count out of the FakeRedis
// store. Returns null when the key is ABSENT (the limiter middleware never ran
// for this key, so it was never INCR'd) — the slot-untouched invariant the
// malformed-body-pre-limiter canary asserts. The key shape mirrors the
// middleware's `${appTag}:rl:${name}:` prefix. Synchronous because FakeRedis
// holds its data in a plain in-process Map (no awaitable round-trip), unlike
// the real-Redis `rateLimitCount` in `custody-limiter-cpu-amplification.test.ts`.
function rateLimitCount(name: string, key: string): number | null {
  const raw = fakeRedis.store.get(`${config.appTag}:rl:${name}:${key}`);
  if (raw === undefined) return null;
  return Number(raw);
}

// Each spec receives a unique simulated client IP via X-Forwarded-For so the
// per-IP rate-limit bucket is isolated from prior specs. Without this, the
// in-memory limiter `memStore` (closed over by the rateLimit middleware
// factory) persists across specs in-process: a prior spec's successful
// 2xx leaves a timestamp in the bucket and the next spec starts with a
// non-empty budget. `trust proxy = 1` is set in `app.ts` so Express derives
// `req.ip` from the first-in-chain X-Forwarded-For value.
async function signedPost(
  path: string,
  username: string,
  body: Record<string, unknown>,
  forwardedFor: string,
) {
  const timestamp = new Date().toISOString();
  const signature = signRequestBound('POST', path, body, timestamp);
  return request(app)
    .post(path)
    .set('X-Hive-Username', username)
    .set('X-Hive-Signature', signature)
    .set('X-Hive-Timestamp', timestamp)
    .set('X-Forwarded-For', forwardedFor)
    .send(body);
}

// Signed POST with an explicit non-JSON (or absent) Content-Type. `express.json`
// only parses `application/json`, so under Express 5 `req.body === undefined`
// for these requests and `verifyHiveSignature` body-hashes `undefined ?? {}`
// === '{}'. We therefore sign over the empty-body shape `{}` so the signature
// matches end-to-end (cryptographic verification runs real-path here). Pass
// `contentType: null` to omit the Content-Type header entirely (the
// missing-header bypass); pass a string to set it (e.g. 'text/plain').
async function signedPostNonJson(
  path: string,
  username: string,
  rawPayload: string,
  forwardedFor: string,
  contentType: string | null,
) {
  const timestamp = new Date().toISOString();
  // Server hashes the empty-body shape because the parser leaves req.body undefined.
  const signature = signRequestBound('POST', path, {}, timestamp);
  const req = request(app)
    .post(path)
    .set('X-Hive-Username', username)
    .set('X-Hive-Signature', signature)
    .set('X-Hive-Timestamp', timestamp)
    .set('X-Forwarded-For', forwardedFor);
  if (contentType === null) {
    // Omit Content-Type entirely: send no body so supertest does not
    // auto-attach a default Content-Type for a string payload.
    return req.send();
  }
  return req.set('Content-Type', contentType).send(rawPayload);
}

beforeEach(async () => {
  fakeRedis.store.clear();
  fakeRedis.setnxBlockedCount.clear();
  sendOperations.mockClear();
  pgQuery.mockClear();
  accreditedSet.clear();
  sendOperationsImpl = async () => ({ id: 'mock-tx-id' });
  pgQueryImpl = async () => ({ rows: [] });
  // Clear out any queue rows left from prior runs of these specs so a
  // re-run does not collide on the per-user cap or permlink uniqueness.
  await cleanupQueueRowsFor('registerlimiter');
});

describe('registerLimiter slot-refund on retriable error paths (skipFailedRequests=true)', () => {
  let tableReady = false;

  beforeEach(async () => {
    tableReady = await tableAvailable();
  });

  it('HAF-503 cascade: 10 sequential SERVICE_UNAVAILABLE responses do NOT exhaust the per-IP 10/hour budget; 11th request under healthy HAF returns 202', async () => {
    if (!tableReady) return;
    // Install a HAF responder that throws → /register catch arm emits 503
    // with `details.retriable: true`. The SPA auto-retries on retriable;
    // each retry consumes a fresh slot up-front. Without
    // `skipFailedRequests: true`, the 11th request (under healthy HAF
    // restored below) sees an exhausted bucket and 429s.
    const TEST_IP = '203.0.113.1';
    const ACCREDITED = 'registerlimiterhaf';
    accreditedSet.add(ACCREDITED);
    pgQueryImpl = async () => {
      throw new Error('simulated HAF connection refused');
    };

    for (let i = 0; i < 10; i++) {
      const failRes = await signedPost('/api/bridge/register', ACCREDITED, {
        identifier: '2301.99991',
        discipline: 'CS',
      }, TEST_IP);
      expect(failRes.status).toBe(503);
      expect(failRes.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(failRes.body.error.details).toEqual({ retriable: true });
    }

    // Restore HAF: duplicate-check passes (no rows). The 11th request
    // should be accepted into the queue with 202 — if the limiter had NOT
    // refunded slots on the 10 failed attempts, this would be 429.
    pgQueryImpl = async () => ({ rows: [] });
    const successRes = await signedPost('/api/bridge/register', ACCREDITED, {
      identifier: '2301.99991',
      discipline: 'CS',
    }, TEST_IP);
    expect(successRes.status).toBe(202);
    expect(successRes.body.status).toBe('ok');
  });

  it('DUPLICATE-active cascade: 10 sequential 409 DUPLICATE responses do NOT exhaust the per-IP 10/hour budget', async () => {
    if (!tableReady) return;
    // After the route switched to enqueue-on-success, a second submission
    // for the same identifier hits the queue's active-permlink branch
    // (409 DUPLICATE) instead of the old per-permlink Redis lock's
    // LOCK_HELD branch. The rate-limiter refund still has to apply to
    // these retriable 409s so an SPA retry on `details.retriable` does
    // not burn the per-IP budget.
    const TEST_IP = '203.0.113.2';
    const ACCREDITED = 'registerlimiterdup';
    accreditedSet.add(ACCREDITED);
    // First submission enqueues a real queue row.
    const first = await signedPost('/api/bridge/register', ACCREDITED, {
      identifier: '2301.99992',
      discipline: 'CS',
    }, TEST_IP);
    expect(first.status).toBe(202);

    // 10 subsequent submissions for the same identifier should hit
    // duplicate_active in the queue (DUPLICATE 409 retriable). Each
    // refunds its slot under `skipFailedRequests: true`.
    for (let i = 0; i < 10; i++) {
      const failRes = await signedPost('/api/bridge/register', ACCREDITED, {
        identifier: '2301.99992',
        discipline: 'CS',
      }, TEST_IP);
      expect(failRes.status).toBe(409);
      expect(failRes.body.error.code).toBe('DUPLICATE');
    }

    // Issue an 11th attempt from the same IP for a DIFFERENT identifier
    // (so it does not hit duplicate_active). The slot accounting must
    // have refunded the 10 DUPLICATE-409s; the successful first counted
    // as 1 slot, the 11th counts as another → 2 slots consumed of 10.
    const followUpRes = await signedPost('/api/bridge/register', ACCREDITED, {
      identifier: '2301.99993',
      discipline: 'CS',
    }, TEST_IP);
    expect(followUpRes.status).not.toBe(429);
  });

  it('per-IP abuse cap preserved on success path: 10 successful 202s from the same IP exhaust the budget; 11th returns 429 RATE_LIMITED', async () => {
    if (!tableReady) return;
    // Drive 10 successful enqueues against distinct identifiers (so the
    // per-permlink dedup and the HAF duplicate-check both pass). The
    // 11th request from the same IP must 429 — the successful path still
    // consumes a slot.
    //
    // Each enqueue increments the per-user concurrent-pending counter,
    // and `BRIDGE_QUEUE_USER_CAP` is 5. Use a fresh user per attempt so
    // the per-user cap does not also fire and contaminate the per-IP
    // assertion this spec exists to pin.
    const TEST_IP = '203.0.113.3';
    const USER_PREFIX = 'registerlimitersuccess';
    for (let i = 0; i < 10; i++) {
      const username = `${USER_PREFIX}${i}`;
      accreditedSet.add(username);
      const id = `2301.${String(20000 + i).padStart(5, '0')}`;
      const okRes = await signedPost('/api/bridge/register', username, {
        identifier: id,
        discipline: 'CS',
      }, TEST_IP);
      expect(okRes.status).toBe(202);
      expect(okRes.body.status).toBe('ok');
    }

    // 11th attempt from the same IP — bucket exhausted on success path.
    const extraUser = `${USER_PREFIX}11`;
    accreditedSet.add(extraUser);
    const blockedRes = await signedPost('/api/bridge/register', extraUser, {
      identifier: '2301.20011',
      discipline: 'CS',
    }, TEST_IP);
    expect(blockedRes.status).toBe(429);
    expect(blockedRes.body.error.code).toBe('RATE_LIMITED');
  });

  it('malformed body (empty-string identifier) 400s BEFORE the limiter; the slot is never consumed', async () => {
    if (!tableReady) return;
    // Load-bearing invariant of the middleware order
    // (verifyHiveSignature → validateRegisterBody → registerLimiter): a
    // malformed body short-circuits at validateRegisterBody BEFORE
    // registerLimiter, so the per-IP slot is never acquired. The three
    // refund-path canaries above all send well-formed bodies and exercise
    // the slot-acquired-then-decremented path, not this pre-limiter
    // short-circuit path; a refactor reverting the mount to
    // limiter-before-validation would reopen the round-1 CPU/RPC
    // amplification surface while leaving those three green.
    //
    // Content-Type is application/json so the request passes the
    // Content-Type guard at the top of validateRegisterBody and reaches
    // the field-presence check (the empty-string identifier 400s there).
    //
    // Slot-untouched probe — mirrors the `custody-limiter-cpu-amplification`
    // sibling's `rateLimitCount(...) → toBeNull()` contract. `rateLimitCount`
    // reads the per-IP limiter key out of the FakeRedis store, which the
    // rate-limit middleware writes only when it actually runs (FakeRedis
    // implements the RATE_LIMIT_CHECK_AND_CONSUME Lua, so the middleware uses
    // its Redis path rather than the memStore fallback). A null result means
    // the key was never created — the limiter was never reached, so the slot
    // was never INCR'd. That distinguishes:
    //   - Correct order (`verifyHiveSignature → validateRegisterBody →
    //     registerLimiter`): the malformed body 400s at validateRegisterBody
    //     BEFORE the limiter → key absent → rateLimitCount === null.
    //   - Mutation order (`registerLimiter → verifyHiveSignature →
    //     validateRegisterBody`, limiter first): the limiter INCRs the key
    //     before validation runs; under skipFailedRequests the 400 refunds
    //     (DECRs) the slot, leaving the key present at "0" — NOT absent. So
    //     rateLimitCount === 0, not null, and `toBeNull()` flips RED. The
    //     three refund-path canaries stay green (they read no key probe and
    //     assert response codes the Redis path reproduces identically).
    const TEST_IP = '203.0.113.4';
    const ACCREDITED = 'registerlimitermalformed';
    accreditedSet.add(ACCREDITED);

    const failRes = await signedPost('/api/bridge/register', ACCREDITED, {
      identifier: '',
      discipline: 'CS',
    }, TEST_IP);
    expect(failRes.status).toBe(400);
    expect(failRes.body.error.code).toBe('BAD_REQUEST');
    expect(failRes.body.error.message).toMatch(/identifier/);

    // The limiter was never reached, so the per-IP slot key was never written.
    expect(rateLimitCount('bridge-register', TEST_IP)).toBeNull();
  });
});

describe('validateRegisterBody Content-Type guard (415 before limiter, slot untouched)', () => {
  let tableReady = false;

  beforeEach(async () => {
    tableReady = await tableAvailable();
  });

  // Slot-untouched is asserted two ways. Primary: the `rateLimitCount(...) →
  // toBeNull()` probe after each spray (mirrors the sibling malformed-body
  // canary). `rateLimitCount` reads the per-IP limiter key from the FakeRedis
  // store; FakeRedis implements the RATE_LIMIT_CHECK_AND_CONSUME Lua
  // (`evalsha`/`eval`), so the rate-limit middleware uses its Redis path (not
  // the memStore fallback) and writes the key iff registerLimiter actually
  // ran. A null result means the limiter was never reached: the Content-Type
  // guard 415s inside validateRegisterBody BEFORE registerLimiter. This kills
  // the limiter-before-validation reorder mutation — under that order the
  // limiter INCRs first and skipFailedRequests refunds on the 415, leaving the
  // key present at "0" (rateLimitCount === 0, not null) so toBeNull() flips
  // RED. Complementary end-to-end check: a full per-IP cap (10/hour) of
  // well-formed 202s from the SAME IP still goes through after the spray,
  // proving no rejected request burned a slot. A fresh accredited user per
  // success avoids BRIDGE_QUEUE_USER_CAP (5) contaminating the per-IP
  // assertion (matches the abuse-cap canary above). The probe must run BEFORE
  // this cap check, since the successes themselves write the per-IP key.
  async function assertCapWorthOfSuccessesFromSameIp(ip: string, userPrefix: string) {
    for (let i = 0; i < 10; i++) {
      const username = `${userPrefix}${i}`;
      accreditedSet.add(username);
      const id = `2301.${String(30000 + i).padStart(5, '0')}`;
      const okRes = await signedPost('/api/bridge/register', username, {
        identifier: id,
        discipline: 'CS',
      }, ip);
      expect(okRes.status).toBe(202);
      expect(okRes.body.status).toBe('ok');
    }
  }

  it('non-JSON Content-Type (text/plain): 415 before the limiter; the slot is never consumed', async () => {
    if (!tableReady) return;
    // Attacker holds a valid posting key; signs the empty-body canonical
    // message and sprays text/plain payloads. express.json leaves req.body
    // undefined; the guard 415s BEFORE registerLimiter. Mutation-kill:
    // remove the Content-Type guard from validateRegisterBody → the
    // body.identifier read throws a TypeError → 500 INTERNAL_ERROR, flipping
    // the 415 assertion RED.
    const TEST_IP = '203.0.113.10';
    const ACCREDITED = 'registerlimiterct';
    accreditedSet.add(ACCREDITED);

    for (let i = 0; i < 12; i++) {
      const res = await signedPostNonJson(
        '/api/bridge/register',
        ACCREDITED,
        'identifier=2301.99981&discipline=CS',
        TEST_IP,
        'text/plain',
      );
      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    }

    // Primary slot-untouched probe: the 415 fired inside validateRegisterBody
    // before registerLimiter, so the per-IP limiter key was never written.
    // Must precede the cap check below, which writes the key via its 202s.
    expect(rateLimitCount('bridge-register', TEST_IP)).toBeNull();

    // Complementary: a full per-IP cap of well-formed successes from the
    // same IP still go through (none of the 12 text/plain sprays burned a slot).
    await assertCapWorthOfSuccessesFromSameIp(TEST_IP, 'registerlimiterctok');
  });

  it('missing Content-Type header: 415 before the limiter; the slot is never consumed', async () => {
    if (!tableReady) return;
    const TEST_IP = '203.0.113.11';
    const ACCREDITED = 'registerlimiternoct';
    accreditedSet.add(ACCREDITED);

    for (let i = 0; i < 12; i++) {
      const res = await signedPostNonJson(
        '/api/bridge/register',
        ACCREDITED,
        '',
        TEST_IP,
        null,
      );
      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    }

    // Primary slot-untouched probe (see the describe-block comment): 415
    // before registerLimiter ⇒ the per-IP key was never written. Precedes the
    // cap check, which writes the key via its 202s.
    expect(rateLimitCount('bridge-register', TEST_IP)).toBeNull();

    await assertCapWorthOfSuccessesFromSameIp(TEST_IP, 'registerlimiternoctok');
  });

  it('empty body with application/json: passes the Content-Type guard and 400s on the presence check', async () => {
    if (!tableReady) return;
    // Express 5 parses an empty application/json body to req.body === {}. The
    // Content-Type guard passes (it IS application/json); the existing
    // presence check then returns a clean 400 BAD_REQUEST. Pins this so a
    // future Express upgrade or json-parser swap can't silently flip an
    // empty JSON body into the 415 or 500 paths.
    const TEST_IP = '203.0.113.12';
    const ACCREDITED = 'registerlimiterempty';
    accreditedSet.add(ACCREDITED);

    const timestamp = new Date().toISOString();
    const signature = signRequestBound('POST', '/api/bridge/register', {}, timestamp);
    const res = await request(app)
      .post('/api/bridge/register')
      .set('X-Hive-Username', ACCREDITED)
      .set('X-Hive-Signature', signature)
      .set('X-Hive-Timestamp', timestamp)
      .set('X-Forwarded-For', TEST_IP)
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toMatch(/identifier/);
  });
});

afterAll(async () => {
  await cleanupQueueRowsFor('registerlimiter').catch(() => undefined);
  await closeAppPool().catch(() => undefined);
});

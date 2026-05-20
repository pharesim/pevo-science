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

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  async eval(_lua: string, _numKeys: number, key: string, expected: string) {
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

vi.mock('../../src/app-db.js', () => ({
  getAppPool: () => null,
}));

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { signRequestBound: signRequestBoundShared } = await import('../support/sign-request.js');

const app = createApp();

function signRequestBound(method: string, fullPath: string, body: Record<string, unknown>, timestamp: string): string {
  return signRequestBoundShared(TEST_PRIVATE_KEY, method, fullPath, body, timestamp);
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

beforeEach(async () => {
  fakeRedis.store.clear();
  fakeRedis.setnxBlockedCount.clear();
  sendOperations.mockClear();
  pgQuery.mockClear();
  accreditedSet.clear();
  sendOperationsImpl = async () => ({ id: 'mock-tx-id' });
  pgQueryImpl = async () => ({ rows: [] });
});

describe('registerLimiter slot-refund on retriable error paths (skipFailedRequests=true)', () => {
  const ACCREDITED = 'registerlimiterauthor';

  beforeEach(() => {
    accreditedSet.add(ACCREDITED);
  });

  it('HAF-503 cascade: 10 sequential SERVICE_UNAVAILABLE responses do NOT exhaust the per-IP 10/hour budget; 11th request under healthy HAF returns 200', async () => {
    // Install a HAF responder that throws → /register catch arm emits 503
    // with `details.retriable: true`. The SPA auto-retries on retriable;
    // each retry consumes a fresh slot up-front. Without
    // `skipFailedRequests: true`, the 11th request (under healthy HAF
    // restored below) sees an exhausted bucket and 429s.
    const TEST_IP = '203.0.113.1';
    pgQueryImpl = async () => {
      throw new Error('simulated HAF connection refused');
    };

    for (let i = 0; i < 10; i++) {
      const failRes = await signedPost('/api/bridge/register', ACCREDITED, {
        identifier: '2301.99999',
        discipline: 'CS',
      }, TEST_IP);
      expect(failRes.status).toBe(503);
      expect(failRes.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(failRes.body.error.details).toEqual({ retriable: true });
    }

    // Restore HAF: duplicate-check passes (no rows). The 11th request
    // should succeed — if the limiter had NOT refunded slots on the 10
    // failed attempts, this would be 429.
    pgQueryImpl = async () => ({ rows: [] });
    const successRes = await signedPost('/api/bridge/register', ACCREDITED, {
      identifier: '2301.99999',
      discipline: 'CS',
    }, TEST_IP);
    expect(successRes.status).toBe(200);
    expect(successRes.body.status).toBe('ok');
  });

  it('LOCK_HELD cascade: 10 sequential 409 LOCK_HELD responses do NOT exhaust the per-IP 10/hour budget; 11th request after lock release is not 429', async () => {
    // Slow-broadcast gate: request A holds the per-permlink lock until we
    // release the gate. While A is in broadcast, the next 10 attempts for
    // the same identifier hit the SETNX-already-held branch and return
    // 409 LOCK_HELD with `details.retriable: true`. Without
    // `skipFailedRequests: true`, those 10 retries would burn the
    // bucket and the post-release attempt would 429.
    const TEST_IP = '203.0.113.2';
    let releaseBroadcast: (() => void) | null = null;
    const broadcastGate = new Promise<void>((resolve) => { releaseBroadcast = resolve; });
    sendOperationsImpl = async () => {
      await broadcastGate;
      return { id: 'tx-winner' };
    };

    const expectedLockKey = `${config.appTag}:bridge_register_lock:bridge-arxiv-2301-99999`;

    // Fire A but do NOT await — it parks on the broadcast gate.
    const reqA = signedPost('/api/bridge/register', ACCREDITED, {
      identifier: '2301.99999',
      discipline: 'CS',
    }, TEST_IP);

    // Spin until A has acquired the lock so the next 10 calls deterministically
    // hit the LOCK_HELD branch. Polling pattern matches the sibling
    // `waitForLockAcquired` helper in `bridge-haf-lag-locks.test.ts`.
    const lockAcquired = async () => {
      const deadline = Date.now() + 1_000;
      while (!fakeRedis.store.has(expectedLockKey)) {
        if (Date.now() > deadline) throw new Error('lock not acquired in time');
        await new Promise((r) => setImmediate(r));
      }
    };
    await lockAcquired();

    // Issue 10 sequential follow-up calls for the same identifier. Each
    // hits SETNX-already-held and 409s with retriable:true.
    for (let i = 0; i < 10; i++) {
      const failRes = await signedPost('/api/bridge/register', ACCREDITED, {
        identifier: '2301.99999',
        discipline: 'CS',
      }, TEST_IP);
      expect(failRes.status).toBe(409);
      expect(failRes.body.error.code).toBe('LOCK_HELD');
      expect(failRes.body.error.details).toEqual({ retriable: true });
    }

    // Release A's gate so it broadcasts, releases the lock, and 200s.
    releaseBroadcast!();
    const resA = await reqA;
    expect(resA.status).toBe(200);

    // Issue an 11th attempt from the same IP — same identifier (now
    // already broadcast, so will 409 DUPLICATE if HAF rows it; here
    // pgQueryImpl still returns empty so it broadcasts again). The
    // load-bearing assertion is NOT 429; the slot accounting must have
    // refunded the 10 LOCK_HELD attempts. The successful A counted as 1
    // slot, the 11th followUp counts as another → 2 slots consumed of
    // 10, well clear of the cap.
    const followUpRes = await signedPost('/api/bridge/register', ACCREDITED, {
      identifier: '2301.99999',
      discipline: 'CS',
    }, TEST_IP);
    expect(followUpRes.status).not.toBe(429);
  });

  it('per-IP abuse cap preserved on success path: 10 successful 200s from the same IP exhaust the budget; 11th returns 429 RATE_LIMITED', async () => {
    // Drive 10 successful registrations against distinct identifiers (so
    // the per-permlink lock and the HAF duplicate-check both pass). The
    // 11th request from the same IP must 429 — the successful path still
    // consumes a slot.
    const TEST_IP = '203.0.113.3';
    for (let i = 0; i < 10; i++) {
      const id = `2301.${String(10000 + i).padStart(5, '0')}`;
      const okRes = await signedPost('/api/bridge/register', ACCREDITED, {
        identifier: id,
        discipline: 'CS',
      }, TEST_IP);
      expect(okRes.status).toBe(200);
      expect(okRes.body.status).toBe('ok');
    }

    // 11th attempt from the same IP — bucket exhausted on success path.
    const blockedRes = await signedPost('/api/bridge/register', ACCREDITED, {
      identifier: '2301.20000',
      discipline: 'CS',
    }, TEST_IP);
    expect(blockedRes.status).toBe(429);
    expect(blockedRes.body.error.code).toBe('RATE_LIMITED');
  });
});

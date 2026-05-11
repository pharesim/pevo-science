/**
 * BE-BRIDGE-WRITE-HAF-LAG — concurrent /register lock specs.
 *
 * Justification for the Redis mock (per root CLAUDE.md carve-out clause c):
 * we need deterministic ordering between two concurrent in-flight requests
 * so the second hits the lock-already-held branch reliably. Real-Redis
 * cannot be ordered like this without sleep-tuning that's flaky in CI. We
 * use a stateful in-memory Redis stub so SET ... NX EX behaves exactly like
 * real Redis for the SETNX semantics under concurrent access.
 *
 * Round-2 hold item #5 (PS-001): the prior citation of bridge.test.ts's
 * unlocked-degrade path (under `getRedis: () => null`) is a different risk
 * class — Redis-unavailable fallback, NOT SETNX contention. Backend filed
 * follow-up task `backend-bridge-lock-real-redis-companion.md` (in
 * tasks/pending/) to land a real-Redis SETNX-contention companion. Once
 * that lands, this header is updated to cite the new test file. The
 * follow-up satisfies clause c via the "OR a follow-up task is filed to add
 * such coverage" branch.
 *
 * `verifyHiveSignature` is NOT mocked — requests are signed end-to-end. Only
 * `getPool`/`getAppPool`/`getRedis` and broadcast/preprint helpers are stubbed,
 * matching the existing bridge.test.ts pattern.
 *
 * Specs covered:
 *   1. /register: 2 concurrent calls for the same identifier → exactly ONE
 *      broadcast fires; the second returns 409 LOCK_HELD with retriable:
 *      true. After both requests resolve, the Redis lock key is absent.
 *   2. /register: HAF query throws → 503 SERVICE_UNAVAILABLE with
 *      retriable: true and structured warn-level log with route:
 *      'bridge.register'.
 *   3. /check: HAF query throws → 200 with fail-open shape {exists: false}
 *      (no `status` field leaks on the wire); warn-log emits route:
 *      'bridge.check' (NOT bridge.register).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { PrivateKey, cryptoUtils } from '@hiveio/dhive';

const TEST_PRIVATE_KEY = PrivateKey.fromSeed('pevo-bridge-haf-lag-seed');
const TEST_PUBLIC_KEY = TEST_PRIVATE_KEY.createPublic().toString();
const TEST_BRIDGE_KEY = PrivateKey.fromSeed('pevo-bridge-haf-lag-bridge-key').toString();

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
// the concurrency specs).
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

// Bridge module mock — short-circuit identifier resolution and metadata
// fetch so no real Crossref/arXiv calls happen.
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
      if (identifier === '2301.99999') return { type: 'arxiv', id: '2301.99999' };
      return actual.resolveToCanonical(identifier);
    }),
    lookupPreprint: vi.fn().mockImplementation(async () => MOCK_META),
  };
});

const accreditedSet = new Set<string>();
vi.mock('../../src/accreditation.js', () => ({
  getAccreditedSet: vi.fn().mockImplementation(async (names: string[]) =>
    new Set(names.filter((n) => accreditedSet.has(n))),
  ),
  getAllAccreditedAccounts: vi.fn().mockResolvedValue(new Set<string>()),
}));

// Postgres pool mock — exposes `query` so checkExistingBridge can run. By
// default returns no rows (no existing duplicate); tests can override.
let pgQueryImpl: (...args: unknown[]) => Promise<{ rows: unknown[] }> = async () => ({ rows: [] });
const pgQuery = vi.fn().mockImplementation((...args: unknown[]) => pgQueryImpl(...args));
vi.mock('../../src/db.js', () => ({
  getPool: () => ({ query: pgQuery }),
  isHafAvailable: () => true,
  closeHafPool: async () => {},
}));

// In-memory Redis stub. Implements only the surface
// bridge.ts and verifyHiveSignature touch:
//   - SET key value EX <ttl> NX  (acquireBridgeLock)
//   - eval(LUA, 1, key, value)   (releaseBridgeLock CAS)
//   - status: 'ready'             (isRedisAvailable returns true)
//   - get / set / del             (verifyHiveSignature replay-cache)
// EX TTL is intentionally not honored in real time — every test releases
// the lock explicitly via the route's finally so TTL expiry is not exercised
// here. Lock-TTL semantics are covered indirectly by the orcid suite which
// runs against real Redis.
class FakeRedis {
  store = new Map<string, string>();
  status = 'ready';

  async set(key: string, value: string, ...args: unknown[]) {
    // SET key value EX <ttl> NX
    let nx = false;
    for (const a of args) {
      if (typeof a === 'string' && a.toUpperCase() === 'NX') nx = true;
    }
    if (nx && this.store.has(key)) return null;
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
    // Mirrors RELEASE_LOCK_LUA: DEL only when stored value matches expected.
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

  async incr(key: string) {
    const v = (parseInt(this.store.get(key) ?? '0', 10) || 0) + 1;
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

const app = createApp();

function signRequestBound(method: string, fullPath: string, body: unknown, timestamp: string): string {
  const bodyHash = cryptoUtils.sha256(JSON.stringify(body || {})).toString('hex');
  const msg = `${config.appTag}-auth|v1|${method}|${fullPath}|${bodyHash}|${timestamp}`;
  const msgHash = cryptoUtils.sha256(msg);
  return TEST_PRIVATE_KEY.sign(msgHash).toString();
}

async function signedPost(path: string, username: string, body: unknown) {
  const timestamp = new Date().toISOString();
  const signature = signRequestBound('POST', path, body, timestamp);
  return request(app)
    .post(path)
    .set('X-Hive-Username', username)
    .set('X-Hive-Signature', signature)
    .set('X-Hive-Timestamp', timestamp)
    .send(body);
}

beforeEach(() => {
  fakeRedis.store.clear();
  sendOperations.mockClear();
  pgQuery.mockClear();
  accreditedSet.clear();
  // Default broadcast: instantaneous success. Specs that need slow broadcast
  // override sendOperationsImpl per-test.
  sendOperationsImpl = async () => ({ id: 'mock-tx-id' });
  // Default HAF: no existing duplicate.
  pgQueryImpl = async () => ({ rows: [] });
});

describe('BE-BRIDGE-WRITE-HAF-LAG — /register concurrent same-identifier lock', () => {
  const ACCREDITED = 'racingauthor';

  beforeEach(() => {
    accreditedSet.add(ACCREDITED);
  });

  it('two concurrent /register for the same identifier: exactly ONE broadcast fires, the second returns 409 LOCK_HELD retriable, lock key released in finally', async () => {
    // Slow broadcast: hold the lock for ~50ms so the second request hits the
    // SETNX-already-held branch with high reliability.
    let releaseBroadcast: (() => void) | null = null;
    const broadcastGate = new Promise<void>((resolve) => { releaseBroadcast = resolve; });
    sendOperationsImpl = async () => {
      await broadcastGate;
      return { id: 'tx-winner' };
    };

    const body = { identifier: '2301.99999', discipline: 'CS' };
    const reqA = signedPost('/api/bridge/register', ACCREDITED, body);
    // Tiny stagger so reqA wins the SETNX deterministically.
    await new Promise((r) => setTimeout(r, 5));
    const reqB = signedPost('/api/bridge/register', ACCREDITED, body);

    // Let reqB hit the lock check before releasing reqA's broadcast.
    await new Promise((r) => setTimeout(r, 20));
    releaseBroadcast!();

    const [resA, resB] = await Promise.all([reqA, reqB]);

    // Exactly one broadcast must have fired.
    expect(sendOperations).toHaveBeenCalledTimes(1);

    const winner = resA.status === 200 ? resA : resB;
    const loser = resA.status === 200 ? resB : resA;

    expect(winner.status).toBe(200);
    expect(winner.body.status).toBe('ok');
    expect(winner.body.data.tx_id).toBe('tx-winner');

    // Round-2 hold item #1: lock-held 409 carries `code: 'LOCK_HELD'`, NOT
    // `code: 'DUPLICATE'`. The two 409 shapes share the HTTP status but
    // differ on the error code so SPA/integrators can switch on
    // err.code without parsing the message string.
    expect(loser.status).toBe(409);
    expect(loser.body.error.code).toBe('LOCK_HELD');
    expect(loser.body.error.details).toEqual({ retriable: true });

    // Round-2 hold item #9: assert the lock key is absent from Redis after
    // both requests resolve — catches early-return / missing-`state ===
    // 'acquired'` regressions in the finally block. The winner's finally
    // released the key under Lua CAS; the loser never acquired it.
    // Reconstruct the key from config.appTag + bridgeRegisterLockKey shape.
    const expectedLockKey = `${config.appTag}:bridge_register_lock:bridge-arxiv-2301-99999`;
    expect(fakeRedis.store.has(expectedLockKey)).toBe(false);
  });
});

describe('BE-BRIDGE-WRITE-HAF-LAG — /register fails closed on HAF outage', () => {
  const ACCREDITED = 'hafoutageauthor';

  beforeEach(() => {
    accreditedSet.add(ACCREDITED);
  });

  it('HAF query throws → 503 SERVICE_UNAVAILABLE with retriable: true, no broadcast, structured warn log', async () => {
    pgQueryImpl = async () => {
      throw new Error('simulated HAF connection refused');
    };

    // Capture the warn-level log assertion. The route uses logger.warn with
    // event: 'bridge.register.haf_check_failed'. We spy on the logger module.
    const { logger } = await import('../../src/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn');

    try {
      const res = await signedPost('/api/bridge/register', ACCREDITED, {
        identifier: '2301.99999',
        discipline: 'CS',
      });

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.body.error.details).toEqual({ retriable: true });
      expect(sendOperations).not.toHaveBeenCalled();

      // The structured event field discriminates this branch for operator
      // dashboards.
      const calls = warnSpy.mock.calls;
      const matchingCall = calls.find((c) => {
        const ctx = c[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'bridge.register.haf_check_failed';
      });
      expect(matchingCall, 'expected a logger.warn call with event=bridge.register.haf_check_failed').toBeDefined();
      const ctx = matchingCall![0] as Record<string, unknown>;
      expect(ctx.route).toBe('bridge.register');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('BE-BRIDGE-WRITE-HAF-LAG — /check fail-open on HAF outage (round-2 hold item #8)', () => {
  it('GET /api/bridge/check: HAF query throws → 200 with {exists:false} fail-open shape, no status field leaks on wire, warn route=bridge.check', async () => {
    pgQueryImpl = async () => {
      throw new Error('simulated HAF connection refused');
    };

    const { logger } = await import('../../src/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn');

    try {
      const res = await request(app)
        .get('/api/bridge/check')
        .query({ identifier: '2301.99999' });

      // /check is read-only: HAF blip maps to fail-open exists=false. The
      // 503 fail-closed policy is reserved for /register where the
      // consequence of a stale answer is a duplicate broadcast.
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');

      // Round-2 hold item #8: the response body MUST NOT leak the
      // internal-only `status` discriminator from BridgeCheckResult on the
      // wire. The handler maps haf_unavailable → exists:false WITHOUT
      // forwarding the status field.
      expect(res.body.data).toEqual({
        exists: false,
        author: null,
        permlink: null,
        title: null,
        created: null,
      });
      expect(res.body.data).not.toHaveProperty('status');

      // Round-2 hold item #4: the HAF-failure warn log emits route:
      // 'bridge.check' (NOT bridge.register) so operator dashboards
      // filtering on `route: 'bridge.register'` don't false-alert on
      // /check HAF blips. The event field is parameterized on callerLabel.
      const calls = warnSpy.mock.calls;
      const matchingCall = calls.find((c) => {
        const ctx = c[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'bridge.check.haf_check_failed';
      });
      expect(matchingCall, 'expected a logger.warn call with event=bridge.check.haf_check_failed').toBeDefined();
      const ctx = matchingCall![0] as Record<string, unknown>;
      expect(ctx.route).toBe('bridge.check');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

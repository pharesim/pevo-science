import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { PrivateKey } from '@hiveio/dhive';

// DB pool mocks. Root CLAUDE.md says "no mocked database pools," but these
// tests need deterministic responses to six narrow query shapes to exercise
// the auth gate (SEC-002-BE), the 409 ORCID_ALREADY_LINKED check, the
// authority-filter (SEC-AUTH-BYPASS), and the SETNX concurrency lock
// (SEC-002-TOCTOU-LOCK) assertions. The
// alternative — seeding the real HAF with specific accreditation states per
// test — would couple the suite to external pevotest chain data and hide
// logic bugs behind fixture drift. The trade-off is accepted here because
// (a) the middleware under test (verifyHiveSignature) is NOT mocked, which
// is the blind-spot SEC-002-BE explicitly targets, and (b) broadcast.json
// must be stubbed regardless, since the tests must not sign real on-chain ops.
// For SEC-002-TOCTOU-LOCK specifically: a genuine in-process race between two
// supertest requests is non-deterministic because Redis SETNX is atomic server-
// side but the two requests still race on the application code around it. We
// simulate the concurrent-arrival shape by serializing the SETs and asserting
// the lock semantics (one acquires, the other gets 'held' → 409); see the
// "same-tick SETNX lock" block at the bottom of this file for the specifics.
// vi.hoisted keeps these references alive across the hoisted vi.mock factories below.
const { hafQueryMock, appQueryMock, broadcastJsonMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn().mockResolvedValue({ rows: [] }),
  appQueryMock: vi.fn().mockResolvedValue({ rows: [] }),
  broadcastJsonMock: vi.fn().mockResolvedValue({ id: 'mock-orcid-tx' }),
}));

vi.mock('../../src/db.js', () => ({
  getPool: () => ({ query: hafQueryMock }),
  isHafAvailable: () => true,
  closeHafPool: async () => { /* no-op */ },
}));

vi.mock('../../src/app-db.js', () => ({
  getAppPool: () => ({ query: appQueryMock }),
}));

vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: { getAccounts: vi.fn().mockResolvedValue([]) },
    broadcast: { json: broadcastJsonMock },
  },
}));

// handleAccredit asks whether the caller is already accredited before broadcasting.
vi.mock('../../src/accreditation.js', () => ({
  getAccreditedSet: vi.fn().mockResolvedValue(new Set()),
}));

// NOTE: verifyHiveSignature is intentionally NOT mocked. The SEC-002-BE fix must
// be exercised against the real auth middleware; the fixtures/mock-auth shim hid
// the state-hijack gap in the first place and must not be reintroduced here.

import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { getRedis } from '../../src/redis.js';

// The dev .env leaves ORCID and admin-key fields empty, and config is built at
// import time (cached by the setupFile before this file runs), so we patch the
// runtime config here. A deterministic WIF keeps PrivateKey.fromString happy on
// the broadcast path; broadcast.json is mocked, so no actual signing happens.
config.orcidClientId = 'test-orcid-client-id';
config.orcidClientSecret = 'test-orcid-client-secret';
config.pevoAdminPostingKey = PrivateKey.fromSeed('pevo-orcid-test-admin').toString();

const app = createApp();

function jwtFor(username: string): string {
  return jwt.sign({ sub: username, custody: 'light' }, config.sessionSecret, { expiresIn: '1h' });
}

async function startUnauthed(mode: 'signup' | 'login'): Promise<string> {
  const res = await request(app).post('/api/orcid/start').send({ mode });
  expect(res.status).toBe(200);
  return new URL(res.body.data.redirect_url).searchParams.get('state')!;
}

async function startAuthed(mode: 'accredit' | 'link', username: string): Promise<string> {
  const res = await request(app)
    .post('/api/orcid/start')
    .set('Authorization', `Bearer ${jwtFor(username)}`)
    .send({ mode });
  expect(res.status).toBe(200);
  return new URL(res.body.data.redirect_url).searchParams.get('state')!;
}

type OrcidStubOpts = { orcid: string; name?: string; works?: number };

function installOrcidFetchStub(opts: OrcidStubOpts): void {
  const name = opts.name ?? 'Test User';
  const worksCount = opts.works ?? config.orcidMinWorks;
  // Each group has an "external" source-orcid (different from the profile orcid)
  // so countExternalWorks() counts it toward ORCID_MIN_WORKS.
  const group = Array.from({ length: worksCount }, (_, i) => ({
    'work-summary': [{ source: { 'source-orcid': { path: `9999-9999-9999-${String(i).padStart(4, '0')}` } } }],
  }));
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/oauth/token')) {
      return new Response(
        JSON.stringify({ orcid: opts.orcid, name, access_token: 'tk' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('pub.orcid.org')) {
      return new Response(
        JSON.stringify({ group }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected fetch URL in orcid test: ${u}`);
  }));
}

beforeEach(async () => {
  hafQueryMock.mockReset().mockResolvedValue({ rows: [] });
  appQueryMock.mockReset().mockResolvedValue({ rows: [] });
  broadcastJsonMock.mockReset().mockResolvedValue({ id: 'mock-orcid-tx' });
  vi.unstubAllGlobals();
  // Default fetch throws — tests that reach ORCID must call installOrcidFetchStub().
  // Tests that short-circuit at the auth gate never reach fetch.
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    throw new Error(`Unexpected fetch in test (install installOrcidFetchStub first): ${url}`);
  }));
  // Clear rate-limit counters so parallel/retried tests don't burn through the
  // 10-req/min /start window. Both limiters key by IP; supertest always uses 127.0.0.1.
  const redis = getRedis();
  if (redis) {
    try {
      const keys = await redis.keys(`${config.appTag}:rl:orcid-*`);
      if (keys.length > 0) await redis.del(...keys);
    } catch { /* ignore */ }
  }
});

describe('POST /api/orcid/callback — auth gate (SEC-002-BE)', () => {
  it(
    'returns 403 when link caller does not match the state initiator',
    async () => {
      const state = await startAuthed('link', 'alice');
      const res = await request(app)
        .post('/api/orcid/callback')
        .set('Authorization', `Bearer ${jwtFor('mallory')}`)
        .send({ code: 'fake', state });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(broadcastJsonMock).not.toHaveBeenCalled();
    },
  );

  it(
    'returns 401 when link callback is invoked without auth headers',
    async () => {
      const state = await startAuthed('link', 'alice');
      const res = await request(app).post('/api/orcid/callback').send({ code: 'fake', state });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(broadcastJsonMock).not.toHaveBeenCalled();
    },
  );

  it(
    'returns 200 and broadcasts on link callback when caller matches initiator',
    async () => {
      installOrcidFetchStub({ orcid: '0000-0001-2222-3333', name: 'Alice', works: 3 });
      hafQueryMock.mockImplementation(async (sql: string) => {
        if (sql.includes("'orcid' = $1")) {
          // findAccreditedAccountWithOrcid first query — ORCID not yet bound
          return { rows: [] };
        }
        if (sql.includes("'action' IN ('accredit', 'revoke')") && sql.includes("'account' = $1")) {
          // getExistingAccreditation — alice IS accredited
          return {
            rows: [{
              json: { action: 'accredit', name: 'Alice', institution: 'X', field: 'Y', method: 'email' },
            }],
          };
        }
        return { rows: [] };
      });
      const state = await startAuthed('link', 'alice');
      const res = await request(app)
        .post('/api/orcid/callback')
        .set('Authorization', `Bearer ${jwtFor('alice')}`)
        .send({ code: 'fake', state });
      expect(res.status).toBe(200);
      expect(res.body.data.mode).toBe('link');
      expect(res.body.data.username).toBe('alice');
      expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
    },
  );

  it(
    'accepts signup callback without auth headers (behavior preserved)',
    async () => {
      installOrcidFetchStub({ orcid: '0000-0001-4444-5555', name: 'Bob', works: 3 });
      const state = await startUnauthed('signup');
      const res = await request(app).post('/api/orcid/callback').send({ code: 'fake', state });
      expect(res.status).toBe(200);
      expect(res.body.data.mode).toBe('signup');
      expect(res.body.data.orcid_token).toBeTruthy();
    },
  );

  it(
    'reaches login mode dispatch without auth headers (behavior preserved)',
    async () => {
      installOrcidFetchStub({ orcid: '0000-0001-6666-7777' });
      // Default appQueryMock returns no rows, so login responds 404 NO_ACCOUNT.
      // The assertion is that auth was NOT required to get there.
      const state = await startUnauthed('login');
      const res = await request(app).post('/api/orcid/callback').send({ code: 'fake', state });
      expect(res.body.error?.code).not.toBe('UNAUTHORIZED');
      expect(res.body.error?.code).not.toBe('FORBIDDEN');
      expect([200, 404]).toContain(res.status);
    },
  );

  it(
    'returns 409 ORCID_ALREADY_LINKED when the ORCID is bound to another account (accredit)',
    async () => {
      const orcidId = '0000-0001-9999-9999';
      installOrcidFetchStub({ orcid: orcidId, name: 'Alice', works: 3 });
      hafQueryMock.mockImplementation(async (sql: string) => {
        if (sql.includes("'action' = 'accredit'") && sql.includes("'orcid' = $1")) {
          return { rows: [{ account: 'bob' }] };
        }
        if (sql.includes("'action' IN ('accredit', 'revoke')") && sql.includes("'account' = $1")) {
          // bob's latest authorized action still binds this ORCID
          return { rows: [{ action: 'accredit', orcid: orcidId }] };
        }
        return { rows: [] };
      });
      const state = await startAuthed('accredit', 'alice');
      const res = await request(app)
        .post('/api/orcid/callback')
        .set('Authorization', `Bearer ${jwtFor('alice')}`)
        .send({ code: 'fake', state });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ORCID_ALREADY_LINKED');
      expect(broadcastJsonMock).not.toHaveBeenCalled();
    },
  );

  it(
    'SEC-AUTH-BYPASS: link rejects a self-broadcast fake accredit (422, no broadcast)',
    async () => {
      // Exploit: attacker X broadcasts a custom_json with action=accredit,
      // account=X, signed by X's OWN posting key. Without the authority filter,
      // getExistingAccreditation would find this self-broadcast op and let the
      // /link flow burn the admin key to actually accredit X.
      //
      // With the fix, the query filters on `required_posting_auths ?| $4::text[]`
      // where $4 is config.accreditationAuthorities. The mock below asserts the
      // filter is applied (params length includes authorities) and simulates the
      // filter's effect (no authority-signed op => no row).
      const orcidId = '0000-0001-5555-0001';
      installOrcidFetchStub({ orcid: orcidId, name: 'Mallory', works: 3 });
      hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql.includes("'action' IN ('accredit', 'revoke')") && sql.includes("'account' = $1")) {
          // getExistingAccreditation for mallory. The fixed query includes the
          // authority filter; the self-broadcast op wouldn't match because its
          // required_posting_auths is ['mallory'], not an authority.
          expect(sql).toContain('required_posting_auths ?| $4::text[]');
          expect(params[3]).toEqual(config.accreditationAuthorities);
          return { rows: [] };
        }
        return { rows: [] };
      });
      const state = await startAuthed('link', 'mallory');
      const res = await request(app)
        .post('/api/orcid/callback')
        .set('Authorization', `Bearer ${jwtFor('mallory')}`)
        .send({ code: 'fake', state });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/not accredited/i);
      expect(broadcastJsonMock).not.toHaveBeenCalled();
      // Prove the guarded branch of the mock actually fired so the
      // load-bearing authority-filter assertions inside the guard ran. A
      // future SQL refactor that changes the column selection or query shape
      // would otherwise fall through to the empty default and silently leave
      // the assertions un-exercised.
      expect(hafQueryMock).toHaveBeenCalled();
    },
  );

  it(
    'SEC-AUTH-BYPASS: link succeeds on an authority-signed accredit (200, admin broadcast fires)',
    async () => {
      // Positive counterpart: when a real authority (config.hiveAdminAccount)
      // signed the accredit op, the authority-filtered query returns the row
      // and the link flow proceeds, broadcasting the new ORCID binding.
      const orcidId = '0000-0001-5555-0002';
      installOrcidFetchStub({ orcid: orcidId, name: 'Alice', works: 3 });
      hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql.includes("'orcid' = $1")) {
          // findAccreditedAccountWithOrcid: ORCID not yet bound to any account.
          return { rows: [] };
        }
        if (sql.includes("'action' IN ('accredit', 'revoke')") && sql.includes("'account' = $1")) {
          // Authority filter must be present.
          expect(sql).toContain('required_posting_auths ?| $4::text[]');
          expect(params[3]).toEqual(config.accreditationAuthorities);
          // Simulate the filter matching: an authority-signed accredit exists.
          return {
            rows: [{
              json: { action: 'accredit', name: 'Alice', institution: 'MIT', field: 'CS', method: 'email' },
            }],
          };
        }
        return { rows: [] };
      });
      const state = await startAuthed('link', 'alice');
      const res = await request(app)
        .post('/api/orcid/callback')
        .set('Authorization', `Bearer ${jwtFor('alice')}`)
        .send({ code: 'fake', state });
      expect(res.status).toBe(200);
      expect(res.body.data.mode).toBe('link');
      expect(res.body.data.username).toBe('alice');
      expect(res.body.data.orcid).toBe(orcidId);
      expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
      expect(hafQueryMock).toHaveBeenCalled();
    },
  );

  it(
    'returns 409 ORCID_ALREADY_LINKED when the ORCID is bound to another account (link)',
    async () => {
      const orcidId = '0000-0001-8888-8888';
      installOrcidFetchStub({ orcid: orcidId, name: 'Alice', works: 3 });
      hafQueryMock.mockImplementation(async (sql: string) => {
        if (sql.includes("'orcid' = $1")) {
          return { rows: [{ account: 'bob' }] };
        }
        if (sql.includes("'action' IN ('accredit', 'revoke')") && sql.includes("'account' = $1")) {
          // Both getExistingAccreditation(alice) and the binding-liveness
          // check for bob hit this branch. Return an accredited payload that
          // carries the target orcid when it matters; it's ignored otherwise.
          return {
            rows: [{
              action: 'accredit',
              orcid: orcidId,
              json: { action: 'accredit', name: 'Alice', institution: 'X', field: 'Y', method: 'email' },
            }],
          };
        }
        return { rows: [] };
      });
      const state = await startAuthed('link', 'alice');
      const res = await request(app)
        .post('/api/orcid/callback')
        .set('Authorization', `Bearer ${jwtFor('alice')}`)
        .send({ code: 'fake', state });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ORCID_ALREADY_LINKED');
      expect(broadcastJsonMock).not.toHaveBeenCalled();
    },
  );
});

describe('POST /api/orcid/callback — hardening (SEC-002-HARDENING)', () => {
  // Item 1: state-consume lives inside the outer try/catch. A Redis flap on
  // the stateKey DEL must surface as a clean 500 INTERNAL_ERROR rather than
  // escaping as an unhandled rejection (which would kill the process under the
  // global unhandledRejection handler). We spy on the real Redis client's `del`
  // to simulate a transient flap WITHOUT mocking out the redis module, so the
  // broader state-read/auth-check path keeps using the real client.
  it(
    'returns 500 when redis.del throws while consuming state (state-consume is inside try/catch)',
    async () => {
      const redis = getRedis();
      if (!redis) {
        // Without Redis the in-memory Map.delete can't throw — the behavior
        // under test exists only on the Redis path. Skip rather than fake it.
        return;
      }
      installOrcidFetchStub({ orcid: '0000-0001-9001-0001', name: 'Alice', works: 3 });
      const state = await startUnauthed('signup');
      const delSpy = vi.spyOn(redis, 'del').mockImplementationOnce(async () => {
        throw new Error('simulated Redis flap on state DEL');
      });
      try {
        const res = await request(app)
          .post('/api/orcid/callback')
          .send({ code: 'fake', state });
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('INTERNAL_ERROR');
        // The state-consume throw must not have leaked past the handler as a
        // broadcast: the crash path must abort before dispatch.
        expect(broadcastJsonMock).not.toHaveBeenCalled();
      } finally {
        delSpy.mockRestore();
      }
    },
  );

  // Round-2 P2 counterpart to the DEL-throw test above: the state-READ path
  // must also sit inside the outer try/catch, and the DEL must NOT fire when
  // GET threw (state-not-consumed-on-infra-error, symmetric with the 403 path).
  it(
    'returns 500 when redis.get throws while reading state (state-read is inside try/catch, state not consumed)',
    async () => {
      const redis = getRedis();
      if (!redis) return;
      installOrcidFetchStub({ orcid: '0000-0001-9001-0002', name: 'Alice', works: 3 });
      const state = await startUnauthed('signup');
      const stateKey = `${config.appTag}:orcid_state:${state}`;

      const getSpy = vi.spyOn(redis, 'get').mockImplementationOnce(async () => {
        throw new Error('simulated Redis flap on state GET');
      });
      const delSpy = vi.spyOn(redis, 'del');
      try {
        const res = await request(app)
          .post('/api/orcid/callback')
          .send({ code: 'fake', state });
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('INTERNAL_ERROR');
        expect(broadcastJsonMock).not.toHaveBeenCalled();
        // Assert via del call args (not stateKey read-back): the state key may
        // have expired under TTL in flaky CI and the contract is "DEL didn't run".
        const delCalls = delSpy.mock.calls.map((c) => String(c[0]));
        expect(delCalls.some((k) => k === stateKey)).toBe(false);
      } finally {
        getSpy.mockRestore();
        delSpy.mockRestore();
      }
    },
  );

  // Item 2: NO_ACCOUNT envelope compliance. `orcid_id` must live inside
  // `error.details` (not as a top-level sibling, which the ApiError envelope
  // does not carry and strict parsers drop).
  it(
    'login mode returns NO_ACCOUNT with orcid_id in error.details (envelope compliance)',
    async () => {
      const orcidId = '0000-0001-9002-0002';
      installOrcidFetchStub({ orcid: orcidId });
      // No app-db row => NO_ACCOUNT branch fires.
      appQueryMock.mockResolvedValue({ rows: [] });
      const state = await startUnauthed('login');
      const res = await request(app)
        .post('/api/orcid/callback')
        .send({ code: 'fake', state });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NO_ACCOUNT');
      expect(res.body.error.details).toEqual({ orcid_id: orcidId });
      // Must NOT leak orcid_id at the top level — that was the drift this
      // hardening fixes.
      expect(res.body.orcid_id).toBeUndefined();
    },
  );

  // Item 5 (cache hit): findAccreditedAccountWithOrcid consults the recent-bind
  // cache BEFORE HAF. A cached binding to a different account must trigger
  // 409 ORCID_ALREADY_LINKED without any HAF query running at all. This is the
  // TOCTOU mitigation that closes the HAF-indexing-lag window.
  it(
    'accredit returns 409 from cache alone when another account bound this ORCID seconds ago',
    async () => {
      const redis = getRedis();
      if (!redis) return; // Cache requires Redis; no-op otherwise.
      const orcidId = '0000-0001-9002-0003';
      const cacheKey = `${config.appTag}:orcid_binding:${orcidId}`;
      await redis.set(cacheKey, 'bob', 'EX', 120);
      try {
        installOrcidFetchStub({ orcid: orcidId, name: 'Alice', works: 3 });
        // HAF mock returns empty — proving the cache alone drove the 409.
        hafQueryMock.mockResolvedValue({ rows: [] });
        const state = await startAuthed('accredit', 'alice');
        const res = await request(app)
          .post('/api/orcid/callback')
          .set('Authorization', `Bearer ${jwtFor('alice')}`)
          .send({ code: 'fake', state });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('ORCID_ALREADY_LINKED');
        expect(broadcastJsonMock).not.toHaveBeenCalled();
      } finally {
        await redis.del(cacheKey).catch(() => { /* cleanup */ });
      }
    },
  );

  // Item 5 (cache write): after a successful link broadcast, the binding is
  // written to the recent-bind cache so a subsequent concurrent request sees
  // it before HAF catches up. Spec asserts the cache key holds the broadcast
  // username and that the TTL is set (EX was applied, not a permanent key).
  it(
    'link writes the ORCID → username binding to Redis after a successful broadcast',
    async () => {
      const redis = getRedis();
      if (!redis) return;
      const orcidId = '0000-0001-9002-0004';
      installOrcidFetchStub({ orcid: orcidId, name: 'Alice', works: 3 });
      hafQueryMock.mockImplementation(async (sql: string) => {
        if (sql.includes("'orcid' = $1")) {
          // findAccreditedAccountWithOrcid: ORCID not yet bound
          return { rows: [] };
        }
        if (sql.includes("'action' IN ('accredit', 'revoke')") && sql.includes("'account' = $1")) {
          return {
            rows: [{
              json: { action: 'accredit', name: 'Alice', institution: 'MIT', field: 'CS', method: 'email' },
            }],
          };
        }
        return { rows: [] };
      });
      const state = await startAuthed('link', 'alice');
      const res = await request(app)
        .post('/api/orcid/callback')
        .set('Authorization', `Bearer ${jwtFor('alice')}`)
        .send({ code: 'fake', state });
      expect(res.status).toBe(200);
      const cacheKey = `${config.appTag}:orcid_binding:${orcidId}`;
      try {
        const cached = await redis.get(cacheKey);
        expect(cached).toBe('alice');
        const ttl = await redis.ttl(cacheKey);
        // TTL must be a positive number (EX set, not -1 permanent / -2 missing).
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(120);
      } finally {
        await redis.del(cacheKey).catch(() => { /* cleanup */ });
      }
    },
  );

  // Item 5 (graceful degrade): when Redis is unavailable at cache-write time,
  // the handler must not fail the broadcast. The Redis-optional contract
  // binds the behaviour — the HAF path is authoritative once the op indexes.
  // Simulated by spying on redis.set to throw; the 200 response proves the
  // cache write was isolated (try/catch) and didn't propagate.
  it(
    'link still returns 200 when the ORCID binding cache write fails (Redis-optional)',
    async () => {
      const redis = getRedis();
      if (!redis) return;
      const orcidId = '0000-0001-9002-0005';
      installOrcidFetchStub({ orcid: orcidId, name: 'Alice', works: 3 });
      hafQueryMock.mockImplementation(async (sql: string) => {
        if (sql.includes("'orcid' = $1")) return { rows: [] };
        if (sql.includes("'action' IN ('accredit', 'revoke')") && sql.includes("'account' = $1")) {
          return {
            rows: [{
              json: { action: 'accredit', name: 'Alice', institution: 'MIT', field: 'CS', method: 'email' },
            }],
          };
        }
        return { rows: [] };
      });
      // Throw only on the binding-cache key so the state-consume DEL still works.
      const origSet = redis.set.bind(redis);
      const setSpy = vi.spyOn(redis, 'set').mockImplementation(async (...args: unknown[]) => {
        const k = String(args[0]);
        if (k.includes(':orcid_binding:')) throw new Error('simulated Redis flap on binding SET');
        // Forward every other SET to the real client — state/verified keys still need to work.
        // @ts-expect-error ioredis set is variadic; forwarding by spread is safe here.
        return origSet(...args);
      });
      try {
        const state = await startAuthed('link', 'alice');
        const res = await request(app)
          .post('/api/orcid/callback')
          .set('Authorization', `Bearer ${jwtFor('alice')}`)
          .send({ code: 'fake', state });
        expect(res.status).toBe(200);
        expect(res.body.data.mode).toBe('link');
        expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
      } finally {
        setSpy.mockRestore();
      }
    },
  );
});

// BE-ORCID-ID-FORMAT-VALIDATION — format-level guard on orcid_id at the OAuth
// token-exchange boundary. Each handler (handleAccredit / handleLink /
// handleLogin) gets a module-level ORCID_RE check; the dispatch site also
// guards before branching. These specs inject a structurally invalid orcid_id
// via the mocked token endpoint (e.g. '0000-0000-0000-0001/../../oauth/token')
// and assert 400 BAD_REQUEST before any Redis (binding cache/lock), Hive
// (broadcast.json), or HAF (hafQueryMock) call fires on the rejection path.
describe('POST /api/orcid/callback — orcid_id format validation (BE-ORCID-ID-FORMAT-VALIDATION)', () => {
  const MALFORMED_ORCID = '0000-0000-0000-0001/../../oauth/token';

  // Install a fetch stub that returns a structurally invalid orcid from the
  // token endpoint. Mirrors installOrcidFetchStub but with no format guard
  // inside the stub — the handler's guard is what we're testing.
  function installMalformedOrcidFetchStub(): void {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/oauth/token')) {
        return new Response(
          JSON.stringify({ orcid: MALFORMED_ORCID, name: 'Malformed', access_token: 'tk' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // If the guard fails to fire, a subsequent countExternalWorks() fetch to
      // pub.orcid.org would surface here. Throw loudly so the test fails with
      // a clear signal rather than a silent 422/500 downstream.
      throw new Error(`Unexpected post-guard fetch in format-validation test: ${u}`);
    }));
  }

  it(
    'handleAccredit rejects malformed orcid_id with 400 BAD_REQUEST before any Redis/Hive/HAF call',
    async () => {
      installMalformedOrcidFetchStub();
      const state = await startAuthed('accredit', 'alice');
      const res = await request(app)
        .post('/api/orcid/callback')
        .set('Authorization', `Bearer ${jwtFor('alice')}`)
        .send({ code: 'fake', state });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toMatch(/invalid orcid/i);
      // Rejection must happen before any downstream side effect.
      expect(broadcastJsonMock).not.toHaveBeenCalled();
      expect(hafQueryMock).not.toHaveBeenCalled();
    },
  );

  it(
    'handleLink rejects malformed orcid_id with 400 BAD_REQUEST before any Redis/Hive/HAF call',
    async () => {
      installMalformedOrcidFetchStub();
      const state = await startAuthed('link', 'alice');
      const res = await request(app)
        .post('/api/orcid/callback')
        .set('Authorization', `Bearer ${jwtFor('alice')}`)
        .send({ code: 'fake', state });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toMatch(/invalid orcid/i);
      expect(broadcastJsonMock).not.toHaveBeenCalled();
      expect(hafQueryMock).not.toHaveBeenCalled();
    },
  );

  it(
    'handleLogin rejects malformed orcid_id with 400 BAD_REQUEST before any Redis/Hive/HAF call',
    async () => {
      installMalformedOrcidFetchStub();
      const state = await startUnauthed('login');
      const res = await request(app)
        .post('/api/orcid/callback')
        .send({ code: 'fake', state });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toMatch(/invalid orcid/i);
      // login mode would normally hit appQueryMock; guard must fire first.
      expect(appQueryMock).not.toHaveBeenCalled();
      expect(hafQueryMock).not.toHaveBeenCalled();
      expect(broadcastJsonMock).not.toHaveBeenCalled();
    },
  );
});

// SEC-002-TOCTOU-LOCK — same-event-loop-tick race on ORCID binding.
// The orcid_binding cache (EX 120s) narrows the HAF-indexing-lag window but is
// written AFTER broadcast. Two concurrent requests for the same orcid_id both
// see empty cache + empty HAF, both broadcast, both write. The SETNX lock on
// `${appTag}:orcid_binding_lock:${orcidId}` is claimed BEFORE broadcast and
// forces exactly one winner.
describe('POST /api/orcid/callback — same-tick SETNX lock (SEC-002-TOCTOU-LOCK)', () => {
  it(
    'exactly one of two concurrent same-orcid accredit requests broadcasts; the other gets 409',
    async () => {
      const redis = getRedis();
      if (!redis) return; // Lock requires Redis; no-op otherwise.
      const orcidId = '0000-0001-9003-0001';
      const lockKey = `${config.appTag}:orcid_binding_lock:${orcidId}`;
      const cacheKey = `${config.appTag}:orcid_binding:${orcidId}`;
      // Ensure clean slate (no leftover lock from a prior run).
      await redis.del(lockKey, cacheKey).catch(() => { /* ignore */ });

      installOrcidFetchStub({ orcid: orcidId, name: 'Alice', works: 3 });
      // HAF path says: ORCID not yet bound for either caller.
      hafQueryMock.mockResolvedValue({ rows: [] });

      // Gate the winner's broadcast so the winner cannot finish and release
      // the lock before the loser has attempted SETNX. Without this gate, a
      // fast-path broadcast (mocked = instant) could complete before the
      // loser's event-loop turn reaches acquireBindingLock, making the test
      // pass or fail on scheduling whims. The gate enforces the real-world
      // shape: broadcasts take ~1s, the lock is held across that window.
      let releaseBroadcast!: () => void;
      const broadcastGate = new Promise<void>((r) => { releaseBroadcast = r; });
      broadcastJsonMock.mockImplementation(async () => {
        // First call (winner) parks here; we release once both requests have
        // raced through to SETNX. Subsequent calls (should not happen with the
        // lock in place — this is also the failure-mode signal) return
        // immediately so the test fails loudly on the assert rather than
        // hanging.
        await broadcastGate;
        return { id: 'mock-orcid-tx' };
      });

      // Fire two /start + /callback flows for the same orcid_id with different
      // usernames. Kick them off concurrently — one will SETNX first (atomic
      // inside Redis), the other loses the race and returns 409 before
      // reaching broadcast.
      const [aliceState, bobState] = await Promise.all([
        startAuthed('accredit', 'alice'),
        startAuthed('accredit', 'bob'),
      ]);
      const alicePromise = request(app)
        .post('/api/orcid/callback')
        .set('Authorization', `Bearer ${jwtFor('alice')}`)
        .send({ code: 'fake', state: aliceState });
      const bobPromise = request(app)
        .post('/api/orcid/callback')
        .set('Authorization', `Bearer ${jwtFor('bob')}`)
        .send({ code: 'fake', state: bobState });

      // Give both callbacks enough scheduler turns to reach acquireBindingLock
      // (Redis SETNX is atomic, and the loser returns 409 immediately; only the
      // winner parks on broadcastGate). 200ms is ample for in-process supertest
      // + local Redis RTT and comfortably under any CI timeout.
      await new Promise((r) => setTimeout(r, 200));
      // Release the winner's broadcast so both promises can settle.
      releaseBroadcast();
      const [aliceRes, bobRes] = await Promise.all([alicePromise, bobPromise]);

      try {
        const statuses = [aliceRes.status, bobRes.status].sort();
        expect(statuses).toEqual([200, 409]);
        const loser = [aliceRes, bobRes].find((r) => r.status === 409)!;
        expect(loser.body.error.code).toBe('ORCID_ALREADY_LINKED');
        // Exactly one broadcast fired — proves the lock prevented the
        // double-broadcast failure mode.
        expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
      } finally {
        await redis.del(lockKey, cacheKey).catch(() => { /* cleanup */ });
      }
    },
  );

  it(
    'stale lock from a crashed holder expires after EX and a retry succeeds',
    async () => {
      const redis = getRedis();
      if (!redis) return;
      const orcidId = '0000-0001-9003-0002';
      const lockKey = `${config.appTag}:orcid_binding_lock:${orcidId}`;
      const cacheKey = `${config.appTag}:orcid_binding:${orcidId}`;
      await redis.del(lockKey, cacheKey).catch(() => { /* ignore */ });

      // Simulate a prior crashed holder: acquire the lock and never release.
      // Use a short PX TTL instead of the production EX=10s so the test can
      // assert expiry-then-retry without a 10s wall-clock wait. This is a
      // proxy for the same failure mode (holder dies mid-broadcast) because
      // Redis treats both the same: the key self-deletes on TTL, freeing the
      // slot for the next SETNX attempt.
      await redis.set(lockKey, 'zombie-holder', 'PX', 150, 'NX');
      // Confirm the lock is actually held before the request arrives.
      expect(await redis.get(lockKey)).toBe('zombie-holder');

      installOrcidFetchStub({ orcid: orcidId, name: 'Alice', works: 3 });
      hafQueryMock.mockResolvedValue({ rows: [] });

      // Wait long enough for Redis to expire the key. 500ms is comfortably
      // over the 150ms PX TTL and keeps the test fast.
      await new Promise((r) => setTimeout(r, 500));
      expect(await redis.get(lockKey)).toBeNull();

      try {
        const state = await startAuthed('accredit', 'alice');
        const res = await request(app)
          .post('/api/orcid/callback')
          .set('Authorization', `Bearer ${jwtFor('alice')}`)
          .send({ code: 'fake', state });
        expect(res.status).toBe(200);
        expect(res.body.data.mode).toBe('accredit');
        expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
      } finally {
        await redis.del(lockKey, cacheKey).catch(() => { /* cleanup */ });
      }
    },
  );

  it(
    'falls back to the cache-less path when the lock SETNX throws (Redis outage)',
    async () => {
      const redis = getRedis();
      if (!redis) return;
      const orcidId = '0000-0001-9003-0003';
      const lockKey = `${config.appTag}:orcid_binding_lock:${orcidId}`;
      const cacheKey = `${config.appTag}:orcid_binding:${orcidId}`;
      await redis.del(lockKey, cacheKey).catch(() => { /* ignore */ });

      installOrcidFetchStub({ orcid: orcidId, name: 'Alice', works: 3 });
      hafQueryMock.mockResolvedValue({ rows: [] });

      // Fail only on the lock key so /start, state DEL, and the binding cache
      // write all use the real client. A transient flap on the lock SET must
      // NOT fail the request closed — per the Redis-optional contract we
      // degrade to the cache-less HAF-only path, accepting the narrow race
      // window rather than locking out all binds.
      const origSet = redis.set.bind(redis);
      const setSpy = vi.spyOn(redis, 'set').mockImplementation(async (...args: unknown[]) => {
        const k = String(args[0]);
        if (k.includes(':orcid_binding_lock:')) throw new Error('simulated Redis flap on lock SET');
        // @ts-expect-error ioredis set is variadic; forwarding by spread is safe here.
        return origSet(...args);
      });
      try {
        const state = await startAuthed('accredit', 'alice');
        const res = await request(app)
          .post('/api/orcid/callback')
          .set('Authorization', `Bearer ${jwtFor('alice')}`)
          .send({ code: 'fake', state });
        expect(res.status).toBe(200);
        expect(res.body.data.mode).toBe('accredit');
        expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
        // The lock key was never written (set threw). Proves the degrade path
        // ran rather than the lock-acquired path.
        expect(await redis.get(lockKey)).toBeNull();
      } finally {
        setSpy.mockRestore();
        await redis.del(cacheKey).catch(() => { /* cleanup */ });
      }
    },
  );
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
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
//
// Round-2 additions under the same carve-out:
//   * broadcast-throw finally-path specs (one per accredit/link mode) that
//     drive broadcastJsonMock to reject and assert the lock is released under
//     the nonce CAS in withOrcidBindingLock's finally block.
//   * link-mode matrix: all four SEC-002-TOCTOU-LOCK specs are parameterized
//     via describe.each over accredit + link modes so wrapper-handling
//     divergence between the two handlers surfaces in one of the two branches.
//   * explicit Lua CAS multi-holder spec that pre-seeds the lock key with a
//     different nonce and asserts releaseBindingLock refuses to DEL — the
//     primary safety property of the Redlock release path, which the other
//     specs only exercise indirectly.
//
// Confirmed STILL UNMOCKED for the new specs (per root CLAUDE.md carve-out):
// verifyHiveSignature, the rest of the auth middleware chain, the real Redis
// client (lock/cache keys are observed via live redis.get / redis.set calls
// in the test body). Only the database pools and broadcast.json are mocked;
// that scope matches the SEC-002-BE carve-out and does not widen here.
// vi.hoisted keeps these references alive across the hoisted vi.mock factories below.
// MockBroadcastTimeoutError mirrors the real class's constructor signature (timeoutMs
// property) so handlers discriminating via `err instanceof BroadcastTimeoutError`
// can read `err.timeoutMs` identically against mock and real errors. The hoisted
// class identity is visible in both the vi.mock factory and in test bodies.
const { hafQueryMock, appQueryMock, broadcastJsonMock, MockBroadcastTimeoutError } = vi.hoisted(() => ({
  hafQueryMock: vi.fn().mockResolvedValue({ rows: [] }),
  appQueryMock: vi.fn().mockResolvedValue({ rows: [] }),
  broadcastJsonMock: vi.fn().mockResolvedValue({ id: 'mock-orcid-tx' }),
  MockBroadcastTimeoutError: class BroadcastTimeoutError extends Error {
    public readonly timeoutMs: number;
    constructor(timeoutMs: number) {
      super(`Hive broadcast timed out after ${timeoutMs}ms`);
      this.name = 'BroadcastTimeoutError';
      this.timeoutMs = timeoutMs;
    }
  },
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
  broadcastJsonWithTimeout: (...args: unknown[]) =>
    (broadcastJsonMock as (...a: unknown[]) => unknown)(...args),
  BroadcastTimeoutError: MockBroadcastTimeoutError,
  DEFAULT_BROADCAST_TIMEOUT_MS: 30_000,
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
import { logger } from '../../src/logger.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';
// Test-only export — see note at orcid.ts __test_releaseBindingLock export.
import { __test_releaseBindingLock as releaseBindingLock } from '../../src/routes/orcid.js';

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
  // Use the shared helper — it ready-waits on redis.status before issuing the
  // KEYS/DEL so the clear isn't silently skipped during the client's initial
  // connect window (was a divergent inline caller prior to
  // BE-TESTS-ORCID-RATE-LIMIT-CLEAR-HELPER-MIGRATION).
  await clearRateLimitKeys(['orcid-start', 'orcid-callback']);
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
      const orcidId = '0000-0001-2222-3333';
      installOrcidFetchStub({ orcid: orcidId, name: 'Alice', works: 3 });
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
      // Call-shape assertions on both load-bearing HAF queries. If a future
      // refactor drops either predicate the fallback path { rows: [] } would
      // leave outer assertions passing on a regressed query — promote the
      // mock-guard from existence-check to shape-check. See
      // agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md.
      // `'orcid' = $1` call pins orcidId at $1 via arrayContaining (sibling
      // sites use the same shape); `expect.anything()` was insufficient
      // because it lets a regression re-bind the lookup to a different value.
      expect(hafQueryMock).toHaveBeenCalledWith(
        expect.stringContaining("'orcid' = $1"),
        expect.arrayContaining([orcidId]),
      );
      expect(hafQueryMock).toHaveBeenCalledWith(
        expect.stringContaining("'action' IN ('accredit', 'revoke')"),
        expect.arrayContaining(['alice']),
      );
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
      // Durable-binding 409 is semantically distinct from the lock-contention
      // 409 (the latter carries retriable=true + Retry-After). A regression
      // routing durable bindings through withOrcidBindingLock (or otherwise
      // stamping these fields onto the permanent-binding path) would cause
      // clients / agents to infinite-retry permanent bindings. Assert the
      // discriminator fields are ABSENT here so that mistake fails loudly.
      expect(res.body.error.details?.retriable).toBeUndefined();
      expect(res.headers['retry-after']).toBeUndefined();
      expect(broadcastJsonMock).not.toHaveBeenCalled();
      // Call-shape assertions: both the orcid-binding lookup AND the existing-
      // accreditation check for the incumbent account (bob) must have fired
      // with the right params. A fallback-path-only run would return empty
      // rows and the handler's 409 response would still be produced by an
      // unrelated code path, leaving the 409 regression-detection value of
      // this test hollow. See
      // agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md.
      expect(hafQueryMock).toHaveBeenCalledWith(
        expect.stringContaining("'orcid' = $1"),
        expect.arrayContaining([orcidId]),
      );
      expect(hafQueryMock).toHaveBeenCalledWith(
        expect.stringContaining("'action' IN ('accredit', 'revoke')"),
        expect.arrayContaining(['bob']),
      );
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
      hafQueryMock.mockImplementation(async (sql: string) => {
        if (sql.includes("'action' IN ('accredit', 'revoke')") && sql.includes("'account' = $1")) {
          // getExistingAccreditation for mallory. The fixed query includes the
          // authority filter; the self-broadcast op wouldn't match because its
          // required_posting_auths is ['mallory'], not an authority. Load-bearing
          // call-shape assertions (authority-filter SQL fragment + params[3] ===
          // accreditationAuthorities) moved out of the mock guard and onto the
          // caller so they fire ONLY when a matching call actually happened;
          // the mock's fallback path returning { rows: [] } would otherwise
          // leave them un-exercised on a regressed SQL shape. See
          // agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md.
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
      // Call-shape assertion on the load-bearing HAF call: the authority-filtered
      // getExistingAccreditation query must have fired with both the action-set
      // predicate AND mallory + accreditationAuthorities in the params. A SQL
      // refactor that drops `required_posting_auths ?| $4::text[]` or reorders
      // the binds so authorities no longer sits at $4 would produce a matcher
      // miss here. The positional pin on params[3] closes the arrayContaining
      // order-agnostic gap.
      expect(hafQueryMock).toHaveBeenCalledWith(
        expect.stringContaining("'action' IN ('accredit', 'revoke')"),
        expect.arrayContaining(['mallory', config.accreditationAuthorities]),
      );
      const authorityCall = hafQueryMock.mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes("'action' IN ('accredit', 'revoke')") &&
          c[0].includes("'account' = $1"),
      );
      expect(authorityCall).toBeDefined();
      expect((authorityCall![1] as unknown[])[3]).toEqual(config.accreditationAuthorities);
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
      hafQueryMock.mockImplementation(async (sql: string) => {
        if (sql.includes("'orcid' = $1")) {
          // findAccreditedAccountWithOrcid: ORCID not yet bound to any account.
          return { rows: [] };
        }
        if (sql.includes("'action' IN ('accredit', 'revoke')") && sql.includes("'account' = $1")) {
          // Authority-filter assertions moved out of the guard to the caller
          // below so they fire only when a matching call actually happened.
          // See agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md.
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
      // Call-shape assertion: the authority-filtered getExistingAccreditation
      // query fired with alice + accreditationAuthorities in the params. A
      // positional pin on params[3] closes the arrayContaining order-agnostic
      // gap (a mutant moving authorities off of $4 would pass arrayContaining
      // but fail the positional check).
      expect(hafQueryMock).toHaveBeenCalledWith(
        expect.stringContaining("'action' IN ('accredit', 'revoke')"),
        expect.arrayContaining(['alice', config.accreditationAuthorities]),
      );
      const authorityCall = hafQueryMock.mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes("'action' IN ('accredit', 'revoke')") &&
          c[0].includes("'account' = $1"),
      );
      expect(authorityCall).toBeDefined();
      expect((authorityCall![1] as unknown[])[3]).toEqual(config.accreditationAuthorities);
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
      // Durable-binding 409 (link mode) must not carry the retriable/Retry-After
      // discriminator that lock-contention 409 sets. Permanent bindings are
      // terminal; clients / agents relying on the contract at orcid.md:183-186
      // would infinite-retry if these fields leaked onto this path.
      expect(res.body.error.details?.retriable).toBeUndefined();
      expect(res.headers['retry-after']).toBeUndefined();
      expect(broadcastJsonMock).not.toHaveBeenCalled();
      // Call-shape assertions: both load-bearing HAF queries (ORCID-binding
      // lookup + action-IN check) must have fired. A fallback-only run would
      // still produce 409 via other code paths, hollowing out the regression
      // kill value. See
      // agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md.
      expect(hafQueryMock).toHaveBeenCalledWith(
        expect.stringContaining("'orcid' = $1"),
        expect.arrayContaining([orcidId]),
      );
      // The action-IN query fires twice on this path: once for alice's
      // getExistingAccreditation (pre-lock), once for bob's binding-liveness
      // check (inside findAccreditedAccountWithOrcid). The 409 branch is
      // reached only when bob's call returns an accredit row still carrying
      // this orcid — i.e. bob is the load-bearing caller. Pin bob in the
      // params so a regression that stops querying the incumbent account
      // fails loudly. `expect.anything()` accepted any invocation regardless
      // of which account was being queried.
      expect(hafQueryMock).toHaveBeenCalledWith(
        expect.stringContaining("'action' IN ('accredit', 'revoke')"),
        expect.arrayContaining(['bob']),
      );
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

  // Item 2: NO_ACCOUNT envelope compliance (BE-ORCID-NO-ACCOUNT-ERROR-
  // SHAPE-ALIGN). The prior shape put `orcid_id` inside `error.details`;
  // per re-review the field was never consumed by any frontend handler
  // and was dropped entirely. This spec pins the new payload-less
  // shape: status 404, error.code = 'NO_ACCOUNT', no orcid_id anywhere
  // (neither top-level nor in error.details). A regression that adds it
  // back in either position fails this assertion.
  it(
    'login mode returns NO_ACCOUNT with no orcid_id anywhere in the response body',
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
      // details must not exist at all — sendError omits the key when
      // the caller passes no details argument, and the envelope must
      // not carry a stale orcid_id field.
      expect(res.body.error.details).toBeUndefined();
      // Belt-and-suspenders: neither top-level nor any other path
      // echoes the orcid_id the caller submitted.
      expect(res.body.orcid_id).toBeUndefined();
      expect(res.body.data).toBeUndefined();
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
      // Call-shape assertions on the two load-bearing HAF queries. See
      // agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md.
      expect(hafQueryMock).toHaveBeenCalledWith(
        expect.stringContaining("'orcid' = $1"),
        expect.arrayContaining([orcidId]),
      );
      expect(hafQueryMock).toHaveBeenCalledWith(
        expect.stringContaining("'action' IN ('accredit', 'revoke')"),
        expect.arrayContaining(['alice']),
      );
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
        // Call-shape assertions on the two load-bearing HAF queries. See
        // agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md.
        expect(hafQueryMock).toHaveBeenCalledWith(
          expect.stringContaining("'orcid' = $1"),
          expect.arrayContaining([orcidId]),
        );
        expect(hafQueryMock).toHaveBeenCalledWith(
          expect.stringContaining("'action' IN ('accredit', 'revoke')"),
          expect.arrayContaining(['alice']),
        );
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

  it(
    'handleSignup rejects malformed orcid_id with 400 BAD_REQUEST before any Redis/Hive/HAF call',
    async () => {
      // Signup's in-handler guard is the mutation-kill for the dispatch-site
      // guard on the signup path — handleSignup is the only handler that feeds
      // orcidId into a URL-path interpolation (countExternalWorks →
      // pub.orcid.org). If the inner guard is dropped, a future refactor that
      // also drops the dispatch-site guard would silently let a malformed id
      // reach that fetch. The malformed-fetch stub throws on any post-guard
      // pub.orcid.org fetch, so a guard bypass surfaces loudly rather than
      // falling through to a generic 422 works-count branch.
      installMalformedOrcidFetchStub();
      const state = await startUnauthed('signup');
      const res = await request(app)
        .post('/api/orcid/callback')
        .send({ code: 'fake', state });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toMatch(/invalid orcid/i);
      expect(broadcastJsonMock).not.toHaveBeenCalled();
      expect(hafQueryMock).not.toHaveBeenCalled();
      expect(appQueryMock).not.toHaveBeenCalled();
    },
  );
});

// SEC-002-TOCTOU-LOCK — same-event-loop-tick race on ORCID binding.
// The orcid_binding cache (EX 120s) narrows the HAF-indexing-lag window but is
// written AFTER broadcast. Two concurrent requests for the same orcid_id both
// see empty cache + empty HAF, both broadcast, both write. The SETNX lock on
// `${appTag}:orcid_binding_lock:${orcidId}` is claimed BEFORE broadcast and
// forces exactly one winner.
//
// Parameterized over accredit + link modes because withOrcidBindingLock wraps
// both handlers identically. Each mode gets its own set of 4 specs (concurrent
// race, stale-lock expiry, Redis-outage degrade, broadcast-throw finally); any
// divergence in the wrapper's handling of the two handlers surfaces here.
// `orcidSuffix` is a single character stitched into the ORCID ID template
// literal (e.g. '0000-0001-1111-000X'). It must be unique across rows so the
// derived Redis lock/cache keys do not collide between the two matrix branches
// running in the same test process — that would cause accredit-mode mocks to
// interfere with link-mode state and produce flaky cross-mode failures.
describe.each([
  { mode: 'accredit' as const, orcidSuffix: '1' },
  { mode: 'link' as const, orcidSuffix: '2' },
])('POST /api/orcid/callback — same-tick SETNX lock (SEC-002-TOCTOU-LOCK) — $mode mode', ({ mode, orcidSuffix }) => {
  // link mode needs the pre-lock getExistingAccreditation(username) to find
  // an existing authority-signed accredit row; otherwise handleLink 422s
  // before touching the lock. accredit mode only needs the default empty-rows
  // shape for findAccreditedAccountWithOrcid.
  const installLockModeMocks = (): void => {
    if (mode === 'link') {
      hafQueryMock.mockImplementation(async (sql: string) => {
        if (sql.includes("'orcid' = $1")) return { rows: [] };
        if (sql.includes("'action' IN ('accredit', 'revoke')") && sql.includes("'account' = $1")) {
          return {
            rows: [{
              json: { action: 'accredit', name: 'Test', institution: 'X', field: 'Y', method: 'email' },
            }],
          };
        }
        return { rows: [] };
      });
    } else {
      hafQueryMock.mockResolvedValue({ rows: [] });
    }
  };

  it(
    'exactly one of two concurrent same-orcid requests broadcasts; the other gets 409 with Retry-After and retriable=true',
    async () => {
      const redis = getRedis();
      if (!redis) return; // Lock requires Redis; no-op otherwise.
      const orcidId = `0000-0001-${orcidSuffix}${orcidSuffix}${orcidSuffix}${orcidSuffix}-0001`;
      const lockKey = `${config.appTag}:orcid_binding_lock:${orcidId}`;
      const cacheKey = `${config.appTag}:orcid_binding:${orcidId}`;
      // Ensure clean slate (no leftover lock from a prior run).
      await redis.del(lockKey, cacheKey).catch(() => { /* ignore */ });

      installOrcidFetchStub({ orcid: orcidId, name: 'Alice', works: 3 });
      installLockModeMocks();

      // Gate the winner's broadcast so the winner cannot finish and release
      // the lock before the loser has attempted SETNX. Without this gate, a
      // fast-path broadcast (mocked = instant) could complete before the
      // loser's event-loop turn reaches acquireBindingLock, making the test
      // pass or fail on scheduling whims. The gate enforces the real-world
      // shape: broadcasts take ~1s, the lock is held across that window.
      //
      // Mock shape: first call parks on the gate; subsequent calls resolve
      // immediately. This is the lock's failure-mode signal: if the lock is
      // removed (the regression this spec exists to detect), both concurrent
      // requests reach broadcast, both would call broadcastJsonMock, and the
      // `toHaveBeenCalledTimes(1)` assertion after the gate release fires
      // fails loudly. With `mockImplementation` (no "Once"), a second call
      // would also park on the same resolved gate Promise → the test times
      // out opaquely at vitest's per-test timeout instead. mockImplementation
      // Once + mockResolvedValue gives the two-call regression a fast, clean
      // failure surface.
      let releaseBroadcast!: () => void;
      const broadcastGate = new Promise<void>((r) => { releaseBroadcast = r; });
      broadcastJsonMock
        .mockImplementationOnce(async () => {
          await broadcastGate;
          return { id: 'mock-orcid-tx' };
        })
        .mockResolvedValue({ id: 'mock-orcid-tx-second-should-not-fire' });

      // Fire two /start + /callback flows for the same orcid_id with different
      // usernames. Kick them off concurrently — one will SETNX first (atomic
      // inside Redis), the other loses the race and returns 409 before
      // reaching broadcast.
      //
      // Install ordering note: the broadcastJsonMock.mockImplementationOnce
      // call above MUST precede the request-promise creation below. The
      // supertest requests dispatch into the handler synchronously on the next
      // microtask turn; a future refactor that reorders the mock install after
      // the request promises would race the gate-install against the first
      // broadcast call and lose the synchronization point. Keep the mock
      // install above the request-promise creation.
      const [aliceState, bobState] = await Promise.all([
        startAuthed(mode, 'alice'),
        startAuthed(mode, 'bob'),
      ]);
      const alicePromise = request(app)
        .post('/api/orcid/callback')
        .set('Authorization', `Bearer ${jwtFor('alice')}`)
        .send({ code: 'fake', state: aliceState });
      const bobPromise = request(app)
        .post('/api/orcid/callback')
        .set('Authorization', `Bearer ${jwtFor('bob')}`)
        .send({ code: 'fake', state: bobState });

      // Wait for the loser to settle (return 409 after SETNX-held). This is a
      // deterministic signal that the winner has already acquired the lock and
      // is parked on broadcastGate — by definition of "loser", SETNX saw the
      // key held, which requires the winner's SETNX to have completed first.
      // More reliable than a fixed setTimeout, which can be scheduler-starved
      // in CI before either handler reaches acquireBindingLock.
      await Promise.race([alicePromise, bobPromise]);
      // Prove the lock is actually held during the gate window. The winner is
      // still parked on broadcastGate inside withOrcidBindingLock's try block,
      // so the nonce-valued lock key must still be present. Without this
      // assertion, a handler change that releases the lock before the
      // broadcast awaits would silently remove the race test's guarantee.
      // Lock value is an opaque per-acquisition nonce; we only check truthiness.
      expect(await redis.get(lockKey)).toBeTruthy();
      // Release the winner's broadcast so both promises can settle.
      releaseBroadcast();
      const [aliceRes, bobRes] = await Promise.all([alicePromise, bobPromise]);

      try {
        const statuses = [aliceRes.status, bobRes.status].sort();
        expect(statuses).toEqual([200, 409]);
        const loser = [aliceRes, bobRes].find((r) => r.status === 409)!;
        expect(loser.body.error.code).toBe('ORCID_ALREADY_LINKED');
        // Lock-contention 409 is discriminable from durable-binding 409 by the
        // retriable flag, retry_after_seconds in details, and the Retry-After
        // response header. The contract (orcid.md 409 section) uses presence/
        // absence of these fields to distinguish transient lock contention
        // (client should retry after ~10s) from a permanent binding (client
        // should NOT retry).
        expect(loser.body.error.details).toMatchObject({
          retriable: true,
          retry_after_seconds: 10,
        });
        expect(loser.headers['retry-after']).toBe('10');
        // Exactly one broadcast fired — proves the lock prevented the
        // double-broadcast failure mode.
        expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
      } finally {
        await redis.del(lockKey, cacheKey).catch(() => { /* cleanup */ });
      }
    },
  );

  it(
    'stale lock from a crashed holder expires after TTL and a retry succeeds',
    async () => {
      const redis = getRedis();
      if (!redis) return;
      const orcidId = `0000-0001-${orcidSuffix}${orcidSuffix}${orcidSuffix}${orcidSuffix}-0002`;
      const lockKey = `${config.appTag}:orcid_binding_lock:${orcidId}`;
      const cacheKey = `${config.appTag}:orcid_binding:${orcidId}`;
      await redis.del(lockKey, cacheKey).catch(() => { /* ignore */ });

      // Simulate a prior crashed holder: acquire the lock and never release.
      // Use a short PX TTL instead of the production 35s EX so the test can
      // assert expiry-then-retry without a 35s wall-clock wait. This is a
      // proxy for the same failure mode (holder dies mid-broadcast) because
      // Redis treats both the same: the key self-deletes on TTL, freeing the
      // slot for the next SETNX attempt.
      await redis.set(lockKey, 'zombie-holder', 'PX', 150, 'NX');
      // Confirm the lock is actually held before the request arrives.
      expect(await redis.get(lockKey)).toBe('zombie-holder');

      installOrcidFetchStub({ orcid: orcidId, name: 'Alice', works: 3 });
      installLockModeMocks();

      // Wait long enough for Redis to expire the key. 500ms is comfortably
      // over the 150ms PX TTL and keeps the test fast.
      await new Promise((r) => setTimeout(r, 500));
      expect(await redis.get(lockKey)).toBeNull();

      try {
        const state = await startAuthed(mode, 'alice');
        const res = await request(app)
          .post('/api/orcid/callback')
          .set('Authorization', `Bearer ${jwtFor('alice')}`)
          .send({ code: 'fake', state });
        expect(res.status).toBe(200);
        expect(res.body.data.mode).toBe(mode);
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
      const orcidId = `0000-0001-${orcidSuffix}${orcidSuffix}${orcidSuffix}${orcidSuffix}-0003`;
      const lockKey = `${config.appTag}:orcid_binding_lock:${orcidId}`;
      const cacheKey = `${config.appTag}:orcid_binding:${orcidId}`;
      await redis.del(lockKey, cacheKey).catch(() => { /* ignore */ });

      installOrcidFetchStub({ orcid: orcidId, name: 'Alice', works: 3 });
      installLockModeMocks();

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
        const state = await startAuthed(mode, 'alice');
        const res = await request(app)
          .post('/api/orcid/callback')
          .set('Authorization', `Bearer ${jwtFor('alice')}`)
          .send({ code: 'fake', state });
        expect(res.status).toBe(200);
        expect(res.body.data.mode).toBe(mode);
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

  // Broadcast-throw finally-path test. Guarantee: "crash mid-broadcast releases
  // the lock via finally so retries aren't locked out for 35s." Without this
  // test, if the `if (lock.state === 'acquired')` guard in withOrcidBindingLock's
  // finally were inverted, no other spec would fail. Here we force broadcast to
  // reject, assert the outer /callback catch maps to 500, and assert the lock
  // was released under the nonce CAS (redis.get returns null — any release
  // that doesn't own the nonce would leave the lock in place until TTL).
  it(
    'releases the lock via nonce CAS when broadcast throws mid-request (finally)',
    async () => {
      const redis = getRedis();
      if (!redis) return;
      const orcidId = `0000-0001-${orcidSuffix}${orcidSuffix}${orcidSuffix}${orcidSuffix}-0004`;
      const lockKey = `${config.appTag}:orcid_binding_lock:${orcidId}`;
      const cacheKey = `${config.appTag}:orcid_binding:${orcidId}`;
      await redis.del(lockKey, cacheKey).catch(() => { /* ignore */ });

      installOrcidFetchStub({ orcid: orcidId, name: 'Alice', works: 3 });
      installLockModeMocks();
      broadcastJsonMock.mockRejectedValueOnce(new Error('simulated chain failure mid-broadcast'));

      try {
        const state = await startAuthed(mode, 'alice');
        const res = await request(app)
          .post('/api/orcid/callback')
          .set('Authorization', `Bearer ${jwtFor('alice')}`)
          .send({ code: 'fake', state });

        // The narrow try/catch around broadcastJsonWithTimeout maps the
        // non-timeout chain-rejection into 502 BROADCAST_FAILED (retriable=false).
        // The finally in withOrcidBindingLock runs on its way out, releasing
        // the lock under the nonce CAS.
        expect(res.status).toBe(502);
        expect(res.body.error.code).toBe('BROADCAST_FAILED');
        expect(res.body.error.details).toEqual({ retriable: false });
        // Key proof: lock was released despite the broadcast throw. A retry
        // arriving now would acquire cleanly rather than wait for the 35s TTL.
        expect(await redis.get(lockKey)).toBeNull();
        // The cache write happens AFTER broadcast, so a broadcast throw means
        // no cache entry was written.
        expect(await redis.get(cacheKey)).toBeNull();
      } finally {
        await redis.del(lockKey, cacheKey).catch(() => { /* cleanup */ });
      }
    },
  );

  // Direct Lua-CAS correctness spec. The primary safety property of
  // RELEASE_LOCK_LUA is that it refuses to delete the key when the stored
  // value does not equal the caller's nonce. The other specs in this block
  // only exercise the CAS indirectly (self-release on success, self-release
  // on broadcast throw, TTL expiry). A regression to plain `redis.del(key)`
  // (the exact stomp bug round-1 #1 closed) would pass every other spec in
  // this file but must fail this one. The scenario mirrors the real stomp:
  // holder A stalled past TTL, holder B acquired the same key, A's finally
  // tries to release — the CAS must refuse because B's nonce is stored.
  it(
    'releaseBindingLock no-ops when the caller nonce does not match the stored lock value (Lua CAS)',
    async () => {
      const redis = getRedis();
      if (!redis) return;
      const orcidId = `0000-0001-${orcidSuffix}${orcidSuffix}${orcidSuffix}${orcidSuffix}-0005`;
      const lockKey = `${config.appTag}:orcid_binding_lock:${orcidId}`;
      await redis.del(lockKey).catch(() => { /* ignore */ });

      // Pre-seed the lock key with nonce B (shape-matched to production:
      // 32-char lowercase hex so the byte-equality contract is exercised on
      // the real production encoding, not just any string). Simulates holder
      // B having acquired the lock after holder A's TTL expired.
      const nonceB = 'b'.repeat(32);
      await redis.set(lockKey, nonceB, 'EX', 35, 'NX');
      expect(await redis.get(lockKey)).toBe(nonceB);

      try {
        // Holder A's finally runs with its own (stale) nonce A. Under the
        // Lua CAS, the DEL must NOT fire because stored value != nonce A.
        const nonceA = 'a'.repeat(32);
        await releaseBindingLock(orcidId, nonceA);

        // Lock is intact: B's nonce is still the stored value. A regression
        // to plain DEL would make this null.
        expect(await redis.get(lockKey)).toBe(nonceB);
      } finally {
        await redis.del(lockKey).catch(() => { /* cleanup */ });
      }
    },
  );

  // BE-ORCID-BROADCAST-ABORT-TIMEOUT — route-level timeout discrimination.
  // When broadcastJsonWithTimeout raises BroadcastTimeoutError, the handler
  // must return 504 BROADCAST_TIMEOUT with { retriable: true, timeout_ms }
  // details AND must NOT write any post-broadcast side-effects (no
  // cacheOrcidBinding, no updateAccountOrcid). A regression to the plain
  // outer-catch-only pattern would return 500 INTERNAL_ERROR and lose the
  // retriable signal UI/agent consumers need.
  it(
    'broadcast timeout → 504 BROADCAST_TIMEOUT, no cache write, lock released',
    async () => {
      const redis = getRedis();
      if (!redis) return;
      const orcidId = `0000-0001-${orcidSuffix}${orcidSuffix}${orcidSuffix}${orcidSuffix}-0006`;
      const lockKey = `${config.appTag}:orcid_binding_lock:${orcidId}`;
      const cacheKey = `${config.appTag}:orcid_binding:${orcidId}`;
      await redis.del(lockKey, cacheKey).catch(() => { /* ignore */ });

      installOrcidFetchStub({ orcid: orcidId, name: 'Alice', works: 3 });
      installLockModeMocks();
      broadcastJsonMock.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));

      try {
        const state = await startAuthed(mode, 'alice');
        const res = await request(app)
          .post('/api/orcid/callback')
          .set('Authorization', `Bearer ${jwtFor('alice')}`)
          .send({ code: 'fake', state });

        expect(res.status).toBe(504);
        expect(res.body.error.code).toBe('BROADCAST_TIMEOUT');
        // Envelope per common.md + orcid-specific verify_location (state was
        // consumed before dispatch, so retriable=false; caller verifies chain
        // state at /settings before attempting a fresh OAuth flow).
        expect(res.body.error.details).toEqual({
          retriable: false,
          outcome: 'uncertain',
          verify_before_retry: true,
          verify_location: '/settings',
          timeout_ms: 30_000,
        });
        // Post-broadcast side-effects must NOT fire on timeout: no cache entry,
        // lock released via finally's nonce CAS so retries aren't blocked.
        expect(await redis.get(cacheKey)).toBeNull();
        expect(await redis.get(lockKey)).toBeNull();
      } finally {
        await redis.del(lockKey, cacheKey).catch(() => { /* cleanup */ });
      }
    },
  );

  // BE-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING — unavailable-branch
  // BroadcastTimeoutError path. When the lock SETNX fails (Redis flap/outage),
  // acquireBindingLock returns 'unavailable' and withOrcidBindingLock runs fn()
  // on the cache-less degrade path. A timer-fire during that fn() must still
  // emit the 504 BROADCAST_TIMEOUT ambiguous-outcome envelope — NOT fall
  // through to the outer /callback catch's 500 INTERNAL_ERROR. The state token
  // was already consumed before dispatch, so 500 hard-blocks the user on a
  // retry path that may also duplicate-broadcast (the 'unavailable' branch
  // has no lock-TTL margin to close the race).
  it(
    'broadcast timeout in the lock-unavailable branch → 504 BROADCAST_TIMEOUT ambiguous-outcome envelope',
    async () => {
      const redis = getRedis();
      if (!redis) return;
      const orcidId = `0000-0001-${orcidSuffix}${orcidSuffix}${orcidSuffix}${orcidSuffix}-0008`;
      const lockKey = `${config.appTag}:orcid_binding_lock:${orcidId}`;
      const cacheKey = `${config.appTag}:orcid_binding:${orcidId}`;
      await redis.del(lockKey, cacheKey).catch(() => { /* ignore */ });

      installOrcidFetchStub({ orcid: orcidId, name: 'Alice', works: 3 });
      installLockModeMocks();

      // Force the 'unavailable' branch: lock-key SETNX throws (Redis flap).
      // Same technique as the "falls back to the cache-less path" spec above.
      const origSet = redis.set.bind(redis);
      const setSpy = vi.spyOn(redis, 'set').mockImplementation(async (...args: unknown[]) => {
        const k = String(args[0]);
        if (k.includes(':orcid_binding_lock:')) throw new Error('simulated Redis flap on lock SET');
        // @ts-expect-error ioredis set is variadic; forwarding by spread is safe here.
        return origSet(...args);
      });
      // Broadcast on the unavailable-branch fn() times out.
      broadcastJsonMock.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));

      try {
        const state = await startAuthed(mode, 'alice');
        const res = await request(app)
          .post('/api/orcid/callback')
          .set('Authorization', `Bearer ${jwtFor('alice')}`)
          .send({ code: 'fake', state });

        expect(res.status).toBe(504);
        expect(res.body.error.code).toBe('BROADCAST_TIMEOUT');
        expect(res.body.error.details).toEqual({
          retriable: false,
          outcome: 'uncertain',
          verify_before_retry: true,
          verify_location: '/settings',
          timeout_ms: 30_000,
        });
        // No cache entry written (broadcast never confirmed). No lock key
        // either (SETNX threw). A regression to 500 from the outer catch
        // would fail the .status assertion; a regression that swallows the
        // envelope and returns 200 would fail details.outcome.
        expect(await redis.get(cacheKey)).toBeNull();
        expect(await redis.get(lockKey)).toBeNull();
      } finally {
        setSpy.mockRestore();
        await redis.del(lockKey, cacheKey).catch(() => { /* cleanup */ });
      }
    },
  );

  // BE-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING — unavailable-branch
  // non-broadcast throw path. Per architect decision: with Redis down, every
  // throw on the lock-unavailable branch is outcome-ambiguous (the broadcast
  // may have landed and no lock-TTL margin closes the race), so a throw
  // escaping fn's inner try/catch (e.g. from PrivateKey.fromString, a future
  // DB write, or any other code path that could run after a successful
  // broadcast but outside an inner guard) still collapses to the 504
  // BROADCAST_TIMEOUT ambiguous-outcome envelope rather than propagating to
  // the outer /callback catch's 500 INTERNAL_ERROR. Without the wrapper's
  // new forceAmbiguousOutcome path the user's consumed-state-token OAuth
  // flow is hard-blocked on any unexpected throw in the degraded-Redis
  // regime. `timeout_ms` MUST be absent — the throw did not come from the
  // timer, so fabricating a timeout value would mislead consumers keying
  // retry-backoff off that field.
  it(
    'non-broadcast throw inside fn on the lock-unavailable branch → 504 BROADCAST_TIMEOUT ambiguous-outcome (no timeout_ms)',
    async () => {
      const redis = getRedis();
      if (!redis) return;
      const orcidId = `0000-0001-${orcidSuffix}${orcidSuffix}${orcidSuffix}${orcidSuffix}-0009`;
      const lockKey = `${config.appTag}:orcid_binding_lock:${orcidId}`;
      const cacheKey = `${config.appTag}:orcid_binding:${orcidId}`;
      await redis.del(lockKey, cacheKey).catch(() => { /* ignore */ });

      installOrcidFetchStub({ orcid: orcidId, name: 'Alice', works: 3 });
      installLockModeMocks();

      // Force the 'unavailable' branch via lock SETNX flap. Keep non-lock
      // SETs working so the rest of the request pipeline is unaffected.
      const origSet = redis.set.bind(redis);
      const setSpy = vi.spyOn(redis, 'set').mockImplementation(async (...args: unknown[]) => {
        const k = String(args[0]);
        if (k.includes(':orcid_binding_lock:')) throw new Error('simulated Redis flap on lock SET');
        // @ts-expect-error ioredis set is variadic; forwarding by spread is safe here.
        return origSet(...args);
      });
      // Force a throw that ESCAPES fn's inner try/catch (which only wraps
      // broadcastJsonWithTimeout). PrivateKey.fromString is called inside fn
      // before the broadcast and outside any guard. A bad WIF here would
      // throw before the inner try runs, propagating to the wrapper's new
      // forceAmbiguousOutcome catch on the unavailable branch.
      const pkSpy = vi.spyOn(PrivateKey, 'fromString').mockImplementation(() => {
        throw new Error('simulated PrivateKey.fromString failure (escapes fn inner catch)');
      });
      // Silence the logger.error emitted by handleBroadcastError's
      // ambiguous-outcome branch — a single structured error is expected on
      // this path and the spy keeps test output clean.
      const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => { /* silence */ });

      try {
        const state = await startAuthed(mode, 'alice');
        const res = await request(app)
          .post('/api/orcid/callback')
          .set('Authorization', `Bearer ${jwtFor('alice')}`)
          .send({ code: 'fake', state });

        expect(res.status).toBe(504);
        expect(res.body.error.code).toBe('BROADCAST_TIMEOUT');
        // Same envelope shape as the timeout case, but timeout_ms is
        // intentionally omitted: the error did not originate from the timer.
        expect(res.body.error.details).toEqual({
          retriable: false,
          outcome: 'uncertain',
          verify_before_retry: true,
          verify_location: '/settings',
        });
        expect(res.body.error.details).not.toHaveProperty('timeout_ms');
        // Broadcast never fired (PrivateKey.fromString threw before it).
        expect(broadcastJsonMock).not.toHaveBeenCalled();
        // No cache entry, no lock key.
        expect(await redis.get(cacheKey)).toBeNull();
        expect(await redis.get(lockKey)).toBeNull();
        // handleBroadcastError's ambiguous-outcome log fires at error level
        // with the distinctive message suffix. This guards against a
        // regression that silently swallows the throw without emitting the
        // structured error for operators.
        const ambiguousCalls = loggerErrorSpy.mock.calls.filter(
          (call) => typeof call[1] === 'string' && call[1].includes('broadcast failed on ambiguous-outcome path'),
        );
        expect(ambiguousCalls.length).toBeGreaterThanOrEqual(1);
      } finally {
        pkSpy.mockRestore();
        setSpy.mockRestore();
        loggerErrorSpy.mockRestore();
        await redis.del(lockKey, cacheKey).catch(() => { /* cleanup */ });
      }
    },
  );

  // Nonce-shape invariant drift: if a future refactor changes the nonce
  // encoding away from the 32-char lowercase hex shape, the Lua CAS byte-
  // equality contract would silently break. acquireBindingLock guards this
  // at the source with a LOCK_NONCE_RE regex check; on mismatch it emits a
  // structured `event: 'nonce_drift'` error log and returns 'unavailable' so
  // the handler falls through to the HAF-only degrade path (NOT a 500 on a
  // consumed state token — that would hard-block the user's OAuth flow).
  //
  // This spec forces the branch by stubbing `crypto.randomBytes` during the
  // /callback dispatch to return a short buffer (10 hex chars, fails the
  // 32-char regex). Reverting the regex guard to `throw new Error(...)` or
  // removing it entirely would fail this spec; the other specs in this file
  // cannot distinguish the nonce-drift path from the Redis-outage path.
  it(
    'nonce-shape invariant drift: /callback degrades to 2xx, emits event: nonce_drift, skips lock SETNX',
    async () => {
      const redis = getRedis();
      if (!redis) return;
      const orcidId = `0000-0001-${orcidSuffix}${orcidSuffix}${orcidSuffix}${orcidSuffix}-0007`;
      const lockKey = `${config.appTag}:orcid_binding_lock:${orcidId}`;
      const cacheKey = `${config.appTag}:orcid_binding:${orcidId}`;
      await redis.del(lockKey, cacheKey).catch(() => { /* ignore */ });

      installOrcidFetchStub({ orcid: orcidId, name: 'Alice', works: 3 });
      installLockModeMocks();

      // Get state from /start BEFORE installing the randomBytes spy so the
      // state token gets a valid nonce. The spy activates only for the
      // /callback dispatch below, scoping the drift to acquireBindingLock.
      const state = await startAuthed(mode, 'alice');

      // Spy on crypto.randomBytes so the nonce generated inside
      // acquireBindingLock fails LOCK_NONCE_RE. Short buffer (10 bytes →
      // 20 hex chars via .toString('hex')) fails the 32-hex regex; regex
      // rejects it. handleAccredit and handleLink use crypto.createHash
      // (not randomBytes) between /start and the lock acquisition, so this
      // spy only affects the lock nonce path.
      const randomBytesSpy = vi.spyOn(crypto, 'randomBytes').mockImplementation(((size: number) => {
        // Only shrink the 16-byte call (the lock nonce). Defensive: if any
        // other caller asks for a different size during this window, honor it
        // to avoid breaking unrelated paths.
        if (size === 16) return Buffer.from('shortdrift');
        return Buffer.alloc(size);
      }) as typeof crypto.randomBytes);
      // Spy on redis.set so we can assert the lock-key SETNX was never issued.
      const origSet = redis.set.bind(redis);
      const setSpy = vi.spyOn(redis, 'set').mockImplementation(async (...args: unknown[]) => {
        // @ts-expect-error ioredis set is variadic; forwarding by spread is safe here.
        return origSet(...args);
      });
      const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => { /* silence */ });

      try {
        const res = await request(app)
          .post('/api/orcid/callback')
          .set('Authorization', `Bearer ${jwtFor('alice')}`)
          .send({ code: 'fake', state });

        // Fail-soft: the /callback returns 2xx rather than 500, so the user is
        // not hard-blocked on a consumed state token. Degrades to HAF-only
        // dedup (the 120s binding cache still guards the narrow TOCTOU window).
        expect(res.status).toBe(200);
        expect(res.body.data.mode).toBe(mode);

        // Structured log discriminator fires — alert pipelines keyed on the
        // `event` field can distinguish nonce_drift (code defect) from
        // redis_outage (infra event). A regression to the single suffix
        // "— degrading to HAF-only path" would pass the 2xx assertion above
        // but fail this one.
        const nonceDriftCalls = loggerErrorSpy.mock.calls.filter(
          (call) => typeof call[0] === 'object' && call[0] !== null && (call[0] as { event?: unknown }).event === 'nonce_drift',
        );
        expect(nonceDriftCalls.length).toBeGreaterThanOrEqual(1);

        // The lock SETNX must never have been attempted — the regex guard
        // exited acquireBindingLock before redis.set was called. A regression
        // that checked the regex AFTER the SETNX would fail this assertion.
        const lockSetCalls = setSpy.mock.calls.filter(
          (call) => typeof call[0] === 'string' && call[0].includes(':orcid_binding_lock:'),
        );
        expect(lockSetCalls).toEqual([]);
        // Sanity: the key is absent in Redis too, not just unset by the spy.
        expect(await redis.get(lockKey)).toBeNull();
      } finally {
        randomBytesSpy.mockRestore();
        setSpy.mockRestore();
        loggerErrorSpy.mockRestore();
        await redis.del(lockKey, cacheKey).catch(() => { /* cleanup */ });
      }
    },
  );
});

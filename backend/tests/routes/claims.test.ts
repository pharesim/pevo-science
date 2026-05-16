/**
 * SEC-003-BE — Authorization coverage for the bridge-claim approve/revoke paths.
 *
 * Uses the REAL `verifyHiveSignature` middleware (we produce genuine Hive
 * signatures with a deterministic test keypair and mock only the on-chain
 * account lookup). The real middleware is required by the SEC-003-BE task
 * spec so these tests actually exercise the authentication layer.
 *
 * Justification for the `getPool()` mock (per root CLAUDE.md carve-out):
 * the `isApprovedCoAuthor` path requires a paper-author/permlink/claimer row
 * in `authorship_claims` with status='accepted'. Seeding that into real HAF
 * would require (a) broadcasting `claim_authorship` + `approve_authorship`
 * custom_jsons on Hive, (b) waiting for HAF to index them, and (c) the
 * paper's comment row existing. That's impractical per-test. Mocking the
 * pool lets us deterministically toggle the authorization grid. The real
 * `verifyHiveSignature` is NOT mocked.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import * as dhive from '@hiveio/dhive';
import { PrivateKey } from '@hiveio/dhive';

// Deterministic test keypair — shared by all test usernames, since the mocked
// getAccounts lookup resolves every requested name to the same public key.
const TEST_PRIVATE_KEY = PrivateKey.fromSeed('pevo-claims-test-seed-deterministic');
const TEST_PUBLIC_KEY = TEST_PRIVATE_KEY.createPublic().toString();

// Valid-format posting keys for the fake bridge and admin keys in the
// overridden config. Never broadcast because hive.js is mocked — just need to
// parse via PrivateKey.fromString() inside the handlers.
const TEST_BRIDGE_KEY = PrivateKey.fromSeed('pevo-test-bridge-key-seed').toString();
const TEST_ADMIN_KEY = PrivateKey.fromSeed('pevo-test-admin-key-seed').toString();

// Override config so bridge-broadcast + admin-broadcast branches are reachable
// even when the local .env leaves the posting keys empty. Also set a
// hiveBridgeAccount distinct from hiveAdminAccount — dev .env collapses both
// to `pevotest.admin`, which silently hides a class of role-conflation
// mutations (prod runs them as distinct accounts).
vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js');
  return {
    ...actual,
    config: {
      ...actual.config,
      hiveBridgeAccount: 'pevotest.bridge',
      pevoBridgePostingKey: TEST_BRIDGE_KEY,
      pevoAdminPostingKey: TEST_ADMIN_KEY,
    },
  };
});

// Hive client mock (signature verification + broadcast capture)
const broadcastJson = vi.fn().mockResolvedValue({ id: 'mock-tx-id' });
// The stub BroadcastTimeoutError class mirrors the real one's constructor
// signature (timeoutMs property) so routes that discriminate via
// `err instanceof BroadcastTimeoutError` and read `err.timeoutMs` behave
// identically against the mock. Hoisted so the same class identity is
// visible both inside the vi.mock factory and in test bodies that
// construct instances to stage mockRejectedValue.
const { MockBroadcastTimeoutError } = vi.hoisted(() => ({
  MockBroadcastTimeoutError: class BroadcastTimeoutError extends Error {
    public readonly timeoutMs: number;
    constructor(timeoutMs: number) {
      super(`Hive broadcast timed out after ${timeoutMs}ms`);
      this.name = 'BroadcastTimeoutError';
      this.timeoutMs = timeoutMs;
    }
  },
}));
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
      json: (...args: unknown[]) => broadcastJson(...args),
    },
  },
  broadcastJsonWithTimeout: (...args: unknown[]) => broadcastJson(...args),
  BroadcastTimeoutError: MockBroadcastTimeoutError,
  DEFAULT_BROADCAST_TIMEOUT_MS: 30_000,
}));

// Pool mock — controls the isApprovedCoAuthor lookup per test.
//
// The isApprovedCoAuthor query filters by paper_author / paper_permlink /
// claimer / status='accepted' and returns rows where the match succeeds.
// We key approved-co-author-ness on (paperAuthor, paperPermlink, candidate).
const approvedCoAuthors = new Set<string>();
function approvedKey(paperAuthor: string, paperPermlink: string, candidate: string) {
  return `${paperAuthor}::${paperPermlink}::${candidate}`;
}

// Exported via the vi.mock factory so individual tests can stage
// mockRejectedValueOnce / mockResolvedValueOnce for the fail-closed path.
const { queryFn } = vi.hoisted(() => ({
  queryFn: vi.fn(),
}));

queryFn.mockImplementation(async (sql: string, params: unknown[]) => {
  // Only the isApprovedCoAuthor query reaches this mock in approve/revoke
  // tests. Its trailing three params are paperAuthor, paperPermlink,
  // candidate (the CTE params come first). Multi-signal match: require both
  // the target relation (FROM authorship_claims) AND the target status — the
  // single-signal form silently bypasses when SQL gets refactored (constant
  // extraction, quote-style change, JOIN additions).
  if (sql.includes('FROM authorship_claims') && sql.includes("status = 'accepted'")) {
    const paperAuthor = params[params.length - 3] as string;
    const paperPermlink = params[params.length - 2] as string;
    const candidate = params[params.length - 1] as string;
    const hit = approvedCoAuthors.has(approvedKey(paperAuthor, paperPermlink, candidate));
    return { rows: hit ? [{ '?column?': 1 }] : [] };
  }
  // Fall-through for any other query: return empty.
  return { rows: [] };
});

vi.mock('../../src/db.js', () => ({
  getPool: () => ({ query: queryFn }),
  isHafConfigured: () => true,
  closeHafPool: async () => {},
}));

// Redis in test environment: stay silent. verifyHiveSignature tolerates no-redis
// via the in-memory replay fallback.
vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
}));

// The app-db getAppPool is only consulted during Bearer-JWT session-invalidation
// checks. We don't use Bearer in these tests, so returning null is safe.
vi.mock('../../src/app-db.js', () => ({
  getAppPool: () => null,
}));

// Import createApp AFTER the mocks so the route wiring picks up the mocked deps.
const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { hafCache } = await import('../../src/cache.js');
// Dynamic import (not top-level static) so the eager import chain doesn't
// pull `../../src/config.js` in before this file's vi.mock factory's closed-
// over `TEST_BRIDGE_KEY` / `TEST_ADMIN_KEY` initializes. Static import would
// trigger a TDZ ReferenceError on test-runner module evaluation.
const { signRequestBound: signRequestBoundShared } = await import('../support/sign-request.js');

const app = createApp();

function signRequestBound(method: string, fullPath: string, body: Record<string, unknown>, timestamp: string): string {
  return signRequestBoundShared(TEST_PRIVATE_KEY, method, fullPath, body, timestamp);
}

async function signedPost(path: string, username: string, body: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const signature = signRequestBound('POST', path, body, timestamp);
  return request(app)
    .post(path)
    .set('X-Hive-Username', username)
    .set('X-Hive-Signature', signature)
    .set('X-Hive-Timestamp', timestamp)
    .send(body);
}

const BRIDGE = config.hiveBridgeAccount;
const ADMIN = config.hiveAdminAccount;
const PAPER_PERMLINK = 'bridge-paper-sec003';
const NATIVE_AUTHOR = 'nativeauthor';
const CLAIMER = 'claimeraccount';
const UNRELATED = 'someintruder';
const COAUTHOR = 'approvedcoauthor';

beforeEach(() => {
  broadcastJson.mockClear();
  approvedCoAuthors.clear();
  queryFn.mockClear();
});

describe('SEC-003-BE — POST /:claimer/approve authorization', () => {
  it('bridge paper: unrelated authed user → 403, no broadcast', async () => {
    const path = `/api/papers/${BRIDGE}/${PAPER_PERMLINK}/claims/${CLAIMER}/approve`;
    const res = await signedPost(path, UNRELATED, {});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(broadcastJson).not.toHaveBeenCalled();
  });

  it('bridge paper: admin → 200 + broadcast with bridge account', async () => {
    const path = `/api/papers/${BRIDGE}/${PAPER_PERMLINK}/claims/${CLAIMER}/approve`;
    const res = await signedPost(path, ADMIN, {});
    expect(res.status).toBe(200);
    expect(res.body.data.tx_id).toBe('mock-tx-id');
    expect(broadcastJson).toHaveBeenCalledTimes(1);
    const [opArg] = broadcastJson.mock.calls[0];
    expect(opArg.required_posting_auths).toEqual([BRIDGE]);
  });

  it('bridge paper: approved co-author of same paper → 200 + broadcast', async () => {
    approvedCoAuthors.add(approvedKey(BRIDGE, PAPER_PERMLINK, COAUTHOR));
    const path = `/api/papers/${BRIDGE}/${PAPER_PERMLINK}/claims/${CLAIMER}/approve`;
    const res = await signedPost(path, COAUTHOR, {});
    expect(res.status).toBe(200);
    expect(broadcastJson).toHaveBeenCalledTimes(1);
  });

  it('bridge paper: claimer self-approving → 403, no broadcast', async () => {
    // Even if somehow flagged as an approved co-author, the self-approval
    // short-circuit must reject first. Seed both conditions to prove the
    // self-approval guard is not bypassable.
    approvedCoAuthors.add(approvedKey(BRIDGE, PAPER_PERMLINK, CLAIMER));
    const path = `/api/papers/${BRIDGE}/${PAPER_PERMLINK}/claims/${CLAIMER}/approve`;
    const res = await signedPost(path, CLAIMER, {});
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/own claim/i);
    expect(broadcastJson).not.toHaveBeenCalled();
  });

  it('native paper: caller ≠ paperAuthor → 403', async () => {
    const path = `/api/papers/${NATIVE_AUTHOR}/${PAPER_PERMLINK}/claims/${CLAIMER}/approve`;
    const res = await signedPost(path, UNRELATED, {});
    expect(res.status).toBe(403);
    expect(broadcastJson).not.toHaveBeenCalled();
  });

  it('native paper: caller = paperAuthor → 200 + returns operation (no server broadcast)', async () => {
    const path = `/api/papers/${NATIVE_AUTHOR}/${PAPER_PERMLINK}/claims/${CLAIMER}/approve`;
    const res = await signedPost(path, NATIVE_AUTHOR, {});
    expect(res.status).toBe(200);
    expect(res.body.data.operation).toBeDefined();
    expect(res.body.data.operation[0]).toBe('custom_json');
    expect(res.body.data.operation[1].required_posting_auths).toEqual([NATIVE_AUTHOR]);
    expect(broadcastJson).not.toHaveBeenCalled();
  });

  it('bridge paper: isApprovedCoAuthor HAF throw → 403 fail-closed, no broadcast', async () => {
    // The isApprovedCoAuthor catch block must deny authorization when HAF is
    // unavailable. The negative invariant — "bridge key is NOT used" — is the
    // load-bearing assertion: a fail-open regression would broadcast under
    // the bridge account's posting auth on a dropped database connection.
    //
    // Seed the caller as an approved co-author; the throw must override.
    approvedCoAuthors.add(approvedKey(BRIDGE, PAPER_PERMLINK, COAUTHOR));
    queryFn.mockRejectedValueOnce(new Error('ECONNRESET'));

    const path = `/api/papers/${BRIDGE}/${PAPER_PERMLINK}/claims/${CLAIMER}/approve`;
    const res = await signedPost(path, COAUTHOR, {});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(broadcastJson).not.toHaveBeenCalled();
  });
});

describe('SEC-003-BE — POST /:claimer/revoke authorization', () => {
  it('bridge paper: unrelated authed user → 403 (the exact current bug)', async () => {
    const path = `/api/papers/${BRIDGE}/${PAPER_PERMLINK}/claims/${CLAIMER}/revoke`;
    const res = await signedPost(path, UNRELATED, { reason: 'test' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(broadcastJson).not.toHaveBeenCalled();
  });

  it('bridge paper: claimer revoking own claim → 200 + returns operation (NOT a bridge-key broadcast)', async () => {
    const path = `/api/papers/${BRIDGE}/${PAPER_PERMLINK}/claims/${CLAIMER}/revoke`;
    const res = await signedPost(path, CLAIMER, { reason: 'withdrawn' });
    expect(res.status).toBe(200);
    expect(res.body.data.operation).toBeDefined();
    expect(res.body.data.operation[0]).toBe('custom_json');
    expect(res.body.data.operation[1].required_posting_auths).toEqual([CLAIMER]);
    expect(broadcastJson).not.toHaveBeenCalled();
  });

  it('bridge paper: admin → 200 + bridge-key broadcast', async () => {
    const path = `/api/papers/${BRIDGE}/${PAPER_PERMLINK}/claims/${CLAIMER}/revoke`;
    const res = await signedPost(path, ADMIN, { reason: 'abuse' });
    expect(res.status).toBe(200);
    expect(broadcastJson).toHaveBeenCalledTimes(1);
    const [opArg] = broadcastJson.mock.calls[0];
    expect(opArg.required_posting_auths).toEqual([BRIDGE]);
  });

  it('native paper: caller = paperAuthor → 200 + returns operation', async () => {
    const path = `/api/papers/${NATIVE_AUTHOR}/${PAPER_PERMLINK}/claims/${CLAIMER}/revoke`;
    const res = await signedPost(path, NATIVE_AUTHOR, { reason: 'retracted' });
    expect(res.status).toBe(200);
    expect(res.body.data.operation).toBeDefined();
    expect(res.body.data.operation[1].required_posting_auths).toEqual([NATIVE_AUTHOR]);
    expect(broadcastJson).not.toHaveBeenCalled();
  });

  it('native paper: admin revoking → 200 + admin-key broadcast (not bridge key)', async () => {
    const path = `/api/papers/${NATIVE_AUTHOR}/${PAPER_PERMLINK}/claims/${CLAIMER}/revoke`;
    const res = await signedPost(path, ADMIN, { reason: 'abuse' });
    expect(res.status).toBe(200);
    expect(broadcastJson).toHaveBeenCalledTimes(1);
    const [opArg] = broadcastJson.mock.calls[0];
    expect(opArg.required_posting_auths).toEqual([ADMIN]);
    expect(opArg.required_posting_auths).not.toEqual([BRIDGE]);
  });

  it('native paper: claimer revoking own claim → 200 + returns operation (no server broadcast)', async () => {
    // Symmetric mutation-kill for the "claimer can always revoke" invariant.
    // Bridge-paper counterpart is tested above; native-paper path must behave
    // identically — the self-revoke right does not depend on paper type.
    const path = `/api/papers/${NATIVE_AUTHOR}/${PAPER_PERMLINK}/claims/${CLAIMER}/revoke`;
    const res = await signedPost(path, CLAIMER, { reason: 'withdrawn' });
    expect(res.status).toBe(200);
    expect(res.body.data.operation).toBeDefined();
    expect(res.body.data.operation[0]).toBe('custom_json');
    expect(res.body.data.operation[1].required_posting_auths).toEqual([CLAIMER]);
    expect(broadcastJson).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
// BE-CLAIMS-ERROR-POLISH — Bridge-misconfig 503 surface
//
// When the paper is a bridge paper but PEVO_BRIDGE_POSTING_KEY is unconfigured,
// both approve and revoke handlers must return a distinct 503 SERVICE_UNAVAILABLE
// rather than silently falling through to the native-paper branch (approve) or
// the admin-key / client-signed branches (revoke). This surfaces the operator-
// facing misconfig distinctly from authorization errors.
// ──────────────────────────────────────────────

describe('BE-CLAIMS-ERROR-POLISH — bridge misconfig surfaces as 503', () => {
  // Snapshot-and-restore the key around each test so we only toggle the
  // misconfig state for this block and don't leak into other describe suites.
  let originalBridgeKey: string;

  beforeEach(() => {
    originalBridgeKey = config.pevoBridgePostingKey;
    (config as { pevoBridgePostingKey: string }).pevoBridgePostingKey = '';
  });

  afterEach(() => {
    (config as { pevoBridgePostingKey: string }).pevoBridgePostingKey = originalBridgeKey;
  });

  it('POST approve on bridge paper with empty bridge key → 503 SERVICE_UNAVAILABLE, no broadcast', async () => {
    // Admin caller would normally be authorized for the bridge-branch broadcast.
    // With the bridge key unconfigured, the handler must short-circuit to 503
    // rather than fall through to "Only the post author can approve claims on
    // native papers", which was misleading for operators debugging the misconfig.
    const path = `/api/papers/${BRIDGE}/${PAPER_PERMLINK}/claims/${CLAIMER}/approve`;
    const res = await signedPost(path, ADMIN, {});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.message).toMatch(/bridge posting key/i);
    expect(broadcastJson).not.toHaveBeenCalled();
  });

  it('POST revoke on bridge paper with empty bridge key → 503 SERVICE_UNAVAILABLE, no broadcast', async () => {
    // Admin caller would normally trigger the bridge-key broadcast branch.
    // With the key unconfigured the handler must 503 rather than silently
    // falling through to the admin-key branch (which would broadcast with
    // admin-account signing identity, not bridge).
    const path = `/api/papers/${BRIDGE}/${PAPER_PERMLINK}/claims/${CLAIMER}/revoke`;
    const res = await signedPost(path, ADMIN, { reason: 'abuse' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.message).toMatch(/bridge posting key/i);
    expect(broadcastJson).not.toHaveBeenCalled();
  });

  it('POST revoke as claimer on bridge paper with empty bridge key → 200 with operation, no 503', async () => {
    // Round-3 hold-block fix (architect re-review 2026-04-21 round-3): the
    // assertBridgeKeyConfigured guard previously sat above the admin-on-bridge
    // broadcast branch and fired unconditionally for any bridge paper with the
    // key unset. That blocked the client-signed return path for a claimer self-
    // revoking on a bridge paper, surfacing 503 instead of the expected 200 +
    // operation payload. Reorder moves the guard inside the admin-on-bridge
    // branch so it fires only when the server actually needs to broadcast with
    // the bridge key. Claimer self-revoke must reach the client-signed branch.
    const path = `/api/papers/${BRIDGE}/${PAPER_PERMLINK}/claims/${CLAIMER}/revoke`;
    const res = await signedPost(path, CLAIMER, { reason: 'withdrawn' });
    expect(res.status).toBe(200);
    expect(res.body.data.operation).toBeDefined();
    expect(res.body.data.operation[0]).toBe('custom_json');
    expect(res.body.data.operation[1].required_posting_auths).toEqual([CLAIMER]);
    expect(broadcastJson).not.toHaveBeenCalled();
  });

  it('native paper with empty bridge key → unaffected (approve 403 for unrelated caller)', async () => {
    // Negative: the 503 guard must NOT fire on native papers. Unrelated caller
    // hitting a native-paper approve still gets 403 FORBIDDEN from the
    // native-paper-only guard, not 503.
    const path = `/api/papers/${NATIVE_AUTHOR}/${PAPER_PERMLINK}/claims/${CLAIMER}/approve`;
    const res = await signedPost(path, UNRELATED, {});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(broadcastJson).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
// BE-ORCID-BROADCAST-ABORT-TIMEOUT — route-level BroadcastTimeoutError discrimination.
//
// The helper's timeout mechanism is unit-tested in hive-broadcast-timeout.test.ts.
// These specs cover the route-level catch-and-discriminate pattern: each of
// the three claims.ts broadcastJsonWithTimeout call sites must translate
// BroadcastTimeoutError into the round-3 504 BROADCAST_TIMEOUT envelope shape
// (see `agents/docs/api-contracts/common.md` and the `TIMEOUT_DETAILS`
// constant below): { retriable:false, outcome:'uncertain',
// verify_before_retry:true, timeout_ms }. The post-broadcast side-effect
// (hafCache.invalidate) must NOT fire on timeout.
// ──────────────────────────────────────────────

// Envelope mandated by agents/docs/api-contracts/common.md for BROADCAST_TIMEOUT
// at non-orcid surfaces (no verify_location — that field is orcid-specific).
const TIMEOUT_DETAILS = {
  retriable: false,
  outcome: 'uncertain',
  verify_before_retry: true,
  timeout_ms: 30_000,
};

describe('BE-ORCID-BROADCAST-ABORT-TIMEOUT — claims timeout discrimination', () => {
  it('approve bridge paper: BroadcastTimeoutError → 504 BROADCAST_TIMEOUT with uncertain-outcome envelope', async () => {
    const invalidateSpy = vi.spyOn(hafCache, 'invalidate');
    broadcastJson.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));
    const path = `/api/papers/${BRIDGE}/${PAPER_PERMLINK}/claims/${CLAIMER}/approve`;
    const res = await signedPost(path, ADMIN, {});
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('BROADCAST_TIMEOUT');
    expect(res.body.error.details).toEqual(TIMEOUT_DETAILS);
    // Broadcast was attempted (and timed out).
    expect(broadcastJson).toHaveBeenCalledTimes(1);
    // Post-broadcast cache invalidation must NOT fire on timeout.
    expect(invalidateSpy).not.toHaveBeenCalled();
    invalidateSpy.mockRestore();
  });

  it('approve bridge paper: non-timeout broadcast error → 502 BROADCAST_FAILED with retriable=false', async () => {
    broadcastJson.mockRejectedValueOnce(new Error('RPC node rejected: insufficient RC'));
    const path = `/api/papers/${BRIDGE}/${PAPER_PERMLINK}/claims/${CLAIMER}/approve`;
    const res = await signedPost(path, ADMIN, {});
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('BROADCAST_FAILED');
    expect(res.body.error.details).toEqual({ retriable: false });
  });

  it('revoke bridge paper (admin): BroadcastTimeoutError → 504 BROADCAST_TIMEOUT', async () => {
    const invalidateSpy = vi.spyOn(hafCache, 'invalidate');
    broadcastJson.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));
    const path = `/api/papers/${BRIDGE}/${PAPER_PERMLINK}/claims/${CLAIMER}/revoke`;
    const res = await signedPost(path, ADMIN, { reason: 'abuse' });
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('BROADCAST_TIMEOUT');
    expect(res.body.error.details).toEqual(TIMEOUT_DETAILS);
    expect(invalidateSpy).not.toHaveBeenCalled();
    invalidateSpy.mockRestore();
  });

  it('revoke native paper (admin): BroadcastTimeoutError → 504 BROADCAST_TIMEOUT', async () => {
    const invalidateSpy = vi.spyOn(hafCache, 'invalidate');
    broadcastJson.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));
    const path = `/api/papers/${NATIVE_AUTHOR}/${PAPER_PERMLINK}/claims/${CLAIMER}/revoke`;
    const res = await signedPost(path, ADMIN, { reason: 'abuse' });
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('BROADCAST_TIMEOUT');
    expect(res.body.error.details).toEqual(TIMEOUT_DETAILS);
    expect(invalidateSpy).not.toHaveBeenCalled();
    invalidateSpy.mockRestore();
  });
});

// ──────────────────────────────────────────────
// BACKEND-BRIDGE-KEY-CLAIMS-ROUTE-MIGRATION — coverage check
//
// The migration replaces per-request `PrivateKey.fromString(config.pevoBridgePostingKey)`
// at the approve / revoke bridge-key call sites with the boot-cached
// `getRequiredBridgePostingKey()` accessor. The negative invariant — "the
// per-request parse of the bridge WIF no longer fires inside the request
// handler" — is the load-bearing assertion: a regression that re-introduces
// the per-request parse re-opens the AssertionError `.actual`/`.expected`
// Buffer-slice leak surface that the cache accessor exists to close.
// ──────────────────────────────────────────────

describe('BACKEND-BRIDGE-KEY-CLAIMS-ROUTE-MIGRATION — handlers no longer parse the bridge WIF per-request', () => {
  // Round-1 hold-fix #1: deterministic cache population before any spy is
  // installed. Without this, the test passes only by cache-state inheritance
  // from sibling describe blocks. Run in isolation, the lazy-fallback at
  // `startup-checks.ts` (`getCachedBridgePostingKey()` on a null cache with
  // a configured source) fires `PrivateKey.fromString(source)` on the
  // request hot path, the spy records it, and the negative-invariant
  // assertion fails. Reset+init the cache here so the spy is installed
  // against a primed cache, and the only legitimate `PrivateKey.fromString`
  // calls during the request are unrelated parses (e.g. signature
  // verification of test keys), never the bridge WIF.
  beforeAll(async () => {
    const { _resetBridgePostingKeyCacheForTests, _initBridgePostingKeyCacheForTests } =
      await import('../../src/startup-checks.js');
    _resetBridgePostingKeyCacheForTests();
    _initBridgePostingKeyCacheForTests();
  });

  it('approve bridge paper (admin happy path): PrivateKey.fromString NOT called with the bridge WIF', async () => {
    const fromStringSpy = vi.spyOn(dhive.PrivateKey, 'fromString');
    try {
      const path = `/api/papers/${BRIDGE}/${PAPER_PERMLINK}/claims/${CLAIMER}/approve`;
      const res = await signedPost(path, ADMIN, {});
      expect(res.status).toBe(200);
      expect(broadcastJson).toHaveBeenCalledTimes(1);
      const calledWithBridgeWif = fromStringSpy.mock.calls.some(
        ([wif]) => wif === config.pevoBridgePostingKey,
      );
      expect(calledWithBridgeWif).toBe(false);
    } finally {
      fromStringSpy.mockRestore();
    }
  });

  it('revoke bridge paper (admin happy path): PrivateKey.fromString NOT called with the bridge WIF', async () => {
    const fromStringSpy = vi.spyOn(dhive.PrivateKey, 'fromString');
    try {
      const path = `/api/papers/${BRIDGE}/${PAPER_PERMLINK}/claims/${CLAIMER}/revoke`;
      const res = await signedPost(path, ADMIN, { reason: 'abuse' });
      expect(res.status).toBe(200);
      expect(broadcastJson).toHaveBeenCalledTimes(1);
      const calledWithBridgeWif = fromStringSpy.mock.calls.some(
        ([wif]) => wif === config.pevoBridgePostingKey,
      );
      expect(calledWithBridgeWif).toBe(false);
    } finally {
      fromStringSpy.mockRestore();
    }
  });
});

/**
 * Route tests for /api/bridge/*.
 *
 * Most scenarios (lookup/check/unauthenticated register) don't need
 * mocking — the handlers short-circuit on input validation before touching
 * Hive/HAF. The BE-CLAIMS-ERROR-POLISH block (503 on missing bridge posting
 * key) does need the auth layer to pass, so that block mocks the same shape
 * as claims.test.ts: real `verifyHiveSignature` with a deterministic keypair,
 * mocked on-chain account lookup, and a mocked accreditation lookup. We do
 * NOT mock `verifyHiveSignature` itself — the tests sign real requests.
 *
 * Justification for the `getAccreditedSet` mock (per root CLAUDE.md carve-out):
 * the bridge /register handler requires the caller to be accredited.
 * Seeding an accreditation row means broadcasting an `issue_accreditation`
 * custom_json on Hive and waiting for HAF to index it. That's impractical
 * per-test when we only care about exercising the 503 misconfig guard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { PrivateKey, cryptoUtils } from '@hiveio/dhive';
import { MockBroadcastTimeoutError, makeDhiveLikeError } from '../support/broadcast-mocks.js';
import { logger } from '../../src/logger.js';

// Deterministic test keypair shared by all usernames (mocked getAccounts
// resolves every name to the same public key).
const TEST_PRIVATE_KEY = PrivateKey.fromSeed('pevo-bridge-test-seed-deterministic');
const TEST_PUBLIC_KEY = TEST_PRIVATE_KEY.createPublic().toString();

// Valid-format bridge posting key (never broadcasts — hive.js is mocked).
const TEST_BRIDGE_KEY = PrivateKey.fromSeed('pevo-test-bridge-key-seed').toString();

// Override config so the bridge account is distinct from the admin account and
// the posting key is populated by default (individual tests toggle it to
// exercise the misconfig guard).
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

// Hive client mock — supports signature verification (getAccounts) and
// captures any accidental broadcast (there must be none when the 503 fires).
// Also exposes broadcastSendOperationsWithTimeout + BroadcastTimeoutError so
// the /register handler's timeout-discrimination catch block is
// reachable from these tests. The stub BroadcastTimeoutError class is
// imported from `../support/broadcast-mocks.ts` (round-2 hold #1: shared
// across bridge.test.ts and custody.test.ts so the substitution chain has
// one canonical mock class identity, and a structural identity assertion at
// the top of the discrimination describe can verify the substitution still
// works on every test run).
const sendOperations = vi.fn().mockResolvedValue({ id: 'mock-tx-id' });
vi.mock('../../src/hive.js', async () => {
  const { MockBroadcastTimeoutError } = await import('../support/broadcast-mocks.js');
  return {
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
    BroadcastTimeoutError: MockBroadcastTimeoutError,
    DEFAULT_BROADCAST_TIMEOUT_MS: 30_000,
  };
});

// Bridge module mock: let checkExistingBridge short-circuit to "no
// duplicate" (exists=false) and stub resolveToCanonical / lookupPreprint so
// the broadcast-timeout specs don't actually hit Crossref / arXiv. The
// unused-helper exports (parseIdentifier, buildBridgeBody, buildBridgeMetadata)
// fall through to the real implementation.
const { MOCK_META } = vi.hoisted(() => ({
  MOCK_META: {
    title: 'A deterministic test paper',
    authors: ['Alice Example', 'Bob Example'],
    abstract: 'Test abstract.',
    doi: null,
    arxiv_id: '2301.12345',
    source_type: 'arxiv',
    source_url: 'https://arxiv.org/abs/2301.12345',
    publication_date: '2023-01-20',
    license: null,
  },
}));
vi.mock('../../src/bridge.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/bridge.js')>('../../src/bridge.js');
  return {
    ...actual,
    // Keep the "unparseable identifier" path real (parseIdentifier handles it)
    // but short-circuit known-good inputs so broadcast-discrimination tests
    // never hit arXiv / Crossref over the network.
    resolveToCanonical: vi.fn().mockImplementation(async (identifier: string) => {
      if (identifier === '2301.12345') return { type: 'arxiv', id: '2301.12345' };
      return actual.resolveToCanonical(identifier);
    }),
    lookupPreprint: vi.fn().mockImplementation(async (identifier: string) => {
      if (identifier === '2301.12345') return MOCK_META;
      return actual.lookupPreprint(identifier);
    }),
  };
});

// Accreditation mock: treat the caller as accredited by default so the 503
// guard (which runs after the accreditation check) is reachable.
const accreditedSet = new Set<string>();
vi.mock('../../src/accreditation.js', () => ({
  getAccreditedSet: vi.fn().mockImplementation(async (names: string[]) =>
    new Set(names.filter((n) => accreditedSet.has(n))),
  ),
  getAllAccreditedAccounts: vi.fn().mockResolvedValue(new Set<string>()),
}));

// DB: no HAF interaction is reached by the 503 scenarios, but supply a safe
// no-op pool so the module imports succeed. The DUPLICATE-existing wire-shape
// spec below overrides `pool.query` per-test to return a synthetic row so the
// register handler hits the `existing.exists` branch without seeding HAF.
const poolQuery = vi.fn();
const hafConfigured = { value: false };
vi.mock('../../src/db.js', () => ({
  getPool: () => (hafConfigured.value ? { query: (...args: unknown[]) => poolQuery(...args) } : null),
  isHafConfigured: () => hafConfigured.value,
  closeHafPool: async () => {},
}));

// Redis stub: verifyHiveSignature tolerates no-redis via its in-memory replay
// fallback.
vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
}));

vi.mock('../../src/app-db.js', () => ({
  getAppPool: () => null,
}));

// Import createApp + config AFTER the mocks so route wiring picks them up.
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

describe('GET /api/bridge/lookup', () => {
  it('returns 400 when identifier is missing', async () => {
    const res = await request(app).get('/api/bridge/lookup');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain('identifier');
  });

  it('returns 400 for empty identifier', async () => {
    const res = await request(app).get('/api/bridge/lookup?identifier=');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});

describe('GET /api/bridge/check', () => {
  it('returns 400 when identifier is missing', async () => {
    const res = await request(app).get('/api/bridge/check');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for unparseable identifier', async () => {
    const res = await request(app).get('/api/bridge/check?identifier=not-a-valid-id');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns exists status for valid arXiv ID', async () => {
    const res = await request(app).get('/api/bridge/check?identifier=2301.12345');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('exists');
    expect(typeof res.body.data.exists).toBe('boolean');
  });
});

describe('POST /api/bridge/register', () => {
  it('requires authentication headers', async () => {
    const res = await request(app)
      .post('/api/bridge/register')
      .send({ identifier: '2301.12345', discipline: 'CS' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

// ──────────────────────────────────────────────
// BACKEND-BRIDGE-ENVELOPE-SHAPE-RECONCILE — Direction A canonical migration
//
// The DUPLICATE-existing 409 branch in /api/bridge/register migrated from an
// open-coded res.status(409).json({...}) with existing_author/existing_permlink
// at error.X to sendError(...) with those fields at error.details.X. Pre-
// migration there was no test fixture asserting the DUPLICATE-existing path
// (architect-verified at 2026-05-11 review — grep -rn 'DUPLICATE.*existing' on
// backend/tests/ returned zero hits before this test landed). This spec closes
// that pre-existing coverage gap on the post-migration wire shape.
//
// Mock-justification (per root CLAUDE.md carve-out): `pool.query` is mocked
// because reaching the duplicate branch with a real HAF row requires
// broadcasting a comment under the bridge account and waiting for HAF to
// index it. That's impractical per-test for what is a deterministic 409
// wire-shape assertion. `verifyHiveSignature` and the accreditation gate are
// NOT mocked — both run real (real signature on the request, real
// `getAccreditedSet` resolves the in-memory `accreditedSet`).
// ──────────────────────────────────────────────

describe('BACKEND-BRIDGE-ENVELOPE-SHAPE-RECONCILE — DUPLICATE-existing wire shape', () => {
  const ACCREDITED_CALLER = 'accreditedbridgedup';
  const EXISTING_AUTHOR = 'pevotest.bridge';
  const EXISTING_PERMLINK = 'bridge-arxiv-2301-12345';

  beforeEach(() => {
    sendOperations.mockClear();
    poolQuery.mockReset();
    accreditedSet.clear();
    accreditedSet.add(ACCREDITED_CALLER);
    hafConfigured.value = true;
    // Synthetic duplicate row so checkExistingBridge's first SELECT returns
    // exists=true and the handler reaches the DUPLICATE branch.
    poolQuery.mockResolvedValueOnce({
      rows: [
        {
          author: EXISTING_AUTHOR,
          permlink: EXISTING_PERMLINK,
          title: 'A deterministic test paper',
          created: '2026-01-20T00:00:00.000Z',
        },
      ],
    });
  });

  afterEach(() => {
    hafConfigured.value = false;
  });

  it('POST /api/bridge/register: duplicate preprint → 409 DUPLICATE with existing_author/existing_permlink at error.details (canonical envelope)', async () => {
    const res = await signedPost('/api/bridge/register', ACCREDITED_CALLER, {
      identifier: '2301.12345',
      discipline: 'CS',
    });
    expect(res.status).toBe(409);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('DUPLICATE');
    expect(res.body.error.message).toBe('This preprint is already registered on PEvO');
    // Canonical envelope shape: divergent fields live inside error.details,
    // NOT at error.existing_author / error.existing_permlink. This is the
    // load-bearing assertion of the migration.
    expect(res.body.error.details).toEqual({
      existing_author: EXISTING_AUTHOR,
      existing_permlink: EXISTING_PERMLINK,
    });
    // Guard against regression to the pre-migration shape.
    expect(res.body.error.existing_author).toBeUndefined();
    expect(res.body.error.existing_permlink).toBeUndefined();
    // No broadcast on the duplicate branch.
    expect(sendOperations).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
// BE-CLAIMS-ERROR-POLISH — Bridge-misconfig 503 surface (bridge.ts side)
//
// Mirrors the round-1 claims.test.ts block. When PEVO_BRIDGE_POSTING_KEY is
// unset, /api/bridge/register must return 503 SERVICE_UNAVAILABLE with the
// same operator-facing message that the claim approve/revoke handlers use,
// instead of the prior 500 INTERNAL_ERROR. This keeps the misconfig
// code+message identical across the call sites.
// ──────────────────────────────────────────────

describe('BE-CLAIMS-ERROR-POLISH — bridge misconfig surfaces as 503', () => {
  const ACCREDITED_CALLER = 'accreditedcaller';

  // Per-test save/restore of the bridge posting key so the misconfig state
  // stays scoped to this block and doesn't leak into sibling describes.
  let originalBridgeKey: string;

  beforeEach(() => {
    originalBridgeKey = config.pevoBridgePostingKey;
    (config as { pevoBridgePostingKey: string }).pevoBridgePostingKey = '';
    sendOperations.mockClear();
    accreditedSet.clear();
    accreditedSet.add(ACCREDITED_CALLER);
  });

  afterEach(() => {
    (config as { pevoBridgePostingKey: string }).pevoBridgePostingKey = originalBridgeKey;
  });

  it('POST /api/bridge/register with empty bridge key → 503 SERVICE_UNAVAILABLE, no broadcast', async () => {
    const res = await signedPost('/api/bridge/register', ACCREDITED_CALLER, {
      identifier: '2301.12345',
      discipline: 'CS',
    });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.message).toBe('Bridge posting key not configured');
    expect(sendOperations).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
// BE-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION — per-route timeout/failure specs.
//
// /register must discriminate BroadcastTimeoutError into a 504
// BROADCAST_TIMEOUT envelope and all other broadcast errors into a 502
// BROADCAST_FAILED envelope with {retriable:false}. The response body must
// NOT interpolate err.message / jse_shortmsg — that was a defense-in-depth
// leak the helper migration closes.
// ──────────────────────────────────────────────

const TIMEOUT_DETAILS = {
  retriable: false,
  outcome: 'uncertain',
  verify_before_retry: true,
  timeout_ms: 30_000,
};

describe('BE-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION — /register timeout discrimination', () => {
  const ACCREDITED_CALLER = 'accreditedregister';

  // Structural identity assertion — round-2 hold #1 (mutation-kill the
  // mock-substitution chain). The route's `instanceof BroadcastTimeoutError`
  // check (and `lib/broadcast-error.ts`'s sibling check inside
  // `handleBroadcastError`) both resolve `BroadcastTimeoutError` via
  // `import { BroadcastTimeoutError } from '../hive.js'`. The `vi.mock` above
  // substitutes `MockBroadcastTimeoutError` at that module's export. If a
  // future refactor (re-export barrel, top-level import preempting the
  // hoist, test-side import-ordering change) breaks the chain, the helper's
  // imported reference would be the REAL class and `instanceof` would return
  // false — the route would emit 502 on a real timeout and every 504-spec
  // would pass against the wrong branch. This single assertion fails fast and
  // surfaces the regression before any other test runs.
  it('mock-substitution chain identity check (round-2 hold #1)', async () => {
    const { BroadcastTimeoutError } = await import('../../src/hive.js');
    expect(BroadcastTimeoutError).toBe(MockBroadcastTimeoutError);
  });

  beforeEach(() => {
    sendOperations.mockClear();
    accreditedSet.clear();
    accreditedSet.add(ACCREDITED_CALLER);
  });

  it('POST /api/bridge/register: BroadcastTimeoutError → 504 BROADCAST_TIMEOUT with uncertain-outcome envelope', async () => {
    sendOperations.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));
    const res = await signedPost('/api/bridge/register', ACCREDITED_CALLER, {
      identifier: '2301.12345',
      discipline: 'CS',
    });
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('BROADCAST_TIMEOUT');
    expect(res.body.error.message).toBe('Broadcasting bridge paper registration timed out');
    expect(res.body.error.details).toEqual(TIMEOUT_DETAILS);
    // No orcid-style verify_location hint on the bridge surface.
    expect(res.body.error.details.verify_location).toBeUndefined();
  });

  it('POST /api/bridge/register: non-timeout broadcast error → 502 BROADCAST_FAILED with retriable=false and no err.message leak', async () => {
    const CHAIN_INTERNAL = 'RPC node rejected: missing_active_authority pevotest.bridge';
    sendOperations.mockRejectedValueOnce(new Error(CHAIN_INTERNAL));
    const res = await signedPost('/api/bridge/register', ACCREDITED_CALLER, {
      identifier: '2301.12345',
      discipline: 'CS',
    });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('BROADCAST_FAILED');
    expect(res.body.error.message).toBe('Failed to broadcast bridge paper registration to Hive');
    expect(res.body.error.details).toEqual({ retriable: false });
    // Chain-internal error text must NOT be interpolated into the response.
    expect(JSON.stringify(res.body)).not.toContain('missing_active_authority');
    expect(JSON.stringify(res.body)).not.toContain(CHAIN_INTERNAL);
  });

  // Round-2 hold #3: the leak-assertion above passes by construction against
  // a plain `Error(CHAIN_INTERNAL)` because the response body is now a static
  // string regardless of throw shape. The pre-migration code preferred
  // `err.jse_shortmsg` over `err.message`; a regression that re-introduces
  // `err.jse_shortmsg` interpolation would NOT fail the prior assertion.
  // This spec stages a real-shaped dhive RPCError so the leak-assertion has
  // actual surface — every field that pre-migration code path touched
  // (`jse_shortmsg`, `jse_cause`, `info`, `cause.message`) is in the throw
  // payload, and the body must contain none of them.
  // Round-3 hold #3: per-field unique sentinels. The fixture now stamps each
  // of `err.message`, `err.jse_shortmsg`, `err.cause.message`, `err.jse_cause`
  // with a distinct auto-generated marker so a single-field interpolation
  // regression cannot pass spuriously against a shared sentinel.
  it('POST /api/bridge/register: dhive-shaped RPCError → no jse_shortmsg/jse_cause/info leak', async () => {
    const SHORT = 'missing_active_authority pevotest.bridge';
    const CAUSE = 'op_authority_check_failed';
    const INFO_KEY = 'rpc_internal_state_dump';
    const dhiveErr = makeDhiveLikeError({
      shortmsg: SHORT,
      cause: CAUSE,
      info: { internal_marker: INFO_KEY, stack_frame: 'witness_node_signature.cpp:217' },
    });
    sendOperations.mockRejectedValueOnce(dhiveErr);
    const res = await signedPost('/api/bridge/register', ACCREDITED_CALLER, {
      identifier: '2301.12345',
      discipline: 'CS',
    });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('BROADCAST_FAILED');
    expect(res.body.error.message).toBe('Failed to broadcast bridge paper registration to Hive');
    const bodyStr = JSON.stringify(res.body);
    // Per-field leak assertions: each marker is unique (round-3 hold #3).
    expect(bodyStr).not.toContain(dhiveErr.messageMarker);
    expect(bodyStr).not.toContain(dhiveErr.jseShortMsgMarker);
    expect(bodyStr).not.toContain(dhiveErr.causeMarker);
    expect(bodyStr).not.toContain(dhiveErr.jseCauseMarker);
    // Keep the original shortmsg / cause / info-key assertions too so any
    // residual interpolation that strips the marker suffix still trips.
    expect(bodyStr).not.toContain(SHORT);
    expect(bodyStr).not.toContain(CAUSE);
    expect(bodyStr).not.toContain(INFO_KEY);
    expect(bodyStr).not.toContain('witness_node');
  });
});

// ──────────────────────────────────────────────
// BACKEND-BRIDGE-OUTER-CATCH-EVENT-DISCRIMINATORS — catch-block log shape.
//
// Each catch-block `logger.error` site under bridge.ts emits an
// `event:` discriminator keyed `bridge.<sub-route>.<failure-class>` so
// operator dashboards filter on event without parsing route+message.
// The convention mirrors `custody.broadcast.internal_error` (round-2 of
// backend-bridge-custody-broadcast-discrimination).
//
// Site-by-site:
//   - /lookup outer-catch (lookupPreprint throw) → bridge.lookup.internal_error
//   - /check outer-catch (resolveToCanonical or downstream throw) →
//     bridge.check.internal_error
//   - /register inner-catch around resolveToCanonical →
//     bridge.register.identifier_resolution_failed
//   - /register inner-catch around lookupPreprint →
//     bridge.register.metadata_fetch_failed
//
// Each spec finds the matching call by event (NOT by message substring,
// which would slip through an event-field regression) and asserts the
// other context fields (route, identifier, username where applicable).
// Anti-pattern guard: `.not.toBe(<other-event>)` on an already-filtered
// call is a circular assertion (round-2 hold #4 of
// backend-bridge-custody-broadcast-discrimination) — we filter by event,
// then assert non-event fields.
// ──────────────────────────────────────────────

describe('BACKEND-BRIDGE-OUTER-CATCH-EVENT-DISCRIMINATORS — catch-block log shape', () => {
  const ACCREDITED_CALLER = 'accreditedevents';

  let errorSpy: ReturnType<typeof vi.spyOn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let bridgeMod: any;

  beforeEach(async () => {
    sendOperations.mockClear();
    accreditedSet.clear();
    accreditedSet.add(ACCREDITED_CALLER);
    errorSpy = vi.spyOn(logger, 'error').mockImplementation((() => undefined) as never);
    bridgeMod = await import('../../src/bridge.js');
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('GET /api/bridge/lookup: lookupPreprint throw → event:bridge.lookup.internal_error with route, identifier', async () => {
    (bridgeMod.lookupPreprint as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('crossref-network-error'));
    const res = await request(app).get('/api/bridge/lookup?identifier=2301.12345');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');

    const matchingCall = errorSpy.mock.calls.find((call) => {
      const ctx = call[0] as Record<string, unknown> | undefined;
      return ctx?.event === 'bridge.lookup.internal_error';
    });
    expect(matchingCall).toBeDefined();
    const ctx = matchingCall![0] as Record<string, unknown>;
    expect(ctx.route).toBe('bridge.lookup');
    expect(ctx.identifier).toBe('2301.12345');
    expect(ctx.err).toBeInstanceOf(Error);
  });

  it('GET /api/bridge/check: resolveToCanonical throw → event:bridge.check.internal_error with route, identifier', async () => {
    (bridgeMod.resolveToCanonical as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('parser-internal-error'));
    const res = await request(app).get('/api/bridge/check?identifier=2301.12345');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');

    const matchingCall = errorSpy.mock.calls.find((call) => {
      const ctx = call[0] as Record<string, unknown> | undefined;
      return ctx?.event === 'bridge.check.internal_error';
    });
    expect(matchingCall).toBeDefined();
    const ctx = matchingCall![0] as Record<string, unknown>;
    expect(ctx.route).toBe('bridge.check');
    expect(ctx.identifier).toBe('2301.12345');
    expect(ctx.err).toBeInstanceOf(Error);
  });

  it('POST /api/bridge/register: resolveToCanonical throw → event:bridge.register.identifier_resolution_failed with route, identifier, username', async () => {
    (bridgeMod.resolveToCanonical as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('parser-internal-error'));
    const res = await signedPost('/api/bridge/register', ACCREDITED_CALLER, {
      identifier: '2301.12345',
      discipline: 'CS',
    });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');

    const matchingCall = errorSpy.mock.calls.find((call) => {
      const ctx = call[0] as Record<string, unknown> | undefined;
      return ctx?.event === 'bridge.register.identifier_resolution_failed';
    });
    expect(matchingCall).toBeDefined();
    const ctx = matchingCall![0] as Record<string, unknown>;
    expect(ctx.route).toBe('bridge.register');
    expect(ctx.identifier).toBe('2301.12345');
    expect(ctx.username).toBe(ACCREDITED_CALLER);
    expect(ctx.err).toBeInstanceOf(Error);
  });

  it('POST /api/bridge/register: lookupPreprint throw → event:bridge.register.metadata_fetch_failed with route, identifier, username', async () => {
    (bridgeMod.lookupPreprint as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('crossref-network-error'));
    const res = await signedPost('/api/bridge/register', ACCREDITED_CALLER, {
      identifier: '2301.12345',
      discipline: 'CS',
    });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');

    const matchingCall = errorSpy.mock.calls.find((call) => {
      const ctx = call[0] as Record<string, unknown> | undefined;
      return ctx?.event === 'bridge.register.metadata_fetch_failed';
    });
    expect(matchingCall).toBeDefined();
    const ctx = matchingCall![0] as Record<string, unknown>;
    expect(ctx.route).toBe('bridge.register');
    expect(ctx.identifier).toBe('2301.12345');
    expect(ctx.username).toBe(ACCREDITED_CALLER);
    expect(ctx.err).toBeInstanceOf(Error);
  });
});


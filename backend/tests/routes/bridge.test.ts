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
 *
 * Justification for the `tryEnqueueBridgeImport` mock (per root CLAUDE.md
 * carve-out clause a): the /register handler's outer try/catch wraps the
 * lock-acquired body, and the only way to drive a synthetic throw INTO that
 * catch without a real Postgres queue is to make a downstream call inside
 * the body throw. After the queue migration the body no longer constructs
 * the post body inline (`buildBridgeBody` now lives in the worker); the
 * reachable in-body throw is the 202-response serialization. Mocking
 * `tryEnqueueBridgeImport` to return an `enqueued` result with a malformed
 * row (a `scheduled_at` that is not a Date) makes `serializeQueueRow` throw
 * synchronously inside the outer try, so the route-level catch is exercised
 * deterministically. The mock does NOT replace `verifyHiveSignature` —
 * requests are signed end-to-end against the real middleware, so this
 * file's auth focus is preserved.
 *
 * Real-path companion (carve-out clause c) for the `tryEnqueueBridgeImport`
 * mock: `backend/tests/routes/bridge-haf-lag-locks.test.ts` — it exercises
 * the integrated `/register` path with real Hive-signed requests against the
 * real `verifyHiveSignature` middleware, covering broadcast-side and
 * lock-side mutation classes (concurrent SETNX contention, HAF-503
 * fail-closed, lock TTL self-cleanup) under deterministic conditions. The
 * companion satisfies the clause-c criterion of exercising the integrated
 * path with real infrastructure so a different mutation class is caught;
 * it does not assert the same thing the mocked outer-catch spec asserts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';
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
// fall through to the real implementation. buildBridgeBody is NOT wrapped as
// a vi.fn here: after the queue migration it is only called by the worker
// (`bridge-worker.ts`), never by the /register route, so mocking it would not
// reach the route's outer-catch. The outer-catch throw is injected via the
// `tryEnqueueBridgeImport` mock below instead.
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

// Bridge-queue mock: `tryEnqueueBridgeImport` is wrapped as a vi.fn so the
// outer-catch fall-through spec can force the route's lock-acquired body to
// throw at 202-response serialization via mockImplementationOnce. Defaults to
// the real implementation so unrelated specs (none currently reach enqueue,
// but future ones might) are unaffected. The other queue exports fall through
// to the real module.
vi.mock('../../src/bridge-queue.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/bridge-queue.js')>('../../src/bridge-queue.js');
  return {
    ...actual,
    tryEnqueueBridgeImport: vi.fn().mockImplementation(
      (...args: Parameters<typeof actual.tryEnqueueBridgeImport>) => actual.tryEnqueueBridgeImport(...args),
    ),
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
// Dynamic import (not top-level static) so the eager import chain doesn't
// pull `../../src/config.js` in before this file's vi.mock factory's closed-
// over `TEST_BRIDGE_KEY` initializes. Static import would trigger a TDZ
// ReferenceError on test-runner module evaluation.
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
// Broadcast-timeout / broadcast-failed discrimination on /api/bridge/register
// was REMOVED when the route switched from synchronous broadcast to enqueue
// + 202 Accepted. Those failure classes now happen at the worker's dispatch
// path, not on the route. The worker-side coverage is exercised through the
// queue model tests in `backend/tests/lib/bridge-queue.test.ts` (state
// transitions on success / retry / terminal failure) and the
// `lib/broadcast-error.test.ts` helper-level tests.
//
// The mock-substitution-chain identity check (the `BroadcastTimeoutError`
// `vi.mock` substitution that gates `instanceof` resolution) is still
// load-bearing for the worker's `handleBroadcastError` consumers; it's
// validated indirectly when the queue's retry path is exercised against
// the real worker dispatch.
// ──────────────────────────────────────────────

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

    const matchingCall = errorSpy.mock.calls.find((call: unknown[]) => {
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

    const matchingCall = errorSpy.mock.calls.find((call: unknown[]) => {
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

    const matchingCall = errorSpy.mock.calls.find((call: unknown[]) => {
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

    const matchingCall = errorSpy.mock.calls.find((call: unknown[]) => {
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

  // The synchronous-broadcast-class outer-catch tests
  // (`buildBridgeBody throw` and `BridgeKeyCacheUnpopulated`) were removed
  // when the route migrated from synchronous broadcast to enqueue + 202.
  // The remaining outer-catch event-discriminator tests above
  // (`bridge.lookup.internal_error`, `bridge.check.internal_error`,
  // `bridge.register.identifier_resolution_failed`,
  // `bridge.register.metadata_fetch_failed`) still apply because those
  // exception paths fire BEFORE enqueue. The broadcast-class catch sites
  // now live in the worker (`backend/src/bridge-worker.ts`) and are
  // covered through the queue model's retry/terminal-fail transitions.
  //
  // The route's own outer-catch fall-through (an unexpected throw escaping
  // the lock-acquired body to the route-level try/catch) is covered by the
  // sibling describe block below.
});

// ──────────────────────────────────────────────
// The /register handler wraps its lock-acquired body in a route-level
// try/catch that maps any unexpected throw to 500 INTERNAL_ERROR + an
// `event: 'bridge.register.internal_error'` operator log. After the queue
// migration the body no longer constructs the post inline; the reachable
// in-body throw is the 202-response serialization. We drive that throw by
// making `tryEnqueueBridgeImport` return an `enqueued` result whose row's
// `scheduled_at` is not a Date, so `serializeQueueRow`'s `.toISOString()`
// throws synchronously inside the outer try. This guards the outer-catch:
// removing it (or changing the event tag / status / message) flips the spec
// RED.
// ──────────────────────────────────────────────

describe('POST /api/bridge/register — outer-catch fall-through emits bridge.register.internal_error', () => {
  const ACCREDITED_CALLER = 'accreditedoutercatch';

  let errorSpy: ReturnType<typeof vi.spyOn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let queueMod: any;

  beforeEach(async () => {
    sendOperations.mockClear();
    accreditedSet.clear();
    accreditedSet.add(ACCREDITED_CALLER);
    // HAF unconfigured so checkExistingBridge short-circuits to exists=false
    // and the handler proceeds into the enqueue path inside the outer try.
    hafConfigured.value = false;
    errorSpy = vi.spyOn(logger, 'error').mockImplementation((() => undefined) as never);
    queueMod = await import('../../src/bridge-queue.js');
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('synthetic in-body throw → 500 INTERNAL_ERROR with bridge.register.internal_error log + route/identifier/username/permlink context', async () => {
    // Malformed enqueue row: `scheduled_at` is a string, not a Date, so
    // serializeQueueRow's `row.scheduled_at.toISOString()` throws a
    // synchronous TypeError inside the route's outer try block.
    (queueMod.tryEnqueueBridgeImport as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
      status: 'enqueued',
      queuePosition: 1,
      row: {
        id: 1,
        operation_kind: 'bridge_register',
        username: ACCREDITED_CALLER,
        identifier: '2301.12345',
        permlink: 'bridge-arxiv-2301-12345',
        discipline: 'CS',
        keywords: [],
        language: 'en',
        state: 'pending',
        attempts: 0,
        // Intentionally NOT a Date — trips serializeQueueRow.
        scheduled_at: 'not-a-date' as unknown as Date,
        lease_expires_at: null,
        tx_id: null,
        error_code: null,
        error_message: null,
        existing_author: null,
        existing_permlink: null,
        created_at: new Date(),
        updated_at: new Date(),
        completed_at: null,
      },
    }));

    const res = await signedPost('/api/bridge/register', ACCREDITED_CALLER, {
      identifier: '2301.12345',
      discipline: 'CS',
    });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.message).toBe('Failed to register bridge paper');

    // Find the catch-block log by event discriminator (not message substring,
    // which would slip an event-field regression), then assert the non-event
    // context fields the operator dashboard keys on.
    const matchingCall = errorSpy.mock.calls.find((call: unknown[]) => {
      const ctx = call[0] as Record<string, unknown> | undefined;
      return ctx?.event === 'bridge.register.internal_error';
    });
    expect(matchingCall).toBeDefined();
    const ctx = matchingCall![0] as Record<string, unknown>;
    expect(ctx.route).toBe('bridge.register');
    expect(ctx.identifier).toBe('2301.12345');
    expect(ctx.username).toBe(ACCREDITED_CALLER);
    expect(ctx.permlink).toBe('bridge-arxiv-2301-12345');
    expect(ctx.err).toBeInstanceOf(Error);

    // The malformed-serialization throw fires AFTER enqueue, so no broadcast
    // is attempted on this path.
    expect(sendOperations).not.toHaveBeenCalled();
  });
});


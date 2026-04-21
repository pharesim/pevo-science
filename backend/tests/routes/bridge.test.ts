/**
 * Route tests for /api/bridge/*.
 *
 * Most scenarios (lookup/check/unauthenticated register/update) don't need
 * mocking — the handlers short-circuit on input validation before touching
 * Hive/HAF. The BE-CLAIMS-ERROR-POLISH block (503 on missing bridge posting
 * key) does need the auth layer to pass, so that block mocks the same shape
 * as claims.test.ts: real `verifyHiveSignature` with a deterministic keypair,
 * mocked on-chain account lookup, and a mocked accreditation lookup. We do
 * NOT mock `verifyHiveSignature` itself — the tests sign real requests.
 *
 * Justification for the `getAccreditedSet` mock (per root CLAUDE.md carve-out):
 * the bridge register/update handlers require the caller to be accredited.
 * Seeding an accreditation row means broadcasting an `issue_accreditation`
 * custom_json on Hive and waiting for HAF to index it. That's impractical
 * per-test when we only care about exercising the 503 misconfig guard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { PrivateKey, cryptoUtils } from '@hiveio/dhive';

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
const sendOperations = vi.fn().mockResolvedValue({ id: 'mock-tx-id' });
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
      call: vi.fn(),
    },
    broadcast: {
      sendOperations: (...args: unknown[]) => sendOperations(...args),
    },
  },
}));

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
// no-op pool so the module imports succeed.
vi.mock('../../src/db.js', () => ({
  getPool: () => null,
  isHafAvailable: () => false,
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

describe('POST /api/bridge/update', () => {
  it('requires authentication headers', async () => {
    const res = await request(app)
      .post('/api/bridge/update')
      .send({ permlink: 'bridge-arxiv-2301-12345' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

// ──────────────────────────────────────────────
// BE-CLAIMS-ERROR-POLISH — Bridge-misconfig 503 surface (bridge.ts side)
//
// Mirrors the round-1 claims.test.ts block. When PEVO_BRIDGE_POSTING_KEY is
// unset, /api/bridge/register and /api/bridge/update must return 503
// SERVICE_UNAVAILABLE with the same operator-facing message that the claim
// approve/revoke handlers use, instead of the prior 500 INTERNAL_ERROR. This
// keeps the misconfig code+message identical across all four call sites.
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

  it('POST /api/bridge/update with empty bridge key → 503 SERVICE_UNAVAILABLE, no broadcast', async () => {
    const res = await signedPost('/api/bridge/update', ACCREDITED_CALLER, {
      permlink: 'bridge-arxiv-2301-12345',
    });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.message).toBe('Bridge posting key not configured');
    expect(sendOperations).not.toHaveBeenCalled();
  });
});

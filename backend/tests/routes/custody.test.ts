/**
 * Route tests for POST /api/custody/broadcast.
 *
 * Scope: BE-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION — verifies that the
 * custodial broadcast handler discriminates BroadcastTimeoutError (504
 * BROADCAST_TIMEOUT, uncertain-outcome envelope) from other broadcast errors
 * (502 BROADCAST_FAILED, retriable=false) and does not interpolate chain-
 * internal err.message text into the response body.
 *
 * Justification for the `getAppPool()` + `decryptKey` + `logCustodyBroadcast`
 * mocks (per root CLAUDE.md carve-out): the /broadcast handler requires
 * (a) a light-custody account row with encrypted posting key material
 * seeded into `app.accounts`, and (b) the AES-GCM ciphertext to decrypt to
 * a valid Hive WIF under the per-account HKDF key. Seeding that per-test
 * needs a matching ciphertext produced by `encryptKey` under a known master
 * key — the test assertion is on envelope discrimination, not on key
 * material correctness, so mocking the decrypt path is justified. The
 * `verifyHiveSignature` middleware is NOT mocked; we pass a Bearer JWT
 * signed with the real SESSION_SECRET path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { PrivateKey } from '@hiveio/dhive';

// Deterministic WIF returned by the mocked decryptKey — never broadcasts
// because broadcastSendOperationsWithTimeout is mocked.
const TEST_POSTING_WIF = PrivateKey.fromSeed('pevo-custody-test-posting-seed').toString();

// BroadcastTimeoutError stub mirroring the real constructor so the route's
// `err instanceof BroadcastTimeoutError` branch fires when the mock rejects
// with it.
const { MockBroadcastTimeoutError, sendOperationsMock } = vi.hoisted(() => ({
  MockBroadcastTimeoutError: class BroadcastTimeoutError extends Error {
    public readonly timeoutMs: number;
    constructor(timeoutMs: number) {
      super(`Hive broadcast timed out after ${timeoutMs}ms`);
      this.name = 'BroadcastTimeoutError';
      this.timeoutMs = timeoutMs;
    }
  },
  sendOperationsMock: vi.fn().mockResolvedValue({ id: 'mock-tx-id', block_num: 42 }),
}));

vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: {
      getAccounts: vi.fn().mockResolvedValue([]),
    },
    broadcast: {
      sendOperations: (...args: unknown[]) => sendOperationsMock(...args),
    },
  },
  broadcastSendOperationsWithTimeout: (...args: unknown[]) => sendOperationsMock(...args),
  BroadcastTimeoutError: MockBroadcastTimeoutError,
  DEFAULT_BROADCAST_TIMEOUT_MS: 30_000,
}));

// getAppPool returns a light-account row with non-null posting_key_enc /
// iv_posting and no upgraded_at. The session-invalidation check inside
// verifyHiveSignature also hits this pool; return a row without
// sessions_invalidated_at for that lookup.
const appQueryMock = vi.fn();
appQueryMock.mockImplementation(async (sql: string, _params: unknown[]) => {
  if (sql.includes('sessions_invalidated_at')) {
    return { rows: [{ sessions_invalidated_at: null }] };
  }
  if (sql.includes('posting_key_enc')) {
    return {
      rows: [
        {
          posting_key_enc: Buffer.from('ciphertext'),
          iv_posting: Buffer.from('iv'),
          upgraded_at: null,
        },
      ],
    };
  }
  return { rows: [] };
});

vi.mock('../../src/app-db.js', () => ({
  getAppPool: () => ({ query: appQueryMock }),
}));

// Decrypted posting key — real decryption would require matching AES-GCM
// material. The return value is parsed by PrivateKey.fromString() so it
// must be a valid WIF; sendOperations never actually runs because the
// timeout helper is mocked above.
vi.mock('../../src/custody-crypto.js', () => ({
  decryptKey: vi.fn().mockReturnValue(TEST_POSTING_WIF),
}));

// Audit log is fire-and-forget; stub to keep it out of the test path.
vi.mock('../../src/custody-audit.js', () => ({
  logCustodyBroadcast: vi.fn().mockResolvedValue(undefined),
}));

// Redis stub — rate limiter + replay cache both tolerate no-redis.
vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
}));

// HAF pool is not used by /broadcast; return null so middleware imports succeed.
vi.mock('../../src/db.js', () => ({
  getPool: () => null,
  isHafAvailable: () => false,
  closeHafPool: async () => {},
}));

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');

const app = createApp();

const USERNAME = 'lightaccountuser';

function bearerFor(username: string, custody: 'light' | 'self' = 'light'): string {
  return jwt.sign({ sub: username, custody }, config.sessionSecret, { expiresIn: '1h' });
}

async function bearerPost(path: string, token: string, body: unknown) {
  return request(app)
    .post(path)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

const VALID_OPERATIONS = [
  [
    'vote',
    {
      voter: USERNAME,
      author: 'someauthor',
      permlink: 'somepermlink',
      weight: 10000,
    },
  ],
];

const TIMEOUT_DETAILS = {
  retriable: false,
  outcome: 'uncertain',
  verify_before_retry: true,
  timeout_ms: 30_000,
};

beforeEach(() => {
  sendOperationsMock.mockReset();
  sendOperationsMock.mockResolvedValue({ id: 'mock-tx-id', block_num: 42 });
  appQueryMock.mockClear();
});

describe('BE-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION — /api/custody/broadcast timeout discrimination', () => {
  it('BroadcastTimeoutError → 504 BROADCAST_TIMEOUT with uncertain-outcome envelope', async () => {
    sendOperationsMock.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));
    const token = bearerFor(USERNAME, 'light');
    const res = await bearerPost('/api/custody/broadcast', token, { operations: VALID_OPERATIONS });
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('BROADCAST_TIMEOUT');
    expect(res.body.error.message).toBe('Broadcasting signed operation timed out');
    expect(res.body.error.details).toEqual(TIMEOUT_DETAILS);
    // Not an orcid surface — no verify_location hint.
    expect(res.body.error.details.verify_location).toBeUndefined();
  });

  it('non-timeout broadcast error → 502 BROADCAST_FAILED with retriable=false and no err.message leak', async () => {
    const CHAIN_INTERNAL = 'RPC node rejected: missing_posting_auth custody';
    sendOperationsMock.mockRejectedValueOnce(new Error(CHAIN_INTERNAL));
    const token = bearerFor(USERNAME, 'light');
    const res = await bearerPost('/api/custody/broadcast', token, { operations: VALID_OPERATIONS });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('BROADCAST_FAILED');
    expect(res.body.error.message).toBe('Failed to broadcast signed operation to Hive');
    expect(res.body.error.details).toEqual({ retriable: false });
    // Chain-internal error text must NOT be interpolated into the response.
    expect(JSON.stringify(res.body)).not.toContain('missing_posting_auth');
    expect(JSON.stringify(res.body)).not.toContain(CHAIN_INTERNAL);
  });
});

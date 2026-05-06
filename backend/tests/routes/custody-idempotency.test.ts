/**
 * Route-level integration tests for the idempotency wiring at POST
 * /api/custody/broadcast. The lib helpers (embed, find, validate) are
 * unit-tested in `tests/lib/idempotency.test.ts`; these specs pin the
 * route-side glue: the pre-broadcast HAF lookup short-circuits to a 200
 * `outcome:'already_landed'` envelope without invoking
 * `broadcastSendOperationsWithTimeout`, the missing-key path emits the
 * `idempotency_key_missing` warn, and the embed mutates the operations
 * array passed to the broadcast.
 *
 * Mock posture mirrors `tests/routes/custody.test.ts` (per the carve-out at
 * root CLAUDE.md "Carve-out for deterministic edge-case coverage"): broadcast
 * is mocked because the dhive RPC client is not safe to drive per-test, the
 * AES-GCM decrypt is mocked because round-tripping ciphertexts adds zero
 * coverage to the wiring under test, and the DB pool is mocked because the
 * route's app-db reads are uncoupled from the idempotency logic. The HAF
 * pool is mocked at the `db.js` boundary so the same query stub serves the
 * three idempotency arms (hit, miss, lookup-failure) by per-test override.
 * `verifyHiveSignature` middleware runs real (real JWT verify against the
 * suite's `SESSION_SECRET`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { PrivateKey } from '@hiveio/dhive';
import { MockBroadcastTimeoutError } from '../support/broadcast-mocks.js';

const TEST_POSTING_WIF = PrivateKey.fromSeed('pevo-custody-idem-test-seed').toString();

const { sendOperationsMock } = vi.hoisted(() => ({
  sendOperationsMock: vi.fn().mockResolvedValue({ id: 'fresh-tx-id', block_num: 999 }),
}));

vi.mock('../../src/hive.js', async () => {
  const { MockBroadcastTimeoutError } = await import('../support/broadcast-mocks.js');
  return {
    hiveClient: {
      database: { getAccounts: vi.fn().mockResolvedValue([]) },
      broadcast: {
        sendOperations: (...args: unknown[]) => sendOperationsMock(...args),
      },
    },
    broadcastSendOperationsWithTimeout: (...args: unknown[]) => sendOperationsMock(...args),
    BroadcastTimeoutError: MockBroadcastTimeoutError,
    DEFAULT_BROADCAST_TIMEOUT_MS: 30_000,
  };
});

const appQueryMock = vi.fn().mockImplementation(async (sql: string) => {
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

const { decryptKeyMock, logCustodyBroadcastMock } = vi.hoisted(() => ({
  decryptKeyMock: vi.fn(),
  logCustodyBroadcastMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/custody-crypto.js', () => ({
  decryptKey: (...args: unknown[]) => decryptKeyMock(...args),
}));

vi.mock('../../src/custody-audit.js', () => ({
  logCustodyBroadcast: (...args: unknown[]) => logCustodyBroadcastMock(...args),
}));

vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
}));

// HAF pool is the load-bearing surface for these specs. `hafQueryMock` lets
// each test stage the comments-then-customJson query response sequence
// findCustodyBroadcastByIdempotencyKey emits.
const { hafQueryMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  getPool: () => ({ query: hafQueryMock }),
  isHafAvailable: () => true,
  closeHafPool: async () => {},
}));

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { logger } = await import('../../src/logger.js');

const app = createApp();
const USERNAME = 'idemcustodyuser';

function bearerFor(username: string): string {
  return jwt.sign({ sub: username, custody: 'light' }, config.sessionSecret, { expiresIn: '1h' });
}

async function bearerPost(token: string, body: unknown) {
  return request(app)
    .post('/api/custody/broadcast')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

const VOTE_OP = [
  'vote',
  { voter: USERNAME, author: 'someauthor', permlink: 'somepermlink', weight: 10000 },
];

const CUSTOM_JSON_REVOTE = [
  'custom_json',
  {
    required_auths: [],
    required_posting_auths: [USERNAME],
    id: config.appTag,
    json: JSON.stringify({ action: 'revote', target: 'someauthor/somepermlink' }),
  },
];

const VALID_KEY = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  sendOperationsMock.mockReset();
  sendOperationsMock.mockResolvedValue({ id: 'fresh-tx-id', block_num: 999 });
  decryptKeyMock.mockReset();
  decryptKeyMock.mockReturnValue(TEST_POSTING_WIF);
  logCustodyBroadcastMock.mockClear();
  appQueryMock.mockClear();
  hafQueryMock.mockReset();
});

describe('custody /broadcast idempotency (Option A.4)', () => {
  it('HAF hit on the comments arm short-circuits with outcome:already_landed and skips broadcast', async () => {
    // First HAF query (comments) returns the prior op; second (custom_json)
    // is never reached. The route emits 200 with the existing tx_id and
    // does NOT invoke broadcastSendOperationsWithTimeout.
    hafQueryMock.mockResolvedValueOnce({
      rows: [{ trx_id: 'tx-prior-comment', block_num: 555 }],
    });

    const res = await bearerPost(bearerFor(USERNAME), {
      operations: [CUSTOM_JSON_REVOTE],
      idempotency_key: VALID_KEY,
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      tx_id: 'tx-prior-comment',
      block_num: 555,
      outcome: 'already_landed',
    });
    expect(sendOperationsMock).not.toHaveBeenCalled();
    expect(decryptKeyMock).not.toHaveBeenCalled();
    expect(logCustodyBroadcastMock).not.toHaveBeenCalled();
  });

  it('HAF hit on the custom_json arm (after empty comments arm) short-circuits', async () => {
    hafQueryMock.mockResolvedValueOnce({ rows: [] });
    hafQueryMock.mockResolvedValueOnce({
      rows: [{ trx_id: 'tx-prior-cj', block_num: 777 }],
    });

    const res = await bearerPost(bearerFor(USERNAME), {
      operations: [CUSTOM_JSON_REVOTE],
      idempotency_key: VALID_KEY,
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      tx_id: 'tx-prior-cj',
      block_num: 777,
      outcome: 'already_landed',
    });
    expect(sendOperationsMock).not.toHaveBeenCalled();
  });

  it('HAF miss embeds idempotency_key into the custom_json op and broadcasts', async () => {
    hafQueryMock.mockResolvedValue({ rows: [] });

    const res = await bearerPost(bearerFor(USERNAME), {
      operations: [CUSTOM_JSON_REVOTE],
      idempotency_key: VALID_KEY,
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ tx_id: 'fresh-tx-id', block_num: 999 });
    expect(res.body.data.outcome).toBeUndefined();
    expect(sendOperationsMock).toHaveBeenCalledTimes(1);
    const broadcastedOps = sendOperationsMock.mock.calls[0][0] as Array<[string, { json: string }]>;
    const cjPayload = JSON.parse(broadcastedOps[0][1].json) as { idempotency_key: string; action: string };
    expect(cjPayload.idempotency_key).toBe(VALID_KEY);
    expect(cjPayload.action).toBe('revote');
  });

  it('rejects malformed idempotency_key (non-string) with 400 VALIDATION_ERROR before any HAF call', async () => {
    const res = await bearerPost(bearerFor(USERNAME), {
      operations: [CUSTOM_JSON_REVOTE],
      idempotency_key: 42,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(hafQueryMock).not.toHaveBeenCalled();
    expect(sendOperationsMock).not.toHaveBeenCalled();
  });

  it('missing idempotency_key emits the migration-window warn and broadcasts as before', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    try {
      const res = await bearerPost(bearerFor(USERNAME), {
        operations: [VOTE_OP],
      });
      expect(res.status).toBe(200);
      expect(sendOperationsMock).toHaveBeenCalledTimes(1);
      const matchingCall = warnSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'custody.broadcast.idempotency_key_missing';
      });
      expect(matchingCall, 'expected idempotency_key_missing warn').toBeDefined();
      // HAF lookup never fires when no key is supplied — the layer is opt-in.
      expect(hafQueryMock).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('pure-vote bundle WITH key emits no_embed_surface warn and broadcasts unchanged', async () => {
    hafQueryMock.mockResolvedValue({ rows: [] });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    try {
      const res = await bearerPost(bearerFor(USERNAME), {
        operations: [VOTE_OP],
        idempotency_key: VALID_KEY,
      });
      expect(res.status).toBe(200);
      expect(sendOperationsMock).toHaveBeenCalledTimes(1);
      const matchingCall = warnSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'custody.broadcast.idempotency_no_embed_surface';
      });
      expect(matchingCall, 'expected idempotency_no_embed_surface warn').toBeDefined();
      // The vote op shape is unchanged — no embed.
      const broadcastedOps = sendOperationsMock.mock.calls[0][0] as Array<[string, Record<string, unknown>]>;
      expect(broadcastedOps[0][1]).not.toHaveProperty('idempotency_key');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('HAF lookup throw degrades gracefully — broadcast still proceeds with embed', async () => {
    hafQueryMock.mockRejectedValueOnce(new Error('haf connection drop'));
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    try {
      const res = await bearerPost(bearerFor(USERNAME), {
        operations: [CUSTOM_JSON_REVOTE],
        idempotency_key: VALID_KEY,
      });
      expect(res.status).toBe(200);
      expect(sendOperationsMock).toHaveBeenCalledTimes(1);
      const matchingCall = warnSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'custody.broadcast.idempotency_lookup_failed';
      });
      expect(matchingCall, 'expected idempotency_lookup_failed warn').toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

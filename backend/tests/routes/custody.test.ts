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
import { MockBroadcastTimeoutError, makeDhiveLikeError } from '../support/broadcast-mocks.js';

// Deterministic WIF returned by the mocked decryptKey — never broadcasts
// because broadcastSendOperationsWithTimeout is mocked.
const TEST_POSTING_WIF = PrivateKey.fromSeed('pevo-custody-test-posting-seed').toString();

// `sendOperationsMock` is hoisted so the `vi.mock` factory below can reference
// it; `MockBroadcastTimeoutError` is imported from the shared
// `tests/support/broadcast-mocks.ts` module (round-2 hold #1) so bridge.test.ts
// and custody.test.ts share one canonical mock identity.
const { sendOperationsMock } = vi.hoisted(() => ({
  sendOperationsMock: vi.fn().mockResolvedValue({ id: 'mock-tx-id', block_num: 42 }),
}));

vi.mock('../../src/hive.js', async () => {
  const { MockBroadcastTimeoutError } = await import('../support/broadcast-mocks.js');
  return {
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
  };
});

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
// timeout helper is mocked above. Hoisted so the outer-catch test below
// (round-2 hold #2) can swap it to throw per-test.
const { decryptKeyMock, logCustodyBroadcastMock } = vi.hoisted(() => ({
  decryptKeyMock: vi.fn(),
  logCustodyBroadcastMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/custody-crypto.js', () => ({
  decryptKey: (...args: unknown[]) => decryptKeyMock(...args),
}));

// Audit log is fire-and-forget; stub to keep it out of the test path.
// Hoisted so the round-2 hold #4 audit-log assertion can read mock state.
vi.mock('../../src/custody-audit.js', () => ({
  logCustodyBroadcast: (...args: unknown[]) => logCustodyBroadcastMock(...args),
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
const { logger } = await import('../../src/logger.js');

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
  decryptKeyMock.mockReset();
  decryptKeyMock.mockReturnValue(TEST_POSTING_WIF);
  logCustodyBroadcastMock.mockClear();
});

describe('BE-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION — /api/custody/broadcast timeout discrimination', () => {
  // Round-2 hold #1: structural identity assertion. Same rationale as the
  // sibling assertion in bridge.test.ts. The route's `instanceof
  // BroadcastTimeoutError` discrimination AND the helper's instanceof check
  // both resolve via `import { BroadcastTimeoutError } from '../hive.js'`.
  // The `vi.mock` above substitutes `MockBroadcastTimeoutError` from the
  // shared `tests/support/broadcast-mocks.ts` module. If the substitution
  // chain breaks (re-export barrel, hoist preempt, ordering refactor), the
  // helper would resolve to the real class and `instanceof` returns false —
  // every 504 spec passes against the wrong branch. This single check fails
  // fast.
  it('mock-substitution chain identity check (round-2 hold #1)', async () => {
    const { BroadcastTimeoutError } = await import('../../src/hive.js');
    expect(BroadcastTimeoutError).toBe(MockBroadcastTimeoutError);
  });

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

  // Round-2 hold #3: dhive-shaped RPCError fixture. The pre-migration code
  // preferred `err.jse_shortmsg` over `err.message`; the leak-assertion above
  // passes by construction against `new Error(CHAIN_INTERNAL)` because the
  // body is a static string regardless of throw shape. Stage a real-shaped
  // RPCError so the leak-assertion has surface to catch a regression that
  // re-introduces `jse_shortmsg` / `jse_cause` / `info` interpolation.
  it('dhive-shaped RPCError → 502 BROADCAST_FAILED, no jse_shortmsg/jse_cause/info leak', async () => {
    const SHORT = 'missing_posting_auth custody';
    const CAUSE = 'op_authority_check_failed';
    const INFO_KEY = 'witness_internal_dump';
    const dhiveErr = makeDhiveLikeError({
      shortmsg: SHORT,
      cause: CAUSE,
      info: { internal_marker: INFO_KEY, op_index: 0 },
    });
    sendOperationsMock.mockRejectedValueOnce(dhiveErr);
    const token = bearerFor(USERNAME, 'light');
    const res = await bearerPost('/api/custody/broadcast', token, { operations: VALID_OPERATIONS });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('BROADCAST_FAILED');
    expect(res.body.error.message).toBe('Failed to broadcast signed operation to Hive');
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain(SHORT);
    expect(bodyStr).not.toContain(CAUSE);
    expect(bodyStr).not.toContain(INFO_KEY);
  });
});

// ──────────────────────────────────────────────
// Round-2 hold #2: outer-catch INTERNAL_ERROR coverage. The discrimination
// migration renamed the outer 500 code from `BROADCAST_FAILED` to
// `INTERNAL_ERROR` (db / decrypt / `PrivateKey.fromString` errors are NOT
// chain-side and shouldn't share the broadcast-failure code), and added an
// `event:'custody_broadcast_internal_error'` discriminator on the structured
// log. Without coverage, a mutation that reverts the rename — or drops the
// event field — is undetected. One spec per failure source (decryptKey here)
// is sufficient: the outer-catch routing is the same for all three (db,
// decrypt, key parse).
// ──────────────────────────────────────────────

describe('BE-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION — /api/custody/broadcast outer-catch', () => {
  it('decryptKey throws → 500 INTERNAL_ERROR with non-chain event discriminator (round-2 hold #2)', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    decryptKeyMock.mockImplementationOnce(() => {
      throw new Error('aes-256-gcm: authentication tag mismatch');
    });
    try {
      const token = bearerFor(USERNAME, 'light');
      const res = await bearerPost('/api/custody/broadcast', token, { operations: VALID_OPERATIONS });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(res.body.error.message).toBe('Failed to broadcast transaction');
      // Structured log carries the non-broadcast event discriminator and the
      // hoisted op-context fields (round-2 hold #5: outer catch must not lose
      // operation context).
      const matchingCall = errorSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'custody_broadcast_internal_error';
      });
      expect(matchingCall, 'expected logger.error to fire with event:custody_broadcast_internal_error').toBeDefined();
      const ctx = matchingCall![0] as Record<string, unknown>;
      expect(ctx.username).toBe(USERNAME);
      expect(ctx.op_types).toEqual(['vote']);
      expect(ctx.op_count).toBe(1);
      // Must NOT carry the broadcast-attempt event (this is upstream of the
      // broadcast).
      expect(ctx.event).not.toBe('custody_broadcast_attempt');
      expect(ctx.event).not.toBe('broadcast_failed');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ──────────────────────────────────────────────
// Round-2 hold #4: per-attempt audit-log signal. The DB-side
// `logCustodyBroadcast` writes only on success; the new pino-side
// `event:'custody_broadcast_attempt'` log fires on EVERY broadcast attempt
// with `outcome ∈ {success, failure, timeout}` so operators have a signal
// for retry-amplification (the full idempotency design is filed separately
// as `backend-broadcast-idempotency-cluster-followup.md`; this hold-fix
// covers the audit-log half only).
// ──────────────────────────────────────────────

describe('BE-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION — per-attempt audit log', () => {
  it('success: emits event:custody_broadcast_attempt with outcome:success and tx_id', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    try {
      const token = bearerFor(USERNAME, 'light');
      const res = await bearerPost('/api/custody/broadcast', token, { operations: VALID_OPERATIONS });
      expect(res.status).toBe(200);
      const matchingCall = infoSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'custody_broadcast_attempt';
      });
      expect(matchingCall, 'expected logger.info to fire with event:custody_broadcast_attempt').toBeDefined();
      const ctx = matchingCall![0] as Record<string, unknown>;
      expect(ctx.outcome).toBe('success');
      expect(ctx.username).toBe(USERNAME);
      expect(ctx.op_types).toEqual(['vote']);
      expect(ctx.op_count).toBe(1);
      expect(ctx.attempt_n).toBe(1);
      expect(ctx.tx_id).toBe('mock-tx-id');
      // The DB-side audit log still fires on success.
      expect(logCustodyBroadcastMock).toHaveBeenCalledTimes(1);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('timeout: emits event:custody_broadcast_attempt with outcome:timeout', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    try {
      sendOperationsMock.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));
      const token = bearerFor(USERNAME, 'light');
      const res = await bearerPost('/api/custody/broadcast', token, { operations: VALID_OPERATIONS });
      expect(res.status).toBe(504);
      const matchingCall = warnSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'custody_broadcast_attempt';
      });
      expect(matchingCall, 'expected logger.warn to fire with event:custody_broadcast_attempt').toBeDefined();
      const ctx = matchingCall![0] as Record<string, unknown>;
      expect(ctx.outcome).toBe('timeout');
      expect(ctx.username).toBe(USERNAME);
      expect(ctx.op_types).toEqual(['vote']);
      // DB-side audit log does NOT fire on timeout (covers only success).
      expect(logCustodyBroadcastMock).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('failure: emits event:custody_broadcast_attempt with outcome:failure', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    try {
      sendOperationsMock.mockRejectedValueOnce(new Error('chain rejection: missing_posting_auth'));
      const token = bearerFor(USERNAME, 'light');
      const res = await bearerPost('/api/custody/broadcast', token, { operations: VALID_OPERATIONS });
      expect(res.status).toBe(502);
      const matchingCall = warnSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'custody_broadcast_attempt';
      });
      expect(matchingCall, 'expected logger.warn to fire with event:custody_broadcast_attempt').toBeDefined();
      const ctx = matchingCall![0] as Record<string, unknown>;
      expect(ctx.outcome).toBe('failure');
      expect(ctx.op_count).toBe(1);
      // DB-side audit log does NOT fire on failure either.
      expect(logCustodyBroadcastMock).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

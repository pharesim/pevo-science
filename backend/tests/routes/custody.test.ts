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
// Hoisted as a module-scope const so the per-test save/restore pattern
// (e.g., the outer-catch specs that install a throw-by-SQL-shape impl in
// a single test) can restore the module-load impl unconditionally in
// `finally`, without depending on `getMockImplementation()` returning the
// current impl. `beforeEach` calls `mockClear` not `mockReset`, so the
// module-load impl survives between tests; restoring from this named
// reference makes the discipline independent of that choice — a future
// switch to `mockReset` would wipe `getMockImplementation()` but the
// named reference still resolves.
const DEFAULT_APP_QUERY_IMPL = async (sql: string, _params: unknown[]) => {
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
};
const appQueryMock = vi.fn();
appQueryMock.mockImplementation(DEFAULT_APP_QUERY_IMPL);

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
  isHafConfigured: () => false,
  closeHafPool: async () => {},
}));

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { logger } = await import('../../src/logger.js');
// BACKEND-CUSTODY-BROADCAST-ORCID-FRESH-AUTH: non-consent broadcast now
// requires a fresh-auth proof. The route consumes via
// `consumeSessionFreshAuthToken` which accepts both session-kind and
// consent_op-kind proofs. Tests mint a fresh proof per call via the
// in-memory fallback store (Redis is mocked out above).
const {
  issueSessionFreshAuthToken,
  _resetFreshAuthMemStoreForTests,
} = await import('../../src/lib/fresh-auth.js');

const app = createApp();

const USERNAME = 'lightaccountuser';

function bearerFor(username: string, custody: 'light' | 'self' = 'light'): string {
  return jwt.sign({ sub: username, custody }, config.sessionSecret, { expiresIn: '1h' });
}

async function bearerPost(path: string, token: string, body: Record<string, unknown>) {
  return request(app)
    .post(path)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

/** Mint a session-kind fresh-auth proof for USERNAME via the in-memory
 *  store (Redis is mocked unavailable above). Each test that hits the
 *  non-consent broadcast surface MUST acquire a fresh proof — single-use
 *  semantic on the consume side burns it after one call. */
async function mintSessionProof(username: string = USERNAME): Promise<string> {
  const { token } = await issueSessionFreshAuthToken(username, 'password');
  return token;
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
  // BACKEND-CUSTODY-BROADCAST-ORCID-FRESH-AUTH: clear the fresh-auth
  // in-memory store between tests so single-use semantics on the consume
  // side don't leak across cases.
  _resetFreshAuthMemStoreForTests();
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
    const res = await bearerPost('/api/custody/broadcast', token, {
      operations: VALID_OPERATIONS,
      fresh_auth_proof: await mintSessionProof(),
    });
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
    const res = await bearerPost('/api/custody/broadcast', token, {
      operations: VALID_OPERATIONS,
      fresh_auth_proof: await mintSessionProof(),
    });
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
  //
  // Round-3 hold #3: per-field unique sentinels. The fixture now stamps each
  // of `err.message`, `err.jse_shortmsg`, `err.cause.message`, `err.jse_cause`
  // with a distinct auto-generated marker. A regression that re-interpolates
  // ANY single one of those fields surfaces against that field's own marker
  // (rather than the prior shared `shortmsg` value, where a single-field leak
  // would silently pass because both `message` and `jse_shortmsg` shared the
  // same value).
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
    const res = await bearerPost('/api/custody/broadcast', token, {
      operations: VALID_OPERATIONS,
      fresh_auth_proof: await mintSessionProof(),
    });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('BROADCAST_FAILED');
    expect(res.body.error.message).toBe('Failed to broadcast signed operation to Hive');
    const bodyStr = JSON.stringify(res.body);
    // Per-field leak assertions: each marker is unique, so a single-field
    // leak is caught against the field's own marker (round-3 hold #3).
    expect(bodyStr).not.toContain(dhiveErr.messageMarker);
    expect(bodyStr).not.toContain(dhiveErr.jseShortMsgMarker);
    expect(bodyStr).not.toContain(dhiveErr.causeMarker);
    expect(bodyStr).not.toContain(dhiveErr.jseCauseMarker);
    // Keep the original shortmsg / cause / info-key assertions too so any
    // residual interpolation that strips the marker suffix still trips.
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
// `event:'custody.broadcast.internal_error'` discriminator on the structured
// log. Without coverage, a mutation that reverts the rename — or drops the
// event field — is undetected. One spec per failure source (decryptKey here)
// is sufficient: the outer-catch routing is the same for all three (db,
// decrypt, key parse).
// ──────────────────────────────────────────────

describe('BE-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION — /api/custody/broadcast outer-catch', () => {
  it('decryptKey throws → 500 INTERNAL_ERROR with non-chain event discriminator (round-2 hold #2)', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    decryptKeyMock.mockImplementationOnce(() => {
      throw new Error('aes-256-gcm: authentication tag mismatch');
    });
    try {
      const token = bearerFor(USERNAME, 'light');
      const res = await bearerPost('/api/custody/broadcast', token, {
      operations: VALID_OPERATIONS,
      fresh_auth_proof: await mintSessionProof(),
    });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(res.body.error.message).toBe('Failed to broadcast transaction');
      // Structured log carries the non-broadcast event discriminator and the
      // hoisted op-context fields (round-2 hold #5: outer catch must not lose
      // operation context).
      const matchingCall = errorSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'custody.broadcast.internal_error';
      });
      expect(matchingCall, 'expected logger.error to fire with event:custody.broadcast.internal_error').toBeDefined();
      const ctx = matchingCall![0] as Record<string, unknown>;
      expect(ctx.username).toBe(USERNAME);
      expect(ctx.op_types).toEqual(['vote']);
      expect(ctx.op_count).toBe(1);
      // Round-3 hold #4: the prior `expect(ctx.event).not.toBe(...)` was
      // circular — the `find` filter already excluded the dual events, so
      // the assertion was trivially true. Replace with a no-emit check on
      // the OTHER side: across ALL logger calls during this outer-catch
      // path, the broadcast-attempt event MUST NOT fire (the failure was
      // upstream of the broadcast helper). A regression where the
      // inner-catch helper also fires the outer-catch event (or vice
      // versa) is now mutation-killed.
      const collect = (spy: typeof errorSpy, evt: string) =>
        spy.mock.calls.filter((c) => (c[0] as Record<string, unknown> | undefined)?.event === evt);
      const attemptCalls = [
        ...collect(infoSpy, 'custody.broadcast.attempt'),
        ...collect(warnSpy, 'custody.broadcast.attempt'),
        ...collect(errorSpy, 'custody.broadcast.attempt'),
      ];
      expect(
        attemptCalls,
        'broadcast-attempt event must NOT fire on outer-catch (pre-broadcast) failure',
      ).toHaveLength(0);
      // The standard 502/504 broadcast-failure events must also NOT fire on
      // the outer-catch path — those route to broadcast on-call, this
      // failure is upstream.
      const broadcastFailedCalls = [
        ...collect(errorSpy, 'broadcast_failed'),
        ...collect(warnSpy, 'broadcast_timeout'),
      ];
      expect(
        broadcastFailedCalls,
        'broadcast_failed/broadcast_timeout events must NOT fire on outer-catch (pre-broadcast) failure',
      ).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  // Round-3 hold #9: the outer-catch is reachable from THREE failure paths
  // (db / decrypt / PrivateKey.fromString); the spec above only exercised
  // the `decryptKey` throw. These two siblings exercise the other paths.
  // The spec comment in the parent describe claims "routing is the same
  // for all three" — these tests pin that claim so a future regression
  // that special-cases one of the other branches is mutation-killed.
  it('pool.query throws → 500 INTERNAL_ERROR with internal_error event (round-3 hold #9)', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    // The middleware does a `sessions_invalidated_at` lookup FIRST. The
    // handler then issues the `posting_key_enc` SELECT — we throw only on
    // that second call so the middleware succeeds and the request reaches
    // the handler's outer-catch. The middleware happens to call
    // `sessions_invalidated_at` exactly once per request, so a single
    // `mockImplementationOnce` for the throw-on-posting-key case is racy
    // — instead, install the throw-by-SQL-shape impl for this test only
    // and restore the module-load impl (the hoisted `DEFAULT_APP_QUERY_IMPL`
    // const) in a finally block so sibling tests are unaffected. The
    // restore is unconditional and does NOT rely on
    // `getMockImplementation()` — a future `mockReset` in `beforeEach`
    // would wipe the live impl, but `DEFAULT_APP_QUERY_IMPL` is still
    // resolvable from module scope.
    appQueryMock.mockImplementation(async (sql: string, _params: unknown[]) => {
      if (sql.includes('sessions_invalidated_at')) {
        return { rows: [{ sessions_invalidated_at: null }] };
      }
      if (sql.includes('posting_key_enc')) {
        throw new Error('pg: connection terminated unexpectedly');
      }
      return { rows: [] };
    });
    try {
      const token = bearerFor(USERNAME, 'light');
      const res = await bearerPost('/api/custody/broadcast', token, {
      operations: VALID_OPERATIONS,
      fresh_auth_proof: await mintSessionProof(),
    });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(res.body.error.message).toBe('Failed to broadcast transaction');
      const matchingCall = errorSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'custody.broadcast.internal_error';
      });
      expect(matchingCall, 'expected logger.error with event:custody.broadcast.internal_error').toBeDefined();
      const ctx = matchingCall![0] as Record<string, unknown>;
      expect(ctx.route).toBe('custody.broadcast');
      expect(ctx.username).toBe(USERNAME);
      expect(ctx.op_types).toEqual(['vote']);
      expect(ctx.op_count).toBe(1);
      // The DB-side audit log must NOT fire on pre-broadcast failure.
      expect(logCustodyBroadcastMock).not.toHaveBeenCalled();
      // No broadcast-attempt event — failure was upstream of the broadcast helper.
      const collect = (spy: typeof errorSpy, evt: string) =>
        spy.mock.calls.filter((c) => (c[0] as Record<string, unknown> | undefined)?.event === evt);
      const attemptCalls = [
        ...collect(infoSpy, 'custody.broadcast.attempt'),
        ...collect(warnSpy, 'custody.broadcast.attempt'),
        ...collect(errorSpy, 'custody.broadcast.attempt'),
      ];
      expect(attemptCalls).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      // Restore the module-load impl unconditionally so sibling tests
      // pick up the seeded row regardless of `mockClear` vs `mockReset`.
      appQueryMock.mockImplementation(DEFAULT_APP_QUERY_IMPL);
    }
  });

  it('PrivateKey.fromString throws (malformed WIF from decryptKey) → 500 INTERNAL_ERROR (round-3 hold #9)', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    // Drive the `PrivateKey.fromString` throw branch by returning a string
    // that is NOT a valid Hive WIF — the dhive parser rejects it at
    // `fromString`, the throw propagates to the outer catch.
    decryptKeyMock.mockReturnValueOnce('not-a-valid-wif-blob');
    try {
      const token = bearerFor(USERNAME, 'light');
      const res = await bearerPost('/api/custody/broadcast', token, {
      operations: VALID_OPERATIONS,
      fresh_auth_proof: await mintSessionProof(),
    });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(res.body.error.message).toBe('Failed to broadcast transaction');
      const matchingCall = errorSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'custody.broadcast.internal_error';
      });
      expect(matchingCall, 'expected logger.error with event:custody.broadcast.internal_error').toBeDefined();
      const ctx = matchingCall![0] as Record<string, unknown>;
      expect(ctx.route).toBe('custody.broadcast');
      expect(ctx.username).toBe(USERNAME);
      expect(ctx.op_types).toEqual(['vote']);
      expect(ctx.op_count).toBe(1);
      // The DB-side audit log must NOT fire on pre-broadcast failure.
      expect(logCustodyBroadcastMock).not.toHaveBeenCalled();
      // No broadcast-attempt event.
      const collect = (spy: typeof errorSpy, evt: string) =>
        spy.mock.calls.filter((c) => (c[0] as Record<string, unknown> | undefined)?.event === evt);
      const attemptCalls = [
        ...collect(infoSpy, 'custody.broadcast.attempt'),
        ...collect(warnSpy, 'custody.broadcast.attempt'),
        ...collect(errorSpy, 'custody.broadcast.attempt'),
      ];
      expect(attemptCalls).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

// ──────────────────────────────────────────────
// Round-2 hold #4: per-attempt audit-log signal. The DB-side
// `logCustodyBroadcast` writes only on success; the new pino-side
// `event:'custody.broadcast.attempt'` log fires on EVERY broadcast attempt
// with `outcome ∈ {success, failure, timeout}` so operators have a signal
// for retry-amplification (the full idempotency design is filed separately
// as `backend-broadcast-idempotency-cluster-followup.md`; this hold-fix
// covers the audit-log half only).
// ──────────────────────────────────────────────

describe('BE-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION — per-attempt audit log', () => {
  it('success: emits event:custody.broadcast.attempt with outcome:success and tx_id', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    try {
      const token = bearerFor(USERNAME, 'light');
      const res = await bearerPost('/api/custody/broadcast', token, {
      operations: VALID_OPERATIONS,
      fresh_auth_proof: await mintSessionProof(),
    });
      expect(res.status).toBe(200);
      const matchingCall = infoSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'custody.broadcast.attempt';
      });
      expect(matchingCall, 'expected logger.info to fire with event:custody.broadcast.attempt').toBeDefined();
      const ctx = matchingCall![0] as Record<string, unknown>;
      expect(ctx.outcome).toBe('success');
      expect(ctx.username).toBe(USERNAME);
      expect(ctx.op_types).toEqual(['vote']);
      expect(ctx.op_count).toBe(1);
      // Round-3 hold #1: `attempt_n` is INTENTIONALLY ABSENT until the
      // idempotency cluster lands the real per-key counter. A constant
      // `attempt_n: 1` would silence retry-amplification dashboards keyed
      // on the field. The absence is the load-bearing signal.
      expect(ctx.attempt_n).toBeUndefined();
      expect(ctx.tx_id).toBe('mock-tx-id');
      // The DB-side audit log still fires on success.
      expect(logCustodyBroadcastMock).toHaveBeenCalledTimes(1);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('timeout: emits event:custody.broadcast.attempt with outcome:timeout', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    try {
      sendOperationsMock.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));
      const token = bearerFor(USERNAME, 'light');
      const res = await bearerPost('/api/custody/broadcast', token, {
      operations: VALID_OPERATIONS,
      fresh_auth_proof: await mintSessionProof(),
    });
      expect(res.status).toBe(504);
      const matchingCall = warnSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'custody.broadcast.attempt';
      });
      expect(matchingCall, 'expected logger.warn to fire with event:custody.broadcast.attempt').toBeDefined();
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

  it('failure: emits event:custody.broadcast.attempt with outcome:failure', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    try {
      sendOperationsMock.mockRejectedValueOnce(new Error('chain rejection: missing_posting_auth'));
      const token = bearerFor(USERNAME, 'light');
      const res = await bearerPost('/api/custody/broadcast', token, {
      operations: VALID_OPERATIONS,
      fresh_auth_proof: await mintSessionProof(),
    });
      expect(res.status).toBe(502);
      const matchingCall = warnSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'custody.broadcast.attempt';
      });
      expect(matchingCall, 'expected logger.warn to fire with event:custody.broadcast.attempt').toBeDefined();
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

// ──────────────────────────────────────────────
// BACKEND-LOG-SHAPE-CONVERGENCE-SIBLING-FILES (Item 3 part B):
// Mutation-killing spy assertions on operationally-critical structured log
// emissions in `backend/src/routes/custody.ts` per
// `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md`.
//
// Justification (per root CLAUDE.md test carve-out clauses a/b/c):
//   (a) Real-path impracticality: each event sits behind a runtime failure
//       (rejected fresh-auth proof, outer-catch DB throws, the documented-
//       unreachable null-hash safety sentinel). Driving them deterministically
//       requires per-test mocks. The carve-out scope is the same as the
//       outer-catch + audit-log specs already in this file (decryptKey,
//       pool.query). `verifyHiveSignature` is NOT mocked — every spec mints
//       a real Bearer JWT signed with `config.sessionSecret` and exercises
//       the real middleware path.
//   (b) Mock targets: the existing module-level mocks (getAppPool, decryptKey,
//       broadcastSendOperationsWithTimeout, redis null) are the only mocks.
//       The logger is spied (not mocked at the module level) so call shape
//       can be asserted while the production format string still fires.
//   (c) Real-path companion: real-path coverage of `/fresh-auth` and
//       `/upgrade` lives in `custody-fresh-auth-null-hash.test.ts` and
//       `custody-upgrade.test.ts` (real signature verify, real pg pool,
//       real verifyHiveSignature middleware). Those exercise the documented-
//       reachable branches end-to-end; this file pins the structured-log
//       shape on the failure-path branches that the real-path companions
//       don't drive.
// ──────────────────────────────────────────────

describe('BE-LOG-SHAPE-CONVERGENCE — custody.ts structured-log emissions (Item 3 part B)', () => {
  it('custody.broadcast.fresh_auth_rejected: consent op without fresh_auth_proof emits canonical warn shape', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    try {
      // Bundle carries a single consent op (`author_accept`) but no
      // `fresh_auth_proof`. `consumeFreshAuthToken(undefined, ...)` resolves
      // to `{valid:false, reason:'missing'}` and the route warns + 401s.
      const consentOps = [
        [
          'custom_json',
          {
            required_posting_auths: [USERNAME],
            id: config.appTag,
            json: JSON.stringify({
              action: 'author_accept',
              root_author: 'someroot',
              root_permlink: 'somepermlink-v1',
            }),
          },
        ],
      ];
      const token = bearerFor(USERNAME, 'light');
      const res = await bearerPost('/api/custody/broadcast', token, {
        operations: consentOps,
        // fresh_auth_proof intentionally omitted
      });
      // Round-4 hold #10: missing/expired/malformed → 401 (not 403, which is
      // reserved for username/target binding violations).
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');

      const matchingCall = warnSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'custody.broadcast.fresh_auth_rejected';
      });
      expect(
        matchingCall,
        'expected logger.warn with event:custody.broadcast.fresh_auth_rejected',
      ).toBeDefined();
      expect(matchingCall![0]).toEqual(
        expect.objectContaining({
          event: 'custody.broadcast.fresh_auth_rejected',
          route: 'custody.broadcast',
          username: USERNAME,
          gated_action: 'author_accept',
          gated_root_author: 'someroot',
          gated_root_permlink: 'somepermlink-v1',
          reason: 'missing',
        }),
      );
      // Broadcast must NOT have run — fresh-auth gate fires before decrypt.
      expect(sendOperationsMock).not.toHaveBeenCalled();
      expect(decryptKeyMock).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('custody.fresh_auth.failed: outer-catch on /fresh-auth emits canonical error shape with err: <Error>', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    // Drive the outer-catch by throwing on the route's password_hash SELECT.
    // The middleware's `sessions_invalidated_at` lookup runs first and must
    // succeed; the throw is scoped to the second query.
    appQueryMock.mockImplementation(async (sql: string, _params: unknown[]) => {
      if (sql.includes('sessions_invalidated_at')) {
        return { rows: [{ sessions_invalidated_at: null }] };
      }
      if (sql.includes('password_hash')) {
        throw new Error('pg: connection terminated unexpectedly (fresh-auth)');
      }
      return { rows: [] };
    });
    try {
      const token = bearerFor(USERNAME, 'light');
      const res = await bearerPost('/api/custody/fresh-auth', token, {
        password: 'AnyPassword1',
        action: 'author_accept',
        root_author: 'someroot',
        root_permlink: 'somepermlink-v1',
      });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');

      const matchingCall = errorSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'custody.fresh_auth.failed';
      });
      expect(
        matchingCall,
        'expected logger.error with event:custody.fresh_auth.failed',
      ).toBeDefined();
      expect(matchingCall![0]).toEqual(
        expect.objectContaining({
          event: 'custody.fresh_auth.failed',
          route: 'custody.fresh-auth',
          username: USERNAME,
        }),
      );
      // err MUST be an Error instance (not its .message string) so pino's
      // err serializer produces .message + .stack + .type at write time.
      expect((matchingCall![0] as { err?: unknown }).err).toBeInstanceOf(Error);
    } finally {
      errorSpy.mockRestore();
      appQueryMock.mockImplementation(DEFAULT_APP_QUERY_IMPL);
    }
  });

  it('custody.upgrade.failed: outer-catch on /upgrade emits canonical error shape with err: <Error>', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    // BACKEND-CUSTODY-UPGRADE-SEED-PHRASE-REAUTH: the /upgrade route now
    // SELECTs only `upgraded_at` (password_hash branch removed). Drive the
    // outer-catch by throwing on the route's `upgraded_at` SELECT (after the
    // middleware's `sessions_invalidated_at` lookup succeeds). Username is
    // unique to dodge the per-account `upgradeLimiter` (max=1/hr) bucket.
    const upgradeUser = `lightupgouterct_${Date.now() % 100000}`;
    appQueryMock.mockImplementation(async (sql: string, _params: unknown[]) => {
      if (sql.includes('sessions_invalidated_at')) {
        return { rows: [{ sessions_invalidated_at: null }] };
      }
      if (sql.includes('upgraded_at') && sql.includes('SELECT')) {
        throw new Error('pg: connection terminated unexpectedly (upgrade)');
      }
      return { rows: [] };
    });
    try {
      const token = bearerFor(upgradeUser, 'light');
      // Body shape post-reauth-change: derived_pubkey + signed_proof + signed_at.
      // Values are syntactically valid but never reach signature verification —
      // the outer-catch fires on the SELECT throw before we inspect the proof.
      const res = await bearerPost('/api/custody/upgrade', token, {
        derived_pubkey: 'STM5jYourPubKeyHereXXX',
        signed_proof: '20'.repeat(65),
        signed_at: new Date().toISOString(),
      });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');

      const matchingCall = errorSpy.mock.calls.find((call) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        return ctx?.event === 'custody.upgrade.failed';
      });
      expect(
        matchingCall,
        'expected logger.error with event:custody.upgrade.failed',
      ).toBeDefined();
      expect(matchingCall![0]).toEqual(
        expect.objectContaining({
          event: 'custody.upgrade.failed',
          route: 'custody.upgrade',
          username: upgradeUser,
        }),
      );
      expect((matchingCall![0] as { err?: unknown }).err).toBeInstanceOf(Error);
    } finally {
      errorSpy.mockRestore();
      appQueryMock.mockImplementation(DEFAULT_APP_QUERY_IMPL);
    }
  });
});

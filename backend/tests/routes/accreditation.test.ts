/**
 * /api/accreditation/{request,verify} coverage.
 *
 * Round-3 addition (BE-ORCID-BROADCAST-ABORT-TIMEOUT): per-route timeout
 * specs for the /verify path. The helper's timeout mechanism is unit-tested
 * in hive-broadcast-timeout.test.ts; these specs cover the route-level
 * catch-and-discriminate pattern:
 *   (a) BroadcastTimeoutError → 504 BROADCAST_TIMEOUT with the
 *       common.md {retriable:false, outcome:'uncertain', verify_before_retry:true,
 *       timeout_ms:number} envelope AND the token must survive (retriable-
 *       after-verify — caller retries after checking chain state).
 *   (b) Non-timeout broadcast error → 502 BROADCAST_FAILED with
 *       {retriable:false} AND the token is deleted (terminal failure; a
 *       fresh token is obtained via /api/accreditation/request).
 *
 * Mocking justification (per root CLAUDE.md carve-out): vi.mock replaces
 * `broadcastJsonWithTimeout` and `BroadcastTimeoutError` so we can stage
 * deterministic failure modes (a hanging broadcast cannot be reliably
 * reproduced against real Hive). verifyHiveSignature is NOT involved here
 * (the /verify route is rate-limited but not auth-gated). The carve-out
 * covers only broadcast error staging; getToken / deleteToken run against
 * real Redis (or in-memory fallback), so the token-lifecycle assertions
 * exercise the real persistence layer.
 *
 * Per-test redis.del / redis.decr / redis.eval rejection mocks
 * (BE-HANDLE-BROADCAST-ERROR-HELPER round 3 + BE-VERIFY-BROADCAST-ATTEMPTS-CAP
 * rounds 3-4): several specs near the bottom of this file use
 * `vi.spyOn(redis, '<verb>').mockRejectedValueOnce(...)` for one call, then
 * `mockRestore()`. Mocked surfaces:
 *   - `redis.del`: 502-with-deleteToken-rejection spec
 *     (BE-HANDLE-BROADCAST-ERROR-HELPER round 3).
 *   - `redis.decr`: round-3 hold #5 decrement-failure log path (504 timeout
 *     followed by a Redis-side rejection on the compensating decrement).
 *   - `redis.eval`: round-4 hold #2 pre-INCR 503 path (Redis-side rejection
 *     on the cap-counter eval, before the broadcast site).
 * The failure modes (Redis evicted to read-only mid-request, transient
 * connection drop, OOM, Lua error) are impractical to induce against the
 * real dev-mode Redis container — the deterministic single-call rejection
 * is the only way to drive the corresponding catch paths on demand. The
 * carve-outs are narrow: only the named verb is mocked, only on that one
 * call, and the seeded token + envelope assertions still exercise real
 * Redis on the rest of the route. Real-Redis coverage of the surrounding
 * envelopes is provided by adjacent specs (e.g. the immediately preceding
 * "non-timeout broadcast error → 502 BROADCAST_FAILED").
 *
 * Round-4 hold item 1 — INTENTIONAL RED in this file:
 * The cleanup-failure spec (502 BROADCAST_FAILED + deleteToken rejection)
 * and the decrement-failure spec (504 BROADCAST_TIMEOUT + decr rejection)
 * use ioredis-shaped error objects (`Object.assign(new Error('flap'), {
 * command: { name: '<verb>', args: [<key>] }, name: 'ReplyError' })`) to
 * exercise the real ioredis rejection shape. The `args` array carries the
 * raw Redis key — which for cap-counter operations contains the 64-hex
 * verification token. The redaction-negative assertion
 * (`expect(JSON.stringify(loggerSpy.mock.calls)).not.toMatch(/[0-9a-f]{64}/)`)
 * will FAIL RED until pino's redact configuration is widened to scrub
 * `err.command.args`. Production fix is deferred to
 * `backend-bridge-key-startup-validation-and-pino-redact.md`. Do NOT
 * "fix" the test back to passing — leave the failure visible so the
 * deferred work has a forcing function.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { PrivateKey } from '@hiveio/dhive';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

// Hoisted so the same class identity is visible inside the vi.mock factory
// and in test bodies that construct instances to stage mockRejectedValueOnce.
const { broadcastJsonMock, MockBroadcastTimeoutError } = vi.hoisted(() => ({
  broadcastJsonMock: vi.fn().mockResolvedValue({ id: 'mock-accred-tx' }),
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
    database: { getAccounts: vi.fn().mockResolvedValue([]) },
    broadcast: { json: broadcastJsonMock },
  },
  broadcastJsonWithTimeout: (...args: unknown[]) =>
    (broadcastJsonMock as (...a: unknown[]) => unknown)(...args),
  BroadcastTimeoutError: MockBroadcastTimeoutError,
  DEFAULT_BROADCAST_TIMEOUT_MS: 30_000,
}));

import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { getRedis } from '../../src/redis.js';
import { logger } from '../../src/logger.js';
import { INCR_AND_EXPIRE_ON_ZERO_TO_ONE_LUA } from '../../src/lib/redis-scripts.js';
import * as redisModule from '../../src/redis.js';
import { __test_seams as accreditationTestSeams } from '../../src/routes/accreditation.js';
import { __test_seams as queueTestSeams } from '../../src/lib/pending-decrement-queue.js';

// Ensure the admin-posting-key guard inside /verify doesn't short-circuit.
// A deterministic WIF keeps PrivateKey.fromString happy on the broadcast path.
config.pevoAdminPostingKey = PrivateKey.fromSeed('pevo-accred-test-admin').toString();

const app = createApp();

describe('POST /api/accreditation/request', () => {
  it('returns 401 without auth headers', async () => {
    const res = await request(app)
      .post('/api/accreditation/request')
      .send({ full_name: 'Test' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 400 when fields are missing', async () => {
    const res = await request(app)
      .post('/api/accreditation/request')
      .set('X-Hive-Username', 'testuser')
      .set('X-Hive-Signature', 'mock')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects free email providers', async () => {
    const res = await request(app)
      .post('/api/accreditation/request')
      .set('X-Hive-Username', 'testuser')
      .set('X-Hive-Signature', 'mock')
      .send({
        full_name: 'Test User',
        institution: 'MIT',
        field: 'physics',
        email: 'test@gmail.com',
      });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('institutional');
  });

  it('rejects yahoo email', async () => {
    const res = await request(app)
      .post('/api/accreditation/request')
      .set('X-Hive-Username', 'testuser')
      .set('X-Hive-Signature', 'mock')
      .send({
        full_name: 'Test User',
        institution: 'MIT',
        field: 'physics',
        email: 'test@yahoo.com',
      });
    expect(res.status).toBe(422);
  });

  it('rejects invalid email format', async () => {
    const res = await request(app)
      .post('/api/accreditation/request')
      .set('X-Hive-Username', 'testuser')
      .set('X-Hive-Signature', 'mock')
      .send({
        full_name: 'Test User',
        institution: 'MIT',
        field: 'physics',
        email: 'not-an-email',
      });
    // 400 for invalid email, or 429 if rate limited from prior tests
    expect([400, 429]).toContain(res.status);
  });
});

describe('POST /api/accreditation/verify', () => {
  it('returns 400 without token', async () => {
    const res = await request(app)
      .post('/api/accreditation/verify')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for invalid token', async () => {
    const res = await request(app)
      .post('/api/accreditation/verify')
      .send({ token: 'nonexistent-token-12345' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Invalid');
  });
});

// ──────────────────────────────────────────────
// BE-ORCID-BROADCAST-ABORT-TIMEOUT — route-level BroadcastTimeoutError discrimination.
//
// Envelope per agents/docs/api-contracts/common.md (no verify_location — that
// field is orcid-specific; accreditation callers verify chain state via
// HAF or their settings page without a canonical URL in the contract).
// ──────────────────────────────────────────────

const TIMEOUT_DETAILS = {
  retriable: false,
  outcome: 'uncertain',
  verify_before_retry: true,
  timeout_ms: 30_000,
};

// Store a pending-accreditation record directly in Redis so /verify's
// getToken() resolves to a real pending row. Matches the shape written by
// storeToken(): `${config.appTag}:pending_accred:${token}` → JSON blob.
async function seedPendingAccreditation(token: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Redis required for accreditation timeout specs');
  const pending = {
    hive_username: 'accred-timeout-user',
    full_name: 'Accred Timeout User',
    institution: 'Test University',
    field: 'physics',
    email: 'timeout-user@university.edu',
    orcid: '',
    token,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
  };
  await redis.set(
    `${config.appTag}:pending_accred:${token}`,
    JSON.stringify(pending),
    'EX',
    24 * 60 * 60,
  );
}

async function tokenExists(token: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  const raw = await redis.get(`${config.appTag}:pending_accred:${token}`);
  return raw !== null;
}

describe('POST /api/accreditation/verify — BE-ORCID-BROADCAST-ABORT-TIMEOUT', () => {
  beforeEach(() => {
    broadcastJsonMock.mockReset();
    broadcastJsonMock.mockResolvedValue({ id: 'mock-accred-tx' });
  });

  afterEach(async () => {
    // Best-effort cleanup: leftover tokens are harmless (rate-limited
    // /verify, 24h TTL) but keep the namespace clean between specs.
    const redis = getRedis();
    if (redis) {
      const keys = await redis.keys(`${config.appTag}:pending_accred:accred-timeout-*`);
      if (keys.length > 0) await redis.del(...keys);
    }
  });

  it('BroadcastTimeoutError → 504 BROADCAST_TIMEOUT with uncertain-outcome envelope; token NOT deleted', async () => {
    const redis = getRedis();
    if (!redis) return; // Redis-only spec; no in-memory fallback path is exercised here.
    const token = `accred-timeout-${crypto.randomBytes(8).toString('hex')}`;
    await seedPendingAccreditation(token);

    broadcastJsonMock.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));

    const res = await request(app)
      .post('/api/accreditation/verify')
      .send({ token });

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('BROADCAST_TIMEOUT');
    expect(res.body.error.details).toEqual(TIMEOUT_DETAILS);
    // Token must survive the 504 — 24h TTL stays so the caller can verify
    // chain state and retry without re-requesting an email.
    expect(await tokenExists(token)).toBe(true);
  });

  it('non-timeout broadcast error → 502 BROADCAST_FAILED with retriable=false; token IS deleted; logs email_hash, not email', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-timeout-${crypto.randomBytes(8).toString('hex')}`;
    await seedPendingAccreditation(token);

    broadcastJsonMock.mockRejectedValueOnce(new Error('RPC node rejected: insufficient RC'));

    // BE-LOG-PII-EMAIL-HASH round-1 hold item 2a: handleBroadcastError emits
    // logger.error with `email_hash: hashEmailForLogs(pending.email)` per
    // accreditation.ts:451. Pre-fix shape was `email: <plaintext>`. The spy
    // pins the migration so a regression that reverts the field name or drops
    // the helper fails this spec.
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    try {
      const res = await request(app)
        .post('/api/accreditation/verify')
        .send({ token });

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('BROADCAST_FAILED');
      expect(res.body.error.details).toEqual({ retriable: false });
      // Chain-rejection is terminal — the token is deleted so it cannot be
      // re-used. A fresh token is obtained via /api/accreditation/request.
      expect(await tokenExists(token)).toBe(false);

      // Find the broadcast-error emission. handleBroadcastError emits the
      // 502 BROADCAST_FAILED log line at lib/broadcast-error.ts:399 with the
      // suffix `<routeLabel> broadcast failed` and `event: 'broadcast_failed'`.
      // Filter by the structured event discriminator (the dashboard-keyable
      // anchor) so the assertion is robust against routeLabel renames.
      const emission = errorSpy.mock.calls.find(
        ([payload]) =>
          payload != null &&
          typeof payload === 'object' &&
          (payload as Record<string, unknown>).event === 'broadcast_failed',
      );
      expect(emission, 'expected handleBroadcastError logger.error emission').toBeDefined();

      const [payload] = emission!;
      const obj = payload as Record<string, unknown>;
      // email_hash is the 12-hex SHA-256 truncation; no top-level `email` key.
      expect(obj.email_hash).toMatch(/^[0-9a-f]{12}$/);
      expect(obj).not.toHaveProperty('email');
    } finally {
      errorSpy.mockRestore();
    }
  });

  // BE-HANDLE-BROADCAST-ERROR-HELPER round-2 hold #1 (P1): when the broadcast
  // fails (502 path) AND deleteToken's underlying redis.del rejects, the route
  // must NOT let the rejection propagate to Express 5's async error handler
  // (which would attempt to write 500 over the already-sent 502 →
  // ERR_HTTP_HEADERS_SENT). The cleanup-failure log line documents the
  // orphaned token; the token TTLs out within 24h so the orphan is harmless.
  it('502 BROADCAST_FAILED path with deleteToken rejection: response stays 502, no header-sent error, cleanup-failure logged, no raw token leak', async () => {
    const redis = getRedis();
    if (!redis) return;
    // Clear the per-IP /verify rate-limit window — prior specs in this
    // describe consume the byIp(127.0.0.1) bucket (limit: 5/min). Without
    // this reset the 5th-or-later request returns 429 and short-circuits the
    // route handler before reaching the broadcast catch.
    const limitKeys = await redis.keys(`${config.appTag}:rl:accred-verify:*`);
    if (limitKeys.length > 0) await redis.del(...limitKeys);

    // Round-4 hold #7c: round-3 hold #5 spec used a 16-hex-tail mock token
    // (`accred-timeout-<16-hex>`). The negative-regex `not.toMatch(/[0-9a-f]{64}/)`
    // assertion below is vacuous against such a token by construction (no
    // 64-hex substring CAN appear). Use a 64-hex token to make the redaction
    // assertion load-bearing — a regression that drops `hashTokenForLogs` and
    // logs the raw token would surface as a real 64-hex match.
    const token = crypto.randomBytes(32).toString('hex');
    const tokenKey = `${config.appTag}:pending_accred:${token}`;
    await seedPendingAccreditation(token);

    broadcastJsonMock.mockRejectedValueOnce(new Error('RPC node rejected: insufficient RC'));

    // Round-4 hold #1: ioredis-shaped error (NOT plain `new Error(...)`).
    // ioredis attaches `command.name` and `command.args` to ReplyError-shaped
    // rejections; the `args` array carries the raw Redis key, which for
    // pending_accred operations is `<appTag>:pending_accred:<64-hex token>`.
    // pino default redact does NOT scrub `err.command.args`, so the raw
    // 64-hex token leaks into the operator log via the `err` field. The
    // negative-regex assertion below pins this exposure: the spec WILL FAIL
    // RED against current production code until pino's redact configuration
    // is widened (deferred to backend-bridge-key-startup-validation-and-pino-redact.md).
    // The intentional red here is the forcing function for that deferred work.
    const delSpy = vi.spyOn(redis, 'del').mockRejectedValueOnce(
      Object.assign(new Error('Redis evicted to read-only'), {
        command: { name: 'del', args: [tokenKey] },
        name: 'ReplyError',
      }),
    );

    // Spy on logger.error so we can assert the cleanup-failure log line was
    // emitted with the canonical fields, AND that no ERR_HTTP_HEADERS_SENT
    // line was emitted (load-bearing negative — its presence would prove the
    // rejection escaped the local try/catch and reached errorHandler).
    // Round-3 hold #1 of BE-HANDLE-BROADCAST-ERROR-HELPER: the prior version
    // of this spec only asserted (a) the 502 envelope and that redis.del was
    // called; it was mutation-insensitive against deletion of the local
    // try/catch (the rejection would still surface as 502 from supertest's
    // first-response semantics). The spy assertions below are the real
    // mutation-sensitivity guards. Per
    // agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md
    // and agents/docs/solutions/runtime-errors/helper-extraction-express5-response-ordering-2026-04-28.md.
    const loggerErrorSpy = vi.spyOn(logger, 'error');

    let res;
    let delCallArgs: unknown[][];
    try {
      res = await request(app)
        .post('/api/accreditation/verify')
        .send({ token });
      // Snapshot the spy calls BEFORE restoring (mockRestore clears mock state).
      delCallArgs = delSpy.mock.calls.slice();

      // Response stays the broadcast-failure 502 — the deleteToken rejection
      // was swallowed, no 500 was layered on top. If the route had let the
      // rejection propagate to Express 5's async error handler, errorHandler
      // would have attempted to write 500 over the already-sent 502, throwing
      // ERR_HTTP_HEADERS_SENT into the request-error pipeline. supertest
      // surfaces only the first response written, so a 502 here is necessary
      // but not sufficient — the spy assertions below carry the real signal.
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('BROADCAST_FAILED');
      expect(res.body.error.details).toEqual({ retriable: false });

      // (a) The route's failure-branch cleanup did call redis.del with the
      // seeded token key — proves the deleteToken path was reached, the
      // rejection fired, and the local try/catch swallowed it.
      expect(delCallArgs).toContainEqual([`${config.appTag}:pending_accred:${token}`]);

      // (b) The cleanup-failure log line was emitted with the expected fields.
      // Call-shape assertion (NOT a bare toHaveBeenCalled): logger.error is
      // also called by handleBroadcastError for the 502 path, so we must pin
      // the cleanup-specific message to distinguish the two calls.
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        // Round-3 hold #1: payload now carries `token_hash` (12-hex sha256 prefix)
        // instead of the raw 64-hex token. Operator-correlation is preserved
        // (the hash is stable across log lines for the same token), but the
        // plaintext-replay capability is removed.
        expect.objectContaining({ err: expect.anything(), token_hash: expect.stringMatching(/^[0-9a-f]{12}$/) }),
        expect.stringContaining('token cleanup failed after broadcast failure'),
      );

      // (c) No ERR_HTTP_HEADERS_SENT log line was emitted — the rejection did
      // not reach Express's async error handler. This is the load-bearing
      // negative assertion for the regression.
      expect(loggerErrorSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/ERR_HTTP_HEADERS_SENT/i),
      );

      // (d) Round-4 hold #1 + #7a: no raw 64-hex token substring in the
      // logger.error payload. `expect.objectContaining({token_hash})` ignores
      // EXTRA fields (`err`, `err.command.args`, etc.) so the positive
      // assertion above is mutation-insensitive against an ioredis-shaped
      // error whose `command.args` carries the raw key. This negative
      // assertion catches the leak. INTENTIONAL RED until pino redact
      // covers `err.command.args` (deferred to
      // backend-bridge-key-startup-validation-and-pino-redact.md).
      //
      // Some logger.error call args are circular (handleBroadcastError logs
      // include `res` / `req` objects that close cycles), so we serialize
      // each call's payload-only first arg with a circular-safe replacer
      // and concat all of them.
      const flatErrorPayload = loggerErrorSpy.mock.calls
        .map(([payload, msg]) => {
          const seen = new WeakSet();
          const safe = JSON.stringify(payload, (_k, v) => {
            if (typeof v === 'object' && v !== null) {
              if (seen.has(v)) return '[Circular]';
              seen.add(v);
            }
            return v;
          });
          return `${safe}|${typeof msg === 'string' ? msg : ''}`;
        })
        .join('||');
      expect(flatErrorPayload).not.toMatch(/[0-9a-f]{64}/);
    } finally {
      delSpy.mockRestore();
      loggerErrorSpy.mockRestore();
      // Explicit cleanup: token doesn't match the afterEach `accred-timeout-*`
      // pattern (round-4 hold #7c switched to a 64-hex token to make the
      // redaction assertion load-bearing).
      await redis.del(tokenKey);
    }
  });
});

// ──────────────────────────────────────────────
// BE-VERIFY-BROADCAST-ATTEMPTS-CAP — per-token broadcast-attempts cap.
//
// The 504 BROADCAST_TIMEOUT envelope (above) deliberately preserves the token
// so the legitimate caller can verify chain state and retry. That survival
// window is also a retry-amplification axis: each retry enqueues a fresh
// broadcast at the dhive layer, and Hive does not deduplicate identical
// custom_json ops. The cap (config.verifyBroadcastAttemptsCap, default 3)
// bounds the per-token blast radius. Counter lives at
// `${appTag}:pending_accred_broadcast_attempts:${token}` and is incremented
// atomically with INCR before each broadcast.
//
// Round-2 hold semantics (BE-VERIFY-BROADCAST-ATTEMPTS-CAP):
//  - Pre-INCR happens on every /verify call that reaches the broadcast site
//    (atomic concurrent-claim — under N parallel retries on the same token,
//    at most `cap` broadcasts fire).
//  - 504 BROADCAST_TIMEOUT outcomes DECREMENT the counter so a transient
//    slow-Hive window cannot permanently destroy a verified token. Only
//    definitive 502 BROADCAST_FAILED outcomes count toward the cap.
//  - Cap-exceeded surfaces the distinct error code
//    BROADCAST_ATTEMPT_LIMIT_EXCEEDED (NOT BROADCAST_FAILED) — operators
//    alerting on the chain-rejection rate need to separate client retry-
//    pressure from real chain failure.
// ──────────────────────────────────────────────

async function broadcastAttemptCount(token: string): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  const raw = await redis.get(`${config.appTag}:pending_accred_broadcast_attempts:${token}`);
  return raw === null ? 0 : Number(raw);
}

describe('POST /api/accreditation/verify — BE-VERIFY-BROADCAST-ATTEMPTS-CAP', () => {
  beforeEach(() => {
    broadcastJsonMock.mockReset();
  });

  afterEach(async () => {
    const redis = getRedis();
    if (redis) {
      const keys = await redis.keys(`${config.appTag}:pending_accred*accred-cap-*`);
      if (keys.length > 0) await redis.del(...keys);
    }
  });

  // Distinct synthetic IPs per spec dodge the verify-route rate limiter
  // (5/min per IP). app.ts sets `trust proxy = 1`, so X-Forwarded-For drives
  // req.ip. Without this, ~10 sequential calls inside this file would
  // collectively trip 429s and obscure the cap-vs-rate-limit signal.
  function postVerify(token: string, ip: string) {
    return request(app)
      .post('/api/accreditation/verify')
      .set('X-Forwarded-For', ip)
      .send({ token });
  }

  it('cap-exceeded path: pre-seeded counter ≥ cap returns BROADCAST_ATTEMPT_LIMIT_EXCEEDED; broadcast NOT invoked; token PRESERVED (round-3 soft-block)', async () => {
    const redis = getRedis();
    if (!redis) throw new Error('Redis required for cap specs');
    const cap = config.verifyBroadcastAttemptsCap;
    const token = `accred-cap-${crypto.randomBytes(8).toString('hex')}`;
    await seedPendingAccreditation(token);
    // Pre-seed the counter to `cap` so the next call's INCR pushes it to
    // `cap + 1`, tripping the cap gate. This isolates the cap-exceeded
    // branch from the timeout-decrement / rejection-delete path
    // arithmetic, giving a mutation-sensitive assertion against the gate.
    await redis.set(`${config.appTag}:pending_accred_broadcast_attempts:${token}`, String(cap), 'EX', 24 * 60 * 60);
    const ip = `10.5.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;

    // Mock would reject if reached; the cap gate must short-circuit BEFORE
    // broadcast.
    broadcastJsonMock.mockRejectedValue(new Error('should not reach broadcast'));

    const res = await postVerify(token, ip);
    expect(res.status).toBe(502);
    // Round-2 hold #1: the distinct error code (NOT BROADCAST_FAILED) is
    // what HTTP-only consumers and operator alerts key off.
    expect(res.body.error.code).toBe('BROADCAST_ATTEMPT_LIMIT_EXCEEDED');
    expect(res.body.error.details).toEqual({ retriable: false });
    expect(res.body.error.message).toMatch(/limit exceeded/i);
    // Broadcast NOT invoked — the cap gate fires before the broadcast site.
    expect(broadcastJsonMock).not.toHaveBeenCalled();
    // Round-3 hold #2 (soft-block): token is PRESERVED on the cap-exceeded
    // path. A stolen-token attacker with cap+1 rotating XFFs cannot mount
    // an asymmetric token-burn DoS; the legitimate user can wait for the
    // 24h Redis TTL to drain instead of being forced into the 3/24h
    // /request lockout. Counter and token both TTL out independently.
    expect(await tokenExists(token)).toBe(true);
    // Counter remains at the pre-seeded cap+1 since soft-block doesn't
    // delete it; it will TTL out alongside the token.
    expect(await broadcastAttemptCount(token)).toBe(cap + 1);
  });

  it('round-2 hold #2: 504 timeout outcomes DECREMENT the counter; user retrying through transient slow-Hive window does not burn cap slots', async () => {
    const redis = getRedis();
    if (!redis) throw new Error('Redis required for cap specs');
    const cap = config.verifyBroadcastAttemptsCap;
    const token = `accred-cap-${crypto.randomBytes(8).toString('hex')}`;
    await seedPendingAccreditation(token);
    const ip = `10.3.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;

    broadcastJsonMock.mockRejectedValue(new MockBroadcastTimeoutError(30_000));

    // Drive `cap + 2` sequential timeouts. Without the decrement, the
    // (cap+1)th call would hit the cap gate and destroy the token. With
    // the decrement, every call resolves to 504 and the counter stays
    // at zero between calls.
    for (let i = 0; i < cap + 2; i++) {
      const res = await postVerify(token, ip);
      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe('BROADCAST_TIMEOUT');
      expect(await tokenExists(token)).toBe(true);
      // Post-decrement, counter is back at 0 (or absent) — the next
      // pre-INCR will start from 1 again.
      expect(await broadcastAttemptCount(token)).toBe(0);
    }
    // Broadcast was invoked every call (no cap-exceeded short-circuit).
    expect(broadcastJsonMock).toHaveBeenCalledTimes(cap + 2);
    expect(await tokenExists(token)).toBe(true);
  });

  it('round-2 hold #4: concurrent retries claim slots atomically — exactly `cap` broadcasts fire under cap+1 parallel /verify calls; (cap+1)th returns BROADCAST_ATTEMPT_LIMIT_EXCEEDED', async () => {
    const redis = getRedis();
    if (!redis) throw new Error('Redis required for cap specs');
    const cap = config.verifyBroadcastAttemptsCap;
    const token = `accred-cap-${crypto.randomBytes(8).toString('hex')}`;
    await seedPendingAccreditation(token);

    // Stage cap+1 distinct synthetic IPs to dodge the 5/min IP limiter
    // (each parallel /verify call must originate from a different
    // X-Forwarded-For so the limiter doesn't 429 the burst).
    const baseOctet = crypto.randomInt(0, 250);
    const ips = Array.from({ length: cap + 1 }, (_, i) => `10.4.${baseOctet}.${i + 1}`);

    // Each broadcast that lands rejects with a definitive non-timeout
    // error (so the failure branch fires on the cap-bound calls and
    // the token IS destroyed on the FIRST 502 to land — without that,
    // subsequent parallel calls that already pre-INCR'd would race
    // against a deleted token. The kit-staged behavior here exercises
    // the pre-INCR atomic claim, which is what item 4 calls out).
    //
    // To make the assertion clean, hang every broadcast indefinitely
    // (resolve never): the route waits, supertest waits, Promise.all
    // resolves all together once we let them. This sidesteps the
    // post-broadcast race (no broadcast actually completes during the
    // burst, so deleteToken doesn't fire on the 'failure' path).
    let release: (val: { id: string }) => void = () => {};
    const broadcastPromise = new Promise<{ id: string }>((resolve) => {
      release = resolve;
    });
    broadcastJsonMock.mockImplementation(() => broadcastPromise);

    // Fire cap+1 parallel /verify calls. The cap gate must short-circuit
    // exactly one of them BEFORE the broadcast site (the one whose
    // pre-INCR pushes the counter to cap+1).
    const responses = Promise.all(ips.map((ip) => postVerify(token, ip)));

    // Round-3 hold #6: deterministic barrier — poll the counter directly
    // until every parallel /verify call has claimed its pre-INCR slot
    // (counter == cap + 1). The prior 100ms sleep was brittle on slow CI
    // and on operator-tuned high caps (cap=10 → 11 parallel supertest
    // invocations tighten the window). Polling the on-disk counter
    // converges as soon as the last pre-INCR lands, regardless of CI
    // speed or cap value.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if ((await broadcastAttemptCount(token)) === cap + 1) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await broadcastAttemptCount(token)).toBe(cap + 1);
    // Release the broadcast promise — the `cap` requests that passed
    // the gate now resolve (their broadcastJsonMock returns
    // {id: 'mock-...'}) → success path → 200.
    release({ id: 'mock-accred-concurrent-tx' });
    const results = await responses;

    // Exactly one response is BROADCAST_ATTEMPT_LIMIT_EXCEEDED (502).
    const capExceeded = results.filter(
      (r) => r.status === 502 && r.body.error.code === 'BROADCAST_ATTEMPT_LIMIT_EXCEEDED',
    );
    expect(capExceeded.length).toBe(1);

    // The other `cap` responses each invoked the broadcast — count is
    // exactly `cap`, regardless of whether they ultimately returned 200
    // (success), 502 (some race), or 504 (rare). Item 4's load-bearing
    // assertion: "exactly cap broadcasts fire."
    expect(broadcastJsonMock).toHaveBeenCalledTimes(cap);
  });

  it('clears the attempt counter on broadcast success', async () => {
    const redis = getRedis();
    if (!redis) throw new Error('Redis required for cap specs');
    const token = `accred-cap-${crypto.randomBytes(8).toString('hex')}`;
    await seedPendingAccreditation(token);
    const ip = `10.1.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;

    broadcastJsonMock.mockResolvedValue({ id: 'mock-accred-tx' });

    const res = await postVerify(token, ip);
    expect(res.status).toBe(200);
    // Token deleted on success path → counter side-key dropped with it.
    expect(await tokenExists(token)).toBe(false);
    expect(await broadcastAttemptCount(token)).toBe(0);
  });

  it('clears the attempt counter on terminal (502) broadcast failure (sequential-flood scope per round-3 hold #8)', async () => {
    const redis = getRedis();
    if (!redis) throw new Error('Redis required for cap specs');
    const token = `accred-cap-${crypto.randomBytes(8).toString('hex')}`;
    await seedPendingAccreditation(token);
    const ip = `10.2.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;

    broadcastJsonMock.mockRejectedValueOnce(new Error('RPC node rejected: insufficient RC'));

    const res = await postVerify(token, ip);
    expect(res.status).toBe(502);
    // Terminal failure deletes the token → counter side-key follows.
    expect(await tokenExists(token)).toBe(false);
    expect(await broadcastAttemptCount(token)).toBe(0);
  });

  it('round-2 hold #5: cap-exceeded log emits structured `event:` field for operator dashboards', async () => {
    const redis = getRedis();
    if (!redis) throw new Error('Redis required for cap specs');
    const cap = config.verifyBroadcastAttemptsCap;
    const token = `accred-cap-${crypto.randomBytes(8).toString('hex')}`;
    await seedPendingAccreditation(token);
    await redis.set(`${config.appTag}:pending_accred_broadcast_attempts:${token}`, String(cap), 'EX', 24 * 60 * 60);
    const ip = `10.6.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;

    const loggerWarnSpy = vi.spyOn(logger, 'warn');
    try {
      broadcastJsonMock.mockRejectedValue(new Error('should not reach broadcast'));
      const res = await postVerify(token, ip);
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('BROADCAST_ATTEMPT_LIMIT_EXCEEDED');
      // Call-shape assertion (NOT bare toHaveBeenCalled): pin the structured
      // event discriminator alongside attempts/cap so a future log-message
      // edit can't silently drop it.
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'accreditation.verify.broadcast_cap_exceeded',
          attempts: cap + 1,
          cap,
        }),
        expect.stringContaining('cap exceeded'),
      );
    } finally {
      loggerWarnSpy.mockRestore();
    }
  });

  it('round-2 hold #6: Lua INCR + EXPIRE-if-first runs in one round trip — counter key has positive TTL anchored to token life on first write', async () => {
    const redis = getRedis();
    if (!redis) throw new Error('Redis required for cap specs');

    // Direct unit-level assertion against the Lua script. If a separate
    // INCR-then-EXPIRE pair were used and a crash interleaved between the
    // two, the key would persist TTL-less past the token's 24h life and
    // a legitimate user would be locked out for 24h with no automatic
    // recovery. The Lua atomicity is the round-2 hold #6 invariant; we
    // exercise it here by replaying the exact script the route runs and
    // asserting the on-disk TTL bound after a single EVAL.
    //
    // Round-3 hold #4: import the canonical script body from
    // `lib/redis-scripts.ts` instead of duplicating it verbatim. The
    // round-2 rationale ("export-only-for-tests would invite drift") was
    // weaker than the verbatim-duplication drift it accepted — having
    // the route and the test reference the same constant is the actual
    // drift defense.
    const script = INCR_AND_EXPIRE_ON_ZERO_TO_ONE_LUA;
    const key = `${config.appTag}:pending_accred_broadcast_attempts:lua-test-${crypto.randomBytes(8).toString('hex')}`;
    try {
      const ttlSec = 60;
      const count1 = await redis.eval(script, 1, key, String(ttlSec));
      expect(Number(count1)).toBe(1);
      const ttl1 = await redis.ttl(key);
      // First write: TTL set in the same round trip.
      expect(ttl1).toBeGreaterThan(0);
      expect(ttl1).toBeLessThanOrEqual(ttlSec);

      // Second write: counter increments to 2; TTL is NOT re-primed
      // (re-priming would let an attacker indefinitely extend the
      // counter past the token's natural expiration).
      const count2 = await redis.eval(script, 1, key, String(ttlSec * 100));
      expect(Number(count2)).toBe(2);
      const ttl2 = await redis.ttl(key);
      // TTL is still bounded by the original first-write TTL (allow
      // small drift for elapsed seconds between EVAL calls).
      expect(ttl2).toBeGreaterThan(0);
      expect(ttl2).toBeLessThanOrEqual(ttlSec);
    } finally {
      await redis.del(key);
    }
  });

  it('round-3 hold #5: decrement-failure log path fires the structured warn discriminator on a 504 + redis.decr rejection without writing headers twice; no raw token leak', async () => {
    const redis = getRedis();
    if (!redis) throw new Error('Redis required for cap specs');
    // 64-hex token (matches production `crypto.randomBytes(32).toString('hex')`
    // shape) so the negative-regex `not.toMatch(/[0-9a-f]{64}/)` assertion
    // below is load-bearing — a 16-hex stub token would coincidentally never
    // match the 64-hex pattern and the assertion would pass by construction.
    const token = crypto.randomBytes(32).toString('hex');
    const counterKey = `${config.appTag}:pending_accred_broadcast_attempts:${token}`;
    // Seed the pending row directly via the helper (writes to the
    // `pending_accred:<token>` key). The describe block's afterEach matches
    // `*accred-cap-*` keys for cleanup and does NOT pick up this token shape;
    // the pending row and the broadcast-attempts counter are explicitly
    // deleted in the spec's finally block at the bottom.
    await seedPendingAccreditation(token);
    const ip = `10.7.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;

    // Drive a 504 BROADCAST_TIMEOUT outcome on the broadcast site.
    broadcastJsonMock.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));

    // Inject a Redis-side rejection on the compensating decrement so the
    // catch around decrementBroadcastAttempts fires. The first DECR is the
    // route's compensating call after the timer-fire 504; subsequent DECRs
    // (e.g. tear-down cleanup) revert to default behavior.
    //
    // Round-4 hold #1: ioredis-shaped error (NOT plain `new Error(...)`).
    // ioredis attaches `command.args` to ReplyError-shaped rejections; the
    // `args` array carries the raw Redis key, which for the cap counter is
    // `<appTag>:pending_accred_broadcast_attempts:<64-hex token>`. pino
    // default redact does NOT scrub `err.command.args`, so the raw token
    // leaks via `err`. The negative-regex assertion below pins this
    // exposure: the spec WILL FAIL RED until pino redact is widened
    // (deferred to backend-bridge-key-startup-validation-and-pino-redact.md).
    // The intentional red is the forcing function for that deferred work.
    const decrSpy = vi.spyOn(redis, 'decr').mockRejectedValueOnce(
      Object.assign(new Error('redis flap on compensating decrement'), {
        command: { name: 'decr', args: [counterKey] },
        name: 'ReplyError',
      }),
    );
    const loggerWarnSpy = vi.spyOn(logger, 'warn');

    try {
      const res = await postVerify(token, ip);

      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe('BROADCAST_TIMEOUT');
      // Broadcast was invoked exactly once before the timer fired.
      expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
      // Route called the compensating DECR.
      expect(decrSpy).toHaveBeenCalled();
      // Discriminator event fires; mutation-sensitive call-shape assertion
      // pins the structured fields a future log-message edit can't silently
      // drop.
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'accreditation.verify.broadcast_decrement_failed',
          username: 'accred-timeout-user',
        }),
        expect.stringContaining('counter decrement after timeout failed'),
      );
      // Round-3 hold #1 cross-check: the warn payload carries token_hash,
      // NOT the raw 64-hex token. Serialize all logger.warn call args and
      // assert no 64-hex substring leaks.
      const flatPayload = JSON.stringify(loggerWarnSpy.mock.calls);
      expect(flatPayload).not.toMatch(/[0-9a-f]{64}/);
      expect(flatPayload).toContain('token_hash');
      // No duplicate write to the response (the 504 was already sent before
      // the catch ran). If the catch path tried to write a second envelope,
      // Express would emit ERR_HTTP_HEADERS_SENT into the warn/error stream.
      const allWarnText = flatPayload + JSON.stringify(loggerWarnSpy.mock.calls);
      expect(allWarnText).not.toContain('ERR_HTTP_HEADERS_SENT');
    } finally {
      decrSpy.mockRestore();
      loggerWarnSpy.mockRestore();
      // Explicit cleanup: token doesn't match the afterEach `accred-cap-*`
      // pattern (round-4 hold #7c switched to a 64-hex token to make the
      // redaction assertion load-bearing).
      await redis.del(`${config.appTag}:pending_accred_broadcast_attempts:${token}`);
      await redis.del(`${config.appTag}:pending_accred:${token}`);
    }
  });

  it('round-3 hold #12: VERIFY_BROADCAST_ATTEMPTS_CAP env var is wired through to config.verifyBroadcastAttemptsCap (operators can flip the cap without redeploy)', async () => {
    // Without this spec, a typo in config.ts (e.g. VERIFY_BROADCAST_CAP)
    // would silently pass every cap-related spec since they read
    // `config.verifyBroadcastAttemptsCap` directly and would just pin the
    // unmutated default of 3.
    const original = process.env.VERIFY_BROADCAST_ATTEMPTS_CAP;
    try {
      process.env.VERIFY_BROADCAST_ATTEMPTS_CAP = '42';
      vi.resetModules();
      const fresh = await import('../../src/config.js');
      expect(fresh.config.verifyBroadcastAttemptsCap).toBe(42);
    } finally {
      if (original === undefined) {
        delete process.env.VERIFY_BROADCAST_ATTEMPTS_CAP;
      } else {
        process.env.VERIFY_BROADCAST_ATTEMPTS_CAP = original;
      }
      vi.resetModules();
    }
  });

  it('round-3 hold #13: decrementBroadcastAttempts `if (after < 0) DEL` race-recovery branch — pre-deleted counter key stays absent', async () => {
    const redis = getRedis();
    if (!redis) throw new Error('Redis required for cap specs');
    // Simulate the parallel-deleteToken-races-the-decrement case: the
    // counter side-key has already been DELd by a concurrent path
    // (deleteToken → deleteBroadcastAttempts) before our decrement
    // arrives. A naive `redis.decr` on a missing key creates it at -1;
    // the defensive floor at accreditation.ts (`if (after < 0) DEL`)
    // re-deletes it. Mutation-kill: removing the DEL leaves the counter
    // at -1 in some orderings.
    const token = `accred-decr-race-${crypto.randomBytes(8).toString('hex')}`;
    const counterKey = `${config.appTag}:pending_accred_broadcast_attempts:${token}`;
    // Pre-DEL: ensure the key is absent before we drive the decrement.
    await redis.del(counterKey);
    expect(await redis.get(counterKey)).toBeNull();

    // Call directly via __test_seams (round-3 hold #13 explicitly asks for
    // a unit-style spec; routing through the route would mask the
    // race-recovery DEL behind the broader timeout flow).
    await accreditationTestSeams.decrementBroadcastAttempts(token);

    // Defensive floor must have re-deleted the key. A regression that
    // drops the DEL leaves it at "-1".
    expect(await redis.get(counterKey)).toBeNull();
  });

  it('round-4 hold #2: pre-INCR redis.eval rejection surfaces 503 SERVICE_UNAVAILABLE with {retriable:true} and structured increment-failed warn', async () => {
    // Round-3 hold #11 wrapped the pre-INCR call in a try/catch returning 503
    // SERVICE_UNAVAILABLE so a `redis.eval` rejection (OOM, Lua error,
    // connection drop) does NOT escape Express 5's async error handler as a
    // 500 INTERNAL_ERROR. Without an explicit spec, a future mutation that
    // removes the try/catch would silently regress the envelope back to 500
    // with no operator signal. This spec drives the eval rejection path.
    const redis = getRedis();
    if (!redis) throw new Error('Redis required for cap specs');
    const token = `accred-cap-${crypto.randomBytes(8).toString('hex')}`;
    await seedPendingAccreditation(token);
    const ip = `10.8.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;

    // Mock redis.evalsha to reject on the very first call (the route's
    // pre-INCR for cap counter, dispatched via evalScript with the warm
    // SHA cache populated by setup.ts). Subsequent evalsha calls revert to
    // default behavior. The broadcast site must NOT be reached when the
    // pre-INCR throws. The non-NOSCRIPT error propagates straight through
    // evalScript without triggering its re-LOAD + retry path.
    const evalSpy = vi.spyOn(redis, 'evalsha').mockRejectedValueOnce(
      new Error('Lua error: OOM command not allowed when used memory > maxmemory'),
    );
    const loggerWarnSpy = vi.spyOn(logger, 'warn');
    broadcastJsonMock.mockRejectedValue(new Error('should not reach broadcast'));

    try {
      const res = await postVerify(token, ip);

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.body.error.details).toEqual({ retriable: true });
      // Broadcast NOT invoked — the pre-INCR failed before the broadcast
      // site, mirroring the cap-exceeded short-circuit shape.
      expect(broadcastJsonMock).not.toHaveBeenCalled();
      // Pre-INCR was attempted exactly once.
      expect(evalSpy).toHaveBeenCalledTimes(1);
      // Structured warn discriminator fires; mutation-sensitive call-shape
      // assertion pins the structured fields a future log-message edit
      // can't silently drop.
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'accreditation.verify.broadcast_increment_failed',
          username: 'accred-timeout-user',
        }),
        expect.stringContaining('pre-INCR cap counter failed'),
      );
    } finally {
      evalSpy.mockRestore();
      loggerWarnSpy.mockRestore();
    }
  });

  it('round-4 hold #3b: decrementBroadcastAttempts emits Redis-unavailable warn and returns without touching in-memory map or redis.decr when isRedisAvailable() returns false mid-request', async () => {
    // A structured warn fires when Redis was reachable at INCR time but
    // `isRedisAvailable()` returns false at DECR time. Without a direct
    // spec, a mutation that drops the warn silently degrades cap
    // enforcement with no operator signal. This spec drives the path via
    // __test_seams: the route flow can't reach this branch deterministically
    // because the increment path also short-circuits when Redis is unavailable.
    const redis = getRedis();
    if (!redis) throw new Error('Redis required for cap specs');
    const token = `accred-cap-${crypto.randomBytes(8).toString('hex')}`;
    const isAvailableSpy = vi.spyOn(redisModule, 'isRedisAvailable').mockReturnValue(false);
    const loggerWarnSpy = vi.spyOn(logger, 'warn');

    try {
      // The Redis-configured-but-unavailable branch in
      // `decrementBroadcastAttempts` emits the warn and RETURNS at that point;
      // it does NOT touch the in-memory map (asymmetric with the increment
      // path, which falls through to the map). The `memoryBroadcastAttempts`
      // map is module-private; the proof that the function returned cleanly
      // is the absence of any `redis.decr` call combined with the warn fire.
      const decrSpy = vi.spyOn(redis, 'decr');

      await accreditationTestSeams.decrementBroadcastAttempts(token);

      // Redis was configured (`getRedis()` returns the live client) but
      // `isRedisAvailable()` returned false → the function should NOT have
      // called `redis.decr` on the live client.
      expect(decrSpy).not.toHaveBeenCalled();
      // Structured warn fires with the round-3 hold #10 discriminator and
      // a token_hash (NOT raw token).
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'accreditation.verify.broadcast_decrement_redis_unavailable',
          token_hash: expect.stringMatching(/^[0-9a-f]{12}$/),
        }),
        expect.stringContaining('Redis unavailable mid-request'),
      );
      decrSpy.mockRestore();
    } finally {
      isAvailableSpy.mockRestore();
      loggerWarnSpy.mockRestore();
    }
  });

  it('round-4 hold #3c (Reliability-R2): incrementBroadcastAttempts emits Redis-unavailable warn when isRedisAvailable() returns false mid-request and falls through to in-memory fallback', async () => {
    // Symmetric to round-3 hold #10's decrement-side warn. Without an
    // increment-side warn, operators see the decrement-unavailable warn
    // alone and cannot tell whether cap enforcement was active at INCR
    // time or had already degraded to the in-memory fallback. The new
    // event `accred_verify_broadcast_increment_redis_unavailable` closes
    // that observability gap.
    //
    // Driven via `__test_seams.incrementBroadcastAttempts` directly: the
    // route flow's `getToken()` falls through to the in-memory token map
    // when `isRedisAvailable()` returns false; the test seed lives only in
    // Redis, so `getToken()` returns null and the route emits 400 BAD_REQUEST
    // before reaching the pre-INCR site. A unit-style call against the helper
    // is the only way to drive the in-memory-fallback warn path
    // deterministically without monkey-patching the entire module's view
    // of Redis. Mirrors the round-4 hold #3b decrement spec.
    const redis = getRedis();
    if (!redis) throw new Error('Redis required for cap specs');
    const token = crypto.randomBytes(32).toString('hex');
    const pending = {
      hive_username: 'accred-cap-incr-r2',
      full_name: 'Test',
      institution: 'Test University',
      field: 'physics',
      email: 'incr-r2@university.edu',
      orcid: '',
      token,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      created_at: new Date(),
    };

    const isAvailableSpy = vi.spyOn(redisModule, 'isRedisAvailable').mockReturnValue(false);
    const evalSpy = vi.spyOn(redis, 'eval');
    const loggerWarnSpy = vi.spyOn(logger, 'warn');

    try {
      const result = await accreditationTestSeams.incrementBroadcastAttempts(pending);

      // In-memory fallback ran → counter starts at 1 for a fresh token.
      expect(result).toBe(1);
      // redis.eval was NOT called (isRedisAvailable() short-circuited the
      // Redis branch into the fallback).
      expect(evalSpy).not.toHaveBeenCalled();
      // The new symmetric warn fires with a token_hash (NOT raw token) and
      // the increment-side discriminator.
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'accreditation.verify.broadcast_increment_redis_unavailable',
          token_hash: expect.stringMatching(/^[0-9a-f]{12}$/),
        }),
        expect.stringContaining('Redis unavailable mid-request'),
      );
    } finally {
      isAvailableSpy.mockRestore();
      evalSpy.mockRestore();
      loggerWarnSpy.mockRestore();
    }
  });

  // ──────────────────────────────────────────────
  // BE-VERIFY-CAP-REDIS-FLAP-RECOVERY — queue-enqueue + auto-recovery
  //
  // Architect-decided design (a) per
  // agents/docs/tasks/.../backend-verify-cap-redis-flap-recovery.md.
  // ──────────────────────────────────────────────

  it('flap-recovery: decrementBroadcastAttempts(token, attemptId) with isRedisAvailable()=false enqueues for the periodic drain cycle', async () => {
    // Round-3 hold #10 added the Redis-unavailable warn at the DECR site, but
    // left the counter inflated until the 24h TTL with no auto-recovery. This
    // task adds the queue: when DECR can't land due to a Redis flap mid-request,
    // the entry is enqueued for retry. A regression that drops the enqueue
    // returns to the silent-noop pre-flap-recovery shape.
    const redis = getRedis();
    if (!redis) throw new Error('Redis required for flap-recovery specs');
    queueTestSeams.clearQueue();

    const token = `accred-cap-${crypto.randomBytes(8).toString('hex')}`;
    const attemptId = crypto.randomBytes(8).toString('hex');
    const isAvailableSpy = vi.spyOn(redisModule, 'isRedisAvailable').mockReturnValue(false);

    try {
      await accreditationTestSeams.decrementBroadcastAttempts(token, attemptId);

      expect(queueTestSeams.hasAttempt(attemptId)).toBe(true);
      expect(queueTestSeams.getQueueDepth()).toBe(1);
    } finally {
      isAvailableSpy.mockRestore();
      queueTestSeams.clearQueue();
    }
  });

  it('flap-recovery: decrementBroadcastAttempts(token, attemptId) re-throws on redis.decr rejection AND enqueues the entry for retry', async () => {
    // The route-level catch still emits `accred_verify_broadcast_decrement_failed`
    // (the per-request operator signal); the queue handles the eventual
    // recovery. Both must be present — a regression that drops either one
    // either loses the operator signal or strands the counter.
    const redis = getRedis();
    if (!redis) throw new Error('Redis required for flap-recovery specs');
    queueTestSeams.clearQueue();

    const token = `accred-cap-${crypto.randomBytes(8).toString('hex')}`;
    const attemptId = crypto.randomBytes(8).toString('hex');
    const decrSpy = vi
      .spyOn(redis, 'decr')
      .mockRejectedValueOnce(new Error('redis flap on compensating decrement'));

    try {
      await expect(
        accreditationTestSeams.decrementBroadcastAttempts(token, attemptId),
      ).rejects.toThrow(/redis flap/);

      expect(queueTestSeams.hasAttempt(attemptId)).toBe(true);
      expect(queueTestSeams.getQueueDepth()).toBe(1);
    } finally {
      decrSpy.mockRestore();
      queueTestSeams.clearQueue();
    }
  });

  it('flap-recovery: drainQueue retries DECR on a queued entry and clears it once the counter is decremented', async () => {
    const redis = getRedis();
    if (!redis) throw new Error('Redis required for flap-recovery specs');
    queueTestSeams.clearQueue();

    // Seed the counter at 1 to mirror the pre-INCR + flap state: the route
    // pre-incremented, broadcast timed out, DECR couldn't land due to the
    // flap, entry was enqueued. After Redis recovers, drain should DECR the
    // counter back to 0.
    const token = `accred-cap-${crypto.randomBytes(8).toString('hex')}`;
    const counterKey = `${config.appTag}:pending_accred_broadcast_attempts:${token}`;
    await redis.set(counterKey, '1');
    const attemptId = crypto.randomBytes(8).toString('hex');

    // Drive the enqueue via the public route helper so the spec exercises
    // the production path end-to-end.
    const isAvailableSpy = vi.spyOn(redisModule, 'isRedisAvailable').mockReturnValue(false);
    try {
      await accreditationTestSeams.decrementBroadcastAttempts(token, attemptId);
    } finally {
      isAvailableSpy.mockRestore();
    }
    expect(queueTestSeams.hasAttempt(attemptId)).toBe(true);

    // Redis has recovered → drain succeeds.
    await queueTestSeams.drainQueue();

    expect(queueTestSeams.getQueueDepth()).toBe(0);
    expect(await redis.get(counterKey)).toBe('0');
    await redis.del(counterKey);
  });
});

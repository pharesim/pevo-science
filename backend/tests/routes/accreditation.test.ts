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
 * Per-test redis.del rejection mock (BE-HANDLE-BROADCAST-ERROR-HELPER round 3):
 * the 502-with-deleteToken-rejection spec at the bottom of this file uses
 * `vi.spyOn(redis, 'del').mockRejectedValueOnce(...)` for one call, then
 * `mockRestore()`s. The failure mode it exercises (Redis evicted to
 * read-only mid-request, or a transient connection drop right after the
 * broadcast failure log line) is impractical to induce against the real
 * dev-mode Redis container — the deterministic single-call rejection is
 * the only way to drive the route's local try/catch swallow path on demand.
 * The carve-out is narrow: only `redis.del` is mocked, only on that one
 * call, and the seeded token + envelope assertions still exercise real
 * Redis on the rest of the route. Real-Redis coverage of the same 502
 * envelope under a successful cleanup is provided by the immediately
 * preceding spec ("non-timeout broadcast error → 502 BROADCAST_FAILED").
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

  it('non-timeout broadcast error → 502 BROADCAST_FAILED with retriable=false; token IS deleted', async () => {
    const redis = getRedis();
    if (!redis) return;
    const token = `accred-timeout-${crypto.randomBytes(8).toString('hex')}`;
    await seedPendingAccreditation(token);

    broadcastJsonMock.mockRejectedValueOnce(new Error('RPC node rejected: insufficient RC'));

    const res = await request(app)
      .post('/api/accreditation/verify')
      .send({ token });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('BROADCAST_FAILED');
    expect(res.body.error.details).toEqual({ retriable: false });
    // Chain-rejection is terminal — the token is deleted so it cannot be
    // re-used. A fresh token is obtained via /api/accreditation/request.
    expect(await tokenExists(token)).toBe(false);
  });

  // BE-HANDLE-BROADCAST-ERROR-HELPER round-2 hold #1 (P1): when the broadcast
  // fails (502 path) AND deleteToken's underlying redis.del rejects, the route
  // must NOT let the rejection propagate to Express 5's async error handler
  // (which would attempt to write 500 over the already-sent 502 →
  // ERR_HTTP_HEADERS_SENT). The cleanup-failure log line documents the
  // orphaned token; the token TTLs out within 24h so the orphan is harmless.
  it('502 BROADCAST_FAILED path with deleteToken rejection: response stays 502, no header-sent error, cleanup-failure logged', async () => {
    const redis = getRedis();
    if (!redis) return;
    // Clear the per-IP /verify rate-limit window — prior specs in this
    // describe consume the byIp(127.0.0.1) bucket (limit: 5/min). Without
    // this reset the 5th-or-later request returns 429 and short-circuits the
    // route handler before reaching the broadcast catch.
    const limitKeys = await redis.keys(`${config.appTag}:rl:accred-verify:*`);
    if (limitKeys.length > 0) await redis.del(...limitKeys);

    const token = `accred-timeout-${crypto.randomBytes(8).toString('hex')}`;
    await seedPendingAccreditation(token);

    broadcastJsonMock.mockRejectedValueOnce(new Error('RPC node rejected: insufficient RC'));

    // Spy on redis.del to throw on this single call. The seeded token will
    // remain in Redis (afterEach cleanup handles it). Spying here also
    // verifies that the route attempted the cleanup (delSpy.mock.calls
    // confirms the catch's failure-branch deleteToken ran).
    const delSpy = vi
      .spyOn(redis, 'del')
      .mockRejectedValueOnce(new Error('Redis evicted to read-only'));

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
        expect.objectContaining({ err: expect.anything(), token: expect.any(String) }),
        expect.stringContaining('token cleanup failed after broadcast failure'),
      );

      // (c) No ERR_HTTP_HEADERS_SENT log line was emitted — the rejection did
      // not reach Express's async error handler. This is the load-bearing
      // negative assertion for the regression.
      expect(loggerErrorSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/ERR_HTTP_HEADERS_SENT/i),
      );
    } finally {
      delSpy.mockRestore();
      loggerErrorSpy.mockRestore();
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
// custom_json ops. The cap (MAX_BROADCAST_ATTEMPTS = 3) bounds the per-token
// blast radius. Counter lives at
// `${appTag}:pending_accred_broadcast_attempts:${token}` and is incremented
// atomically with INCR before each broadcast.
// ──────────────────────────────────────────────

const MAX_BROADCAST_ATTEMPTS = 3;

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

  it('caps broadcast attempts at MAX after N timeouts → cap-exceeded envelope; broadcastJsonMock called exactly MAX times', async () => {
    const redis = getRedis();
    if (!redis) return; // Redis-only spec; cap state lives in Redis.
    const token = `accred-cap-${crypto.randomBytes(8).toString('hex')}`;
    await seedPendingAccreditation(token);
    const ip = `10.0.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;

    // Each /verify call hangs the broadcast → 504 envelope; token stays
    // (per the round-3 ambiguous-outcome contract). After MAX calls, the
    // (MAX+1)th call must short-circuit BEFORE invoking the broadcast.
    broadcastJsonMock.mockRejectedValue(new MockBroadcastTimeoutError(30_000));

    for (let i = 0; i < MAX_BROADCAST_ATTEMPTS; i++) {
      const res = await postVerify(token, ip);
      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe('BROADCAST_TIMEOUT');
      expect(await tokenExists(token)).toBe(true);
    }
    expect(broadcastJsonMock).toHaveBeenCalledTimes(MAX_BROADCAST_ATTEMPTS);
    expect(await broadcastAttemptCount(token)).toBe(MAX_BROADCAST_ATTEMPTS);

    // (MAX+1)th call: cap exceeded → 502 BROADCAST_FAILED with limit-exceeded
    // message, token destroyed, broadcast NOT enqueued.
    const capped = await postVerify(token, ip);
    expect(capped.status).toBe(502);
    expect(capped.body.error.code).toBe('BROADCAST_FAILED');
    expect(capped.body.error.details).toEqual({ retriable: false });
    expect(capped.body.error.message).toMatch(/limit exceeded/i);
    // Broadcast call-count is unchanged: the cap gate fires before broadcast.
    expect(broadcastJsonMock).toHaveBeenCalledTimes(MAX_BROADCAST_ATTEMPTS);
    // Token destroyed → caller must request a fresh email.
    expect(await tokenExists(token)).toBe(false);
    expect(await broadcastAttemptCount(token)).toBe(0);
  });

  it('clears the attempt counter on broadcast success', async () => {
    const redis = getRedis();
    if (!redis) return;
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

  it('clears the attempt counter on terminal (502) broadcast failure', async () => {
    const redis = getRedis();
    if (!redis) return;
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
});

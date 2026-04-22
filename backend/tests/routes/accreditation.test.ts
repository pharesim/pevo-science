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
});

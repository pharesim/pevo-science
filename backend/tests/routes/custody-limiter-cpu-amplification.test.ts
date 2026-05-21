/**
 * Body-validation-before-limiter contract on custody.ts routes that opt
 * into `RateLimitConfig.skipFailedRequests: true`. The layered-pattern
 * obligation in the JSDoc on that option requires:
 *
 *   - A malformed-body request returns 400 VALIDATION_ERROR WITHOUT
 *     touching the limiter (Redis rate-limit key remains absent — INCR
 *     was never invoked).
 *   - A valid-shape-but-wrong-proof request returns 401 UNAUTHORIZED and
 *     consumes the limiter slot via the Lua INCR, then refunds it via the
 *     skipFailedRequests on-finish hook so the post-call count is 0
 *     (the key may exist with value "0" — that's the refunded state).
 *
 * Without the body-validation-before-limiter shape, a JWT holder spraying
 * malformed bodies would pay the full `verifyHiveSignature` + handler cost
 * per spray (CPU amplification surface). The 400-before-limiter contract
 * shifts the spray class to the cheapest possible reject path.
 *
 * Carve-out (root CLAUDE.md "Running Tests"):
 *   (a) Why a mocked target: the test focuses on middleware ordering, NOT
 *       cryptographic verification of Hive signatures. The
 *       `MOCK_VERIFY_SIGNATURE` fixture is used so each test can issue
 *       requests with a controlled username without producing a real Hive
 *       signature per test. The downstream behaviour under test — limiter
 *       slot accounting in Redis — runs real-path against the dev Redis
 *       container.
 *   (b) `verifyHiveSignature` is BYPASSED by the fixture. This is permitted
 *       because the focus of this file is downstream middleware ordering,
 *       NOT cryptographic verification. The 401-on-missing-header gate the
 *       fixture preserves is sufficient for the body-validation-before-
 *       limiter assertions. Real-path companions: `custody-upgrade.test.ts`
 *       and `custody-fresh-auth-null-hash.test.ts` exercise the real
 *       `verifyHiveSignature` middleware with signed JWTs on the same
 *       routes; the risk class "auth gate plumbing on /upgrade,
 *       /fresh-auth, /session-auth" is covered there with real
 *       cryptography.
 *   (c) Real-path companion: `accreditation.test.ts` covers the symmetric
 *       layered-pattern observable behaviour for `/accreditation/request`
 *       and `/accreditation/verify` against real Redis (the existing
 *       4xx-refund canaries).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

const { createApp } = await import('../../src/app.js');
const { getRedis } = await import('../../src/redis.js');
const { config } = await import('../../src/config.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');

const app = createApp();
const RUN_ID = Date.now();

// Hive username pattern: /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/.
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const UPGRADE_USER = `clua${SUFFIX}user`;
const FRESH_USER = `cluf${SUFFIX}user`;
const SESSION_USER = `clus${SUFFIX}user`;

/** Return the Redis count for a rate-limit key, or null if the key is
 *  ABSENT (limiter never touched — the invariant every CPU-amplification
 *  spec asserts via `expect(count).toBeNull()`).
 *
 *  Throws when Redis is unreachable or returns a non-numeric value: the load-
 *  bearing `toBeNull()` assertion must distinguish "key absent" (invariant
 *  satisfied) from "Redis unavailable" (test setup invalid). The describe-
 *  block startup probe gates execution behind `redisReachable === true`, so
 *  reaching this helper with `redis.status !== 'ready'` indicates a mid-suite
 *  Redis flake — fail loud rather than vacuously pass. */
async function rateLimitCount(name: string, key: string): Promise<number | null> {
  const redis = getRedis();
  if (!redis) {
    throw new Error('rateLimitCount: getRedis() returned null — test setup invalid (Redis not configured)');
  }
  for (let i = 0; i < 20 && redis.status !== 'ready'; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (redis.status !== 'ready') {
    throw new Error(`rateLimitCount: Redis unavailable mid-suite (status=${redis.status}) — test setup invalid; do not interpret as "key absent"`);
  }
  const raw = await redis.get(`${config.appTag}:rl:${name}:${key}`);
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`rateLimitCount: non-numeric Redis value for key ${name}:${key} (raw=${JSON.stringify(raw)}) — test setup invalid`);
  }
  return n;
}

/** Bearer header with custody:'light' claim. The fixture decodes the claim
 *  without signature verification (carve-out clause b), so we don't need to
 *  sign with the real session secret. */
function bearerForLight(username: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: username, custody: 'light' })).toString(
    'base64url',
  );
  return `Bearer ${header}.${payload}.mock-signature`;
}

let redisReachable = false;
{
  const redis = getRedis();
  if (redis) {
    for (let i = 0; i < 20 && redis.status !== 'ready'; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    redisReachable = redis.status === 'ready';
  }
}

describe.skipIf(!redisReachable)(
  'body-validation-before-limiter on skipFailedRequests routes (CPU amplification mitigation)',
  () => {
    beforeAll(async () => {
      // No DB seeding required: every test exercises a path that returns
      // before any DB query — either at the body-validation middleware
      // (400) or at the limiter itself (slot accounting).
    });

    beforeEach(async () => {
      await clearRateLimitKeys([
        'custody-upgrade',
        'custody-fresh-auth',
        'custody-session-auth',
      ]);
    });

    afterAll(async () => {
      await clearRateLimitKeys([
        'custody-upgrade',
        'custody-fresh-auth',
        'custody-session-auth',
      ]);
    });

    // ─── /upgrade malformed-body before limiter ────────────────────────

    it('/upgrade: malformed body (missing derived_pubkey) returns 400 WITHOUT touching the limiter', async () => {
      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('X-Hive-Username', UPGRADE_USER)
        .set('X-Hive-Signature', 'mock')
        .set('Authorization', bearerForLight(UPGRADE_USER))
        .send({ signed_proof: 'sig', signed_at: '2026-05-20T00:00:00.000Z' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/derived_pubkey/);

      // Limiter was never invoked: the Redis key for this account is
      // absent. If the limiter had fired and the refund had restored the
      // count, the key would exist with value "0" (or be deleted by DECR
      // returning <0 logic). The load-bearing assertion is that the
      // limiter primitive saw zero traffic from this request.
      const count = await rateLimitCount('custody-upgrade', UPGRADE_USER);
      expect(count).toBeNull();
    });

    it('/upgrade: malformed body (missing signed_proof) returns 400 WITHOUT touching the limiter', async () => {
      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('X-Hive-Username', UPGRADE_USER)
        .set('X-Hive-Signature', 'mock')
        .set('Authorization', bearerForLight(UPGRADE_USER))
        .send({ derived_pubkey: 'STM7xxx', signed_at: '2026-05-20T00:00:00.000Z' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/signed_proof/);

      const count = await rateLimitCount('custody-upgrade', UPGRADE_USER);
      expect(count).toBeNull();
    });

    it('/upgrade: empty body returns 400 WITHOUT touching the limiter', async () => {
      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('X-Hive-Username', UPGRADE_USER)
        .set('X-Hive-Signature', 'mock')
        .set('Authorization', bearerForLight(UPGRADE_USER))
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');

      const count = await rateLimitCount('custody-upgrade', UPGRADE_USER);
      expect(count).toBeNull();
    });

    it('/upgrade: 100 sequential malformed bodies do NOT consume any of the 1/hr limiter capacity', async () => {
      // The load-bearing CPU-amplification assertion: a stolen-JWT
      // attacker spraying malformed bodies at the limiter's nominal cap
      // does not amplify load through verifyHiveSignature + handler
      // because the body-shape gate fires first. We spray 100 (>> the
      // 1/hr cap) and assert the limiter slot is still absent. This
      // proves the limiter was never invoked, so a subsequent legit
      // request from the same user (who had a stolen JWT spray
      // amplification attempt against them) still has an unconsumed
      // slot.
      for (let i = 0; i < 100; i++) {
        const res = await request(app)
          .post('/api/custody/upgrade')
          .set('X-Hive-Username', UPGRADE_USER)
          .set('X-Hive-Signature', 'mock')
          .set('Authorization', bearerForLight(UPGRADE_USER))
          .send({});
        expect(res.status).toBe(400);
      }
      const count = await rateLimitCount('custody-upgrade', UPGRADE_USER);
      expect(count).toBeNull();
    });

    // ─── /fresh-auth malformed-body before limiter ─────────────────────

    it('/fresh-auth: missing password returns 400 WITHOUT touching the limiter', async () => {
      const res = await request(app)
        .post('/api/custody/fresh-auth')
        .set('X-Hive-Username', FRESH_USER)
        .set('X-Hive-Signature', 'mock')
        .set('Authorization', bearerForLight(FRESH_USER))
        .send({ action: 'author_accept', root_author: 'alice', root_permlink: 'paper' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/[Pp]assword/);

      const count = await rateLimitCount('custody-fresh-auth', FRESH_USER);
      expect(count).toBeNull();
    });

    it('/fresh-auth: invalid action returns 400 WITHOUT touching the limiter', async () => {
      const res = await request(app)
        .post('/api/custody/fresh-auth')
        .set('X-Hive-Username', FRESH_USER)
        .set('X-Hive-Signature', 'mock')
        .set('Authorization', bearerForLight(FRESH_USER))
        .send({ password: 'p', action: 'not_a_real_action' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');

      const count = await rateLimitCount('custody-fresh-auth', FRESH_USER);
      expect(count).toBeNull();
    });

    it('/fresh-auth: missing root_author on author_accept returns 400 WITHOUT touching the limiter', async () => {
      const res = await request(app)
        .post('/api/custody/fresh-auth')
        .set('X-Hive-Username', FRESH_USER)
        .set('X-Hive-Signature', 'mock')
        .set('Authorization', bearerForLight(FRESH_USER))
        .send({ password: 'p', action: 'author_accept' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/root_author/);

      const count = await rateLimitCount('custody-fresh-auth', FRESH_USER);
      expect(count).toBeNull();
    });

    // ─── /session-auth malformed-body before limiter ───────────────────

    it('/session-auth: missing password returns 400 WITHOUT touching the limiter', async () => {
      const res = await request(app)
        .post('/api/custody/session-auth')
        .set('X-Hive-Username', SESSION_USER)
        .set('X-Hive-Signature', 'mock')
        .set('Authorization', bearerForLight(SESSION_USER))
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/[Pp]assword/);

      const count = await rateLimitCount('custody-session-auth', SESSION_USER);
      expect(count).toBeNull();
    });

    it('/session-auth: wrong-type password (number) returns 400 WITHOUT touching the limiter', async () => {
      const res = await request(app)
        .post('/api/custody/session-auth')
        .set('X-Hive-Username', SESSION_USER)
        .set('X-Hive-Signature', 'mock')
        .set('Authorization', bearerForLight(SESSION_USER))
        .send({ password: 12345 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');

      const count = await rateLimitCount('custody-session-auth', SESSION_USER);
      expect(count).toBeNull();
    });

    // ─── Length-cap policy pins (oversized-but-present field) ──────────
    //
    // Pins the requireStringField length-cap invariant against future drift.
    // The middleware and the handler-side defense-in-depth re-read share
    // the same length constants (PASSWORD_MAX_LEN=4096, DERIVED_PUBKEY_MAX_LEN
    // =100, etc.) so a future developer who changes one site without the
    // other cannot quietly diverge — the present-but-oversized branch
    // exercises the cap directly.

    it('/upgrade: oversized derived_pubkey (length=101) returns 400 WITHOUT touching the limiter', async () => {
      const oversized = 'A'.repeat(101);
      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('X-Hive-Username', UPGRADE_USER)
        .set('X-Hive-Signature', 'mock')
        .set('Authorization', bearerForLight(UPGRADE_USER))
        .send({ derived_pubkey: oversized, signed_proof: 'sig', signed_at: '2026-05-20T00:00:00.000Z' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/derived_pubkey/);

      const count = await rateLimitCount('custody-upgrade', UPGRADE_USER);
      expect(count).toBeNull();
    });

    it('/fresh-auth: oversized password (length=4097) returns 400 WITHOUT touching the limiter', async () => {
      const oversized = 'p'.repeat(4097);
      const res = await request(app)
        .post('/api/custody/fresh-auth')
        .set('X-Hive-Username', FRESH_USER)
        .set('X-Hive-Signature', 'mock')
        .set('Authorization', bearerForLight(FRESH_USER))
        .send({ password: oversized, action: 'author_accept', root_author: 'alice', root_permlink: 'paper' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/[Pp]assword/);

      const count = await rateLimitCount('custody-fresh-auth', FRESH_USER);
      expect(count).toBeNull();
    });

    it('/session-auth: oversized password (length=4097) returns 400 WITHOUT touching the limiter', async () => {
      const oversized = 'p'.repeat(4097);
      const res = await request(app)
        .post('/api/custody/session-auth')
        .set('X-Hive-Username', SESSION_USER)
        .set('X-Hive-Signature', 'mock')
        .set('Authorization', bearerForLight(SESSION_USER))
        .send({ password: oversized });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/[Pp]assword/);

      const count = await rateLimitCount('custody-session-auth', SESSION_USER);
      expect(count).toBeNull();
    });

    // ─── Missing-auth-header gate fires BEFORE body validation ─────────

    it('/upgrade: missing X-Hive-Username header returns 401 (auth gate runs before body validation)', async () => {
      // Auth runs first by design — the limiter's byAccount keying needs
      // a verified username before the limiter can fire. The 401 is the
      // expected envelope on the no-username path; the body-validation
      // middleware never runs (and the limiter never runs). This pins
      // the auth-before-body-validation ordering for the layered
      // pattern.
      const res = await request(app)
        .post('/api/custody/upgrade')
        .send({ derived_pubkey: 'STMxxx', signed_proof: 'sig', signed_at: 'ts' });

      expect(res.status).toBe(401);
      const count = await rateLimitCount('custody-upgrade', UPGRADE_USER);
      expect(count).toBeNull();
    });
  },
);

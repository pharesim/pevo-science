/**
 * URL-param shape validation on POST /api/papers/:author/:permlink/retract.
 *
 * The retractLimiter opts into `RateLimitConfig.skipFailedRequests: true`
 * (slot refunded on any >= 400 response). Without a pre-limiter URL-shape
 * validator, a JWT holder spraying structurally-invalid slugs (`alice123!`,
 * 500-char permlinks, etc.) would pay the full HAF walker cost per probe
 * (`fetchPaperDetailFromHaf` runs `resolveContinuationChain`, bounded by
 * `hafWalkerWallClockMs`), the 404 "paper not found" path would refund the
 * limiter slot, and per-account RPS at the limiter's nominal cap would
 * sustain HAF query amplification with no rate bound.
 *
 * `validateRetractParams` runs BEFORE `retractLimiter` AND before
 * `verifyHiveSignature` and rejects malformed URL params with 400
 * VALIDATION_ERROR upstream of any HAF roundtrip. This test pins the
 * layered-pattern contract: malformed-slug probes must NOT consume any of the
 * limiter's per-account capacity, mirroring the body-shape contract pinned for
 * the custody routes. It also pins the 400-before-401 ordering directly — a
 * malformed slug sent with NO auth headers returns 400 (validator first), not
 * 401 (auth first) — so a future re-reorder of the chain is caught.
 *
 * Carve-out (root CLAUDE.md "Running Tests"):
 *   (a) Why a mocked target: the focus is middleware ordering on a single
 *       route. The `MOCK_VERIFY_SIGNATURE` fixture is used so each test can
 *       issue malformed-slug probes with a controlled username without
 *       producing a real Hive signature per probe. The downstream behaviour
 *       under test — limiter slot accounting in Redis — runs real-path
 *       against the dev Redis container.
 *   (b) `verifyHiveSignature` is BYPASSED by the fixture. This is permitted
 *       because the focus of this file is URL-param shape gating
 *       upstream of the limiter, NOT cryptographic verification. The 401-on-
 *       missing-header gate the fixture preserves is sufficient. Real-path
 *       companion: `papers-retract-real-path-verifyhivesignature.test.ts`
 *       exercises the real `verifyHiveSignature` middleware against signed
 *       requests to this same route, covering the positive accept branch
 *       (handler reached) and the rejection paths (missing header, missing
 *       timestamp, malformed signature, mismatched chain key, body-tamper,
 *       expired timestamp, cross-account spoof).
 *   (c) Real-path companion: the existing custody-limiter CPU-amplification
 *       test suite covers the equivalent body-shape pattern on the three
 *       custody routes against the same real Redis backend; both suites
 *       share the `rateLimitCount` invariant ("limiter Redis key absent
 *       proves the limiter was never invoked").
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
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const PROBE_USER = `pret${SUFFIX}user`;

/** Mirror of the helper in custody-limiter-cpu-amplification.test.ts. Throws
 *  on Redis-unavailable so the load-bearing `toBeNull()` assertion cannot
 *  vacuously pass on a mid-suite Redis flake. */
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
  'URL-shape validation before retractLimiter (CPU amplification mitigation)',
  () => {
    beforeAll(async () => {
      // No DB seeding required: every probe is rejected at the URL-shape
      // validator before any HAF query fires.
    });

    beforeEach(async () => {
      await clearRateLimitKeys(['paper-retract']);
    });

    afterAll(async () => {
      await clearRateLimitKeys(['paper-retract']);
    });

    it('/retract: uppercase author returns 400 WITHOUT touching the limiter', async () => {
      const res = await request(app)
        .post('/api/papers/Alice/some-paper/retract')
        .set('X-Hive-Username', PROBE_USER)
        .set('X-Hive-Signature', 'mock')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/author/);

      const count = await rateLimitCount('paper-retract', PROBE_USER);
      expect(count).toBeNull();
    });

    it('/retract: author with disallowed punctuation returns 400 WITHOUT touching the limiter', async () => {
      const res = await request(app)
        .post('/api/papers/alice_x/some-paper/retract')
        .set('X-Hive-Username', PROBE_USER)
        .set('X-Hive-Signature', 'mock')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');

      const count = await rateLimitCount('paper-retract', PROBE_USER);
      expect(count).toBeNull();
    });

    it('/retract: malformed slug with NO auth headers returns 400 VALIDATION_ERROR, not 401 — validator runs BEFORE verifyHiveSignature', async () => {
      // Pins the 400-before-401 ordering that is the security rationale for
      // mounting validateRetractParams ahead of verifyHiveSignature on this
      // URL-keyed route. With no X-Hive-Username / X-Hive-Signature headers,
      // the auth gate (the MOCK_VERIFY_SIGNATURE missing-header arm preserves
      // the real middleware's 401) WOULD fire first if the chain were ordered
      // auth-then-validator. A 400 here proves the structural-slug rejection
      // short-circuits upstream of auth; a regression re-reordering the chain
      // (verifyHiveSignature first) would surface as 401 and fail this
      // assertion. No DB/HAF/Redis is reached on the rejection path.
      const res = await request(app)
        .post('/api/papers/Alice/some-paper/retract')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/author/);

      const count = await rateLimitCount('paper-retract', PROBE_USER);
      expect(count).toBeNull();
    });

    it('/retract: oversized permlink (length=257) returns 400 WITHOUT touching the limiter', async () => {
      const oversized = 'a'.repeat(257);
      const res = await request(app)
        .post(`/api/papers/alice/${oversized}/retract`)
        .set('X-Hive-Username', PROBE_USER)
        .set('X-Hive-Signature', 'mock')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/permlink/);

      const count = await rateLimitCount('paper-retract', PROBE_USER);
      expect(count).toBeNull();
    });

    it('/retract: permlink with uppercase character returns 400 WITHOUT touching the limiter', async () => {
      const res = await request(app)
        .post('/api/papers/alice/Some-Paper/retract')
        .set('X-Hive-Username', PROBE_USER)
        .set('X-Hive-Signature', 'mock')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/permlink/);

      const count = await rateLimitCount('paper-retract', PROBE_USER);
      expect(count).toBeNull();
    });

    it('/retract: 100 sequential malformed-slug probes do NOT consume any of the 5/hr limiter capacity', async () => {
      // Mirrors the 100-sequential-malformed-bodies CPU-amplification pin
      // on the custody routes. A stolen-JWT attacker spraying invalid
      // slugs at the limiter's nominal cap must not amplify HAF query
      // load: the URL-shape gate fires first, and the limiter primitive
      // sees zero traffic.
      for (let i = 0; i < 100; i++) {
        const res = await request(app)
          .post(`/api/papers/Bad_Author_${i}/Permlink-${i}/retract`)
          .set('X-Hive-Username', PROBE_USER)
          .set('X-Hive-Signature', 'mock')
          .send({});
        expect(res.status).toBe(400);
      }
      const count = await rateLimitCount('paper-retract', PROBE_USER);
      expect(count).toBeNull();
    });
  },
);

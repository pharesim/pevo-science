// BE-ARGON2-JSLEVEL-CONCURRENCY-CAP concurrent-load test.
//
// Asserts that a burst of concurrent /login unknown-username requests ALL
// complete at or above TIMING_ORACLE_FLOOR_MS, proving the JS-level
// semaphore at lib/argon2-semaphore.ts queues extras deterministically
// instead of letting libuv-pool saturation throw them through the silent
// catch (which reopens the timing oracle).
//
// Without the semaphore, a 20-way Promise.all burst on a 4-slot libuv pool
// would saturate at request ~5: some argon2.verify calls throw, burnSentinel
// swallows via .catch, responses return in ~0ms. The semaphore makes this
// behavior deterministic: the first 4 requests run immediately, the other
// 16 wait in-process, every single response pays the full argon2.verify
// cost and asserts ≥ floor.
//
// /api/health exposes argon2_queue_depth + argon2_in_flight so operators
// see saturation events synchronously. This test also asserts both fields
// are present and typed in the response.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';

const app = createApp();

const TIMING_ORACLE_FLOOR_MS = 35;

let dbReachable = false;
{
  const pool = getAppPool();
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbReachable = true;
    } catch {
      dbReachable = false;
    }
  }
}

describe('BE-ARGON2-JSLEVEL-CONCURRENCY-CAP: concurrent /login unknown-username burst', () => {
  beforeAll(async () => {
    await clearRateLimitKeys(['auth-login', 'read']);
  });

  // T3 (hold block): prevent this test's 8 login attempts from bleeding into
  // unrelated tests via the 10/hr per-IP auth-login limiter. Also clear the
  // shared `read` limiter since /api/health is now rate-limited and shares
  // its keyspace with other read endpoints.
  afterAll(async () => {
    await clearRateLimitKeys(['auth-login', 'read']);
  });

  // loginLimiter is 10/hr per-IP. Use 8 concurrent requests (≤ limit) so
  // none are rate-limited, but above MAX_CONCURRENT_ARGON2_OPS=4 so the
  // semaphore queue actually fills. (If the semaphore were removed, the
  // libuv pool would queue at the thread level, and under OOM pressure
  // some would throw — this assertion would fail.)
  const CONCURRENCY = 8;

  it.skipIf(!dbReachable)(
    `all ${CONCURRENCY} concurrent unknown-user logins return ≥ TIMING_ORACLE_FLOOR_MS`,
    async () => {
      const baseUsername = `jslevel_conc_${Date.now()}`;
      const start = Date.now();
      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          request(app)
            .post('/api/auth/login')
            .send({ username: `${baseUsername}_${i}`, password: 'AnyPassword1' })
            .then((r) => ({ status: r.status, elapsed: Date.now() - start }))
        ),
      );

      // All responses must be 401 UNAUTHORIZED (unknown-user path).
      for (const r of results) {
        expect(r.status).toBe(401);
      }

      // Critical: each response (measured against the shared `start` baseline)
      // paid at least the argon2.verify cost. The first ~4 complete in ~50ms
      // (the semaphore's capacity); the rest queue in-JS and complete
      // progressively later, but NONE return faster than the argon2 floor.
      //
      // If the semaphore were absent and the libuv pool saturated, some
      // burnSentinel calls would throw → silent catch → return in ~0ms from
      // their `start` slot. That would fail this assertion and reopen the
      // oracle in production.
      for (const r of results) {
        expect(r.elapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
      }
    },
    30_000,
  );

  it('/api/health exposes argon2 saturation fields (idle) and does NOT leak the static cap', async () => {
    // Clear the read limiter first — previous tests in this file may have
    // polled /api/health and consumed the 120/min window.
    await clearRateLimitKeys(['read']);
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(typeof res.body.argon2_queue_depth).toBe('number');
    expect(typeof res.body.argon2_in_flight).toBe('number');
    // T4 (hold block): the static cap is no longer exposed — it narrows the
    // search space for queue-DoS reconnaissance without giving operators any
    // live-load signal. The in-flight and queue-depth counters remain.
    expect(res.body).not.toHaveProperty('argon2_max_concurrent');
    // Idle-state assertions: with no auth burst in flight, both counters
    // must read 0. This doubles as a leak detector — if a prior test left
    // slots unreleased, the value would stay >0.
    expect(res.body.argon2_queue_depth).toBe(0);
    expect(res.body.argon2_in_flight).toBe(0);
  });
});

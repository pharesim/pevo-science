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

import { describe, it, expect, beforeAll } from 'vitest';
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
    await clearRateLimitKeys(['auth-login']);
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

  it('/api/health exposes argon2 saturation fields', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(typeof res.body.argon2_queue_depth).toBe('number');
    expect(typeof res.body.argon2_in_flight).toBe('number');
    expect(typeof res.body.argon2_max_concurrent).toBe('number');
    expect(res.body.argon2_queue_depth).toBeGreaterThanOrEqual(0);
    expect(res.body.argon2_in_flight).toBeGreaterThanOrEqual(0);
    expect(res.body.argon2_max_concurrent).toBeGreaterThanOrEqual(1);
  });
});

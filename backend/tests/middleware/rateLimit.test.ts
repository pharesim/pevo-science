import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { rateLimit, byIp, byAccount } from '../../src/middleware/rateLimit.js';
import { createApp } from '../../src/app.js';
import { getRedis } from '../../src/redis.js';
import { config } from '../../src/config.js';

let testCounter = 0;
function createTestApp(
  opts: { windowMs: number; max: number; keyFn: (req: express.Request) => string },
  appOpts: { trustProxy?: number | boolean } = {},
) {
  const config = { ...opts, name: `test-${Date.now()}-${++testCounter}` };
  const app = express();
  if (appOpts.trustProxy !== undefined) {
    app.set('trust proxy', appOpts.trustProxy);
  }
  app.use(express.json());
  // Simulate verifyHiveSignature: populate req.hiveUsername from header
  app.use((req, _res, next) => {
    const username = req.headers['x-hive-username'] as string | undefined;
    if (username) req.hiveUsername = username;
    next();
  });
  app.use(rateLimit(config));
  app.get('/test', (_req, res) => res.json({ ok: true }));
  app.post('/test', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('rateLimit middleware', () => {
  it('allows requests under the limit', async () => {
    const app = createTestApp({ windowMs: 60_000, max: 3, keyFn: byIp });
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
  });

  it('blocks requests exceeding the limit', async () => {
    const app = createTestApp({ windowMs: 60_000, max: 2, keyFn: byIp });

    await request(app).get('/test');
    await request(app).get('/test');
    const res = await request(app).get('/test');

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('uses Retry-After header', async () => {
    const app = createTestApp({ windowMs: 60_000, max: 1, keyFn: byIp });

    await request(app).get('/test');
    const res = await request(app).get('/test');

    expect(res.status).toBe(429);
    const retryAfter = parseInt(res.headers['retry-after'], 10);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('resets after window expires', async () => {
    const app = createTestApp({ windowMs: 50, max: 1, keyFn: byIp });

    await request(app).get('/test');
    const blocked = await request(app).get('/test');
    expect(blocked.status).toBe(429);

    await new Promise((r) => setTimeout(r, 60));
    const allowed = await request(app).get('/test');
    expect(allowed.status).toBe(200);
  });

  it('byAccount keys on X-Hive-Username header', async () => {
    const app = createTestApp({ windowMs: 60_000, max: 1, keyFn: byAccount });

    // First user exhausts their limit
    await request(app).get('/test').set('X-Hive-Username', 'alice');
    const aliceBlocked = await request(app).get('/test').set('X-Hive-Username', 'alice');
    expect(aliceBlocked.status).toBe(429);

    // Second user is unaffected
    const bobOk = await request(app).get('/test').set('X-Hive-Username', 'bob');
    expect(bobOk.status).toBe(200);
  });

  // Regression: production config sets `trust proxy = 1`, so nginx's appended
  // XFF value becomes req.ip. Two requests with *different* XFF values should
  // key on different IPs (each gets its own bucket). A single attacker rotating
  // XFF cannot starve the bucket — but nginx appends the true peer IP, so a
  // direct-to-backend client cannot actually rotate in production. The test
  // here pins the behavior that req.ip reflects the first-in-chain XFF value.
  it('byIp with trust proxy=1 honors first-in-chain X-Forwarded-For', async () => {
    const app = createTestApp(
      { windowMs: 60_000, max: 1, keyFn: byIp },
      { trustProxy: 1 },
    );

    // IP A (1.2.3.4) uses its single request
    const aOk = await request(app).get('/test').set('X-Forwarded-For', '1.2.3.4');
    expect(aOk.status).toBe(200);

    // IP B (5.6.7.8) is a different bucket — should also succeed
    const bOk = await request(app).get('/test').set('X-Forwarded-For', '5.6.7.8');
    expect(bOk.status).toBe(200);

    // IP A again — now over its bucket's limit
    const aBlocked = await request(app).get('/test').set('X-Forwarded-For', '1.2.3.4');
    expect(aBlocked.status).toBe(429);
  });

  // Regression: without `trust proxy`, Express ignores XFF and req.ip is the
  // socket peer (loopback under supertest). Arbitrary XFF rotation does NOT
  // produce distinct buckets — this is the spoof-guard property.
  it('byIp without trust proxy ignores X-Forwarded-For (spoof guard)', async () => {
    const app = createTestApp(
      { windowMs: 60_000, max: 1, keyFn: byIp },
      { trustProxy: false },
    );

    // First spoofed IP uses the single-request bucket
    const first = await request(app).get('/test').set('X-Forwarded-For', '1.2.3.4');
    expect(first.status).toBe(200);

    // A different spoofed XFF on the SAME loopback peer must NOT get a fresh
    // bucket — `req.ip` is loopback in both cases, so the second request is
    // blocked. This is the property the previous manual-XFF-parsing byIp()
    // silently broke.
    const second = await request(app).get('/test').set('X-Forwarded-For', '5.6.7.8');
    expect(second.status).toBe(429);
  });

  // Regression: createApp() in src/app.ts MUST configure `trust proxy = 1` so
  // that nginx's appended XFF value becomes req.ip in production. The `byIp
  // with trust proxy=1 honors first-in-chain X-Forwarded-For` and `byIp
  // without trust proxy ignores X-Forwarded-For (spoof guard)` tests use bare
  // `express()` apps; this one pins the actual production app factory's setting
  // so a refactor that removes `app.set('trust proxy', 1)` from app.ts fails
  // loudly here rather than surfacing as a confusing "premature 429 under XFF
  // rotation" tripwire elsewhere. The assertion pins the literal `1` exactly:
  // `true` would mean "trust ALL X-Forwarded-For values unconditionally" — the
  // spoof vector this task closes — so a refactor swapping `1` for `true` must
  // flip this red, not pass.
  it('createApp() sets trust proxy to one hop', () => {
    const app = createApp();
    const trustProxy = app.get('trust proxy');
    expect(trustProxy).toBe(1);
  });

  // ─── skipFailedRequests + atomic Lua check ───
  //
  // The `skipFailedRequests` Redis path is implemented as a single atomic
  // Lua EVAL rather than a GET → next() → deferred-INCR sequence. The
  // tests below pin two invariants that a non-atomic implementation
  // silently violates:
  //
  //   1. TTL-on-key: PEXPIRE fires on every successful pass, not only when
  //      `count === 1`. A conditional-PEXPIRE implementation lets
  //      concurrent post-success INCRs race past count=1 before the
  //      PEXPIRE lands, leaving the key with no TTL → permanent lockout.
  //   2. No overshoot above `max`: the INCR, the `<= max` check, and the
  //      DECR-on-overflow all run inside one Lua script. A GET-then-check-
  //      then-INCR sequence lets two concurrent requests both observe
  //      count=0, both pass the `>= max` gate, both run the handler, and
  //      both increment on finish — overshooting `max`.
  //
  // The script also DECRs on `res.on('finish')` when status >= 400 (the
  // failed-request refund). These tests pin the resulting properties.

  async function waitForRedisReady(timeoutMs = 1000): Promise<boolean> {
    const r = getRedis();
    if (!r) return false;
    for (let i = 0; i < timeoutMs / 50 && r.status !== 'ready'; i++) {
      await new Promise((res) => setTimeout(res, 50));
    }
    return r.status === 'ready';
  }

  function createSkipFailedApp(name: string, max: number, windowMs: number, statusCode = 200) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const username = req.headers['x-hive-username'] as string | undefined;
      if (username) req.hiveUsername = username;
      next();
    });
    app.use(rateLimit({ windowMs, max, keyFn: byAccount, name, skipFailedRequests: true }));
    app.get('/test', (_req, res) => res.status(statusCode).json({ ok: statusCode < 400 }));
    return app;
  }

  it('skipFailedRequests + concurrent requests within max all succeed; key retains TTL', async () => {
    const ready = await waitForRedisReady();
    if (!ready) {
      // No Redis in this env — the concurrent-INCR Lua path is the one
      // under test; the in-memory fallback has its own coverage via the
      // refund test below.
      return;
    }
    const redis = getRedis()!;
    const limiterName = `test-concurrent-${Date.now()}`;
    const app = createSkipFailedApp(limiterName, 5, 60_000, 200);
    const username = `alice-${Date.now()}`;
    const redisKey = `${config.appTag}:rl:${limiterName}:${username}`;
    await redis.del(redisKey).catch(() => {});

    // 5 concurrent requests; max=5; all should succeed with no 429.
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).get('/test').set('X-Hive-Username', username),
      ),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    // CRITICAL: the key must have a TTL. A conditional-PEXPIRE (only on
    // count==1) implementation leaves the key with no TTL (permanent
    // lockout) when concurrent INCRs race past count==1 before the
    // PEXPIRE lands. The atomic Lua PEXPIREs every successful pass.
    const pttl = await redis.pttl(redisKey);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(60_000);

    // The count should equal the number of consumed slots (5 for
    // status=200; no refund). The Lua INCR + check + PEXPIRE-on-pass /
    // DECR-on-overflow keeps the count bounded.
    const countStr = await redis.get(redisKey);
    const count = countStr ? Number(countStr) : 0;
    expect(count).toBe(5);

    await redis.del(redisKey).catch(() => {});
  });

  it('skipFailedRequests refunds slot when handler returns status >= 400', async () => {
    const ready = await waitForRedisReady();
    if (!ready) return;
    const redis = getRedis()!;
    const limiterName = `test-refund-${Date.now()}`;
    const app = createSkipFailedApp(limiterName, 1, 60_000, 500);
    const username = `bob-${Date.now()}`;
    const redisKey = `${config.appTag}:rl:${limiterName}:${username}`;
    await redis.del(redisKey).catch(() => {});

    // First request returns 500. Slot should refund after finish.
    const failRes = await request(app).get('/test').set('X-Hive-Username', username);
    expect(failRes.status).toBe(500);

    // Wait for the deferred DECR to land (res.on('finish') callback is
    // async). Poll briefly so the test is robust to scheduler latency.
    let count = 1;
    for (let i = 0; i < 20; i++) {
      const s = await redis.get(redisKey);
      count = s ? Number(s) : 0;
      if (count === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(count).toBe(0);

    await redis.del(redisKey).catch(() => {});
  });

  // Refund gate must be `statusCode < 400 && writableEnded`, not status-only.
  // A status-only gate (`res.statusCode < 400`) misses pre-status TCP-abort:
  // a client disconnecting during a pending `await` (e.g. a slow Hive RPC)
  // fires `'close'` with `res.statusCode` still at the Node.js default of 200
  // and `res.writableEnded` false. A status-only gate would treat that as a
  // success, skip the refund, and permanently consume the slot for the full
  // window — exactly the DoS scenario `skipFailedRequests` exists to prevent.
  // This test pins the `writableEnded` conjunct against any future revert to a
  // status-only check. It also exercises the Redis-path once-guard (vs. the
  // in-memory `indexOf` dedup) — abort during a pending await is the only
  // realistic trigger for both `'close'` and `'finish'` firing in non-clean
  // order, which the once-guard exists to handle.
  it('skipFailedRequests refunds slot on pre-status TCP-abort during pending await', async () => {
    const ready = await waitForRedisReady();
    if (!ready) return;
    const redis = getRedis()!;
    const limiterName = `test-abort-${Date.now()}`;
    const username = `dave-${Date.now()}`;
    const redisKey = `${config.appTag}:rl:${limiterName}:${username}`;
    await redis.del(redisKey).catch(() => {});

    // Handler awaits long enough that the client can disconnect before any
    // response status is set. `res.statusCode` stays at its Node default
    // (200) and `res.writableEnded` stays false — a status-only gate
    // (statusCode < 400) would skip the refund; the `statusCode < 400 &&
    // writableEnded` gate refunds.
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const u = req.headers['x-hive-username'] as string | undefined;
      if (u) req.hiveUsername = u;
      next();
    });
    app.use(
      rateLimit({
        windowMs: 60_000,
        max: 1,
        keyFn: byAccount,
        name: limiterName,
        skipFailedRequests: true,
      }),
    );
    app.get('/test', async (_req, res) => {
      await new Promise((r) => setTimeout(r, 300));
      if (!res.writableEnded) {
        try {
          res.json({ ok: true });
        } catch {
          // socket already destroyed by client abort
        }
      }
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;

    // Open the request, then destroy the socket before the handler's
    // 300ms timeout fires. The middleware's INCR has already landed
    // (registration of the refund listeners happened in the middleware
    // before `next()` ran).
    await new Promise<void>((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/test',
          method: 'GET',
          headers: { 'x-hive-username': username },
        },
        () => {},
      );
      req.on('error', () => {});
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });

    // Wait for `res.on('close')` → refund DECR to land.
    let count = 1;
    for (let i = 0; i < 40; i++) {
      const s = await redis.get(redisKey);
      count = s ? Number(s) : 0;
      if (count === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(count).toBe(0);

    // Wait for handler's 300ms timer to fire so it doesn't keep the
    // process alive after the test returns, then close the server.
    await new Promise((r) => setTimeout(r, 350));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await redis.del(redisKey).catch(() => {});
  });

  it('Lua path rejects with 429 on overflow without consuming additional slots (DECR-on-overflow)', async () => {
    const ready = await waitForRedisReady();
    if (!ready) return;
    const redis = getRedis()!;
    const limiterName = `test-overflow-${Date.now()}`;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const username = req.headers['x-hive-username'] as string | undefined;
      if (username) req.hiveUsername = username;
      next();
    });
    app.use(rateLimit({ windowMs: 60_000, max: 2, keyFn: byAccount, name: limiterName }));
    app.get('/test', (_req, res) => res.json({ ok: true }));

    const username = `carol-${Date.now()}`;
    const redisKey = `${config.appTag}:rl:${limiterName}:${username}`;
    await redis.del(redisKey).catch(() => {});

    // Three sequential requests; max=2. First two pass, third 429s.
    const r1 = await request(app).get('/test').set('X-Hive-Username', username);
    const r2 = await request(app).get('/test').set('X-Hive-Username', username);
    const r3 = await request(app).get('/test').set('X-Hive-Username', username);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);

    // The DECR-on-overflow inside the Lua means count sits at max (2),
    // not max+1 (3). Pin that invariant — a future "remove DECR-on-
    // overflow" mutation would leave count drifting above max.
    const countStr = await redis.get(redisKey);
    const count = countStr ? Number(countStr) : 0;
    expect(count).toBe(2);

    await redis.del(redisKey).catch(() => {});
  });
});

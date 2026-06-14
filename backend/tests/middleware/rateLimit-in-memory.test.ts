/**
 * In-memory fallback coverage for `rateLimit` middleware.
 *
 * The main rateLimit test suite at `rateLimit.test.ts` exercises the Redis
 * path (atomic Lua INCR-and-DECR-on-overflow, PEXPIRE invariant, deferred
 * refund) and skips when Redis is unavailable. The in-memory fallback path
 * has its own failure modes that don't surface under Redis coverage:
 *
 *   - The `skipFailedRequests` splice path (`indexOf` + `splice` on
 *     `entry.timestamps`) silently no-ops if the timestamp is missing from
 *     the entry — e.g. if the periodic cleanup interval evicted it between
 *     push and finish. A regression that breaks the splice would leak the
 *     slot indefinitely (until the natural window expires).
 *
 * This file forces in-memory mode by mocking `getRedis()` to always return
 * `null`. That makes the in-memory branch of the middleware the ONLY code
 * path under test, regardless of whether Redis is actually running.
 *
 * Carve-out clause (a): the real-path Redis branch is tested in
 * `rateLimit.test.ts` (skipped when Redis is absent); this file is the
 * deterministic in-memory companion. Clause (c) is satisfied by the
 * sibling Redis test exercising the same conceptual contract under real
 * infrastructure.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
}));

const { rateLimit, byAccount } = await import('../../src/middleware/rateLimit.js');

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

describe('rateLimit middleware — in-memory fallback', () => {
  it('skipFailedRequests refunds slot on status >= 400 (in-memory splice path)', async () => {
    const limiterName = `inmem-refund-${Date.now()}`;
    // max=1: a single failed request would normally consume the only slot
    // and lock the user out for the full window. With the refund, the
    // user can retry immediately.
    const app = createSkipFailedApp(limiterName, 1, 60_000, 500);
    const username = `alice-${Date.now()}`;

    const failRes = await request(app).get('/test').set('X-Hive-Username', username);
    expect(failRes.status).toBe(500);

    // Without the refund, this second request would 429 (slot consumed by
    // the first request). With the in-memory splice on 'finish' /
    // 'close', the slot is returned and the second request passes the
    // length check. We use a sibling app with a 200-status handler so the
    // assertion is purely "the limiter let the request through" (not
    // "the second handler succeeded").
    const passApp = createSkipFailedApp(limiterName, 1, 60_000, 200);
    // Need to give the deferred refund a tick to land — it runs in the
    // 'finish'/'close' callback queued after the response is sent.
    for (let i = 0; i < 20; i++) {
      const probe = await request(passApp).get('/test').set('X-Hive-Username', username);
      if (probe.status === 200) {
        expect(probe.status).toBe(200);
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    // If we got here the refund never landed — fail explicitly.
    expect.fail('In-memory skipFailedRequests refund did not land within 500ms');
  });

  it('skipFailedRequests does NOT refund slot on status < 400', async () => {
    const limiterName = `inmem-no-refund-${Date.now()}`;
    const app = createSkipFailedApp(limiterName, 1, 60_000, 200);
    const username = `bob-${Date.now()}`;

    // First request: status=200, slot consumed, NO refund.
    const okRes = await request(app).get('/test').set('X-Hive-Username', username);
    expect(okRes.status).toBe(200);

    // Second request must 429 — the slot from the successful first
    // request must not be refunded. Pin that the once-guard isn't
    // accidentally refunding success.
    await new Promise((r) => setTimeout(r, 50));
    const blocked = await request(app).get('/test').set('X-Hive-Username', username);
    expect(blocked.status).toBe(429);
  });

  // Companion to the Redis-path pre-status-abort refund test in
  // `rateLimit.test.ts` ('skipFailedRequests refunds slot on pre-status
  // TCP-abort during pending await') — that test pins the `writableEnded`
  // half of the refund gate on the Redis branch. The in-memory refund
  // closure in `rateLimit.ts` carries an identical gate
  // (`statusCode < 400 && writableEnded`); without this mirror a
  // one-sided revert to `statusCode < 400`-only on the in-memory branch
  // would slip past CI because the Redis-path test skips when Redis is
  // absent and the existing in-memory tests use synchronous supertest
  // handlers where `writableEnded` is always true at the time the refund
  // fires. This test runs against the in-memory path (Redis mocked to
  // null at module scope) with a real http.createServer + raw
  // http.request + req.destroy so the pre-status-abort sequence actually
  // fires `'close'` with statusCode at the Node default of 200 and
  // writableEnded false.
  it('skipFailedRequests refunds slot on pre-status TCP-abort during pending await', async () => {
    const limiterName = `inmem-abort-${Date.now()}`;
    const username = `eve-${Date.now()}`;

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
    // Slow route: aborted client-side mid-await. `res.statusCode` stays
    // at the Node default (200) and `res.writableEnded` stays false —
    // a `statusCode < 400` gate alone would skip the refund; the
    // `statusCode < 400 && writableEnded` gate refunds.
    app.get('/slow', async (_req, res) => {
      await new Promise((r) => setTimeout(r, 300));
      if (!res.writableEnded) {
        try {
          res.json({ ok: true });
        } catch {
          // socket already destroyed by client abort
        }
      }
    });
    // Fast route: returns immediately. Used as the limiter follow-up
    // probe to assert the slot was refunded after the abort. Shares the
    // same in-memory `memStore` (one `rateLimit()` instance for the app)
    // so a non-refunded slot would 429 this request.
    app.get('/fast', (_req, res) => res.json({ ok: true }));

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;

    // Open the request, then destroy the socket before the handler's
    // 300ms timeout fires. The middleware's timestamp push has already
    // landed (registration of the refund listeners happened in the
    // middleware before `next()` ran).
    await new Promise<void>((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/slow',
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

    // Poll the follow-up `/fast` request until the limiter admits it.
    // Without the writableEnded half of the gate, the slot would stay
    // consumed and every probe would 429 for the full windowMs.
    let admitted = false;
    for (let i = 0; i < 40; i++) {
      const probe = await request(app).get('/fast').set('X-Hive-Username', username);
      if (probe.status === 200) {
        admitted = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    // Drain handler's 300ms timer + close the server before asserting
    // so a failed assertion doesn't leak the timer / leave the listener
    // bound past test return.
    await new Promise((r) => setTimeout(r, 350));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(admitted).toBe(true);
  });

  // refundStatusCodes is the surgical counterpart to skipFailedRequests: it
  // refunds ONLY the listed code (the per-token activation limiter lists [409]
  // LOCK_HELD) and leaves every other outcome — success AND other 4xx like a
  // 400 invalid-token attempt — to consume a slot normally. This pins the
  // `shouldRefund` mutation "treat 400 (or all >= 400) as refundable", which no
  // skipFailedRequests test catches (skipFailedRequests refunds ALL >= 400, so
  // it cannot distinguish 409-only from blanket-4xx refund). Runs against the
  // in-memory path (Redis mocked null at module scope); the Redis-path sibling
  // in `rateLimit.test.ts` exercises the same shared `shouldRefund` gate under
  // real infrastructure (carve-out clause (c)).
  function createRefundCodesApp(name: string, max: number) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const u = req.headers['x-hive-username'] as string | undefined;
      if (u) req.hiveUsername = u;
      next();
    });
    app.use(rateLimit({ windowMs: 60_000, max, keyFn: byAccount, name, refundStatusCodes: [409] }));
    // Per-request status via ?code= so one app exercises both the refunded
    // (409) and the slot-consuming (400) outcomes against the same bucket.
    app.get('/test', (req, res) => {
      const code = Number(req.query.code) || 200;
      res.status(code).json({ ok: code < 400 });
    });
    return app;
  }

  it('refundStatusCodes refunds 409 (contention loser re-admitted) but 400 consumes its slot', async () => {
    const limiterName = `inmem-refund-codes-${Date.now()}`;
    const app = createRefundCodesApp(limiterName, 1);
    const username = `frank-${Date.now()}`;

    // A 409 LOCK_HELD refunds its slot, so a same-token auto-retry loop is not
    // charged for the holder's slowness. With max=1, three sequential 409s each
    // reach the handler (each refunds before the next is admitted) — never a
    // premature 429. Poll-tolerant: the splice refund lands in the deferred
    // finish/close callback, so a probe may briefly 429 before the prior
    // refund lands (a 429 reject consumes no slot, so polling is non-destructive).
    for (let attempt = 0; attempt < 3; attempt++) {
      let got = 429;
      for (let i = 0; i < 20; i++) {
        const res = await request(app).get('/test?code=409').set('X-Hive-Username', username);
        got = res.status;
        if (got === 409) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(got).toBe(409);
    }

    // A 400 is NOT in the refund set: it consumes the single slot. Poll until
    // it actually reaches the handler (the last 409's refund may still be
    // landing), so the assertion proves the 400 ran and consumed, not that it
    // was rejected.
    let four00 = 429;
    for (let i = 0; i < 20; i++) {
      const res = await request(app).get('/test?code=400').set('X-Hive-Username', username);
      four00 = res.status;
      if (four00 === 400) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(four00).toBe(400);

    // The slot the 400 consumed is NOT refunded — a follow-up request 429s.
    // If `shouldRefund` mutated to treat 400 as refundable, the slot would be
    // free and this would be 200. The 429 pins 400-consumes-slot (brute-force
    // protection intact). Settle time first so an (erroneous) refund could land.
    await new Promise((r) => setTimeout(r, 50));
    const blocked = await request(app).get('/test?code=200').set('X-Hive-Username', username);
    expect(blocked.status).toBe(429);
  });

  it('refunds once on finish+close (no double-splice via once-guard)', async () => {
    // Wire the request to both 'finish' AND 'close' (the supertest /
    // express normal-completion path fires both). The once-guard must
    // prevent the splice from running twice — otherwise a malformed
    // timestamps array could be left after the second splice no-ops on
    // -1 indexOf, or worse, splice an unrelated entry if a parallel
    // request pushed a colliding timestamp.
    const limiterName = `inmem-once-guard-${Date.now()}`;
    const app = createSkipFailedApp(limiterName, 2, 60_000, 500);
    const username = `carol-${Date.now()}`;

    // Two sequential failed requests; max=2; both should refund.
    const r1 = await request(app).get('/test').set('X-Hive-Username', username);
    const r2 = await request(app).get('/test').set('X-Hive-Username', username);
    expect(r1.status).toBe(500);
    expect(r2.status).toBe(500);

    // Both slots should be back. A third 500-failing request should
    // also be admitted (slot refund landed before this poll). If the
    // double-fire (finish + close) double-decremented, the entry would
    // be in an inconsistent state — earlier failure modes would manifest
    // as either a 429 here (slot wrongly consumed twice) or a TypeError
    // inside the splice path.
    let admitted = false;
    for (let i = 0; i < 20; i++) {
      const r3 = await request(app).get('/test').set('X-Hive-Username', username);
      if (r3.status === 500) {
        admitted = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(admitted).toBe(true);
  });
});

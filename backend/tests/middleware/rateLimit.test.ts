import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { rateLimit, byIp, byAccount } from '../../src/middleware/rateLimit.js';

function createTestApp(config: { windowMs: number; max: number; keyFn: (req: express.Request) => string }) {
  const app = express();
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
});

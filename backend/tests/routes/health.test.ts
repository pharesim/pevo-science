import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';

const app = createApp();

describe('GET /api/health', () => {
  // /api/health is rate-limited via the shared `readLimiter` (120/min/IP).
  // When this file runs in the same Vitest worker after auth-concurrency.test.ts
  // (which polls /api/health and may share the read keyspace with other read
  // endpoints), the budget can already be drained on the first GET here.
  // Clearing before/after isolates this file from sibling-test budget bleed.
  beforeAll(async () => {
    await clearRateLimitKeys(['read']);
  });
  afterAll(async () => {
    await clearRateLimitKeys(['read']);
  });

  it('returns status ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('haf_available');
    expect(res.body).toHaveProperty('timestamp');
  });

  it('reports haf_available as true (connected to real HAF)', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.haf_available).toBe(true);
  });

  it('does not expose argon2 semaphore counters (recon channel removed)', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body).not.toHaveProperty('argon2_queue_depth');
    expect(res.body).not.toHaveProperty('argon2_in_flight');
    expect(res.body).not.toHaveProperty('argon2_max_concurrent');
  });
});

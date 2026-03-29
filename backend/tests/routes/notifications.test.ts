import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

const app = createApp();

describe('GET /api/notifications', () => {
  it('returns 401 without auth headers', async () => {
    const res = await request(app).get('/api/notifications?since_block=100');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 400 without since_block', async () => {
    const res = await request(app)
      .get('/api/notifications')
      .set('X-Hive-Username', 'pevo.admin')
      .set('X-Hive-Signature', 'mock-sig');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain('since_block');
  });

  it('returns 400 with invalid since_block', async () => {
    const res = await request(app)
      .get('/api/notifications?since_block=abc')
      .set('X-Hive-Username', 'pevo.admin')
      .set('X-Hive-Signature', 'mock-sig');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns notifications with correct envelope', async () => {
    const res = await request(app)
      .get('/api/notifications?since_block=1')
      .set('X-Hive-Username', 'pevo.admin')
      .set('X-Hive-Signature', 'mock-sig');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data).toHaveProperty('events');
    expect(res.body.data).toHaveProperty('latest_block');
    expect(res.body.data).toHaveProperty('has_more');
    expect(Array.isArray(res.body.data.events)).toBe(true);
  });

  it('respects limit parameter', async () => {
    const res = await request(app)
      .get('/api/notifications?since_block=1&limit=1')
      .set('X-Hive-Username', 'pevo.admin')
      .set('X-Hive-Signature', 'mock-sig');
    expect(res.status).toBe(200);
    expect(res.body.data.events.length).toBeLessThanOrEqual(1);
  });

  it('events are sorted by block_num ascending', async () => {
    const res = await request(app)
      .get('/api/notifications?since_block=1')
      .set('X-Hive-Username', 'pevo.admin')
      .set('X-Hive-Signature', 'mock-sig');
    const events = res.body.data.events;
    for (let i = 1; i < events.length; i++) {
      expect(events[i].block_num).toBeGreaterThanOrEqual(events[i - 1].block_num);
    }
  });
});

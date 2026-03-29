import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const app = createApp();

describe('GET /api/health', () => {
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
});

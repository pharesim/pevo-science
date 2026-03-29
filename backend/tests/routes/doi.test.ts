import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const app = createApp();

describe('GET /api/papers/:author/:permlink/doi', () => {
  it('returns unregistered status when no DOI exists', async () => {
    const listRes = await request(app).get('/api/papers?limit=1');
    if (listRes.body.data.length === 0) return;

    const { author, permlink } = listRes.body.data[0];
    const res = await request(app).get(`/api/papers/${author}/${permlink}/doi`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data).toHaveProperty('status');
    expect(res.body.data).toHaveProperty('doi');
  });

  it('returns unregistered for assign=false on any permlink', async () => {
    const res = await request(app).get('/api/papers/nobody/no-paper/doi?assign=false');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('unregistered');
  });
});

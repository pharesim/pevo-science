import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const app = createApp();

describe('GET /api/bridge/lookup', () => {
  it('returns 400 when identifier is missing', async () => {
    const res = await request(app).get('/api/bridge/lookup');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain('identifier');
  });

  it('returns 400 for empty identifier', async () => {
    const res = await request(app).get('/api/bridge/lookup?identifier=');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});

describe('GET /api/bridge/check', () => {
  it('returns 400 when identifier is missing', async () => {
    const res = await request(app).get('/api/bridge/check');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for unparseable identifier', async () => {
    const res = await request(app).get('/api/bridge/check?identifier=not-a-valid-id');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns exists status for valid arXiv ID', async () => {
    const res = await request(app).get('/api/bridge/check?identifier=2301.12345');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('exists');
    expect(typeof res.body.data.exists).toBe('boolean');
  });
});

describe('POST /api/bridge/register', () => {
  it('requires authentication headers', async () => {
    const res = await request(app)
      .post('/api/bridge/register')
      .send({ identifier: '2301.12345', discipline: 'CS' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('POST /api/bridge/update', () => {
  it('requires authentication headers', async () => {
    const res = await request(app)
      .post('/api/bridge/update')
      .send({ permlink: 'bridge-arxiv-2301-12345' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

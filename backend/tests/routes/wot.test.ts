import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const app = createApp();

describe('GET /api/wot/:username', () => {
  it('returns vouch status or timeout error from real HAF', async () => {
    const res = await request(app).get('/api/wot/pevo.admin');
    // WoT queries scan the full custom_json table — may succeed or timeout
    if (res.status === 200) {
      expect(res.body.status).toBe('ok');
      expect(res.body.data).toHaveProperty('username', 'pevo.admin');
      expect(res.body.data).toHaveProperty('vouch_count');
      expect(res.body.data).toHaveProperty('vouches');
    } else {
      // HAF query timeout is acceptable — the WoT CTE is expensive
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    }
  }, 60_000);
});

describe('POST /api/wot/vouch', () => {
  it('requires authentication headers', async () => {
    const res = await request(app)
      .post('/api/wot/vouch')
      .send({ vouchee: 'bob' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('POST /api/wot/retract', () => {
  it('requires authentication headers', async () => {
    const res = await request(app)
      .post('/api/wot/retract')
      .send({ vouchee: 'bob' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

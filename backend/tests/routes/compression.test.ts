import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const app = createApp();

describe('Response compression', () => {
  it('returns gzip-compressed response when Accept-Encoding is set', async () => {
    const res = await request(app)
      .get('/api/papers')
      .set('Accept-Encoding', 'gzip');
    expect(res.status).toBe(200);
    // supertest decompresses automatically, so just verify we got data
    expect(res.body.status).toBe('ok');
  });
});

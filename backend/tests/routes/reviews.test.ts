import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const app = createApp();

describe('GET /api/reviews/:author/:permlink', () => {
  it('returns 404 for nonexistent review', async () => {
    const res = await request(app).get('/api/reviews/nobody/nothing');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const app = createApp();

describe('GET /api/papers/:author/:permlink/comments', () => {
  it('returns 404 for nonexistent paper', async () => {
    const res = await request(app).get('/api/papers/nobody/no-paper/comments');
    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns comments with correct structure when paper exists', async () => {
    // Find a real paper first
    const listRes = await request(app).get('/api/papers?limit=1');
    if (listRes.body.data.length === 0) return;

    const { author, permlink } = listRes.body.data[0];
    const res = await request(app).get(`/api/papers/${author}/${permlink}/comments?accredited_only=false`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toHaveProperty('page');
    expect(res.body.meta).toHaveProperty('limit');
    expect(res.body.meta).toHaveProperty('total');

    if (res.body.data.length > 0) {
      const comment = res.body.data[0];
      expect(comment).toHaveProperty('author');
      expect(comment).toHaveProperty('permlink');
      expect(comment).toHaveProperty('body');
      expect(comment).toHaveProperty('created');
      expect(comment).toHaveProperty('net_votes');
      expect(comment).toHaveProperty('is_accredited');
      expect(comment).toHaveProperty('parent_author');
      expect(comment).toHaveProperty('parent_permlink');
    }
  });

  it('respects limit parameter', async () => {
    const listRes = await request(app).get('/api/papers?limit=1');
    if (listRes.body.data.length === 0) return;

    const { author, permlink } = listRes.body.data[0];
    const res = await request(app).get(`/api/papers/${author}/${permlink}/comments?limit=1&accredited_only=false`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
  });
});

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const app = createApp();

describe('GET /api/papers', () => {
  it('returns a list of papers with correct envelope', { timeout: 60_000 }, async () => {
    const res = await request(app).get('/api/papers');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toHaveProperty('page');
    expect(res.body.meta).toHaveProperty('total');
  });

  it('returns papers with correct structure when data exists', async () => {
    const res = await request(app).get('/api/papers');
    if (res.body.data.length > 0) {
      const paper = res.body.data[0];
      expect(paper).toHaveProperty('author');
      expect(paper).toHaveProperty('permlink');
      expect(paper).toHaveProperty('title');
      expect(paper).toHaveProperty('abstract');
      expect(paper).toHaveProperty('discipline');
      expect(paper).toHaveProperty('keywords');
      expect(paper).toHaveProperty('net_votes');
      expect(paper).toHaveProperty('is_accredited');
    }
  });

  it('filters by discipline', async () => {
    const res = await request(app).get('/api/papers?discipline=physics');
    expect(res.status).toBe(200);
    for (const paper of res.body.data) {
      expect(paper.discipline).toBe('physics');
    }
  });

  it('respects pagination params', async () => {
    const res = await request(app).get('/api/papers?page=1&limit=1');
    expect(res.status).toBe(200);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(1);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
  });

  it('supports source filter', async () => {
    for (const source of ['native', 'bridge']) {
      const res = await request(app).get(`/api/papers?source=${source}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    }
  });
});

describe('GET /api/papers/:author/:permlink', () => {
  it('returns 404 for nonexistent paper', async () => {
    const res = await request(app).get('/api/papers/nobody/no-paper');
    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns paper detail with correct structure when found', async () => {
    // First get any paper from the listing to use as a real test target
    const listRes = await request(app).get('/api/papers?limit=1');
    if (listRes.body.data.length === 0) return; // no pevo content on chain yet

    const { author, permlink } = listRes.body.data[0];
    const res = await request(app).get(`/api/papers/${author}/${permlink}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.author).toBe(author);
    expect(res.body.data.permlink).toBe(permlink);
    expect(res.body.data).toHaveProperty('body');
    expect(res.body.data).toHaveProperty('reviews');
    expect(Array.isArray(res.body.data.reviews)).toBe(true);
    expect(res.body.data).toHaveProperty('versions');
    expect(res.body.data).toHaveProperty('is_retracted');
  });
});

describe('GET /api/papers/:author/:permlink/citations', () => {
  it('returns citations list (or empty)', async () => {
    const listRes = await request(app).get('/api/papers?limit=1');
    if (listRes.body.data.length === 0) return;

    const { author, permlink } = listRes.body.data[0];
    const res = await request(app).get(`/api/papers/${author}/${permlink}/citations`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toHaveProperty('total');
  });
});

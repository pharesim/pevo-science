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
      // Case-insensitive match: papers tagged "Physics" or "PHYSICS" also match.
      // Assert via lowercase comparison since BE-DISCIPLINE-CANONICALIZE hold #1
      // extended LOWER() matching to the /api/papers filter.
      expect(paper.discipline.toLowerCase()).toBe('physics');
    }
  });

  // BE-DISCIPLINE-CANONICALIZE hold #1(a): mixed-case ?discipline= parity.
  // Before the LOWER() fix on papers.ts, `?discipline=physics` only matched
  // rows tagged lowercase "physics" and silently dropped "Physics"/"PHYSICS"
  // on the primary paper-listing endpoint. Parity is an invariant regardless
  // of whether mixed-case corpus currently exists on HAF — but this real-HAF
  // spec vacuously passes when the corpus has zero `physics`-tagged papers
  // (both sides return total=0 / data=[]), so we skip in that state. The
  // SQL-shape regression is pinned deterministically in
  // disciplines-canon-mocked.test.ts (hold #1a mocked-pool coverage).
  it('?discipline= filter is case-insensitive (parity across casings)', { timeout: 60_000 }, async (ctx) => {
    const [lower, upper] = await Promise.all([
      request(app).get('/api/papers?discipline=physics'),
      request(app).get('/api/papers?discipline=PHYSICS'),
    ]);
    expect(lower.status).toBe(200);
    expect(upper.status).toBe(200);
    if (lower.body.meta.total === 0) {
      // Empty corpus — parity assertion is vacuous. Skip so a future
      // regression on mixed-case inputs surfaces at the mocked-pool spec
      // instead of silently passing here.
      ctx.skip();
      return;
    }
    expect(upper.body.meta.total).toBe(lower.body.meta.total);
    const key = (p: { author: string; permlink: string }) => `${p.author}/${p.permlink}`;
    expect(new Set(upper.body.data.map(key))).toEqual(new Set(lower.body.data.map(key)));
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

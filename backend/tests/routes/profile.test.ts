import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const app = createApp();

describe('GET /api/profile/:username', () => {
  it('returns profile with reputation breakdown', { timeout: 60_000 }, async () => {
    // Use a known Hive account — pevo.admin exists on chain
    const res = await request(app).get('/api/profile/pevo.admin');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.username).toBe('pevo.admin');
    expect(res.body.data).toHaveProperty('is_accredited');
    expect(res.body.data).toHaveProperty('reputation');
    expect(res.body.data.reputation).toHaveProperty('score');
    expect(res.body.data.reputation).toHaveProperty('breakdown');
    expect(res.body.data).toHaveProperty('stats');
  });

  it('returns reputation score between 0 and 100', { timeout: 60_000 }, async () => {
    const res = await request(app).get('/api/profile/pevo.admin');
    const score = res.body.data.reputation.score;
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('includes all breakdown factors', { timeout: 60_000 }, async () => {
    const res = await request(app).get('/api/profile/pevo.admin');
    const breakdown = res.body.data.reputation.breakdown;
    expect(breakdown).toHaveProperty('papers');
    expect(breakdown).toHaveProperty('reviews');
    expect(breakdown).toHaveProperty('citations');
    expect(breakdown).toHaveProperty('accreditation');
    expect(breakdown).not.toHaveProperty('paper_votes');
    expect(breakdown).not.toHaveProperty('review_votes');
    expect(breakdown).not.toHaveProperty('account_age');
  });
});

describe('GET /api/profile/:username/papers', () => {
  it('returns papers list for user', async () => {
    const res = await request(app).get('/api/profile/pevo.admin/papers');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toHaveProperty('total');
  });
});

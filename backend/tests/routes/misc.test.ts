import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

const app = createApp();

describe('GET /api/disciplines', () => {
  it('returns a list of disciplines', async () => {
    const res = await request(app).get('/api/disciplines');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('GET /api/stats', () => {
  it('returns platform statistics with correct structure', async () => {
    const res = await request(app).get('/api/stats');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    const data = res.body.data;
    expect(data).toHaveProperty('total_papers');
    expect(data).toHaveProperty('total_reviews');
    expect(data).toHaveProperty('total_accredited_researchers');
    expect(data).toHaveProperty('total_citations');
    expect(data).toHaveProperty('active_disciplines');
    expect(data).toHaveProperty('papers_last_30_days');
    expect(data).toHaveProperty('reviews_last_30_days');
  });

  it('returns numeric counts', async () => {
    const res = await request(app).get('/api/stats');
    const data = res.body.data;
    expect(typeof data.total_papers).toBe('number');
    expect(typeof data.total_reviews).toBe('number');
    expect(data.total_papers).toBeGreaterThanOrEqual(0);
    expect(data.total_reviews).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /api/accreditations', () => {
  it('returns accreditations list', async () => {
    const res = await request(app).get('/api/accreditations');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('GET /api/accreditations/:username', () => {
  it('returns accreditation status', async () => {
    const res = await request(app).get('/api/accreditations/pevo.admin');
    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe('pevo.admin');
    expect(res.body.data).toHaveProperty('is_accredited');
    expect(res.body.data).toHaveProperty('accreditation');
  });
});

describe('POST /api/accreditation/request', () => {
  it('returns 401 without auth headers', async () => {
    const res = await request(app)
      .post('/api/accreditation/request')
      .send({});
    expect(res.status).toBe(401);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/accreditation/request')
      .set('X-Hive-Username', 'testuser')
      .set('X-Hive-Signature', 'mock')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects free email domains', async () => {
    const res = await request(app)
      .post('/api/accreditation/request')
      .set('X-Hive-Username', 'testuser')
      .set('X-Hive-Signature', 'mock')
      .send({
        full_name: 'Test User',
        institution: 'MIT',
        field: 'physics',
        email: 'test@gmail.com',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('institutional');
  });
});

describe('POST /api/accreditation/verify', () => {
  it('returns 400 when token is missing', async () => {
    const res = await request(app)
      .post('/api/accreditation/verify')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid token', async () => {
    const res = await request(app)
      .post('/api/accreditation/verify')
      .send({ token: 'nonexistent-token' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Invalid');
  });
});

describe('POST /api/ipfs/upload', () => {
  it('returns 401 without auth headers', async () => {
    const res = await request(app)
      .post('/api/ipfs/upload');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('POST /api/reviews/anonymous', () => {
  it('returns 401 without auth headers', async () => {
    const res = await request(app)
      .post('/api/reviews/anonymous')
      .send({ paper_author: 'alice', paper_permlink: 'test', body: 'review', rating: {} });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('404 handling', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/api/nonexistent');
    expect(res.status).toBe(404);
  });
});

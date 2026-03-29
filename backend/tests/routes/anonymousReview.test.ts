import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

const app = createApp();

describe('POST /api/reviews/anonymous', () => {
  it('returns 401 without auth headers', async () => {
    const res = await request(app)
      .post('/api/reviews/anonymous')
      .send({
        paper_author: 'alice',
        paper_permlink: 'quantum-paper',
        body: 'Great paper',
        rating: { methodology: 4, novelty: 5, clarity: 3, significance: 4 },
      });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 400 when fields are missing', async () => {
    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', 'reviewer1')
      .set('X-Hive-Signature', 'mock-sig')
      .send({ paper_author: 'alice' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for invalid rating values', async () => {
    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', 'reviewer1')
      .set('X-Hive-Signature', 'mock-sig')
      .send({
        paper_author: 'alice',
        paper_permlink: 'quantum-paper',
        body: 'Review text',
        rating: { methodology: 6, novelty: 0, clarity: 3, significance: 4 },
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('rating');
  });

  it('returns 400 for non-integer rating', async () => {
    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', 'reviewer1')
      .set('X-Hive-Signature', 'mock-sig')
      .send({
        paper_author: 'alice',
        paper_permlink: 'quantum-paper',
        body: 'Review text',
        rating: { methodology: 3.5, novelty: 4, clarity: 3, significance: 4 },
      });
    expect(res.status).toBe(400);
  });

  it('returns 403 for unaccredited reviewer', async () => {
    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', 'reviewer1')
      .set('X-Hive-Signature', 'mock-sig')
      .send({
        paper_author: 'alice',
        paper_permlink: 'quantum-paper',
        body: 'Good research',
        rating: { methodology: 4, novelty: 5, clarity: 3, significance: 4 },
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

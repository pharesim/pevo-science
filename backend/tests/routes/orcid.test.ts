import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

const app = createApp();

describe('GET /api/accreditation/orcid/start', () => {
  it('returns 500 when ORCID is not configured', async () => {
    const res = await request(app)
      .get('/api/accreditation/orcid/start')
      .set('X-Hive-Username', 'testuser');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain('ORCID integration is not configured');
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/accreditation/orcid/start');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/accreditation/orcid/callback', () => {
  it('returns 500 when ORCID is not configured', async () => {
    const res = await request(app)
      .post('/api/accreditation/orcid/callback')
      .set('X-Hive-Username', 'testuser')
      .send({ code: 'abc', state: 'xyz' });
    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain('ORCID integration is not configured');
  });
});

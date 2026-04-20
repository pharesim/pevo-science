import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

const app = createApp();

describe('POST /api/orcid/start', () => {
  it('returns 500 when ORCID is not configured', async () => {
    const res = await request(app)
      .post('/api/orcid/start')
      .send({ mode: 'signup' });
    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain('ORCID integration is not configured');
  });
});

describe('POST /api/orcid/callback', () => {
  it('returns 500 when ORCID is not configured', async () => {
    const res = await request(app)
      .post('/api/orcid/callback')
      .send({ code: 'abc', state: 'xyz' });
    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain('ORCID integration is not configured');
  });
});

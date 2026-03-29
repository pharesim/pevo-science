import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

const app = createApp();

describe('POST /api/papers/:author/:permlink/retract', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app)
      .post('/api/papers/nobody/no-paper/retract')
      .send({ reason: 'Data fabrication' });
    expect(res.status).toBe(401);
  });

  it('returns 404 for nonexistent paper', async () => {
    const res = await request(app)
      .post('/api/papers/nobody/nonexistent/retract')
      .set('X-Hive-Username', 'nobody')
      .send({ reason: 'Error' });
    expect(res.status).toBe(404);
  });
});

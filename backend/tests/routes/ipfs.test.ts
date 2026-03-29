import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

const app = createApp();

describe('POST /api/ipfs/upload', () => {
  it('returns 401 without auth headers', async () => {
    const res = await request(app)
      .post('/api/ipfs/upload')
      .attach('file', Buffer.from('%PDF-1.4 test'), 'test.pdf');
    expect(res.status).toBe(401);
  });

  it('returns 400 when no file is provided', async () => {
    const res = await request(app)
      .post('/api/ipfs/upload')
      .set('X-Hive-Username', 'testuser')
      .set('X-Hive-Signature', 'mock-sig');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 403 for unaccredited uploader', async () => {
    const res = await request(app)
      .post('/api/ipfs/upload')
      .set('X-Hive-Username', 'testuser')
      .set('X-Hive-Signature', 'mock-sig')
      .attach('file', Buffer.from('%PDF-1.4 test content'), {
        filename: 'paper.pdf',
        contentType: 'application/pdf',
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

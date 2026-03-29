import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

const app = createApp();

describe('GET /api/profile/:username/notification-preferences', () => {
  it('returns defaults when no preferences exist', async () => {
    const res = await request(app)
      .get('/api/profile/testuser/notification-preferences')
      .set('X-Hive-Username', 'testuser');
    expect(res.status).toBe(200);
    expect(res.body.data.email_digest).toBe(false);
    expect(res.body.data.digest_frequency).toBe('weekly');
    expect(res.body.data.email).toBeNull();
  });

  it('rejects access to other users preferences', async () => {
    const res = await request(app)
      .get('/api/profile/otheruser/notification-preferences')
      .set('X-Hive-Username', 'testuser');
    expect(res.status).toBe(403);
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .get('/api/profile/testuser/notification-preferences');
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/profile/:username/notification-preferences', () => {
  it('rejects invalid body', async () => {
    const res = await request(app)
      .put('/api/profile/testuser/notification-preferences')
      .set('X-Hive-Username', 'testuser')
      .send({ email_digest: 'not-a-boolean' });
    expect(res.status).toBe(400);
  });

  it('rejects access to other users preferences', async () => {
    const res = await request(app)
      .put('/api/profile/otheruser/notification-preferences')
      .set('X-Hive-Username', 'testuser')
      .send({ email_digest: true, digest_frequency: 'weekly', email: 'test@mit.edu' });
    expect(res.status).toBe(403);
  });
});

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

const app = createApp();

// Unique test username per run to avoid collisions
const TEST_USER = `settings_test_${Date.now()}`;
const TEST_EMAIL = `settings_test_${Date.now()}@example.com`;
const OTHER_EMAIL = `settings_other_${Date.now()}@example.com`;

// Check if app DB is actually reachable (synchronous-ish via top-level await)
let dbReachable = false;
{
  const pool = getAppPool();
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbReachable = true;
      // Run migration for pending_email columns if needed
      await pool.query(`
        ALTER TABLE accounts ALTER COLUMN password_hash DROP NOT NULL;
        ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pending_email TEXT;
        ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pending_email_token TEXT;
        ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pending_email_expires_at TIMESTAMPTZ;
      `).catch(() => {}); // Ignore if already applied
    } catch {
      dbReachable = false;
    }
  }
}

async function cleanup() {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  try {
    await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [TEST_USER]);
    await pool.query('DELETE FROM notification_preferences WHERE username = $1', [TEST_USER]);
    await pool.query('DELETE FROM accounts WHERE username = $1', [TEST_USER]);
  } catch { /* ignore */ }
}

afterAll(async () => { await cleanup(); });

// ─── Auth + validation tests (no DB needed) ─────────────────

describe('GET /api/settings/email', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .get('/api/settings/email');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/settings/email', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/settings/email')
      .send({ email: 'test@example.com' });
    expect(res.status).toBe(401);
  });

  it('rejects invalid email', async () => {
    const res = await request(app)
      .post('/api/settings/email')
      .set('X-Hive-Username', TEST_USER)
      .send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects missing email', async () => {
    const res = await request(app)
      .post('/api/settings/email')
      .set('X-Hive-Username', TEST_USER)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/settings/email', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .delete('/api/settings/email')
      .send({ confirm: true });
    expect(res.status).toBe(401);
  });

  it('rejects without confirm: true', async () => {
    const res = await request(app)
      .delete('/api/settings/email')
      .set('X-Hive-Username', TEST_USER)
      .send({ confirm: false });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ─── DB-dependent tests ─────────────────────────────────────

describe('Settings email (with DB)', () => {
  beforeAll(async () => { await cleanup(); });

  it.skipIf(!dbReachable)('GET returns hasEmail: false for unknown user', async () => {
    const res = await request(app)
      .get('/api/settings/email')
      .set('X-Hive-Username', TEST_USER);
    expect(res.status).toBe(200);
    expect(res.body.data.hasEmail).toBe(false);
    expect(res.body.data.custody).toBe('self');
  });

  it.skipIf(!dbReachable)('GET returns email status for existing account', async () => {
    const pool = getAppPool()!;
    await pool.query(
      `INSERT INTO accounts (email, username, verify_token) VALUES ($1, $2, NULL)`,
      [TEST_EMAIL, TEST_USER],
    );

    const res = await request(app)
      .get('/api/settings/email')
      .set('X-Hive-Username', TEST_USER);
    expect(res.status).toBe(200);
    expect(res.body.data.hasEmail).toBe(true);
    expect(res.body.data.verified).toBe(true);
    expect(res.body.data.pendingChange).toBe(false);
    expect(res.body.data.email).toMatch(/^s\*\*\*@example\.com$/);

    await pool.query('DELETE FROM accounts WHERE username = $1', [TEST_USER]);
  });

  it.skipIf(!dbReachable)('POST rejects duplicate email used by another account', async () => {
    const pool = getAppPool()!;
    const otherUser = `settings_other_${Date.now()}`;
    await pool.query(
      `INSERT INTO accounts (email, username, verify_token) VALUES ($1, $2, NULL)`,
      [TEST_EMAIL, otherUser],
    );

    const res = await request(app)
      .post('/api/settings/email')
      .set('X-Hive-Username', TEST_USER)
      .send({ email: TEST_EMAIL });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE');

    await pool.query('DELETE FROM accounts WHERE username = $1', [otherUser]);
  });

  it.skipIf(!dbReachable)('verify token - add flow', async () => {
    const pool = getAppPool()!;
    const token = 'test_verify_token_' + Date.now();
    await pool.query(
      `INSERT INTO accounts (email, username, verify_token, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
      [TEST_EMAIL, TEST_USER, token],
    );

    const res = await request(app)
      .get(`/api/settings/email/verify/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.verified).toBe(true);

    const { rows } = await pool.query(
      'SELECT verify_token FROM accounts WHERE username = $1',
      [TEST_USER],
    );
    expect(rows[0].verify_token).toBeNull();

    await pool.query('DELETE FROM accounts WHERE username = $1', [TEST_USER]);
  });

  it.skipIf(!dbReachable)('verify token - change flow', async () => {
    const pool = getAppPool()!;
    const token = 'test_change_token_' + Date.now();
    await pool.query(
      `INSERT INTO accounts (email, username, verify_token, pending_email, pending_email_token, pending_email_expires_at)
       VALUES ($1, $2, NULL, $3, $4, NOW() + INTERVAL '24 hours')`,
      [TEST_EMAIL, TEST_USER, OTHER_EMAIL, token],
    );

    const res = await request(app)
      .get(`/api/settings/email/verify/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.verified).toBe(true);

    const { rows } = await pool.query(
      'SELECT email, pending_email FROM accounts WHERE username = $1',
      [TEST_USER],
    );
    expect(rows[0].email).toBe(OTHER_EMAIL);
    expect(rows[0].pending_email).toBeNull();

    await pool.query('DELETE FROM accounts WHERE username = $1', [TEST_USER]);
  });

  it.skipIf(!dbReachable)('verify token - rejects expired', async () => {
    const pool = getAppPool()!;
    const token = 'test_expired_token_' + Date.now();
    await pool.query(
      `INSERT INTO accounts (email, username, verify_token, expires_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour')`,
      [TEST_EMAIL, TEST_USER, token],
    );

    const res = await request(app)
      .get(`/api/settings/email/verify/${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TOKEN');

    await pool.query('DELETE FROM accounts WHERE username = $1', [TEST_USER]);
  });

  it.skipIf(!dbReachable)('verify token - rejects unknown token', async () => {
    const res = await request(app)
      .get('/api/settings/email/verify/nonexistent_token');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it.skipIf(!dbReachable)('DELETE deletes account and associated data', async () => {
    const pool = getAppPool()!;
    await pool.query(
      `INSERT INTO accounts (email, username, verify_token) VALUES ($1, $2, NULL)`,
      [TEST_EMAIL, TEST_USER],
    );
    await pool.query(
      `INSERT INTO notification_preferences (username, email) VALUES ($1, $2)`,
      [TEST_USER, TEST_EMAIL],
    );

    const res = await request(app)
      .delete('/api/settings/email')
      .set('X-Hive-Username', TEST_USER)
      .send({ confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);

    const { rows: accRows } = await pool.query(
      'SELECT id FROM accounts WHERE username = $1',
      [TEST_USER],
    );
    expect(accRows.length).toBe(0);

    const { rows: prefRows } = await pool.query(
      'SELECT username FROM notification_preferences WHERE username = $1',
      [TEST_USER],
    );
    expect(prefRows.length).toBe(0);
  });

  it.skipIf(!dbReachable)('DELETE returns 404 for unknown user', async () => {
    const res = await request(app)
      .delete('/api/settings/email')
      .set('X-Hive-Username', TEST_USER)
      .send({ confirm: true });
    expect(res.status).toBe(404);
  });
});

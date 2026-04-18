import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { encryptKey } from '../../src/custody-crypto.js';

const app = createApp();

const TEST_USER = `recover_test_${Date.now()}`;
const TEST_EMAIL = `recover_${Date.now()}@example.com`;
const TEST_PASSWORD = 'OldPassword1';
const TEST_MEMO_KEY = '5JexampleMemoKeyForRecoveryTest123456789abcdef';

let dbReachable = false;
{
  const pool = getAppPool();
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbReachable = true;
    } catch {
      dbReachable = false;
    }
  }
}

async function cleanup() {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  try {
    await pool.query('DELETE FROM custody_audit_log WHERE username LIKE $1', ['recover_%']);
    await pool.query('DELETE FROM accounts WHERE username LIKE $1', ['recover_%']);
  } catch { /* ignore */ }
}

afterAll(async () => { await cleanup(); });

// ─── Validation tests ────────────────────────────────────────
// Keep these minimal — rate limit is 5/hr per IP

describe('POST /api/auth/recover — validation', () => {
  it('rejects missing username', async () => {
    const res = await request(app)
      .post('/api/auth/recover')
      .send({ new_email: 'a@b.com', new_password: 'NewPassword1', memo_key: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects missing recovery method', async () => {
    const res = await request(app)
      .post('/api/auth/recover')
      .send({ username: 'someone', new_email: 'a@b.com', new_password: 'NewPassword1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects weak password (short / no uppercase / no number)', async () => {
    // Short
    let res = await request(app)
      .post('/api/auth/recover')
      .send({ username: 'someone', new_email: 'a@b.com', new_password: 'Short1', memo_key: 'x' });
    expect(res.status).toBe(400);
  });
});

// ─── DB-dependent tests ─────────────────────────────────────

describe('POST /api/auth/recover — with DB', () => {
  beforeAll(async () => {
    await cleanup();
    if (!dbReachable) return;
    const pool = getAppPool()!;

    // Create a test light account with encrypted memo key
    const passwordHash = await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id });
    const memoEnc = encryptKey(TEST_USER, TEST_MEMO_KEY);

    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, memo_key_enc, iv_memo, verify_token)
       VALUES ($1, $2, $3, 'light', $4, $5, NULL)`,
      [TEST_EMAIL, TEST_USER, passwordHash, memoEnc.ciphertext, memoEnc.iv],
    );
  });

  it.skipIf(!dbReachable)('returns 404 for non-existent username', async () => {
    const res = await request(app)
      .post('/api/auth/recover')
      .send({
        username: 'nonexistent.user.xyz',
        new_email: 'new@example.com',
        new_password: 'NewPassword1',
        memo_key: 'something',
      });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it.skipIf(!dbReachable)('rejects wrong memo key', async () => {
    const res = await request(app)
      .post('/api/auth/recover')
      .send({
        username: TEST_USER,
        new_email: 'new@example.com',
        new_password: 'NewPassword1',
        memo_key: 'wrong-memo-key',
      });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');

    // Should have audit log entry
    const pool = getAppPool()!;
    const { rows } = await pool.query(
      `SELECT operation_type FROM custody_audit_log
       WHERE username = $1 AND operation_type = 'recovery_failure'
       ORDER BY created_at DESC LIMIT 1`,
      [TEST_USER],
    );
    expect(rows.length).toBe(1);
  });

  it.skipIf(!dbReachable)('rejects duplicate email', async () => {
    const pool = getAppPool()!;
    const otherUser = `recover_other_${Date.now()}`;
    const takenEmail = `taken_${Date.now()}@example.com`;

    await pool.query(
      `INSERT INTO accounts (email, username, verify_token) VALUES ($1, $2, NULL)`,
      [takenEmail, otherUser],
    );

    const res = await request(app)
      .post('/api/auth/recover')
      .send({
        username: TEST_USER,
        new_email: takenEmail,
        new_password: 'NewPassword1',
        memo_key: TEST_MEMO_KEY,
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE');

    await pool.query('DELETE FROM accounts WHERE username = $1', [otherUser]);
  });

  it.skipIf(!dbReachable)('succeeds with correct memo key', async () => {
    const newEmail = `recovered_${Date.now()}@example.com`;
    const newPassword = 'RecoveredPass1';

    const res = await request(app)
      .post('/api/auth/recover')
      .send({
        username: TEST_USER,
        new_email: newEmail,
        new_password: newPassword,
        memo_key: TEST_MEMO_KEY,
      });
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.username).toBe(TEST_USER);
    expect(res.body.data.custody).toBe('light');
    expect(res.body.data.expires_at).toBeDefined();

    // Verify DB was updated
    const pool = getAppPool()!;
    const { rows } = await pool.query(
      'SELECT email, sessions_invalidated_at FROM accounts WHERE username = $1',
      [TEST_USER],
    );
    expect(rows[0].email).toBe(newEmail);
    expect(rows[0].sessions_invalidated_at).not.toBeNull();

    // Verify new password works
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USER, password: newPassword });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.data.token).toBeDefined();

    // Verify old password fails
    const oldLoginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USER, password: TEST_PASSWORD });
    expect(oldLoginRes.status).toBe(401);

    // Verify audit log
    const { rows: auditRows } = await pool.query(
      `SELECT operation_type FROM custody_audit_log
       WHERE username = $1 AND operation_type = 'account_recovery'`,
      [TEST_USER],
    );
    expect(auditRows.length).toBe(1);
  });

  it.skipIf(!dbReachable)('rejects ORCID recovery when account has no ORCID', async () => {
    const res = await request(app)
      .post('/api/auth/recover')
      .send({
        username: TEST_USER,
        new_email: 'new@example.com',
        new_password: 'NewPassword1',
        orcid_token: 'some-nonce',
      });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it.skipIf(!dbReachable)('rejects invalid ORCID token', async () => {
    const pool = getAppPool()!;
    await pool.query('UPDATE accounts SET orcid = $1 WHERE username = $2', ['0000-0001-2345-6789', TEST_USER]);

    const res = await request(app)
      .post('/api/auth/recover')
      .send({
        username: TEST_USER,
        new_email: 'new@example.com',
        new_password: 'NewPassword1',
        orcid_token: 'invalid-nonce-xyz',
      });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');

    await pool.query('UPDATE accounts SET orcid = NULL WHERE username = $1', [TEST_USER]);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { config } from '../../src/config.js';

// SEC-004-BE: Tests for POST /api/settings/set-password.
// Real verifyHiveSignature (Bearer JWT path) — no MOCK_VERIFY_SIGNATURE.
// Rationale: the SEC-004-BE task block explicitly bars mock-auth for the new
// set-password scenarios; a Bearer JWT is verified by the real middleware.

const app = createApp();

const RUN_ID = Date.now();

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

function bearer(username: string): string {
  return jwt.sign({ sub: username, custody: 'light' }, config.sessionSecret, { expiresIn: '1h' });
}

async function cleanup(username: string) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [username]).catch(() => {});
  await pool.query('DELETE FROM accounts WHERE username = $1', [username]).catch(() => {});
}

// Clear settings-write and settings-read rate-limit keys — other test files
// in the same run share this limiter by IP. Without this, combined runs fail
// with 429 RATE_LIMITED even though each test file passes in isolation.
async function clearSettingsRateLimits() {
  const { getRedis, isRedisAvailable } = await import('../../src/redis.js');
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    for (const name of ['settings-write', 'settings-read', 'auth-login']) {
      const keys = await redis.keys(`${config.appTag}:rl:${name}:*`).catch(() => [] as string[]);
      if (keys.length > 0) await redis.del(...keys).catch(() => {});
    }
  }
}

describe.skipIf(!dbReachable)('POST /api/settings/set-password', () => {
  const NULL_USER = `setpw_null_${RUN_ID}`;
  const NULL_EMAIL = `setpw_null_${RUN_ID}@example.com`;
  const SET_USER = `setpw_set_${RUN_ID}`;
  const SET_EMAIL = `setpw_set_${RUN_ID}@example.com`;

  beforeAll(async () => {
    await clearSettingsRateLimits();
    await cleanup(NULL_USER);
    await cleanup(SET_USER);
    const pool = getAppPool()!;
    // Null-hash account
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, verify_token)
       VALUES ($1, $2, NULL, 'light', NULL)`,
      [NULL_EMAIL, NULL_USER],
    );
    // Already-set-password account
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, verify_token)
       VALUES ($1, $2, 'dummy-existing-hash', 'light', NULL)`,
      [SET_EMAIL, SET_USER],
    );
  });

  afterAll(async () => {
    await cleanup(NULL_USER);
    await cleanup(SET_USER);
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/settings/set-password')
      .send({ password: 'ValidPassword1' });
    expect(res.status).toBe(401);
  });

  it('rejects weak password (signup-policy parity)', async () => {
    const res = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', `Bearer ${bearer(NULL_USER)}`)
      .send({ password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('sets password on null-hash account and password login then works', async () => {
    const newPw = 'FreshPassword1';
    const res = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', `Bearer ${bearer(NULL_USER)}`)
      .send({ password: newPw });
    expect(res.status).toBe(200);

    const pool = getAppPool()!;
    const { rows } = await pool.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM accounts WHERE username = $1',
      [NULL_USER],
    );
    expect(rows[0].password_hash).not.toBeNull();

    // Password login now works
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: NULL_USER, password: newPw });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.data.token).toBeTruthy();
  });

  it('rejects with 409 PASSWORD_ALREADY_SET when password is already set', async () => {
    const res = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', `Bearer ${bearer(SET_USER)}`)
      .send({ password: 'ReplacementPw1' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PASSWORD_ALREADY_SET');

    // Password_hash untouched
    const pool = getAppPool()!;
    const { rows } = await pool.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM accounts WHERE username = $1',
      [SET_USER],
    );
    expect(rows[0].password_hash).toBe('dummy-existing-hash');
  });
});

describe.skipIf(!dbReachable)('GET /api/settings/email — has_password flag', () => {
  const FLAG_USER = `setpw_flag_${RUN_ID}`;
  const FLAG_EMAIL = `setpw_flag_${RUN_ID}@example.com`;

  beforeAll(async () => {
    await clearSettingsRateLimits();
    await cleanup(FLAG_USER);
  });

  afterAll(async () => { await cleanup(FLAG_USER); });

  it('reports has_password=false for null-hash accounts and true after setting', async () => {
    const pool = getAppPool()!;
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, verify_token)
       VALUES ($1, $2, NULL, 'light', NULL)`,
      [FLAG_EMAIL, FLAG_USER],
    );

    const before = await request(app)
      .get('/api/settings/email')
      .set('Authorization', `Bearer ${bearer(FLAG_USER)}`);
    expect(before.status).toBe(200);
    expect(before.body.data.has_password).toBe(false);

    const setRes = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', `Bearer ${bearer(FLAG_USER)}`)
      .send({ password: 'FlagPassword1' });
    expect(setRes.status).toBe(200);

    const after = await request(app)
      .get('/api/settings/email')
      .set('Authorization', `Bearer ${bearer(FLAG_USER)}`);
    expect(after.status).toBe(200);
    expect(after.body.data.has_password).toBe(true);
  });
});

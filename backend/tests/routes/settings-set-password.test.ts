import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { config } from '../../src/config.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';
import {
  issueFreshAuthToken,
  setPasswordFreshAuthTarget,
} from '../../src/lib/fresh-auth.js';

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

describe.skipIf(!dbReachable)('POST /api/settings/set-password', () => {
  const NULL_USER = `setpw_null_${RUN_ID}`;
  const NULL_EMAIL = `setpw_null_${RUN_ID}@example.com`;
  const NULL_ORCID = `0000-0003-${RUN_ID.toString().slice(-4)}-0001`;
  const NO_ORCID_USER = `setpw_noorcid_${RUN_ID}`;
  const NO_ORCID_EMAIL = `setpw_noorcid_${RUN_ID}@example.com`;
  const SET_USER = `setpw_set_${RUN_ID}`;
  const SET_EMAIL = `setpw_set_${RUN_ID}@example.com`;
  // Pre-computed argon2id hash of a known plaintext. Swapped in for the
  // previous 'dummy-existing-hash' literal so future tests that exercise the
  // verify path (e.g., re-login after PASSWORD_ALREADY_SET) don't silently
  // fail against a non-argon2 string. The current 409 path short-circuits
  // before argon2.verify, but making the seed realistic closes a mutation
  // surface for later refactors.
  let existingPasswordHash = '';
  const EXISTING_PASSWORD = 'KnownExistingPw1';

  beforeAll(async () => {
    await clearRateLimitKeys(['settings-write', 'settings-read', 'auth-login']);
    await cleanup(NULL_USER);
    await cleanup(NO_ORCID_USER);
    await cleanup(SET_USER);
    existingPasswordHash = await argon2.hash(EXISTING_PASSWORD, { type: argon2.argon2id });
    const pool = getAppPool()!;
    // Null-hash ORCID-verified account (the supported set-password path)
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, verify_token, orcid)
       VALUES ($1, $2, NULL, 'light', NULL, $3)`,
      [NULL_EMAIL, NULL_USER, NULL_ORCID],
    );
    // Null-hash account WITHOUT orcid — exercises the ORCID_REQUIRED guard
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, verify_token)
       VALUES ($1, $2, NULL, 'light', NULL)`,
      [NO_ORCID_EMAIL, NO_ORCID_USER],
    );
    // Already-set-password account (argon2id hash, not a literal string)
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, verify_token)
       VALUES ($1, $2, $3, 'light', NULL)`,
      [SET_EMAIL, SET_USER, existingPasswordHash],
    );
  });

  afterAll(async () => {
    await cleanup(NULL_USER);
    await cleanup(NO_ORCID_USER);
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
    // Fresh-auth gate per BACKEND-SETTINGS-SET-PASSWORD-FRESH-AUTH:
    // ORCID-mechanism proof bound to the per-user set-password target.
    const issued = await issueFreshAuthToken(
      NULL_USER,
      'orcid',
      setPasswordFreshAuthTarget(NULL_USER),
    );
    const res = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', `Bearer ${bearer(NULL_USER)}`)
      .send({ password: newPw, fresh_auth_proof: issued.token });
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

    // Password_hash untouched — still the pre-seeded argon2id hash.
    const pool = getAppPool()!;
    const { rows } = await pool.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM accounts WHERE username = $1',
      [SET_USER],
    );
    expect(rows[0].password_hash).toBe(existingPasswordHash);
  });

  it('returns 403 ORCID_REQUIRED when the null-hash account has no linked ORCID', async () => {
    // Regression guard for the ORCID_REQUIRED invariant. Only ORCID-verified
    // accounts may opt into password login; future code paths that null
    // password_hash for other reasons must not silently inherit set-password
    // eligibility.
    const res = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', `Bearer ${bearer(NO_ORCID_USER)}`)
      .send({ password: 'ShouldNotBeSet1' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORCID_REQUIRED');

    // Confirm password_hash remained null.
    const pool = getAppPool()!;
    const { rows } = await pool.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM accounts WHERE username = $1',
      [NO_ORCID_USER],
    );
    expect(rows[0].password_hash).toBeNull();
  });

  it('returns 401 UNAUTHORIZED when the account row is missing (session stale)', async () => {
    // Finding #2: 404 → 401 audit. Authed endpoint, missing-own-row ≡ stale
    // session. The distinguishing 404 previously leaked account deletion.
    const MISSING_USER = `setpw_missing_${RUN_ID}`;
    const res = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', `Bearer ${bearer(MISSING_USER)}`)
      .send({ password: 'ValidPassword1' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe.skipIf(!dbReachable)('GET /api/settings/email — hasPassword flag', () => {
  const FLAG_USER = `setpw_flag_${RUN_ID}`;
  const FLAG_EMAIL = `setpw_flag_${RUN_ID}@example.com`;
  const FLAG_ORCID = `0000-0003-${RUN_ID.toString().slice(-4)}-0002`;

  beforeAll(async () => {
    await clearRateLimitKeys(['settings-write', 'settings-read', 'auth-login']);
    await cleanup(FLAG_USER);
  });

  afterAll(async () => { await cleanup(FLAG_USER); });

  it('reports hasPassword=false for null-hash accounts and true after setting', async () => {
    const pool = getAppPool()!;
    // Seed with an orcid so the set-password call passes the ORCID_REQUIRED
    // guard added by SEC-004-BE finding #3.
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, verify_token, orcid)
       VALUES ($1, $2, NULL, 'light', NULL, $3)`,
      [FLAG_EMAIL, FLAG_USER, FLAG_ORCID],
    );

    const before = await request(app)
      .get('/api/settings/email')
      .set('Authorization', `Bearer ${bearer(FLAG_USER)}`);
    expect(before.status).toBe(200);
    expect(before.body.data.hasPassword).toBe(false);

    const issued = await issueFreshAuthToken(
      FLAG_USER,
      'orcid',
      setPasswordFreshAuthTarget(FLAG_USER),
    );
    const setRes = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', `Bearer ${bearer(FLAG_USER)}`)
      .send({ password: 'FlagPassword1', fresh_auth_proof: issued.token });
    expect(setRes.status).toBe(200);

    const after = await request(app)
      .get('/api/settings/email')
      .set('Authorization', `Bearer ${bearer(FLAG_USER)}`);
    expect(after.status).toBe(200);
    expect(after.body.data.hasPassword).toBe(true);
  });
});

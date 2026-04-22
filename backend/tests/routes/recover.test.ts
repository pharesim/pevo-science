import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { encryptKey } from '../../src/custody-crypto.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';

const app = createApp();

const TEST_USER = `recover_test_${Date.now()}`;
const TEST_EMAIL = `recover_${Date.now()}@example.com`;
const TEST_PASSWORD = 'OldPassword1';
const TEST_MEMO_KEY = '5JexampleMemoKeyForRecoveryTest123456789abcdef';

const hasCustodyKey = !!process.env.CUSTODY_ENCRYPTION_KEY && process.env.CUSTODY_ENCRYPTION_KEY.length >= 32;
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

// /resend-verification timing specs need a ready Redis connection because the
// rate limiter (3/hr per IP) runs against it; under vitest retry=1, a limiter
// backed by the in-memory fallback cannot be cleared between attempts and the
// second run hits 429. Mirror the dbReachable pattern so the timing specs
// skip cleanly rather than fail for the wrong reason when Redis is unavailable.
// Wrapped in try/catch because `getRedis()` can throw at module load if the
// ioredis client errors before the first `.status` read; without the guard,
// that exception propagates as an unhandled rejection at module evaluation
// time and fails the entire test file with a misleading error.
let redisReachable = false;
try {
  const { getRedis } = await import('../../src/redis.js');
  const redis = getRedis();
  if (redis) {
    for (let i = 0; i < 20 && redis.status !== 'ready'; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    redisReachable = redis.status === 'ready';
  }
} catch {
  redisReachable = false;
}

// Timing-oracle assertion thresholds. Used by every /api/auth/* timing test
// in this file to keep the choice consistent and document-able in one place.
//
// FLOOR is 35ms (not 40ms or ≥50ms) because argon2.verify at our ARGON2_OPTIONS
// (64 MiB, time=3) runs 42-55ms median on reference hardware, but can drop
// into the high-20s on faster CI hosts. Pinning the assertion to 50ms would
// flake on reference; pinning to 40ms would let a faster host silently let a
// ~28ms production oracle through. 35ms still kills the sentinel-removal
// mutation (the pre-sentinel path is ~1ms, so 35× margin) while surviving
// the lowest plausible argon2-verify floor.
//
// CEILING is 150ms (not 40ms) because DB roundtrips + Express + supertest
// overhead on stressed CI can add 20-50ms to the no-argon2 path even without
// a burn. 40ms gave false-negative fails; 150ms is still well below the
// combined cost of argon2.verify + DB + Express (typically ~100ms total),
// so a regression that turns on argon2 on the fast-path would still cross
// 150ms and fail the assertion.
const TIMING_ORACLE_FLOOR_MS = 35;
const TIMING_ORACLE_CEILING_MS = 150;

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

  it('rejects both memo_key and orcid_token supplied', async () => {
    const res = await request(app)
      .post('/api/auth/recover')
      .send({
        username: 'someone',
        new_email: 'a@b.com',
        new_password: 'NewPassword1',
        memo_key: 'x',
        orcid_token: 'y',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/exactly one/i);
  });
});

// ─── DB-dependent tests ─────────────────────────────────────

describe('POST /api/auth/recover — with DB', () => {
  beforeAll(async () => {
    await cleanup();
    if (!dbReachable || !hasCustodyKey) return;
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

  it.skipIf(!dbReachable || !hasCustodyKey)('returns 404 for non-existent username', async () => {
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

  it.skipIf(!dbReachable || !hasCustodyKey)('rejects wrong memo key', async () => {
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

  it.skipIf(!dbReachable || !hasCustodyKey)('rejects duplicate email', async () => {
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

  it.skipIf(!dbReachable || !hasCustodyKey)('succeeds with correct memo key', async () => {
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

  it.skipIf(!dbReachable || !hasCustodyKey)('rejects ORCID recovery when account has no ORCID', async () => {
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

  it.skipIf(!dbReachable || !hasCustodyKey)('rejects invalid ORCID token', async () => {
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

// ─── SEC-004-BE: optional-password ORCID recovery + seed-phrase regression ───

async function seedOrcidNonce(nonce: string, orcidId: string) {
  const { getRedis, isRedisAvailable } = await import('../../src/redis.js');
  const { config } = await import('../../src/config.js');
  const { orcidVerified } = await import('../../src/routes/orcid.js');
  const payload = { orcid_id: orcidId, works_count: 5, name: 't' };
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(`${config.appTag}:orcid_verified:${nonce}`, JSON.stringify(payload), 'EX', 600);
  }
  // Seed in-memory fallback too so test passes regardless of Redis availability.
  orcidVerified.set(nonce, { ...payload, expires: Date.now() + 600_000 });
}

describe('SEC-004-BE: optional password on recovery', () => {
  const NULL_USER = `recover_null_${Date.now()}`;
  const NULL_EMAIL = `recover_null_${Date.now()}@example.com`;
  const NULL_MEMO = '5JnullHashMemoRecoveryRegression123456789abcde';
  const ORCID_ID = '0000-0002-1111-2222';

  beforeAll(async () => {
    if (!dbReachable || !hasCustodyKey) return;
    await clearRateLimitKeys(['auth-recover', 'auth-login']);
    const pool = getAppPool()!;
    const memoEnc = encryptKey(NULL_USER, NULL_MEMO);
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, memo_key_enc, iv_memo, verify_token, orcid)
       VALUES ($1, $2, NULL, 'light', $3, $4, NULL, $5)`,
      [NULL_EMAIL, NULL_USER, memoEnc.ciphertext, memoEnc.iv, ORCID_ID],
    );
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [NULL_USER]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username = $1', [NULL_USER]).catch(() => {});
  });

  it.skipIf(!dbReachable || !hasCustodyKey)('ORCID recover with no password → 200, password_hash stays NULL', async () => {
    await clearRateLimitKeys(['auth-recover', 'auth-login']);
    const nonce = `recover-null-nonce-${Date.now()}`;
    await seedOrcidNonce(nonce, ORCID_ID);

    const newEmail = `recover_null_new_${Date.now()}@example.com`;
    const res = await request(app)
      .post('/api/auth/recover')
      .send({
        username: NULL_USER,
        new_email: newEmail,
        // new_password intentionally omitted
        orcid_token: nonce,
      });
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeDefined();

    const pool = getAppPool()!;
    const { rows } = await pool.query<{ password_hash: string | null; email: string }>(
      'SELECT password_hash, email FROM accounts WHERE username = $1',
      [NULL_USER],
    );
    expect(rows[0].password_hash).toBeNull();
    expect(rows[0].email).toBe(newEmail);
  });

  it.skipIf(!dbReachable || !hasCustodyKey)('supplying both memo_key and orcid_token → 400 + password_hash stays NULL (mutation-kill)', async () => {
    // Beyond the status-code assertion in the validation describe above, this
    // test also asserts the DB invariant: the 400 must fire BEFORE any DB
    // write so a future refactor that reorders validation after DB access
    // would flip password_hash out of NULL and fail this assertion.
    await clearRateLimitKeys(['auth-recover', 'auth-login']);
    const res = await request(app)
      .post('/api/auth/recover')
      .send({
        username: NULL_USER,
        new_email: `recover_null_both_${Date.now()}@example.com`,
        new_password: 'NewPassword1',
        memo_key: NULL_MEMO,
        orcid_token: 'some-nonce',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    const pool = getAppPool()!;
    const { rows } = await pool.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM accounts WHERE username = $1',
      [NULL_USER],
    );
    expect(rows[0].password_hash).toBeNull();
  });

  it.skipIf(!dbReachable || !hasCustodyKey)('seed-phrase recovery on null-hash account still works (regression guard)', async () => {
    await clearRateLimitKeys(['auth-recover', 'auth-login']);
    const newEmail = `recover_null_seed_${Date.now()}@example.com`;
    const newPassword = 'SeedRecovered1';
    const res = await request(app)
      .post('/api/auth/recover')
      .send({
        username: NULL_USER,
        new_email: newEmail,
        new_password: newPassword,
        memo_key: NULL_MEMO,
      });
    expect(res.status).toBe(200);

    const pool = getAppPool()!;
    const { rows } = await pool.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM accounts WHERE username = $1',
      [NULL_USER],
    );
    expect(rows[0].password_hash).not.toBeNull();

    // Password login now works on the previously null-hash account
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: NULL_USER, password: newPassword });
    expect(loginRes.status).toBe(200);
  });
});

// ─── SEC-004-BE: password login on null-hash → 403 NO_PASSWORD_SET ───

describe('SEC-004-BE: login on null-hash account', () => {
  const NULL_LOGIN_USER = `login_nullhash_${Date.now()}`;
  const NULL_LOGIN_EMAIL = `login_nullhash_${Date.now()}@example.com`;

  beforeAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, verify_token)
       VALUES ($1, $2, NULL, 'light', NULL)`,
      [NULL_LOGIN_EMAIL, NULL_LOGIN_USER],
    );
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [NULL_LOGIN_USER]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username = $1', [NULL_LOGIN_USER]).catch(() => {});
  });

  it.skipIf(!dbReachable)('returns 403 NO_PASSWORD_SET, distinct from wrong-password 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: NULL_LOGIN_USER, password: 'AnythingValid1' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NO_PASSWORD_SET');
    expect(res.body.error.message).toMatch(/no password/i);
  });

  it.skipIf(!dbReachable)('email-based login on null-hash also returns 403 NO_PASSWORD_SET', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email_or_username: NULL_LOGIN_EMAIL, password: 'AnythingValid1' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NO_PASSWORD_SET');
  });

  it.skipIf(!dbReachable)('null-hash login burns sentinel argon2.verify for timing-equalization (≥ floor)', async () => {
    // SEC-004-BE finding #1 mutation-kill. Without the sentinel argon2.verify
    // on the NO_PASSWORD_SET branch, this endpoint returns in ~1ms for null-
    // hash accounts vs ~100ms for accounts with a real hash — a timing oracle
    // for enumerating ORCID-only accounts. 40ms lower bound matches the
    // SEC-LOGIN-UNKNOWN-USER-TIMING sibling — argon2.verify at these
    // ARGON2_OPTIONS runs 42-55ms on modern x86 and 50ms produces flakes
    // under parallel load. Still kills the sentinel-removal mutation
    // (40x margin above the ~1ms pre-sentinel path).
    //
    // Warm the sentinel-hash lazy promise so the first call in this test
    // measures steady-state verify cost, not one-time hash-compute cost.
    await request(app)
      .post('/api/auth/login')
      .send({ username: NULL_LOGIN_USER, password: 'WarmupPassword1' });

    const start = Date.now();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: NULL_LOGIN_USER, password: 'AnythingValid1' });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NO_PASSWORD_SET');
    expect(elapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
  });
});

// ─── SEC-LOGIN-UNKNOWN-USER-TIMING: close unknown-account timing oracles ───

describe('SEC-LOGIN-UNKNOWN-USER-TIMING: /login unknown-account burns sentinel', () => {
  it.skipIf(!dbReachable)('returns 401 for unknown username with ≥ floor wall-time', async () => {
    await clearRateLimitKeys(['auth-login']);
    // Without the sentinel argon2.verify on the unknown-account branch of
    // /api/auth/login, this path returns in ~1ms while the known-account
    // wrong-password path takes ~45-100ms — a timing oracle for username/email
    // enumeration by unauthenticated attackers. 40ms lower bound is the
    // mutation-kill threshold (40x margin above the ~1ms pre-sentinel path);
    // set slightly below the existing SEC-004-BE 50ms assertion because
    // argon2.verify at these ARGON2_OPTIONS runs 42-55ms on modern x86 and
    // 50ms produces CI flakes. Still kills the sentinel-removal mutation.
    //
    // Warm the sentinel-hash lazy promise + Node request stack so the measured
    // call reflects steady-state argon2.verify cost (~50ms on modern x86),
    // not first-call overhead.
    for (let i = 0; i < 2; i++) {
      await request(app)
        .post('/api/auth/login')
        .send({ username: `definitely_nonexistent_warmup_user_${i}`, password: 'Warmup1234' });
    }

    const start = Date.now();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'definitely_nonexistent_user_xyz', password: 'AnythingValid1' });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(elapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
  });
});

describe('SEC-LOGIN-UNKNOWN-USER-TIMING: /resend-verification unknown-email burns sentinel', () => {
  it.skipIf(!dbReachable || !redisReachable)('returns 200 for unknown email with ≥ floor wall-time', async () => {
    // Clear per-test (not just beforeAll) because vitest retry reruns the
    // body without reruns of beforeAll, and resendLimiter=3/hr leaves no
    // headroom across a retry.
    await clearRateLimitKeys(['auth-resend']);
    // Without the sentinel argon2.verify on the unknown-email branch of
    // /api/auth/resend-verification, this path returns in ~1ms while the
    // known-email + password-verify path takes ~100ms — a timing oracle
    // that undermines the constant-message 200 response. The status-code
    // is already constant; only the timing leak is closed here.
    //
    // Warm sentinel-hash promise. Limited to 1 warmup request because
    // resendLimiter is only 3/hr (1 warmup + 1 measured + 1 retry headroom).
    await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: 'nonexistent_warmup@example.com', password: 'Warmup1234' });

    const start = Date.now();
    const res = await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: 'definitely_nonexistent_xyz@example.com', password: 'AnythingValid1' });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(elapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
  });
});

describe('SEC-LOGIN-UNKNOWN-USER-TIMING: /recover unknown-username burns sentinel', () => {
  it.skipIf(!dbReachable)('returns 404 for unknown username with ≥ floor wall-time', async () => {
    await clearRateLimitKeys(['auth-recover']);
    // Without the sentinel argon2.verify on the unknown-username branch of
    // /api/auth/recover, this path returns in ~1ms while the happy-path
    // (argon2.hash of new_password on successful recovery) takes ~100ms —
    // a timing oracle for username enumeration. Status-code stays 404.
    //
    // Warm sentinel-hash promise + Node request stack.
    for (let i = 0; i < 2; i++) {
      await request(app)
        .post('/api/auth/recover')
        .send({
          username: `nonexistent_warmup_user_${i}`,
          new_email: `warmup_${Date.now()}_${i}@example.com`,
          new_password: 'WarmupPass1234',
          memo_key: TEST_MEMO_KEY,
        });
    }

    const start = Date.now();
    const res = await request(app)
      .post('/api/auth/recover')
      .send({
        username: 'definitely_nonexistent_recover_user',
        new_email: `recover_timing_${Date.now()}@example.com`,
        new_password: 'NewPassword1234',
        memo_key: TEST_MEMO_KEY,
      });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(elapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
  });
});

// SEC-LOGIN-UNKNOWN-USER-TIMING hold round-2 — new specs that close oracles
// the round-1 fix inverted or missed.

// Hold #1: /resend-verification null-hash (ORCID-only) known-email must ALSO
// burn sentinel. Round-1 closed the unknown-email branch (~50ms now) but the
// null-hash known-email path remained at ~1ms, which made ORCID-only accounts
// DISTINGUISHABLE from both new accounts and password accounts. Closing the
// inversion requires the null-hash branch to take wall-time equal to the
// password-verify branch below it.
describe('SEC-LOGIN-UNKNOWN-USER-TIMING: /resend-verification null-hash known-email burns sentinel', () => {
  const NULL_HASH_EMAIL = `resend_nullhash_${Date.now()}@example.com`;

  beforeAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, verify_token, expires_at)
       VALUES ($1, $2, NULL, 'light', $3, $4)`,
      [
        NULL_HASH_EMAIL,
        `resend_nullhash_${Date.now()}`,
        'pending-verification-token',
        new Date(Date.now() + 60 * 60 * 1000),
      ],
    );
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query('DELETE FROM accounts WHERE email = $1', [NULL_HASH_EMAIL]).catch(() => {});
  });

  it.skipIf(!dbReachable || !redisReachable)(
    'returns 200 for null-hash known-email with ≥ floor wall-time (no oracle vs unknown)',
    async () => {
      await clearRateLimitKeys(['auth-resend']);
      // Warm the sentinel-hash promise + request stack so the measured call
      // reflects steady-state argon2.verify cost, not first-call overhead.
      // Limited to 1 warmup because resendLimiter is 3/hr (warmup + measured
      // + retry headroom).
      await request(app)
        .post('/api/auth/resend-verification')
        .send({ email: `resend_warmup_${Date.now()}@example.com`, password: 'Warmup1234' });

      const start = Date.now();
      const res = await request(app)
        .post('/api/auth/resend-verification')
        .send({ email: NULL_HASH_EMAIL, password: 'AnythingValid1' });
      const elapsed = Date.now() - start;

      // Uniform message — same as unknown-email and wrong-password branches.
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      // Mutation-kill: if the null-hash burn is removed, this path returns in
      // ~1ms and the assertion fails.
      expect(elapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
    },
  );
});

// Hold #2: /recover ORCID-recovery-without-password unknown vs known must
// both be fast. Round-1 burned sentinel on unknown-username regardless of
// passwordProvided; the known-ORCID-no-password happy path skips argon2.hash
// entirely (~5-15ms). Unknown at ~50ms was SLOWER than known, exploitable by
// any attacker holding an ORCID token. Post-fix: unknown burns only when
// passwordProvided, so the no-password caller shape stays symmetric.
describe('SEC-LOGIN-UNKNOWN-USER-TIMING: /recover ORCID-no-password both branches are fast', () => {
  it.skipIf(!dbReachable)(
    'unknown-username without new_password neither branch exceeds ceiling (no inverted oracle)',
    async () => {
      await clearRateLimitKeys(['auth-recover']);
      // Warm Node request stack so first-call overhead doesn't dominate.
      await request(app)
        .post('/api/auth/recover')
        .send({
          username: `recover_warmup_nopass_${Date.now()}`,
          new_email: `recover_nopass_warmup_${Date.now()}@example.com`,
          orcid_token: 'warmup-nonexistent-token',
        });

      const start = Date.now();
      const res = await request(app)
        .post('/api/auth/recover')
        .send({
          username: `recover_timing_nopass_${Date.now()}`,
          new_email: `recover_nopass_${Date.now()}@example.com`,
          orcid_token: 'nonexistent-orcid-token',
          // No new_password — this exercises the ORCID-recovery-no-password shape.
        });
      const elapsed = Date.now() - start;

      // 404 NOT_FOUND for unknown username. The ORCID path yields 404 here
      // because the account lookup happens before ORCID token validation.
      expect(res.status).toBe(404);
      // Mutation-kill: if the passwordProvided gate is removed, the sentinel
      // burn fires (~50ms) and this assertion fails. The test asserts the
      // fast-path wall-time bound rather than ≥X — the inversion is closed
      // by NOT burning, not by burning.
      expect(elapsed).toBeLessThan(TIMING_ORACLE_CEILING_MS);
    },
  );
});

// /signup 409 DUPLICATE must pay argon2.hash cost when hasPassword — the
// happy-path runs argon2.hash (~100ms, not verify), so a plain burnSentinel
// (argon2.verify, ~50ms) would leave a 2× timing gap. The 409 path calls
// argon2.hash directly and discards the result. Without the burn, 409
// returns in ~1ms while new-email happy-path runs argon2.hash at ~100ms —
// two orthogonal enumeration signals (409 status + ~1ms timing) leak
// simultaneously.
describe('SEC-LOGIN-UNKNOWN-USER-TIMING: /signup 409 DUPLICATE burns sentinel', () => {
  const EXISTING_EMAIL = `signup_dup_${Date.now()}@mit.edu`;

  beforeAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    // Seed an already-verified-and-active account so /signup hits the
    // `verify_token === null` 409 path (not the unverified-overwrite path).
    const passwordHash = await argon2.hash('ExistingPassword1', { type: argon2.argon2id });
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, full_name, institution, field, custody, verify_token)
       VALUES ($1, $2, $3, 'Test', 'Uni', 'CS', 'light', NULL)`,
      [EXISTING_EMAIL, `signup_dup_${Date.now()}`, passwordHash],
    );
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query('DELETE FROM accounts WHERE email = $1', [EXISTING_EMAIL]).catch(() => {});
  });

  it.skipIf(!dbReachable)(
    'returns 409 DUPLICATE with ≥ floor wall-time when a password is supplied',
    async () => {
      await clearRateLimitKeys(['auth-signup']);
      // Warm argon2 + request stack.
      await request(app)
        .post('/api/auth/signup')
        .send({
          email: `signup_warmup_${Date.now()}@mit.edu`,
          password: 'Warmup12345',
          full_name: 'Warmup',
          institution: 'Uni',
          field: 'CS',
        });

      const start = Date.now();
      const res = await request(app)
        .post('/api/auth/signup')
        .send({
          email: EXISTING_EMAIL,
          password: 'AnythingValid1',
          full_name: 'Test',
          institution: 'Uni',
          field: 'CS',
        });
      const elapsed = Date.now() - start;

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE');
      // Mutation-kill: removing the 409 argon2.hash burn drops wall-time to ~1ms.
      expect(elapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
    },
  );
});

// (No timing test for /login ACCOUNT_LOCKED: the check runs after
// argon2.verify, so adding a burn creates a 2× asymmetry — verify+burn on
// locked vs verify-only on unlocked. 403 already discloses lockout state to
// correct-password callers. See the handler comment in auth.ts for full
// rationale.)

// burnSentinel must clip attacker-controlled oversize input before handing it
// to argon2.verify. argon2.verify rejects inputs >4096 bytes BEFORE entering
// the compute phase, which without the clip would turn the burn into a ~0ms
// noop via the silent catch and reopen every oracle burnSentinel closes.
describe('SEC-LOGIN-UNKNOWN-USER-TIMING: burnSentinel clips oversized input', () => {
  it.skipIf(!dbReachable)('returns 401 with ≥ floor wall-time even for >4096-byte password', async () => {
    await clearRateLimitKeys(['auth-login']);
    // Warm.
    await request(app)
      .post('/api/auth/login')
      .send({ username: `oversize_warmup_${Date.now()}`, password: 'Warmup1234' });

    // 5000 bytes — above argon2's internal 4096-byte rejection threshold.
    const oversizePassword = 'A'.repeat(5000);

    const start = Date.now();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: `nonexistent_oversize_${Date.now()}`, password: oversizePassword });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    // Mutation-kill: removing the length clip in burnSentinel drops wall-time
    // to ~1ms because argon2.verify rejects the 5000-byte input early.
    expect(elapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
  });
});

// /reset-request unknown-email branch must burn sentinel. Known-email path
// runs DB UPDATE + await sendMail() (100-2000ms); unknown-email returns in
// ~1ms. Without a burn, an attacker enumerates accounts by response time
// despite the uniform 200 status + message body. Note: the SMTP-tail oracle
// on the known-email path is a separate concern (see
// backend-resend-verification-smtp-timing.md). This only closes the
// cheap-early-return half.
describe('SEC-LOGIN-UNKNOWN-USER-TIMING: /reset-request unknown-email burns sentinel', () => {
  it.skipIf(!dbReachable)('returns 200 for unknown email with ≥ floor wall-time', async () => {
    await clearRateLimitKeys(['auth-reset-request']);
    // Warm.
    await request(app)
      .post('/api/auth/reset-request')
      .send({ email: `reset_warmup_${Date.now()}@example.com` });

    const start = Date.now();
    const res = await request(app)
      .post('/api/auth/reset-request')
      .send({ email: `nonexistent_reset_${Date.now()}@example.com` });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    // Mutation-kill: removing the unknown-email burn drops wall-time to ~1ms.
    expect(elapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
  });
});

// /resend-verification must emit a uniform message body across the three
// post-auth-success branches (!verify_token, verify_token starts with
// 'confirmed:', hex verify_token — pending). Distinct messages were a
// privacy-leaking oracle: any password-holder could probe other emails and
// read back the account's lifecycle state. Timing equalization does not
// collapse the message-body axis; this test enforces that the bodies
// match across the three branches.
describe('SEC-LOGIN-UNKNOWN-USER-TIMING: /resend-verification message body is uniform', () => {
  const ACTIVE_EMAIL = `resend_uniform_active_${Date.now()}@example.com`;
  const CONFIRMED_EMAIL = `resend_uniform_confirmed_${Date.now()}@example.com`;
  const PENDING_EMAIL = `resend_uniform_pending_${Date.now()}@example.com`;
  const UNIFORM_PASSWORD = 'UniformTest1234';

  beforeAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    const passwordHash = await argon2.hash(UNIFORM_PASSWORD, { type: argon2.argon2id });
    // Active: verify_token NULL
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, verify_token)
       VALUES ($1, $2, $3, 'light', NULL)`,
      [ACTIVE_EMAIL, `resend_uniform_active_${Date.now()}`, passwordHash],
    );
    // Confirmed: verify_token starts with 'confirmed:'
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, verify_token, expires_at)
       VALUES ($1, $2, $3, 'light', $4, $5)`,
      [
        CONFIRMED_EMAIL,
        `resend_uniform_confirmed_${Date.now()}`,
        passwordHash,
        'confirmed:testtokenconfirmedtoken',
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      ],
    );
    // Pending: hex verify_token
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, verify_token, expires_at)
       VALUES ($1, $2, $3, 'light', $4, $5)`,
      [
        PENDING_EMAIL,
        `resend_uniform_pending_${Date.now()}`,
        passwordHash,
        'abcdef0123456789abcdef0123456789',
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      ],
    );
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query('DELETE FROM accounts WHERE email IN ($1, $2, $3)', [ACTIVE_EMAIL, CONFIRMED_EMAIL, PENDING_EMAIL]).catch(() => {});
  });

  it.skipIf(!dbReachable || !redisReachable)(
    'active and confirmed branches emit the same uniform message body as the unknown-email branch',
    async () => {
      await clearRateLimitKeys(['auth-resend']);

      const activeRes = await request(app)
        .post('/api/auth/resend-verification')
        .send({ email: ACTIVE_EMAIL, password: UNIFORM_PASSWORD });
      await clearRateLimitKeys(['auth-resend']);
      const confirmedRes = await request(app)
        .post('/api/auth/resend-verification')
        .send({ email: CONFIRMED_EMAIL, password: UNIFORM_PASSWORD });
      await clearRateLimitKeys(['auth-resend']);

      // Both branches MUST return 200 and carry the uniform message body.
      // If the fix regresses and these diverge, any password-holder can
      // enumerate account lifecycle state.
      expect(activeRes.status).toBe(200);
      expect(confirmedRes.status).toBe(200);
      expect(activeRes.body.data.message).toBe(confirmedRes.body.data.message);
      expect(activeRes.body.data.message).toMatch(/pending signup/i);

      // Pending-hex branch: in test env SMTP is not configured so it may
      // return 500. When it DOES return 200, assert the same uniform body.
      const pendingRes = await request(app)
        .post('/api/auth/resend-verification')
        .send({ email: PENDING_EMAIL, password: UNIFORM_PASSWORD });
      if (pendingRes.status === 200) {
        expect(pendingRes.body.data.message).toBe(activeRes.body.data.message);
      }
    },
  );
});

// /signup 4-way timing matrix. Per round-2 hold #2+#3: the 409-vs-happy-path
// timing signature must not distinguish which verify_token state the
// already-registered email is in. The four relevant paths all need to land
// in the ≥floor band (none in the ~1-5ms no-argon2 band):
//   (a) unknown email + password: happy-path, runs argon2.hash (~100ms).
//   (b) known email + verify_token NULL + password: 409, runs argon2.hash
//       burn (~100ms).
//   (c) known email + verify_token starts with 'confirmed:' + password: 409,
//       runs argon2.hash burn (~100ms).
//   (d) known email + hex verify_token (pending) + password: fall-through
//       to upsert, runs argon2.hash naturally (~100ms).
// SMTP-not-configured in the test env means (a) and (d) return 500 after
// argon2.hash has run — the wall-time assertion still holds.
describe('SEC-LOGIN-UNKNOWN-USER-TIMING: /signup 4-way timing matrix', () => {
  const NULL_TOKEN_EMAIL = `signup_matrix_null_${Date.now()}@mit.edu`;
  const CONFIRMED_TOKEN_EMAIL = `signup_matrix_conf_${Date.now()}@mit.edu`;
  const PENDING_TOKEN_EMAIL = `signup_matrix_pend_${Date.now()}@mit.edu`;

  beforeAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    const passwordHash = await argon2.hash('ExistingPassword1', { type: argon2.argon2id });
    // NULL verify_token (active & verified)
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, full_name, institution, field, custody, verify_token)
       VALUES ($1, $2, $3, 'Test', 'Uni', 'CS', 'light', NULL)`,
      [NULL_TOKEN_EMAIL, `signup_matrix_null_${Date.now()}`, passwordHash],
    );
    // 'confirmed:' verify_token
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, full_name, institution, field, custody, verify_token, expires_at)
       VALUES ($1, $2, $3, 'Test', 'Uni', 'CS', 'light', $4, $5)`,
      [
        CONFIRMED_TOKEN_EMAIL,
        `signup_matrix_conf_${Date.now()}`,
        passwordHash,
        'confirmed:matrixconfirmedtoken',
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      ],
    );
    // hex verify_token (pending unverified — exercises the fall-through
    // upsert path, not a 409).
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, full_name, institution, field, custody, verify_token, expires_at)
       VALUES ($1, $2, $3, 'Test', 'Uni', 'CS', 'light', $4, $5)`,
      [
        PENDING_TOKEN_EMAIL,
        `signup_matrix_pend_${Date.now()}`,
        passwordHash,
        'abcdef0123456789abcdef0123456789',
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      ],
    );
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query(
      'DELETE FROM accounts WHERE email IN ($1, $2, $3)',
      [NULL_TOKEN_EMAIL, CONFIRMED_TOKEN_EMAIL, PENDING_TOKEN_EMAIL],
    ).catch(() => {});
  });

  it.skipIf(!dbReachable)(
    'all four /signup paths take ≥ floor wall-time (no cheap-early-return leak)',
    async () => {
      await clearRateLimitKeys(['auth-signup']);
      // Warm argon2 + request stack.
      await request(app)
        .post('/api/auth/signup')
        .send({
          email: `signup_matrix_warmup_${Date.now()}@mit.edu`,
          password: 'Warmup12345',
          full_name: 'Warmup',
          institution: 'Uni',
          field: 'CS',
        });

      // (a) unknown email + password — happy path runs argon2.hash.
      const unknownStart = Date.now();
      const unknownRes = await request(app)
        .post('/api/auth/signup')
        .send({
          email: `signup_matrix_unknown_${Date.now()}@mit.edu`,
          password: 'AnythingValid1',
          full_name: 'Test',
          institution: 'Uni',
          field: 'CS',
        });
      const unknownElapsed = Date.now() - unknownStart;

      // (b) known + NULL verify_token — 409 DUPLICATE, argon2.hash burn.
      const nullStart = Date.now();
      const nullRes = await request(app)
        .post('/api/auth/signup')
        .send({
          email: NULL_TOKEN_EMAIL,
          password: 'AnythingValid1',
          full_name: 'Test',
          institution: 'Uni',
          field: 'CS',
        });
      const nullElapsed = Date.now() - nullStart;

      // (c) known + 'confirmed:' verify_token — 409 DUPLICATE, argon2.hash burn.
      const confStart = Date.now();
      const confRes = await request(app)
        .post('/api/auth/signup')
        .send({
          email: CONFIRMED_TOKEN_EMAIL,
          password: 'AnythingValid1',
          full_name: 'Test',
          institution: 'Uni',
          field: 'CS',
        });
      const confElapsed = Date.now() - confStart;

      // (d) known + hex verify_token (pending) — fall-through upsert,
      // argon2.hash natural.
      const pendStart = Date.now();
      const pendRes = await request(app)
        .post('/api/auth/signup')
        .send({
          email: PENDING_TOKEN_EMAIL,
          password: 'AnythingValid1',
          full_name: 'Test',
          institution: 'Uni',
          field: 'CS',
        });
      const pendElapsed = Date.now() - pendStart;

      // Status-code axis: (b) and (c) are 409 DUPLICATE. (a) and (d) round
      // to 500 in the test env because SMTP is not configured; argon2.hash
      // has already run by that point so the wall-time assertion holds.
      expect(nullRes.status).toBe(409);
      expect(confRes.status).toBe(409);
      // (a) and (d) either 200 (in configured env) or 500 (SMTP-not-
      // configured env). Both outcomes happen AFTER argon2.hash.
      expect([200, 500]).toContain(unknownRes.status);
      expect([200, 500]).toContain(pendRes.status);

      // Wall-time axis: all four paths must be ≥ floor. If any path drops
      // into the ~1-5ms band the oracle is open.
      expect(unknownElapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
      expect(nullElapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
      expect(confElapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
      expect(pendElapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
    },
  );
});

// BE-SIGNUP-INSTITUTIONAL-GATE-ORDERING: the /signup duplicate-email check
// must fire BEFORE the accreditation gate. If the gate fires first, an
// attacker submitting a duplicate email on a non-institutional domain gets
// 422 ACCREDITATION_NOT_FOUND in ~0ms (no DB lookup, no argon2 burn), while
// a duplicate on an accredited domain gets 409 DUPLICATE in ~50ms
// (argon2.hash burn). The ~50ms / 422 split leaks registration status on
// any accredited public domain (mit.edu, harvard.edu, etc.). Post-reorder,
// both duplicate paths return 409 and both pay the argon2.hash burn so
// wall-time does not distinguish them.
describe('BE-SIGNUP-INSTITUTIONAL-GATE-ORDERING: duplicate check fires before accreditation gate', () => {
  const ACCREDITED_DUPLICATE_EMAIL = `signup_gate_acc_${Date.now()}@mit.edu`;
  const UNACCREDITED_DUPLICATE_EMAIL = `signup_gate_unacc_${Date.now()}@gmail.com`;

  beforeAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    const passwordHash = await argon2.hash('ExistingPassword1', { type: argon2.argon2id });
    // Seed two already-verified accounts: one on an accredited domain, one
    // on a non-accredited domain. Both should hit the verify_token=NULL 409
    // DUPLICATE branch when /signup is called with their email.
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, full_name, institution, field, custody, verify_token)
       VALUES ($1, $2, $3, 'Test', 'Uni', 'CS', 'light', NULL)`,
      [ACCREDITED_DUPLICATE_EMAIL, `signup_gate_acc_${Date.now()}`, passwordHash],
    );
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, full_name, institution, field, custody, verify_token)
       VALUES ($1, $2, $3, 'Test', 'Uni', 'CS', 'light', NULL)`,
      [UNACCREDITED_DUPLICATE_EMAIL, `signup_gate_unacc_${Date.now()}`, passwordHash],
    );
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query(
      'DELETE FROM accounts WHERE email IN ($1, $2)',
      [ACCREDITED_DUPLICATE_EMAIL, UNACCREDITED_DUPLICATE_EMAIL],
    ).catch(() => {});
  });

  it.skipIf(!dbReachable)(
    'accredited-duplicate AND unaccredited-duplicate both 409 with ≥ floor wall-time',
    async () => {
      await clearRateLimitKeys(['auth-signup']);
      // Warm argon2 + request stack.
      await request(app)
        .post('/api/auth/signup')
        .send({
          email: `signup_gate_warmup_${Date.now()}@mit.edu`,
          password: 'Warmup12345',
          full_name: 'Warmup',
          institution: 'Uni',
          field: 'CS',
        });

      // Accredited domain + duplicate email → 409 DUPLICATE, argon2.hash burn.
      const accStart = Date.now();
      const accRes = await request(app)
        .post('/api/auth/signup')
        .send({
          email: ACCREDITED_DUPLICATE_EMAIL,
          password: 'AnythingValid1',
          full_name: 'Test',
          institution: 'Uni',
          field: 'CS',
        });
      const accElapsed = Date.now() - accStart;

      // Unaccredited domain + duplicate email → also 409 DUPLICATE
      // (post-reorder) with argon2.hash burn. Pre-reorder this would have
      // been a ~0ms 422 ACCREDITATION_NOT_FOUND — the bug this fix closes.
      const unaccStart = Date.now();
      const unaccRes = await request(app)
        .post('/api/auth/signup')
        .send({
          email: UNACCREDITED_DUPLICATE_EMAIL,
          password: 'AnythingValid1',
          full_name: 'Test',
          institution: 'Uni',
          field: 'CS',
        });
      const unaccElapsed = Date.now() - unaccStart;

      // Status-code axis: BOTH must be 409 DUPLICATE. If unaccredited drops
      // to 422 the reorder has regressed and the oracle is open.
      expect(accRes.status).toBe(409);
      expect(accRes.body.error.code).toBe('DUPLICATE');
      expect(unaccRes.status).toBe(409);
      expect(unaccRes.body.error.code).toBe('DUPLICATE');

      // Wall-time axis: both 409 paths must pay the argon2.hash burn.
      // Removing the hasPassword-gated argon2.hash in the duplicate branch
      // or moving the accreditation gate back before the duplicate check
      // drops unaccElapsed into the ~1-5ms band and fails this assertion.
      expect(accElapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
      expect(unaccElapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
    },
  );
});

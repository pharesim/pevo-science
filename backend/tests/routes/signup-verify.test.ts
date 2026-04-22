import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';

// Mock chain-broadcasting bits before createApp() so the confirm flow does not
// hit the real Hive network. We still use the real argon2, real pg pool, and
// real verifyHiveSignature — the SEC-004-BE deliverable explicitly rules out
// mock-auth for these tests.
const { getAccountsMock, broadcastJsonMock, createClaimedAccountMock } = vi.hoisted(() => ({
  getAccountsMock: vi.fn().mockResolvedValue([]),
  broadcastJsonMock: vi.fn().mockResolvedValue({ id: 'mock-tx' }),
  createClaimedAccountMock: vi.fn().mockResolvedValue({ block_num: 12345 }),
}));

vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: { getAccounts: getAccountsMock },
    broadcast: { json: broadcastJsonMock },
  },
  broadcastJsonWithTimeout: (...args: unknown[]) =>
    (broadcastJsonMock as (...a: unknown[]) => unknown)(...args),
  // Mirror the real BroadcastTimeoutError shape (timeoutMs ctor arg) so code
  // under test that reads `err.timeoutMs` after `instanceof` discrimination
  // gets the property rather than undefined. signup-verify treats accreditation
  // broadcast as best-effort: failures (including timeouts) are logged and the
  // confirm flow returns 200 regardless, so no 504 surface to test here. This
  // mirror protects against latent false-confidence if the log structure or
  // discrimination semantics change later.
  BroadcastTimeoutError: class BroadcastTimeoutError extends Error {
    public readonly timeoutMs: number;
    constructor(timeoutMs: number) {
      super(`Hive broadcast timed out after ${timeoutMs}ms`);
      this.name = 'BroadcastTimeoutError';
      this.timeoutMs = timeoutMs;
    }
  },
  DEFAULT_BROADCAST_TIMEOUT_MS: 30_000,
}));

vi.mock('../../src/account-creation.js', () => ({
  createClaimedAccount: createClaimedAccountMock,
  startAccountCreationWorker: vi.fn(),
  stopAccountCreationWorker: vi.fn(),
}));

import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { orcidVerified } from '../../src/routes/orcid.js';
import { config } from '../../src/config.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';

// Encryption key must be configured for `/confirm` (encryptKey on posting/memo)
if (!process.env.CUSTODY_ENCRYPTION_KEY || process.env.CUSTODY_ENCRYPTION_KEY.length < 32) {
  process.env.CUSTODY_ENCRYPTION_KEY = 'test-custody-encryption-key-32chars!';
}
// Admin key optional — if unset, the accreditation broadcast is skipped silently
config.pevoAdminPostingKey = config.pevoAdminPostingKey || PrivateKey.fromSeed('sec-004-be-admin').toString();

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

async function cleanupByEmail(email: string) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query("DELETE FROM custody_audit_log WHERE username LIKE 'sec004be_%'").catch(() => {});
  await pool.query('DELETE FROM accounts WHERE email = $1', [email]).catch(() => {});
}

async function cleanupByUsername(username: string) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [username]).catch(() => {});
  await pool.query('DELETE FROM accounts WHERE username = $1', [username]).catch(() => {});
}

afterEach(() => {
  getAccountsMock.mockReset();
  getAccountsMock.mockResolvedValue([]); // default: username available
  createClaimedAccountMock.mockReset();
  createClaimedAccountMock.mockResolvedValue({ block_num: 12345 });
  broadcastJsonMock.mockReset();
  broadcastJsonMock.mockResolvedValue({ id: 'mock-tx' });
});

/**
 * Seed a verified-ORCID nonce into Redis (if available) and the in-memory map.
 * The signup/recover routes read Redis first when it's available, so both
 * stores must be primed to work regardless of the test environment.
 * Single-use: consumed by /signup or /recover on first read.
 */
async function seedOrcidNonce(nonce: string, orcidId: string, name = 'Test Researcher') {
  const { getRedis, isRedisAvailable } = await import('../../src/redis.js');
  const payload = { orcid_id: orcidId, works_count: 5, name };
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(`${config.appTag}:orcid_verified:${nonce}`, JSON.stringify(payload), 'EX', 600);
  }
  orcidVerified.set(nonce, { ...payload, expires: Date.now() + 10 * 60_000 });
}

// ──────────────────────────────────────────────────────────────
// Action 1 — ORCID signup with NO password → confirm → null hash
// ──────────────────────────────────────────────────────────────

// Hive usernames must match /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/ — no underscores,
// must start/end alphanumeric. Derive a short suffix from RUN_ID that fits.
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-6);

describe.skipIf(!dbReachable)('SEC-004-BE: ORCID signup + confirm without password', () => {
  const username = `sec004np${SUFFIX}`;
  const email = `sec004be_no_${RUN_ID}@example.com`;
  const orcidId = '0000-0001-0000-0001';
  const nonce = `sec004be-nonce-no-${RUN_ID}`;

  beforeAll(async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
  });

  afterAll(async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
  });

  it('stores password_hash = NULL end-to-end and confirm succeeds', async () => {
    await clearRateLimitKeys(['auth-signup', 'signup-confirm']);
    await seedOrcidNonce(nonce, orcidId);

    // /signup with orcid_token + no password
    const signupRes = await request(app)
      .post('/api/auth/signup')
      .send({
        email,
        full_name: 'Test Researcher',
        institution: 'MIT',
        field: 'physics',
        orcid_token: nonce,
      });
    expect(signupRes.status).toBe(200);
    const authToken = signupRes.body.data.auth_token as string;
    expect(authToken).toMatch(/^confirmed:/);

    // DB assertion: password_hash is NULL
    const pool = getAppPool()!;
    const pre = await pool.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM accounts WHERE email = $1',
      [email],
    );
    expect(pre.rows[0].password_hash).toBeNull();

    // /confirm with client-side keys — should succeed regardless of null password_hash
    getAccountsMock.mockImplementation(async (names: string[]) => {
      // Username must not exist yet (available), but after creation the
      // middleware may not look it up again in this flow.
      if (names.includes(username)) return [];
      return [];
    });

    const confirmRes = await request(app)
      .post('/api/auth/confirm')
      .send({
        auth_token: authToken,
        username,
        keys: {
          owner_public: PrivateKey.fromSeed(`${username}-o`).createPublic().toString(),
          active_public: PrivateKey.fromSeed(`${username}-a`).createPublic().toString(),
          posting_public: PrivateKey.fromSeed(`${username}-p`).createPublic().toString(),
          memo_public: PrivateKey.fromSeed(`${username}-m`).createPublic().toString(),
          posting_private: PrivateKey.fromSeed(`${username}-p`).toString(),
          memo_private: PrivateKey.fromSeed(`${username}-m`).toString(),
        },
      });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.data.username).toBe(username);

    // Post-confirm: row has username + custody='light', password_hash still null
    const post = await pool.query<{ password_hash: string | null; custody: string | null }>(
      'SELECT password_hash, custody FROM accounts WHERE username = $1',
      [username],
    );
    expect(post.rows[0].password_hash).toBeNull();
    expect(post.rows[0].custody).toBe('light');
  });
});

// ──────────────────────────────────────────────────────────────
// Action 2 — ORCID signup WITH password → login works
// ──────────────────────────────────────────────────────────────

describe.skipIf(!dbReachable)('SEC-004-BE: ORCID signup + confirm WITH password', () => {
  const username = `sec004wp${SUFFIX}`;
  const email = `sec004be_wp_${RUN_ID}@example.com`;
  const password = 'OrcidOptIn1';
  const orcidId = '0000-0001-0000-0002';
  const nonce = `sec004be-nonce-wp-${RUN_ID}`;

  beforeAll(async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
  });

  afterAll(async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
  });

  it('stores password_hash, confirm succeeds, password login works', async () => {
    await clearRateLimitKeys(['auth-signup', 'signup-confirm']);
    await seedOrcidNonce(nonce, orcidId);

    const signupRes = await request(app)
      .post('/api/auth/signup')
      .send({
        email,
        password,
        full_name: 'Test Researcher WP',
        institution: 'MIT',
        field: 'physics',
        orcid_token: nonce,
      });
    expect(signupRes.status).toBe(200);
    const authToken = signupRes.body.data.auth_token as string;

    const pool = getAppPool()!;
    const pre = await pool.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM accounts WHERE email = $1',
      [email],
    );
    expect(pre.rows[0].password_hash).not.toBeNull();

    const confirmRes = await request(app)
      .post('/api/auth/confirm')
      .send({
        auth_token: authToken,
        username,
        keys: {
          owner_public: PrivateKey.fromSeed(`${username}-o`).createPublic().toString(),
          active_public: PrivateKey.fromSeed(`${username}-a`).createPublic().toString(),
          posting_public: PrivateKey.fromSeed(`${username}-p`).createPublic().toString(),
          memo_public: PrivateKey.fromSeed(`${username}-m`).createPublic().toString(),
          posting_private: PrivateKey.fromSeed(`${username}-p`).toString(),
          memo_private: PrivateKey.fromSeed(`${username}-m`).toString(),
        },
      });
    expect(confirmRes.status).toBe(200);

    // Password login works
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username, password });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.data.token).toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────────
// BE-AUTH-RESUME-SIGNUP-TIMING-GUARD — close unknown-email timing
// oracle on /api/auth/resume-signup. Mirrors the three sibling
// timing specs in recover.test.ts (unknown-user on /login, /recover,
// /resend-verification). The FLOOR value is identical (35ms) because
// the mutation-kill threshold is set by argon2.verify wall-time at
// our ARGON2_OPTIONS, not by the endpoint under test.
// ──────────────────────────────────────────────────────────────

// Duplicated from recover.test.ts to keep each route test file self-
// contained. See that file for the rationale on 35ms (reference hardware
// argon2.verify runs 42-55ms; faster CI drops to high-20s; 35ms still
// kills the sentinel-removal mutation at ≥35× margin over the ~1ms
// pre-sentinel path).
const TIMING_ORACLE_FLOOR_MS = 35;

describe('BE-AUTH-RESUME-SIGNUP-TIMING-GUARD: /resume-signup unknown-email burns sentinel', () => {
  it.skipIf(!dbReachable)('returns 400 for unknown email with ≥ floor wall-time', async () => {
    await clearRateLimitKeys(['signup-resume']);
    // Without the sentinel argon2.verify on the unknown-email branch of
    // /api/auth/resume-signup, this path returns in ~1ms while the known-
    // email-in-confirmed-signup-state branch pays argon2.verify (~50ms) —
    // an enumeration oracle that leaks which emails sit in a resumable
    // state. Status-code stays 400.
    //
    // Warm the sentinel-hash lazy promise + Node request stack so the
    // measured call reflects steady-state argon2.verify cost, not first-
    // call overhead. resumeLimiter is 5/hr per IP (1 warmup + 1 measured
    // + 3 retry headroom).
    await request(app)
      .post('/api/auth/resume-signup')
      .send({ email: 'resume_warmup@example.com', password: 'Warmup1234' });

    const start = Date.now();
    const res = await request(app)
      .post('/api/auth/resume-signup')
      .send({ email: 'definitely_nonexistent_resume_xyz@example.com', password: 'AnythingValid1' });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(elapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
  });
});

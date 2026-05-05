import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { PrivateKey, cryptoUtils } from '@hiveio/dhive';

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
import { logger } from '../../src/logger.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';
import { TIMING_ORACLE_FLOOR_MS } from '../support/timing-constants.js';

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

// TIMING_ORACLE_FLOOR_MS lives in ../support/timing-constants.ts; see that
// file for the argon2-tuning rationale on the 35ms floor.

// Round-2 parametrization: the oracle closes across THREE branches that all
// must equal the confirmed+wrong-password wall-time (~argon2.verify cost):
//   (a) unknown-email                 → rows.length === 0 early-return
//   (b) non-confirmed-state           → row exists, verify_token not
//                                       `confirmed:…` (raw 64-hex pre-verify)
//   (c) ORCID-only confirmed          → row confirmed, password_hash IS NULL
//                                       (ORCID-autopath with no password)
// Each scenario must pay argon2.verify wall-time before the 400 return, or
// an attacker can enumerate which (email, lifecycle-state) tuples exist.
type ResumeTimingScenario = {
  label: string;
  email: string;
};
const TIMING_RUN_ID = Date.now();

describe.skipIf(!dbReachable)('BE-AUTH-RESUME-SIGNUP-TIMING-GUARD: /resume-signup burns sentinel on all non-verify-path branches', () => {
  const pool = dbReachable ? getAppPool()! : null;

  const unknownEmail = `resume_unknown_${TIMING_RUN_ID}@example.com`;
  const nonConfirmedEmail = `resume_nonconfirmed_${TIMING_RUN_ID}@example.com`;
  const orcidOnlyEmail = `resume_orcidonly_${TIMING_RUN_ID}@example.com`;

  beforeAll(async () => {
    if (!pool) return;
    // Clean any prior rows
    await pool.query('DELETE FROM accounts WHERE email = ANY($1)', [
      [unknownEmail, nonConfirmedEmail, orcidOnlyEmail],
    ]).catch(() => {});
    // Seed (b): non-confirmed-state — raw 64-hex verify_token (pre-email-verify lifecycle).
    // password_hash is a real argon2 hash so the real surface the guard protects
    // (confirmed-branch burn) is symmetric with this row.
    const fakeHash = '$argon2id$v=19$m=65536,t=3,p=4$aaaaaaaaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const rawHexToken = 'a'.repeat(64);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO accounts (email, password_hash, full_name, institution, field, orcid, verify_token, expires_at)
       VALUES ($1, $2, 'Timing Nonconfirmed', 'MIT', 'physics', NULL, $3, $4)`,
      [nonConfirmedEmail, fakeHash, rawHexToken, expiresAt],
    );
    // Seed (c): ORCID-only confirmed — password_hash = NULL, verify_token = 'confirmed:…'
    const confirmedToken = `confirmed:${'c'.repeat(64)}`;
    await pool.query(
      `INSERT INTO accounts (email, password_hash, full_name, institution, field, orcid, verify_token, expires_at)
       VALUES ($1, NULL, 'Timing ORCID', 'MIT', 'physics', '0000-0001-0000-9999', $2, $3)`,
      [orcidOnlyEmail, confirmedToken, expiresAt],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM accounts WHERE email = ANY($1)', [
      [unknownEmail, nonConfirmedEmail, orcidOnlyEmail],
    ]).catch(() => {});
  });

  const scenarios: ResumeTimingScenario[] = [
    { label: 'unknown-email (no row)', email: unknownEmail },
    { label: 'non-confirmed-state (raw 64-hex verify_token)', email: nonConfirmedEmail },
    { label: 'ORCID-only confirmed (null password_hash)', email: orcidOnlyEmail },
  ];

  it.each(scenarios)('returns 400 with ≥ floor wall-time for $label', async ({ email }) => {
    await clearRateLimitKeys(['signup-resume']);

    // Warm the sentinel-hash lazy promise + Node request stack so the
    // measured call reflects steady-state argon2.verify cost, not first-
    // call overhead. resumeLimiter is 5/hr per IP but we clear it above,
    // so 1 warmup + 1 measured is fine per scenario.
    await request(app)
      .post('/api/auth/resume-signup')
      .send({ email: `resume_warmup_${TIMING_RUN_ID}@example.com`, password: 'Warmup1234' });

    const start = Date.now();
    const res = await request(app)
      .post('/api/auth/resume-signup')
      .send({ email, password: 'AnythingValid1' });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(elapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
  });
});

// ──────────────────────────────────────────────────────────────
// BE-LOG-PII-EMAIL-HASH round-1 hold item 2c: ORCID-only broadcast-rejection
// harness. Pins both halves of the round-1 P1 fix on the /confirm and /link
// catch-block log emissions:
//
//   (1) account.email IS NULL (ORCID-only signup state). Pre-fix
//       hashEmailForLogs(account.email) called null.trim() and threw a
//       synchronous TypeError, which propagated to the outer catch and
//       converted the recoverable `logger.error + 200 + JWT` flow into a
//       500 INTERNAL_ERROR. The post-fix path uses safeHashEmailForLogs and
//       returns email_hash: null, then proceeds to the 200 + JWT response.
//   (2) The log payload carries email_hash (null on this branch), NOT a
//       top-level `email` key. A regression that reverts to plaintext shape
//       fails the negative assertion.
//
// Without these specs, a revert of either fix passes every other suite. The
// harness shape (account.email = NULL row + broadcastJsonMock rejecting) is
// the strict subset called for by the architect's hold block — once it lands
// the email_hash/email-shape checks are one extra line each.
// ──────────────────────────────────────────────────────────────

const PII_RUN_ID = Date.now();
const PII_SUFFIX = (PII_RUN_ID % 100000).toString(36).padStart(4, '0').slice(-6);

describe.skipIf(!dbReachable)('BE-LOG-PII-EMAIL-HASH item 2c: /confirm broadcast-rejection on ORCID-only (email=NULL) row logs email_hash safely, returns 502 BROADCAST_FAILED', () => {
  const username = `piinul${PII_SUFFIX}`;
  const orcidId = '0000-0001-0000-1234';
  const confirmedToken = `confirmed:${'a1b2c3d4'.repeat(8)}`;

  beforeAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await cleanupByUsername(username);
    // Seed the ORCID-only signup row: email = NULL, password_hash = NULL,
    // verify_token = 'confirmed:…' (post-/signup state, pre-/confirm).
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO accounts (email, password_hash, full_name, institution, field, orcid, verify_token, expires_at)
       VALUES (NULL, NULL, 'PII Null Confirm', 'MIT', 'physics', $1, $2, $3)`,
      [orcidId, confirmedToken, expiresAt],
    );
  });

  afterAll(async () => {
    await cleanupByUsername(username);
  });

  it('logs email_hash:undefined with no top-level email key, then returns 502 BROADCAST_FAILED (no JWT)', async () => {
    await clearRateLimitKeys(['auth-signup', 'signup-confirm']);

    // The accreditation broadcast in the catch path is the failure we stage.
    // createClaimedAccount stays at its default success — the broadcast catch
    // is what exercises the safeHashEmailForLogs(account.email) call site.
    // Per BACKEND-REPUTATION-SSOT round-1 hold #8: broadcast failure now
    // produces 502 BROADCAST_FAILED instead of the prior 200 + dangling JWT.
    // The PII-safe email_hash invariant still holds via the structured log
    // emitted by handleBroadcastError.
    broadcastJsonMock.mockReset();
    broadcastJsonMock.mockRejectedValue(new Error('RPC node rejected: insufficient RC'));
    // Username lookup at line 264 must return [] (Hive-side username is
    // available — createClaimedAccount can claim it).
    getAccountsMock.mockReset();
    getAccountsMock.mockResolvedValue([]);

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    try {
      const res = await request(app)
        .post('/api/auth/confirm')
        .send({
          auth_token: confirmedToken,
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

      // Post-fix: broadcast failure surfaces 502 BROADCAST_FAILED, NOT 200 +
      // JWT (the prior dangling-JWT class). The user must NOT receive a
      // session for an account whose chain op never landed.
      expect(res.status).toBe(502);
      expect(res.body.status).toBe('error');
      expect(res.body.error?.code).toBe('BROADCAST_FAILED');
      expect(res.body.data?.token).toBeFalsy();

      const emission = errorSpy.mock.calls.find(
        ([, msg]) =>
          typeof msg === 'string' &&
          msg.includes('signup_verify.confirm broadcast failed'),
      );
      expect(emission, 'expected broadcast-failure logger.error emission in /confirm').toBeDefined();
      const [payload] = emission!;
      const obj = payload as Record<string, unknown>;
      // The LogContext interface required `email_hash?: string`, so the route
      // passes `email_hash: safeHashEmailForLogs(account.email) ?? undefined`.
      // For ORCID-only signups (email = NULL), the field is absent (vs the
      // pre-fix `email_hash: null`). The PII invariant — no top-level `email`
      // key, no raw email value anywhere in the structured log — is what
      // matters and remains pinned below.
      expect(obj).not.toHaveProperty('email');
      expect(obj.email_hash).toBeUndefined();
      expect(obj.username).toBe(username);
      expect(obj.orcid).toBe(orcidId);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// /link uses the real verifyHiveSignature middleware (per file header
// comment, mock-auth is ruled out for these tests). The harness signs a
// request-bound message with a deterministic test private key and primes
// getAccountsMock to publish the matching public key on the test username,
// so middleware succeeds end-to-end against the real signature path. No
// mock-auth fixture is reused here.
describe.skipIf(!dbReachable)('BE-LOG-PII-EMAIL-HASH item 2c: /link broadcast-rejection on ORCID-only (email=NULL) row logs email_hash safely, returns 502 BROADCAST_FAILED', () => {
  const username = `piilink${PII_SUFFIX}`;
  const orcidId = '0000-0001-0000-5678';
  const confirmedToken = `confirmed:${'b2c3d4e5'.repeat(8)}`;
  const TEST_KEY = PrivateKey.fromSeed(`pii-link-${PII_SUFFIX}`);
  const TEST_PUB = TEST_KEY.createPublic().toString();

  beforeAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await cleanupByUsername(username);
    // Seed the ORCID-only signup row: email = NULL, ready for /link.
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO accounts (email, password_hash, full_name, institution, field, orcid, verify_token, expires_at)
       VALUES (NULL, NULL, 'PII Null Link', 'MIT', 'physics', $1, $2, $3)`,
      [orcidId, confirmedToken, expiresAt],
    );
  });

  afterAll(async () => {
    await cleanupByUsername(username);
  });

  function signRequestBound(method: string, fullPath: string, body: unknown, timestamp: string): string {
    const bodyHash = cryptoUtils.sha256(JSON.stringify(body || {})).toString('hex');
    const msg = `${config.appTag}-auth|v1|${method}|${fullPath}|${bodyHash}|${timestamp}`;
    const msgHash = cryptoUtils.sha256(msg);
    return TEST_KEY.sign(msgHash).toString();
  }

  it('logs email_hash:undefined with no top-level email key, then returns 502 BROADCAST_FAILED (no JWT)', async () => {
    await clearRateLimitKeys(['auth-link']);

    // verifyHiveSignature looks up the account by username and reads
    // posting.key_auths to verify the recovered key. /link's route handler
    // then calls getAccounts a second time at line 404 (existence check
    // — same return value works there).
    // Per BACKEND-REPUTATION-SSOT round-1 hold #8: broadcast failure now
    // surfaces 502 BROADCAST_FAILED instead of 200 + JWT.
    getAccountsMock.mockReset();
    getAccountsMock.mockImplementation(async (names: string[]) => {
      if (names.includes(username)) {
        return [{ name: username, posting: { key_auths: [[TEST_PUB, 1]] } }];
      }
      return [];
    });
    broadcastJsonMock.mockReset();
    broadcastJsonMock.mockRejectedValue(new Error('RPC node rejected: insufficient RC'));

    const body = { auth_token: confirmedToken };
    const timestamp = new Date().toISOString();
    const signature = signRequestBound('POST', '/api/auth/link', body, timestamp);

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    try {
      const res = await request(app)
        .post('/api/auth/link')
        .set('X-Hive-Username', username)
        .set('X-Hive-Signature', signature)
        .set('X-Hive-Timestamp', timestamp)
        .send(body);

      expect(res.status).toBe(502);
      expect(res.body.status).toBe('error');
      expect(res.body.error?.code).toBe('BROADCAST_FAILED');
      expect(res.body.data?.token).toBeFalsy();

      const emission = errorSpy.mock.calls.find(
        ([, msg]) =>
          typeof msg === 'string' &&
          msg.includes('signup_verify.link broadcast failed'),
      );
      expect(emission, 'expected broadcast-failure logger.error emission in /link').toBeDefined();
      const [payload] = emission!;
      const obj = payload as Record<string, unknown>;
      // PII invariant unchanged: no top-level `email` key, no raw email anywhere.
      // For ORCID-only rows the email_hash field is absent (the route passes
      // `email_hash: safeHashEmailForLogs(account.email) ?? undefined` to
      // satisfy the LogContext typed interface).
      expect(obj).not.toHaveProperty('email');
      expect(obj.email_hash).toBeUndefined();
      expect(obj.username).toBe(username);
      expect(obj.orcid).toBe(orcidId);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

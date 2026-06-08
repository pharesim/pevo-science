import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';
import { signRequestBound as signRequestBoundShared } from '../support/sign-request.js';

// Test-mock carve-out (per root CLAUDE.md "Running Tests"):
//   (a) Why real-Hive broadcast is impractical per-test: a real accreditation
//       broadcast against Hive takes up to the broadcast timeout (tens of
//       seconds) to resolve, burns a finite claim-token on account creation,
//       and its on-chain outcome is non-deterministic at test scope. So the
//       chain-broadcasting seams (getAccounts, broadcast.json,
//       createClaimedAccount, broadcastJsonWithTimeout) are mocked before
//       createApp().
//   (b) Auth/crypto runs real: argon2 hashing, the pg pool, and
//       verifyHiveSignature are all real here. Cryptographic signature
//       verification is NOT bypassed in this file — only the chain-write
//       seams above are mocked.
//   (c) Real-path companion: signed-request signature verification (the real
//       verifyHiveSignature middleware against signed requests) is exercised
//       for the /link route in signup-verify-concurrent-activation.test.ts.
//       /confirm carries no verifyHiveSignature middleware: its resume-path
//       auth is the in-handler posting-key check, so /confirm's real-auth
//       coverage in THIS file is the argon2 + pg path of clause (b), not
//       middleware signature verification.
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

import crypto from 'node:crypto';
import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { orcidVerified } from '../../src/routes/orcid.js';
import { config } from '../../src/config.js';
import { logger } from '../../src/logger.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';
import { TIMING_ORACLE_FLOOR_MS } from '../support/timing-constants.js';
import { SIGNUP_BINDING_COOKIE_NAME } from '../../src/signup-session-binding.js';

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

// Test-environment bootstrap: see signup-verify-session-binding.test.ts
// for the rationale. ADD COLUMN IF NOT EXISTS is idempotent and does not
// violate the migrations-as-sole-authority contract — the operator-driven
// `./deploy.sh migrate` flow would apply exactly the same DDL.
if (dbReachable) {
  const pool = getAppPool()!;
  await pool.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS signup_binding_hash BYTEA').catch(() => {});
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
 * Extract `Set-Cookie` header values from a supertest response in the shape
 * supertest's `.set('Cookie', ...)` accepts (an array of `name=value` pairs,
 * with cookie attributes stripped). Used to forward the signup-binding
 * cookie from one request to the next so the same simulated browser owns
 * both halves of the signup ceremony.
 */
function extractSetCookies(res: { headers: Record<string, string | string[] | undefined> }): string[] {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((entry) => entry.split(';')[0]);
}

/**
 * Synthesize a (cookie-value, sha256-hash) pair for tests that seed a row
 * directly via INSERT (bypassing /signup or /verify, which would otherwise
 * mint and persist the binding for us). The hash goes into
 * `accounts.signup_binding_hash`; the cookie value goes into the request's
 * `Cookie:` header so /confirm and /link's binding check passes.
 */
function makeBindingForSeededRow(): { cookieValue: string; hash: Buffer; cookieHeader: string } {
  const cookieValue = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(cookieValue).digest();
  return {
    cookieValue,
    hash,
    cookieHeader: `${SIGNUP_BINDING_COOKIE_NAME}=${cookieValue}`,
  };
}

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

describe.skipIf(!dbReachable)('ORCID signup + confirm without password (email+ORCID path, password_hash = NULL)', () => {
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
    await clearRateLimitKeys(['auth-signup', 'signup-confirm', 'signup-confirm-token']);
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
    // /signup mints a session-binding httpOnly cookie that /confirm requires.
    const signupCookies = extractSetCookies(signupRes);
    expect(signupCookies.length).toBeGreaterThan(0);

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
      .set('Cookie', signupCookies)
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

describe.skipIf(!dbReachable)('ORCID signup + confirm WITH password (ORCID-match then password-confirm path)', () => {
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
    await clearRateLimitKeys(['auth-signup', 'signup-confirm', 'signup-confirm-token']);
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
    const signupCookies = extractSetCookies(signupRes);

    const pool = getAppPool()!;
    const pre = await pool.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM accounts WHERE email = $1',
      [email],
    );
    expect(pre.rows[0].password_hash).not.toBeNull();

    const confirmRes = await request(app)
      .post('/api/auth/confirm')
      .set('Cookie', signupCookies)
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
// Close the unknown-email timing oracle on /api/auth/resume-signup.
// Mirrors the three sibling timing specs in recover.test.ts
// (unknown-user on /login, /recover, /resend-verification). The FLOOR
// value is identical (35ms) because the mutation-kill threshold is set
// by argon2.verify wall-time at our ARGON2_OPTIONS, not by the endpoint
// under test.
// ──────────────────────────────────────────────────────────────

// TIMING_ORACLE_FLOOR_MS lives in ../support/timing-constants.ts; see that
// file for the argon2-tuning rationale on the 35ms floor.

// The oracle closes across THREE branches that all must equal the
// confirmed+wrong-password wall-time (~argon2.verify cost):
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

describe.skipIf(!dbReachable)('/resume-signup burns sentinel on all non-verify-path branches', () => {
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
// ORCID-only broadcast-rejection harness. Pins both halves of the PII-safe
// logging fix on the /confirm and /link catch-block log emissions:
//
//   (1) account.email IS NULL (ORCID-only signup state). A naive
//       hashEmailForLogs(account.email) would call null.trim() and throw a
//       synchronous TypeError, which propagates to the outer catch and
//       converts the recoverable `logger.error + handled response` flow
//       into a 500 INTERNAL_ERROR. The correct path uses
//       safeHashEmailForLogs, which returns `undefined` for nullish input
//       (the return type is `string | undefined` to match
//       LogContext.email_hash?: string). The route then proceeds to the
//       dangling-JWT-prevention handler: broadcast failure returns 502
//       BROADCAST_FAILED (no dangling JWT), NOT a 200 + JWT.
//   (2) The structured log payload carries `email_hash` (absent / omitted
//       on this branch because pino strips `undefined` properties from
//       emitted JSON), and crucially has NO top-level `email` key. The
//       `not.toHaveProperty('email')` negative assertion is the
//       load-bearing CNPD-aligned privacy invariant: a regression that
//       reverts to the plaintext `email:` shape fails this assertion even
//       if the `email_hash` value matches.
//
// Without these specs, a revert of either fix passes every other suite. The
// harness shape is an account.email = NULL row + broadcastJsonMock rejecting.
// ──────────────────────────────────────────────────────────────

const PII_RUN_ID = Date.now();
const PII_SUFFIX = (PII_RUN_ID % 100000).toString(36).padStart(4, '0').slice(-6);

describe.skipIf(!dbReachable)('/confirm broadcast-rejection on ORCID-only (email=NULL) row logs email_hash safely, returns 502 BROADCAST_FAILED', () => {
  const username = `piinul${PII_SUFFIX}`;
  const orcidId = '0000-0001-0000-1234';
  const confirmedToken = `confirmed:${'a1b2c3d4'.repeat(8)}`;
  const binding = makeBindingForSeededRow();

  beforeAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await cleanupByUsername(username);
    // Seed the ORCID-only signup row: email = NULL, password_hash = NULL,
    // verify_token = 'confirmed:…' (post-/signup state, pre-/confirm). The
    // signup_binding_hash mimics the cookie minted at /signup so /confirm's
    // binding check passes; the same cookie value is forwarded in the
    // request below.
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO accounts (email, password_hash, full_name, institution, field, orcid, verify_token, expires_at, signup_binding_hash)
       VALUES (NULL, NULL, 'PII Null Confirm', 'MIT', 'physics', $1, $2, $3, $4)`,
      [orcidId, confirmedToken, expiresAt, binding.hash],
    );
  });

  afterAll(async () => {
    await cleanupByUsername(username);
  });

  it('logs email_hash:undefined with no top-level email key, then returns 502 BROADCAST_FAILED (no JWT)', async () => {
    await clearRateLimitKeys(['auth-signup', 'signup-confirm', 'signup-confirm-token']);

    // The accreditation broadcast in the catch path is the failure we stage.
    // createClaimedAccount stays at its default success — the broadcast catch
    // is what exercises the safeHashEmailForLogs(account.email) call site.
    // Broadcast failure produces 502 BROADCAST_FAILED, never a 200 + dangling
    // JWT (no session token for an account whose chain op never landed). The
    // PII-safe email_hash invariant still holds via the structured log emitted
    // by handleBroadcastError.
    broadcastJsonMock.mockReset();
    broadcastJsonMock.mockRejectedValue(new Error('RPC node rejected: insufficient RC'));
    // Username lookup at confirm handler must return [] (Hive-side username
    // is available — createClaimedAccount can claim it).
    getAccountsMock.mockReset();
    getAccountsMock.mockResolvedValue([]);

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    try {
      const res = await request(app)
        .post('/api/auth/confirm')
        .set('Cookie', binding.cookieHeader)
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
      // The LogContext interface declares `email_hash?: string`.
      // safeHashEmailForLogs returns `string | undefined`, so the route can
      // assign the helper's return value directly into the typed interface
      // without a `?? undefined` coercion at the call site. For ORCID-only
      // signups (email = NULL) the field is
      // `undefined`, which pino omits from emitted JSON. The PII invariant
      // — no top-level `email` key, no raw email value anywhere in the
      // structured log — is what matters and remains pinned below.
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
describe.skipIf(!dbReachable)('/link broadcast-rejection on ORCID-only (email=NULL) row logs email_hash safely, returns 502 BROADCAST_FAILED', () => {
  const username = `piilink${PII_SUFFIX}`;
  const orcidId = '0000-0001-0000-5678';
  const confirmedToken = `confirmed:${'b2c3d4e5'.repeat(8)}`;
  const TEST_KEY = PrivateKey.fromSeed(`pii-link-${PII_SUFFIX}`);
  const TEST_PUB = TEST_KEY.createPublic().toString();
  const binding = makeBindingForSeededRow();

  beforeAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await cleanupByUsername(username);
    // Seed the ORCID-only signup row: email = NULL, ready for /link. The
    // signup_binding_hash mirrors a cookie minted at /signup so /link's
    // binding check passes; the same cookie value is forwarded in the
    // request below.
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO accounts (email, password_hash, full_name, institution, field, orcid, verify_token, expires_at, signup_binding_hash)
       VALUES (NULL, NULL, 'PII Null Link', 'MIT', 'physics', $1, $2, $3, $4)`,
      [orcidId, confirmedToken, expiresAt, binding.hash],
    );
  });

  afterAll(async () => {
    await cleanupByUsername(username);
  });

  // Per-suite binding of the shared helper to TEST_KEY. The signing protocol
  // is implemented once in `../support/sign-request.ts` so every suite signs
  // requests identically.
  function signRequestBound(method: string, fullPath: string, body: unknown, timestamp: string): string {
    return signRequestBoundShared(TEST_KEY, method, fullPath, body, timestamp);
  }

  it('logs email_hash:undefined with no top-level email key, then returns 502 BROADCAST_FAILED (no JWT)', async () => {
    await clearRateLimitKeys(['auth-link']);

    // verifyHiveSignature looks up the account by username and reads
    // posting.key_auths to verify the recovered key. /link's route handler
    // then calls getAccounts a second time for an existence check (same
    // return value works there). Broadcast failure surfaces 502
    // BROADCAST_FAILED, never a 200 + dangling JWT.
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
        .set('Cookie', binding.cookieHeader)
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
      // PII invariant unchanged: no top-level `email` key, no raw email
      // anywhere. For ORCID-only rows the email_hash field is absent
      // because safeHashEmailForLogs returns `undefined` for nullish input
      // and pino omits `undefined` properties from emitted JSON. The route
      // assigns the helper's return value directly to satisfy the
      // LogContext.email_hash?: string typed interface.
      expect(obj).not.toHaveProperty('email');
      expect(obj.email_hash).toBeUndefined();
      expect(obj.username).toBe(username);
      expect(obj.orcid).toBe(orcidId);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Mutation-killing spy assertions on the 4 outer-catch `*.failed`
// events emitted from `backend/src/routes/signup-verify.ts`.
//
// The 2 ORCID-only `errorSpy` blocks above match by log MESSAGE text
// emitted from broadcast-error.ts — they do NOT cover these 4
// outer-catch events whose `event` field is the only stable
// discriminator. A typo or rename mutation on any of the 4 event names
// passes every behavioral check while breaking operator dashboards keyed
// on `event`.
//
// Strategy mirrors `auth-log-shape.test.ts`: spy on `logger.error`,
// trigger each handler's outer catch by patching the live `pool.query`
// to reject on the first call only (restored in finally), then assert
// the canonical `event` + `route` + `err: <Error>` shape per
// `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md`.
//
// Justification for `vi.spyOn` (per root CLAUDE.md test carve-out,
// clauses a/b/c):
//   (a) Real-path impracticality: forcing the outer catch requires
//       inducing pg failures mid-handler, which conflicts with the
//       real-pg policy. The catch paths exist for unforeseen runtime
//       failures; the only deterministic way to exercise them is to
//       mock the pool's `query` so the catch fires reproducibly. The
//       /link spec additionally uses real `verifyHiveSignature` (no
//       mock-auth) — only `pool.query` is patched.
//   (b) Mock target is the live `pool.query` only (and the logger
//       spy that captures without suppressing). All other middleware
//       — rateLimit, verifyHiveSignature, abort-signal — runs real.
//   (c) Real-HAF behavioral coverage of the same routes lives in the
//       ORCID-only /confirm and /link broadcast-rejection specs above
//       (and the /resume-signup timing-guard spec); this block is the
//       complementary log-shape pin.
// ──────────────────────────────────────────────────────────────

// Helper: search a spy's call list for the first call whose first
// argument is an object with a matching `event` discriminator.
// Returns the structured-fields object or undefined. Mirrors the
// `findEvent` helper in `auth-log-shape.test.ts`.
function findEventCall(
  spy: ReturnType<typeof vi.spyOn>,
  event: string,
): Record<string, unknown> | undefined {
  for (const call of spy.mock.calls) {
    const [obj] = call;
    if (obj && typeof obj === 'object' && (obj as { event?: string }).event === event) {
      return obj as Record<string, unknown>;
    }
  }
  return undefined;
}

describe.skipIf(!dbReachable)('signup_verify.verify.failed log shape', () => {
  it('fires from outer catch with event + route + err: <Error>', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const pool = getAppPool()!;
    const origQuery = pool.query.bind(pool);
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...args: unknown[]) => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new Error('synthetic db failure for signup_verify.verify.failed'));
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return origQuery(...(args as [any]));
    };

    try {
      await clearRateLimitKeys(['signup-verify']);
      const res = await request(app)
        .post('/api/auth/verify')
        .send({ token: 'log_shape_synthetic_token_for_verify_failed' });
      expect(res.status).toBe(500);

      const fields = findEventCall(errorSpy as never, 'signup_verify.verify.failed');
      expect(fields, 'expected logger.error call with event=signup_verify.verify.failed').toBeDefined();
      expect(fields).toMatchObject({
        event: 'signup_verify.verify.failed',
        route: 'signup-verify.verify',
      });
      expect(fields!.err).toBeInstanceOf(Error);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pool as any).query = origQuery;
      errorSpy.mockRestore();
    }
  });
});

describe.skipIf(!dbReachable)('signup_verify.resume_signup.failed log shape', () => {
  it('fires from outer catch with event + route + err: <Error>', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const pool = getAppPool()!;
    const origQuery = pool.query.bind(pool);
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...args: unknown[]) => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new Error('synthetic db failure for signup_verify.resume_signup.failed'));
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return origQuery(...(args as [any]));
    };

    try {
      await clearRateLimitKeys(['signup-resume']);
      const res = await request(app)
        .post('/api/auth/resume-signup')
        .send({
          email: `log_shape_resume_failed_${Date.now()}@example.com`,
          password: 'TestPassword1',
        });
      expect(res.status).toBe(500);

      const fields = findEventCall(errorSpy as never, 'signup_verify.resume_signup.failed');
      expect(fields, 'expected logger.error call with event=signup_verify.resume_signup.failed').toBeDefined();
      expect(fields).toMatchObject({
        event: 'signup_verify.resume_signup.failed',
        route: 'signup-verify.resume-signup',
      });
      expect(fields!.err).toBeInstanceOf(Error);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pool as any).query = origQuery;
      errorSpy.mockRestore();
    }
  });
});

describe.skipIf(!dbReachable)('signup_verify.confirm.failed log shape', () => {
  it('fires from outer catch with event + route + err: <Error>', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const pool = getAppPool()!;
    // The /confirm handler reads the pending row via a plain pool.query (no
    // held transaction; the activation lock — acquired before any pg work and
    // released in `finally` — is the single-fire guard). Fail that first
    // pool.query to drive the error straight to the outer catch (the 500 +
    // failure-log path this test pins). Later pool.query calls pass through so
    // any cleanup behaves normally.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const origQuery = (pool as any).query.bind(pool);
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...qargs: unknown[]) => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error('synthetic pg failure for signup_verify.confirm.failed'));
      }
      return origQuery(...qargs);
    };

    try {
      await clearRateLimitKeys(['signup-confirm']);
      const username = `lscfm${SUFFIX}`;
      const res = await request(app)
        .post('/api/auth/confirm')
        .send({
          auth_token: `confirmed:${'9'.repeat(64)}`,
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
      expect(res.status).toBe(500);

      const fields = findEventCall(errorSpy as never, 'signup_verify.confirm.failed');
      expect(fields, 'expected logger.error call with event=signup_verify.confirm.failed').toBeDefined();
      expect(fields).toMatchObject({
        event: 'signup_verify.confirm.failed',
        route: 'signup-verify.confirm',
      });
      expect(fields!.err).toBeInstanceOf(Error);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pool as any).query = origQuery;
      errorSpy.mockRestore();
    }
  });
});

describe.skipIf(!dbReachable)('signup_verify.link.failed log shape', () => {
  // /link uses real verifyHiveSignature middleware (per file header).
  // The harness signs a request-bound message with a deterministic test
  // private key and primes getAccountsMock to publish the matching
  // public key on the test username, so middleware succeeds end-to-end
  // against the real signature path before the outer catch is exercised.
  const username = `lslfm${SUFFIX}`;
  const TEST_KEY = PrivateKey.fromSeed(`log-shape-link-${SUFFIX}`);
  const TEST_PUB = TEST_KEY.createPublic().toString();

  function signRequestBound(method: string, fullPath: string, body: unknown, timestamp: string): string {
    return signRequestBoundShared(TEST_KEY, method, fullPath, body, timestamp);
  }

  it('fires from outer catch with event + route + err: <Error>', async () => {
    // Stage Hive lookup so verifyHiveSignature succeeds.
    getAccountsMock.mockReset();
    getAccountsMock.mockImplementation(async (names: string[]) => {
      if (names.includes(username)) {
        return [{ name: username, posting: { key_auths: [[TEST_PUB, 1]] } }];
      }
      return [];
    });

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const pool = getAppPool()!;
    // The /link handler reads the pending row via a plain pool.query (no held
    // transaction; the activation lock — acquired before any pg work and
    // released in `finally` — is the single-fire guard). Fail that first
    // pool.query to drive the error straight to the outer catch (the 500 +
    // failure-log path this test pins). verifyHiveSignature runs first and uses
    // the mocked Hive lookup, not the pool, so the row lookup is the first
    // pool.query. Later calls pass through so cleanup behaves normally.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const origQuery = (pool as any).query.bind(pool);
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...qargs: unknown[]) => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error('synthetic pg failure for signup_verify.link.failed'));
      }
      return origQuery(...qargs);
    };

    try {
      await clearRateLimitKeys(['signup-link']);
      const body = { auth_token: `confirmed:${'8'.repeat(64)}` };
      const timestamp = new Date().toISOString();
      const signature = signRequestBound('POST', '/api/auth/link', body, timestamp);

      const res = await request(app)
        .post('/api/auth/link')
        .set('X-Hive-Username', username)
        .set('X-Hive-Signature', signature)
        .set('X-Hive-Timestamp', timestamp)
        .send(body);
      expect(res.status).toBe(500);

      const fields = findEventCall(errorSpy as never, 'signup_verify.link.failed');
      expect(fields, 'expected logger.error call with event=signup_verify.link.failed').toBeDefined();
      expect(fields).toMatchObject({
        event: 'signup_verify.link.failed',
        route: 'signup-verify.link',
      });
      expect(fields!.err).toBeInstanceOf(Error);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pool as any).query = origQuery;
      errorSpy.mockRestore();
    }
  });
});

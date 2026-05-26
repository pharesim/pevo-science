/**
 * Cross-session attack regression: the signup `auth_token` is bound to the
 * browser session that initiated the signup. Possession of the token alone
 * (mailbox leak, Referer header, login error body, etc.) must NOT be
 * enough to complete the signup with attacker-controlled keys.
 *
 * Tests in this file exercise the binding contract end-to-end against the
 * real pg pool and real `verifyHiveSignature` middleware (no
 * `MOCK_VERIFY_SIGNATURE` fixture — this suite IS auth-focused, so the
 * carve-out at `agents/docs/solutions/conventions/test-mock-carve-out-
 * clause-c-2026-05-04.md` requires running the real signature path).
 *
 * The only mocks here cover the chain-side surface that is impractical to
 * run per-test: `createClaimedAccount`, the `hiveClient.database.getAccounts`
 * lookup, and `broadcastJsonWithTimeout`. The session-binding logic itself
 * runs entirely real (cookie minting, sha256 hashing, pg INSERT/UPDATE of
 * `signup_binding_hash`, cookie verify in `/confirm` and `/link`).
 *
 * Coverage:
 *   - /confirm: cookie A from /signup matches; subsequent /confirm with no
 *     cookie OR with cookie B (different session) is rejected with the
 *     same 400 BAD_REQUEST as an invalid auth_token (no token-validity
 *     oracle).
 *   - /link: same shape, against a verifyHiveSignature-signed request.
 *   - Login PENDING_SIGNUP no longer returns `auth_token` in the response
 *     body (item 3 of the task).
 *   - /confirm per-auth_token rate limit accumulates across rotated IPs
 *     (item 4).
 *   - Successful /confirm clears the row's `signup_binding_hash` (item 1
 *     post-condition; ensures replay of the cookie against a sibling row
 *     cannot succeed once the user is fully active).
 *   - /link parity: the cross-session reject pins the same no-oracle message
 *     as /confirm, a forged-cookie (valid signature + wrong cookie) attack is
 *     rejected, the per-auth_token rate limit accumulates across rotated IPs,
 *     and a successful /link clears the row's `signup_binding_hash`.
 *   - Deploy-window fail-closed: a pending row that predates the binding
 *     migration (verify_token set, signup_binding_hash NULL) is rejected at
 *     /confirm and never activated.
 *   - A malformed-percent-encoding cookie + a valid auth_token yields the
 *     same 400 as a wrong cookie, never a URIError 500 (no oracle).
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { PrivateKey } from '@hiveio/dhive';
import { clearRateLimitKeys } from '../support/redis-helpers.js';
import { signRequestBound as signRequestBoundShared } from '../support/sign-request.js';

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
import { SIGNUP_BINDING_COOKIE_NAME } from '../../src/signup-session-binding.js';

if (!process.env.CUSTODY_ENCRYPTION_KEY || process.env.CUSTODY_ENCRYPTION_KEY.length < 32) {
  process.env.CUSTODY_ENCRYPTION_KEY = 'test-binding-encryption-key-32chars';
}
config.pevoAdminPostingKey = config.pevoAdminPostingKey || PrivateKey.fromSeed('binding-admin').toString();

const app = createApp();
const RUN_ID = Date.now();
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-6);

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

// Test-environment bootstrap: in CI / dev where the operator has not yet
// run `./deploy.sh migrate` since the column was added, the
// signup_binding_hash column may be missing. Apply the migration's
// idempotent ADD COLUMN IF NOT EXISTS clause directly so this suite can
// run regardless. Production paths always go through deploy.sh migrate;
// this is a test-only convenience that does not violate the
// migrations-as-sole-authority contract because the same DDL would be
// applied by the operator anyway.
if (dbReachable) {
  const pool = getAppPool()!;
  await pool.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS signup_binding_hash BYTEA').catch(() => {});
}

async function cleanupByEmail(email: string) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM accounts WHERE email = $1', [email]).catch(() => {});
}

async function cleanupByUsername(username: string) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [username]).catch(() => {});
  await pool.query('DELETE FROM accounts WHERE username = $1', [username]).catch(() => {});
}

function extractSetCookies(res: { headers: Record<string, string | string[] | undefined> }): string[] {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((entry) => entry.split(';')[0]);
}

function buildKeys(username: string) {
  return {
    owner_public: PrivateKey.fromSeed(`${username}-o`).createPublic().toString(),
    active_public: PrivateKey.fromSeed(`${username}-a`).createPublic().toString(),
    posting_public: PrivateKey.fromSeed(`${username}-p`).createPublic().toString(),
    memo_public: PrivateKey.fromSeed(`${username}-m`).createPublic().toString(),
    posting_private: PrivateKey.fromSeed(`${username}-p`).toString(),
    memo_private: PrivateKey.fromSeed(`${username}-m`).toString(),
  };
}

async function seedOrcidNonce(nonce: string, orcidId: string) {
  const { getRedis, isRedisAvailable } = await import('../../src/redis.js');
  const payload = { orcid_id: orcidId, works_count: 5, name: 'Binding Test' };
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(`${config.appTag}:orcid_verified:${nonce}`, JSON.stringify(payload), 'EX', 600);
  }
  orcidVerified.set(nonce, { ...payload, expires: Date.now() + 10 * 60_000 });
}

afterEach(() => {
  getAccountsMock.mockReset().mockResolvedValue([]);
  createClaimedAccountMock.mockReset().mockResolvedValue({ block_num: 12345 });
  broadcastJsonMock.mockReset().mockResolvedValue({ id: 'mock-tx' });
});

// ─────────────────────────────────────────────────────────────────
// /confirm: cross-session rejection (the task's required spec)
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!dbReachable)('/confirm rejects cross-session replay of a leaked auth_token', () => {
  const username = `bindx${SUFFIX}`;
  const email = `binding_xsess_${RUN_ID}@example.com`;
  const orcidId = '0000-0001-2222-3001';
  const nonce = `binding-nonce-xsess-${RUN_ID}`;

  beforeAll(async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
  });

  afterAll(async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
  });

  it('session B with session A\'s leaked auth_token but no/wrong cookie gets 400 (same shape as invalid token)', async () => {
    // Reseed inside the it() body so vitest's `retry:1` (set in
    // backend/vitest.config.ts) replays cleanly — the previous attempt
    // left a row with this email/orcid and consumed the orcid nonce.
    await cleanupByUsername(username);
    await cleanupByEmail(email);
    await clearRateLimitKeys(['auth-signup', 'signup-confirm', 'signup-confirm-token']);
    await seedOrcidNonce(nonce, orcidId);

    // Session A: original signup ceremony. Mints binding cookie + persists
    // sha256 on accounts.signup_binding_hash.
    const sessionA = await request(app)
      .post('/api/auth/signup')
      .send({
        email,
        full_name: 'Binding XSession',
        institution: 'MIT',
        field: 'physics',
        orcid_token: nonce,
      });
    expect(sessionA.status).toBe(200);
    const authToken = sessionA.body.data.auth_token as string;
    expect(authToken).toMatch(/^confirmed:/);
    const sessionACookies = extractSetCookies(sessionA);
    expect(sessionACookies.some((c) => c.startsWith(`${SIGNUP_BINDING_COOKIE_NAME}=`))).toBe(true);

    // Attack 1: session B has the leaked auth_token but no cookie.
    // Expectation: 400 BAD_REQUEST "Invalid or expired auth token" — same
    // shape as a wholly invalid token (no token-validity oracle).
    const attackNoCookie = await request(app)
      .post('/api/auth/confirm')
      // intentionally no .set('Cookie', ...)
      .send({
        auth_token: authToken,
        username,
        keys: buildKeys(username),
      });
    expect(attackNoCookie.status).toBe(400);
    expect(attackNoCookie.body.status).toBe('error');
    expect(attackNoCookie.body.error?.code).toBe('BAD_REQUEST');
    expect(attackNoCookie.body.error?.message).toMatch(/Invalid or expired auth token/);
    expect(attackNoCookie.body.data?.token).toBeFalsy();

    // Attack 2: session B has the leaked auth_token AND a cookie with the
    // RIGHT name but a wrong/forged value (32 random hex bytes the attacker
    // controls). Expectation: same 400 BAD_REQUEST.
    const forgedCookie = `${SIGNUP_BINDING_COOKIE_NAME}=${'fa'.repeat(32)}`;
    const attackWrongCookie = await request(app)
      .post('/api/auth/confirm')
      .set('Cookie', forgedCookie)
      .send({
        auth_token: authToken,
        username,
        keys: buildKeys(username),
      });
    expect(attackWrongCookie.status).toBe(400);
    expect(attackWrongCookie.body.error?.code).toBe('BAD_REQUEST');
    expect(attackWrongCookie.body.data?.token).toBeFalsy();

    // Session A completes successfully when it presents its own cookie.
    const legit = await request(app)
      .post('/api/auth/confirm')
      .set('Cookie', sessionACookies)
      .send({
        auth_token: authToken,
        username,
        keys: buildKeys(username),
      });
    expect(legit.status).toBe(200);
    expect(legit.body.data?.username).toBe(username);

    // Post-condition: row's signup_binding_hash is cleared (it served its
    // purpose; lingering it would let a re-played cookie complete a sibling
    // row in the rare cross-identity scenario).
    const pool = getAppPool()!;
    const post = await pool.query<{ signup_binding_hash: Buffer | null }>(
      'SELECT signup_binding_hash FROM accounts WHERE username = $1',
      [username],
    );
    expect(post.rows[0].signup_binding_hash).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// /link: cross-session rejection (parallel spec)
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!dbReachable)('/link rejects cross-session replay of a leaked auth_token', () => {
  const linkUser = `bindlnk${SUFFIX}`;
  const email = `binding_link_${RUN_ID}@example.com`;
  const orcidId = '0000-0001-2222-3002';
  const nonce = `binding-nonce-link-${RUN_ID}`;
  const TEST_KEY = PrivateKey.fromSeed(`binding-link-${SUFFIX}`);
  const TEST_PUB = TEST_KEY.createPublic().toString();

  beforeAll(async () => {
    await cleanupByUsername(linkUser);
    await cleanupByEmail(email);
  });

  afterAll(async () => {
    await cleanupByUsername(linkUser);
    await cleanupByEmail(email);
  });

  function signLink(body: unknown, timestamp: string): string {
    return signRequestBoundShared(TEST_KEY, 'POST', '/api/auth/link', body, timestamp);
  }

  it('session B with leaked auth_token + signed request but no cookie gets 400', async () => {
    await cleanupByUsername(linkUser);
    await cleanupByEmail(email);
    await clearRateLimitKeys(['auth-signup', 'signup-link', 'signup-link-token']);
    await seedOrcidNonce(nonce, orcidId);

    // Session A creates the signup, gets binding cookie + auth_token.
    const sessionA = await request(app)
      .post('/api/auth/signup')
      .send({
        email,
        full_name: 'Binding Link',
        institution: 'MIT',
        field: 'physics',
        orcid_token: nonce,
      });
    expect(sessionA.status).toBe(200);
    const authToken = sessionA.body.data.auth_token as string;
    const sessionACookies = extractSetCookies(sessionA);

    // Stage verifyHiveSignature middleware (the linked Hive account
    // publishes the matching public key).
    getAccountsMock.mockReset();
    getAccountsMock.mockImplementation(async (names: string[]) => {
      if (names.includes(linkUser)) {
        return [{ name: linkUser, posting: { key_auths: [[TEST_PUB, 1]] } }];
      }
      return [];
    });

    const body = { auth_token: authToken };

    // Attack 1: session B presents the leaked auth_token AND a valid signed
    // request from a Hive account they control, but NO binding cookie.
    // Expectation: 400 BAD_REQUEST with the SAME message as a wholly invalid
    // token ("Invalid or expired link request") — a distinguishable
    // binding-reject message would be a token-validity oracle.
    const attackTimestamp = new Date().toISOString();
    const attackSignature = signLink(body, attackTimestamp);
    const attack = await request(app)
      .post('/api/auth/link')
      .set('X-Hive-Username', linkUser)
      .set('X-Hive-Signature', attackSignature)
      .set('X-Hive-Timestamp', attackTimestamp)
      .send(body);
    expect(attack.status).toBe(400);
    expect(attack.body.status).toBe('error');
    expect(attack.body.error?.code).toBe('BAD_REQUEST');
    expect(attack.body.error?.message).toMatch(/Invalid or expired link request/);
    expect(attack.body.data?.token).toBeFalsy();

    // Attack 2: session B presents the leaked auth_token + a valid signed
    // request AND a cookie with the RIGHT name but a forged value (32 random
    // hex bytes the attacker controls). Same 400 reject + same message — the
    // wrong-cookie path must not expose an oracle either. A fresh timestamp /
    // signature is required because verifyHiveSignature's replay cache
    // rejects a repeated signature value.
    const forgedTimestamp = new Date(Date.now() + 1000).toISOString();
    const forgedSignature = signLink(body, forgedTimestamp);
    const forgedCookie = `${SIGNUP_BINDING_COOKIE_NAME}=${'fa'.repeat(32)}`;
    const attackForged = await request(app)
      .post('/api/auth/link')
      .set('X-Hive-Username', linkUser)
      .set('X-Hive-Signature', forgedSignature)
      .set('X-Hive-Timestamp', forgedTimestamp)
      .set('Cookie', forgedCookie)
      .send(body);
    expect(attackForged.status).toBe(400);
    expect(attackForged.body.error?.code).toBe('BAD_REQUEST');
    expect(attackForged.body.error?.message).toMatch(/Invalid or expired link request/);
    expect(attackForged.body.data?.token).toBeFalsy();

    // Session A completes successfully when it presents its own cookie.
    // Use a fresh timestamp + signature: the replay-prevention cache in
    // verifyHiveSignature rejects the same signature value twice, so the
    // legit call must sign anew (a later timestamp is enough — the assembled
    // hash differs on timestamp alone).
    const legitTimestamp = new Date(Date.now() + 2000).toISOString();
    const legitSignature = signLink(body, legitTimestamp);
    const legit = await request(app)
      .post('/api/auth/link')
      .set('X-Hive-Username', linkUser)
      .set('X-Hive-Signature', legitSignature)
      .set('X-Hive-Timestamp', legitTimestamp)
      .set('Cookie', sessionACookies)
      .send(body);
    expect(legit.status).toBe(200);
    expect(legit.body.data?.token).toBeTruthy();

    // Post-condition: the row's signup_binding_hash is cleared on a
    // successful /link (mirrors /confirm) so a replayed cookie cannot
    // complete a sibling row once this user is fully active.
    const pool = getAppPool()!;
    const post = await pool.query<{ signup_binding_hash: Buffer | null }>(
      'SELECT signup_binding_hash FROM accounts WHERE username = $1',
      [linkUser],
    );
    expect(post.rows[0].signup_binding_hash).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// Login PENDING_SIGNUP: response body must NOT carry auth_token
// (task item 3).
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!dbReachable)('/login PENDING_SIGNUP response does not leak auth_token', () => {
  const username = `bndlgn${SUFFIX}`;
  const email = `binding_login_${RUN_ID}@example.com`;
  const password = 'BindingLogin1';
  const confirmedToken = `confirmed:${'d4'.repeat(32)}`;

  beforeAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await cleanupByUsername(username);
    await cleanupByEmail(email);
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO accounts (email, password_hash, full_name, institution, field, verify_token, expires_at)
       VALUES ($1, $2, 'Binding Login', 'MIT', 'physics', $3, $4)`,
      [email, passwordHash, confirmedToken, expiresAt],
    );
  });

  afterAll(async () => {
    await cleanupByEmail(email);
    await cleanupByUsername(username);
  });

  it('returns 409 PENDING_SIGNUP with email but NO auth_token in the response body', async () => {
    await clearRateLimitKeys(['auth-login']);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email_or_username: email, password });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('PENDING_SIGNUP');
    expect(res.body.data?.email).toBe(email);
    // Critical pin: auth_token MUST NOT appear in the response body.
    // The whole point of the binding fix is that the auth_token is not
    // capability-equivalent to a password, and login error bodies are one
    // of the documented leak paths (mailbox / Referer / login body).
    expect(res.body.data?.auth_token).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(confirmedToken);
  });
});

// ─────────────────────────────────────────────────────────────────
// /confirm rate-limit by auth_token (task item 4).
// Brute-force attempts against the same token from rotated IPs share a
// budget.
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!dbReachable)('/confirm per-auth_token rate limit', () => {
  it('429s after the 6th attempt against the same auth_token even when X-Forwarded-For rotates', async () => {
    await clearRateLimitKeys(['signup-confirm', 'signup-confirm-token']);

    // A bogus auth_token: the per-token limiter fires BEFORE the row
    // lookup, so the token never has to be valid. Each request rotates
    // the X-Forwarded-For so the per-IP limiter (max 10/hr) stays cool;
    // the per-token limiter (max 5/hr) is the only one that accumulates.
    const bogusToken = `confirmed:${'bf'.repeat(32)}`;
    const username = 'limittarget';
    const keys = buildKeys(username);

    let last429 = false;
    // 5 should pass through the token-limiter (and 400 downstream on the
    // bogus token); the 6th hits 429.
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post('/api/auth/confirm')
        .set('X-Forwarded-For', `203.0.113.${i + 1}`)
        .send({
          auth_token: bogusToken,
          username,
          keys,
        });
      if (i < 5) {
        // First 5 attempts pass the token-limiter; they then 400 on the
        // missing binding (or invalid auth_token), but the slot was burned.
        expect(res.status).not.toBe(429);
      } else {
        last429 = res.status === 429;
      }
    }
    expect(last429, 'expected the 6th /confirm with the same auth_token to 429').toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// /link rate-limit by auth_token (parity with the /confirm limiter).
// The linkTokenLimiter runs before verifyHiveSignature, so attempts
// accumulate per-token even without a valid signature.
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!dbReachable)('/link per-auth_token rate limit', () => {
  it('429s after the 6th attempt against the same auth_token even when X-Forwarded-For rotates', async () => {
    await clearRateLimitKeys(['signup-link', 'signup-link-token']);

    // Bogus token: the per-token limiter (max 5/hr) fires before the
    // signature check, so the token never has to be valid. Rotating
    // X-Forwarded-For keeps the per-IP limiter (max 10/hr) cool so the
    // per-token bucket is the only one that trips.
    const bogusToken = `confirmed:${'7e'.repeat(32)}`;

    let last429 = false;
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post('/api/auth/link')
        .set('X-Forwarded-For', `198.51.100.${i + 1}`)
        .send({ auth_token: bogusToken });
      if (i < 5) {
        // First 5 pass the token-limiter, then fail at verifyHiveSignature
        // (no signature) — but the per-token slot is burned regardless.
        expect(res.status).not.toBe(429);
      } else {
        last429 = res.status === 429;
      }
    }
    expect(last429, 'expected the 6th /link with the same auth_token to 429').toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// Deploy-window safety: a pending row that predates migration 011 has a
// NULL signup_binding_hash. /confirm must fail closed (verifyBinding
// returns false for a NULL stored hash) rather than activate, and must
// not surface a 500.
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!dbReachable)('/confirm rejects a NULL-binding row (deploy-window safety)', () => {
  const username = `bindnul${SUFFIX}`;
  const email = `binding_null_${RUN_ID}@example.com`;
  const nullBindingToken = `confirmed:${'9c'.repeat(32)}`;

  beforeAll(async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
  });

  afterAll(async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
  });

  it('a row with verify_token set but signup_binding_hash NULL is rejected with the invalid-token shape and not activated', async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
    await clearRateLimitKeys(['signup-confirm', 'signup-confirm-token']);

    // Seed a confirmed pending row WITHOUT a binding hash — the shape of a
    // signup that was mid-flight when migration 011 added the column.
    const pool = getAppPool()!;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO accounts (email, full_name, institution, field, verify_token, expires_at, signup_binding_hash)
       VALUES ($1, 'Binding Null', 'MIT', 'physics', $2, $3, NULL)`,
      [email, nullBindingToken, expiresAt],
    );

    const res = await request(app)
      .post('/api/auth/confirm')
      .send({
        auth_token: nullBindingToken,
        username,
        keys: buildKeys(username),
      });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('BAD_REQUEST');
    expect(res.body.error?.message).toMatch(/Invalid or expired auth token/);
    expect(res.body.data?.token).toBeFalsy();

    // Fail-closed: the chain account was never created and the row was not
    // activated (username stays unset).
    expect(createClaimedAccountMock).not.toHaveBeenCalled();
    const after = await pool.query<{ username: string | null }>(
      'SELECT username FROM accounts WHERE email = $1',
      [email],
    );
    expect(after.rows[0]?.username ?? null).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// Malformed-cookie 500-oracle regression: a cookie value with an invalid
// percent-encoding makes decodeURIComponent throw URIError.
// extractBindingCookie must catch it and return null so a VALID auth_token
// yields the same 400 as a wrong-but-decodable cookie — never a 500, which
// would distinguish valid tokens from invalid ones.
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!dbReachable)('/confirm with a malformed binding cookie degrades to 400, not 500', () => {
  const username = `bindmal${SUFFIX}`;
  const email = `binding_malformed_${RUN_ID}@example.com`;
  const orcidId = '0000-0001-2222-3003';
  const nonce = `binding-nonce-malformed-${RUN_ID}`;

  beforeAll(async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
  });

  afterAll(async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
  });

  it('an invalid-percent-encoding cookie + a VALID auth_token returns 400 (no URIError 500)', async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
    await clearRateLimitKeys(['auth-signup', 'signup-confirm', 'signup-confirm-token']);
    await seedOrcidNonce(nonce, orcidId);

    // Mint a real binding so the row carries a non-NULL hash: this isolates
    // the failure to cookie DECODING, not a missing hash.
    const signup = await request(app)
      .post('/api/auth/signup')
      .send({
        email,
        full_name: 'Binding Malformed',
        institution: 'MIT',
        field: 'physics',
        orcid_token: nonce,
      });
    expect(signup.status).toBe(200);
    const authToken = signup.body.data.auth_token as string;

    // `%GG` is not a valid percent-encoding; decodeURIComponent throws on it.
    const res = await request(app)
      .post('/api/auth/confirm')
      .set('Cookie', `${SIGNUP_BINDING_COOKIE_NAME}=%GG`)
      .send({
        auth_token: authToken,
        username,
        keys: buildKeys(username),
      });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('BAD_REQUEST');
    expect(res.body.error?.message).toMatch(/Invalid or expired auth token/);
    expect(res.body.data?.token).toBeFalsy();
  });
});

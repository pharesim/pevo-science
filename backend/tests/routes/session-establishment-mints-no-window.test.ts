/**
 * Behavioural backstop for `agents/docs/ARCHITECTURE.md` § 6.5 invariant #9:
 * establishing a session never opens a broadcast window.
 *
 * A session-kind fresh-auth proof is target-less and multi-use for the life of
 * its window, so a route that hands one back as a side effect of logging in has
 * collapsed the fresh-auth layer into the session layer — possession of a JWT
 * would once again be enough to broadcast, which is the exact property the
 * layer exists to deny. Only an explicit re-auth act may mint one
 * (`POST /api/custody/session-auth`, `POST /api/orcid/callback
 * mode='session_auth'`).
 *
 * Why this file exists alongside the source-scanning canary in
 * `tests/eslint/no-session-proof-mint-outside-reauth-routes.test.ts`: that
 * canary is static. It greps for the mint's call shape, so its coverage stops
 * exactly where a regression stops looking like a call to that function — a
 * hand-rolled entry, a helper under a new name, a proof read out of the store
 * and echoed. This suite asserts the observable property instead: the responses
 * a client actually receives from session establishment carry no proof. A proof
 * minted but never returned is unusable by the client, so "absent from the
 * response body" is the wire-level form of the invariant.
 *
 * Four surfaces here, chosen because they are the sympathetic ones. Login is
 * where "the user just proved their password, why prompt again" lands. Signup
 * finalization is worse: its best-effort-JWT contract lets a fast retry mint a
 * second session, so a proof minted there would be minted twice per
 * finalization. Token refresh is covered on both of its branches, because
 * presenting an unexpired JWT or a Hive signature is authentication rather than
 * a re-auth act, and a proof attached to either would let a stolen credential
 * renew its own window indefinitely. The ORCID `mode='login'` branch is covered
 * in `tests/routes/orcid.test.ts`, where the OAuth round-trip harness lives; the
 * recovery surfaces are covered in
 * `tests/routes/session-proof-invalidation.test.ts`, where their fixtures live;
 * the custody upgrade and the Keychain link have theirs in their own suites. The
 * set of session-issuing handlers is itself pinned, in
 * `tests/eslint/no-session-proof-mint-outside-reauth-routes.test.ts`, so a new
 * one cannot land without an assertion.
 *
 * Mocks (per root CLAUDE.md "Carve-out for deterministic edge-case coverage"):
 *   (a) The chain-side surface only — `createClaimedAccount`, the
 *       `hiveClient.database.getAccounts` lookup, and the broadcast seams.
 *       Real account creation would sign and submit to a live witness, which is
 *       the carve-out's "third-party libraries non-trivial to run for real
 *       per-test" target. Postgres, Redis, argon2, the session-binding cookie
 *       check, and the fresh-auth store all run real.
 *   (b) No auth middleware is mocked, and none is bypassed. The login and
 *       signup-finalization routes are unauthenticated, because the password and
 *       the auth_token respectively ARE the authentication. The two token-refresh
 *       specs drive `verifyHiveSignature` for real, one down its Bearer branch
 *       and one down its signature branch against a deterministic seed-derived
 *       key; the chain lookup is conditional so signup finalization still sees an
 *       empty account set for the username it is claiming.
 *   (c) The risk class — "a session-establishment response starts carrying a
 *       proof" — is asserted against the real route and the real response
 *       envelope, not against a stub.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import argon2 from 'argon2';
import { PrivateKey } from '@hiveio/dhive';
import jwt from 'jsonwebtoken';
import { clearRateLimitKeys } from '../support/redis-helpers.js';
import { signRequestBound } from '../support/sign-request.js';
import { expectNoSessionProof } from '../support/session-proof-shape.js';

const { getAccountsMock, broadcastJsonMock, createClaimedAccountMock } = vi.hoisted(() => ({
  getAccountsMock: vi.fn(),
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
  broadcastAdminCustomJson: (payload: Record<string, unknown>, timeoutMs?: number) =>
    (broadcastJsonMock as (...a: unknown[]) => unknown)(
      { required_auths: [], required_posting_auths: [], json: JSON.stringify(payload) },
      undefined,
      timeoutMs,
    ),
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
import { config } from '../../src/config.js';
import { SIGNUP_BINDING_COOKIE_NAME } from '../../src/signup-session-binding.js';

if (!process.env.CUSTODY_ENCRYPTION_KEY || process.env.CUSTODY_ENCRYPTION_KEY.length < 32) {
  process.env.CUSTODY_ENCRYPTION_KEY = 'test-no-window-encryption-key-32c';
}
config.pevoAdminPostingKey = config.pevoAdminPostingKey || PrivateKey.fromSeed('no-window-admin').toString();

const app = createApp();
const RUN_ID = Date.now();
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-6);

const LOGIN_USER = `nwlg${SUFFIX}`;
const LOGIN_EMAIL = `nowindow_login_${RUN_ID}@example.com`;
const LOGIN_PASSWORD = 'NoWindowPass1';
const CONFIRM_USER = `nwcf${SUFFIX}`;
const CONFIRM_EMAIL = `nowindow_confirm_${RUN_ID}@example.com`;
const SIGNER_USER = `nwsg${SUFFIX}`;
const SIGNER_KEY = PrivateKey.fromSeed('pevo-no-window-session-signer');

// Conditional on purpose: POST /api/auth/confirm consults this same chain lookup
// to decide the requested username is free, and a non-empty answer sends it down
// the ownership-proof path to a duplicate-username rejection. An unconditional
// key-publishing mock would fail signup finalization instead of the assertion
// under test.
getAccountsMock.mockImplementation((names: string[]) =>
  Promise.resolve(
    names.includes(SIGNER_USER)
      ? [{ name: SIGNER_USER, posting: { key_auths: [[SIGNER_KEY.createPublic().toString(), 1]] } }]
      : [],
  ),
);

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

if (dbReachable) {
  const pool = getAppPool()!;
  await pool.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS signup_binding_hash BYTEA').catch(() => {});
}

async function cleanup() {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  for (const username of [LOGIN_USER, CONFIRM_USER]) {
    await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [username]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username = $1', [username]).catch(() => {});
  }
  for (const email of [LOGIN_EMAIL, CONFIRM_EMAIL]) {
    await pool.query('DELETE FROM accounts WHERE email = $1', [email]).catch(() => {});
  }
}

beforeAll(async () => {
  await cleanup();
  if (!dbReachable) return;
  // Seeded once, not per-test: vitest retries a failed test in place, and a
  // re-run INSERT would fail on the email unique constraint and mask the real
  // assertion failure behind a duplicate-key error.
  const pool = getAppPool()!;
  const passwordHash = await argon2.hash(LOGIN_PASSWORD, { type: argon2.argon2id });
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, custody, verify_token)
     VALUES ($1, $2, $3, 'light', NULL)`,
    [LOGIN_EMAIL, LOGIN_USER, passwordHash],
  );
});

afterAll(async () => {
  await cleanup();
});

describe.skipIf(!dbReachable)('session establishment opens no broadcast window', () => {
  it('POST /api/auth/login returns a session and no fresh-auth proof', async () => {
    await clearRateLimitKeys(['auth-login']);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email_or_username: LOGIN_EMAIL, password: LOGIN_PASSWORD });

    // The positive half matters: an assertion that only checks for absence
    // passes trivially against a 401, which would prove nothing about what a
    // SUCCESSFUL login hands back.
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTruthy();
    expectNoSessionProof(res, 'login response');
  });

  it('POST /api/auth/confirm finalizes a signup and returns no fresh-auth proof', async () => {
    const pool = getAppPool()!;
    await clearRateLimitKeys(['signup-confirm', 'signup-confirm-token']);
    const authToken = `confirmed:${'c3'.repeat(32)}`;
    const cookieValue = crypto.randomBytes(32).toString('hex');
    const bindingHash = crypto.createHash('sha256').update(cookieValue).digest();
    // Retry-safe: a vitest retry must re-seed the row the previous attempt
    // consumed, without tripping the email unique constraint.
    await pool.query('DELETE FROM accounts WHERE email = $1 OR username = $2', [
      CONFIRM_EMAIL,
      CONFIRM_USER,
    ]);
    await pool.query(
      `INSERT INTO accounts (email, full_name, institution, field, verify_token, expires_at, signup_binding_hash)
       VALUES ($1, 'No Window', 'MIT', 'physics', $2, $3, $4)`,
      [CONFIRM_EMAIL, authToken, new Date(Date.now() + 24 * 60 * 60 * 1000), bindingHash],
    );

    const res = await request(app)
      .post('/api/auth/confirm')
      .set('Cookie', `${SIGNUP_BINDING_COOKIE_NAME}=${cookieValue}`)
      .send({
        auth_token: authToken,
        username: CONFIRM_USER,
        keys: {
          owner_public: PrivateKey.fromSeed(`${CONFIRM_USER}-o`).createPublic().toString(),
          active_public: PrivateKey.fromSeed(`${CONFIRM_USER}-a`).createPublic().toString(),
          posting_public: PrivateKey.fromSeed(`${CONFIRM_USER}-p`).createPublic().toString(),
          memo_public: PrivateKey.fromSeed(`${CONFIRM_USER}-m`).createPublic().toString(),
          posting_private: PrivateKey.fromSeed(`${CONFIRM_USER}-p`).toString(),
          memo_private: PrivateKey.fromSeed(`${CONFIRM_USER}-m`).toString(),
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe(CONFIRM_USER);
    expectNoSessionProof(res, 'signup-finalize response');
  });

  it('POST /api/auth/session refreshes a session and returns no fresh-auth proof', async () => {
    // The token-refresh surface. Presenting an unexpired session token buys a
    // new session token and nothing else; a proof handed back here would make
    // every refresh silently re-open a broadcast window, so a stolen JWT would
    // renew its own window indefinitely without the user ever re-authenticating.
    // This drives the Bearer branch of verifyHiveSignature, which is the branch
    // that reads the revocation column; the signature branch below does not.
    await clearRateLimitKeys(['auth-session']);
    const bearer = jwt.sign({ sub: LOGIN_USER, custody: 'light' }, config.sessionSecret, {
      expiresIn: '1h',
    });
    const res = await request(app)
      .post('/api/auth/session')
      .set('Authorization', `Bearer ${bearer}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTruthy();
    expectNoSessionProof(res, 'session-refresh response');
  });

  it('POST /api/auth/session accepts a Hive signature and returns no fresh-auth proof', async () => {
    // The Keychain surface. Presenting a signature is authentication, not a
    // re-auth act: it proves the posting key, which is the credential a stolen
    // session already implies control of, so a proof handed back here would make
    // possession of a signable key equal to a standing broadcast window.
    await clearRateLimitKeys(['auth-session']);
    const timestamp = new Date().toISOString();
    const signature = signRequestBound(SIGNER_KEY, 'POST', '/api/auth/session', {}, timestamp);
    const res = await request(app)
      .post('/api/auth/session')
      .set('X-Hive-Username', SIGNER_USER)
      .set('X-Hive-Signature', signature)
      .set('X-Hive-Timestamp', timestamp)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTruthy();
    expectNoSessionProof(res, 'keychain session response');
  });

  it('the detector fires on every placement, name, and channel a regression could use', () => {
    // Planted positives and negatives. Without them a mangled walker would
    // report no offenders for every response and every assertion above would
    // pass while enforcing nothing. The positives carry a real proof-shaped
    // value where the point is the value tell, because a renamed field is caught
    // by nothing else.
    const HEX64 = 'a3'.repeat(32);
    const JWT_SAMPLE =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiJhbGljZSIsImN1c3RvZHkiOiJsaWdodCIsImlhdCI6MTc1NjY0MDAwMH0.' +
      'Zr0kQm8vXcT1yB2nHfLpJdWsQeAbCdEfGhIjKlMnOpQ';
    type Response = Parameters<typeof expectNoSessionProof>[0];
    const positives: Array<[string, Response]> = [
      ['top level', { body: { fresh_auth_proof: 'x' } }],
      ['nested under data', { body: { data: { token: 't', fresh_auth_proof: 'x' } } }],
      ['two levels down', { body: { data: { session: { fresh_auth_proof: 'x' } } } }],
      ['inside an array', { body: { data: { grants: [{ session_proof: 'x' }] } } }],
      ['renamed to camelCase', { body: { data: { freshAuthProof: 'x' } } }],
      // Name tells nothing; only the value does.
      ['renamed to proof, still 64 hex', { body: { data: { proof: HEX64 } } }],
      ['renamed to reauth_token', { body: { data: { reauth_token: HEX64 } } }],
      ['renamed to broadcast_token', { body: { data: { broadcast_token: HEX64 } } }],
      ['inside a redirect URL', { body: { data: { next: `https://example.org/cb?p=${HEX64}` } } }],
      // Channels a body-only walk never sees.
      ['a bespoke response header', { headers: { 'x-fresh-auth-proof': 'x' } }],
      ['an unnamed header carrying it', { headers: { 'x-grant': HEX64 } }],
      ['a cookie other than the binder', { headers: { 'set-cookie': [`pevo_bc=${HEX64}; Path=/`] } }],
      [
        'a proof-named cookie with a re-encoded value',
        { headers: { 'set-cookie': ['pevo_fresh_auth=bm90LWhleA; Path=/'] } },
      ],
    ];
    for (const [label, res] of positives) {
      expect(() => expectNoSessionProof(res, label), label).toThrow();
    }

    const negatives: Array<[string, Response]> = [
      [
        'a realistic full response',
        {
          body: {
            status: 'ok',
            data: {
              token: JWT_SAMPLE,
              expires_at: '2026-08-31T12:00:00.000Z',
              custody: 'light',
              username: 'alice',
            },
          },
          headers: {
            'content-type': 'application/json; charset=utf-8',
            etag: 'W/"6d-Zr0kQm8vXcT1yB2nHfLpJdWsQeA"',
            'set-cookie': [
              `${SIGNUP_BINDING_COOKIE_NAME}=; Path=/api/auth; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
            ],
          },
        },
      ],
      // A 32-hex nonce and a 128-hex digest both sit either side of the proof's
      // exact width, which is what the boundaries on the value tell are for.
      ['the 32-hex ORCID state', { body: { data: { state: 'ab'.repeat(16) } } }],
      ['a 128-hex digest', { body: { data: { digest: 'de'.repeat(64) } } }],
      // The signup binder emits the same 32-byte-hex shape and is not a
      // broadcast credential, so its value is exempt by cookie name.
      [
        'the binding-cookie mint',
        {
          headers: {
            'set-cookie': [
              `${SIGNUP_BINDING_COOKIE_NAME}=${HEX64}; Max-Age=86400; Path=/api/auth; HttpOnly; SameSite=Lax`,
            ],
          },
        },
      ],
    ];
    for (const [label, res] of negatives) {
      expect(() => expectNoSessionProof(res, label), label).not.toThrow();
    }
  });
});

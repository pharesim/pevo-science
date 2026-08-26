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
 * Two surfaces, chosen because they are the sympathetic ones. Login is where
 * "the user just proved their password, why prompt again" lands. Signup
 * finalization is worse: its best-effort-JWT contract lets a fast retry mint a
 * second session, so a proof minted there would be minted twice per
 * finalization. The ORCID `mode='login'` branch is covered in
 * `tests/routes/orcid.test.ts`, where the OAuth round-trip harness lives.
 *
 * Mocks (per root CLAUDE.md "Carve-out for deterministic edge-case coverage"):
 *   (a) The chain-side surface only — `createClaimedAccount`, the
 *       `hiveClient.database.getAccounts` lookup, and the broadcast seams.
 *       Real account creation would sign and submit to a live witness, which is
 *       the carve-out's "third-party libraries non-trivial to run for real
 *       per-test" target. Postgres, Redis, argon2, the session-binding cookie
 *       check, and the fresh-auth store all run real.
 *   (b) No auth middleware is mocked, and none is bypassed: both routes are
 *       unauthenticated, because the password and the auth_token respectively
 *       ARE the authentication. Nothing here depends on cryptographic
 *       signature verification.
 *   (c) The risk class — "a session-establishment response starts carrying a
 *       proof" — is asserted against the real route and the real response
 *       envelope, not against a stub.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import argon2 from 'argon2';
import { PrivateKey } from '@hiveio/dhive';
import { clearRateLimitKeys } from '../support/redis-helpers.js';

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

/**
 * Assert that nothing anywhere in a response body looks like a session-proof
 * grant.
 *
 * Deliberately a deep walk over the parsed body rather than a check on
 * `data.fresh_auth_proof`. The field's placement is not the invariant — a proof
 * handed back under `data.session.fresh_auth_proof`, or beside a reissued
 * token, or renamed to `session_proof`, breaks § 6.5 invariant #9 just as
 * completely as one at the documented path, and a path-specific assertion would
 * pass for all three.
 */
function expectNoSessionProof(body: unknown, label: string): void {
  const offenders: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      // Underscores stripped before matching, so `freshAuthProof` and
      // `fresh_auth_proof` are the same key to this check. A regression that
      // renames the field into camelCase is the same regression.
      if (/freshauth|sessionproof/.test(key.replace(/_/g, '').toLowerCase())) {
        offenders.push(`${path}.${key}`);
      }
      walk(value, `${path}.${key}`);
    }
  };
  walk(body, label);
  expect(
    offenders,
    `${label} carries a session-proof-shaped field. Only an explicit re-auth act ` +
      'may open a broadcast window (ARCH.md § 6.5 invariant #9); a session ' +
      'established by logging in or finalizing a signup must not come with one ' +
      `attached:\n${offenders.join('\n')}\n\nbody:\n${JSON.stringify(body, null, 2)}`,
  ).toEqual([]);
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
    expectNoSessionProof(res.body, 'login response');
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
    expectNoSessionProof(res.body, 'signup-finalize response');
  });

  it('the detector fires on every placement a regression could use', () => {
    // Planted positives and a negative. Without them a mangled walker would
    // report no offenders for every body and both assertions above would pass
    // while enforcing nothing.
    const cases: Array<[string, unknown]> = [
      ['top level', { fresh_auth_proof: 'x' }],
      ['nested under data', { data: { token: 't', fresh_auth_proof: 'x' } }],
      ['two levels down', { data: { session: { fresh_auth_proof: 'x' } } }],
      ['inside an array', { data: { grants: [{ session_proof: 'x' }] } }],
      ['renamed', { data: { freshAuthProof: 'x' } }],
    ];
    for (const [label, body] of cases) {
      expect(() => expectNoSessionProof(body, label), label).toThrow();
    }
    expect(() =>
      expectNoSessionProof({ data: { token: 't', custody: 'light', username: 'alice' } }, 'clean'),
    ).not.toThrow();
  });
});

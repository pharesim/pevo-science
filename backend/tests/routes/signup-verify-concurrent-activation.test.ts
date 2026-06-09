/**
 * Concurrent-activation regression: two near-simultaneous /confirm (or /link)
 * requests carrying the SAME valid auth_token (+ binding cookie / signed
 * request) must result in EXACTLY ONE activation. The single-use chain
 * account-creation broadcast (createClaimedAccount) must fire at most once;
 * the loser observes verify_token already cleared and takes the normal
 * "invalid or expired" reject.
 *
 * Mechanism under test: a per-auth_token activation lock (Redis SET-NX CAS,
 * with an in-process fallback when Redis is down — see signup-activation-lock.ts)
 * serializes the lookup-through-finalize critical section. The pg connection is
 * NOT held across the broadcast; the lock is what single-fires it. A concurrent
 * same-token request waits for the holder to release, then re-reads its row and
 * converges on the already-consumed reject (loser 400). This suite drives the
 * real lock against real Redis + Postgres.
 *
 * Mock carve-out (root CLAUDE.md "Running Tests"): the chain-side surface is
 * mocked because exercising real account creation / Hive broadcast per-test is
 * impractical — `createClaimedAccount`, `hiveClient.database.getAccounts`, and
 * `broadcastJsonWithTimeout`. The createClaimedAccount mock is given an
 * artificial in-flight delay so the two concurrent requests overlap; without
 * the delay the requests would serialize incidentally on event-loop ordering
 * and not exercise the race. The session-binding logic, the activation lock,
 * the row lookup, and the verify_token-clearing UPDATE all run real.
 *
 * verifyHiveSignature runs REAL for the /link case (this is an auth-adjacent
 * route and the loser-reject correctness depends on the row state, not on
 * bypassing the signature) — no MOCK_VERIFY_SIGNATURE fixture is used.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
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
  // Admin-broadcast envelope helper now backs the migrated admin custom_json
  // sites; route it through the same `broadcastJsonMock` so staged
  // results/rejections and call-arg inspection carry over from the prior wiring.
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
  process.env.CUSTODY_ENCRYPTION_KEY = 'test-concurrent-encryption-key-32c';
}
config.pevoAdminPostingKey = config.pevoAdminPostingKey || PrivateKey.fromSeed('concurrent-admin').toString();

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

if (dbReachable) {
  const pool = getAppPool()!;
  await pool.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS signup_binding_hash BYTEA').catch(() => {});
}

async function cleanupByUsername(username: string) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [username]).catch(() => {});
  await pool.query('DELETE FROM accounts WHERE username = $1', [username]).catch(() => {});
}

async function cleanupByEmail(email: string) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM accounts WHERE email = $1', [email]).catch(() => {});
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

/** Mint a (cookieValue, sha256-hash) pair matching the production binding. */
function mintTestBinding() {
  const cookieValue = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(cookieValue).digest();
  return { cookieValue, hash };
}

afterEach(() => {
  getAccountsMock.mockReset().mockResolvedValue([]);
  createClaimedAccountMock.mockReset().mockResolvedValue({ block_num: 12345 });
  broadcastJsonMock.mockReset().mockResolvedValue({ id: 'mock-tx' });
});

// ─────────────────────────────────────────────────────────────────
// /confirm: concurrent same-token activation fires createClaimedAccount once.
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!dbReachable)('/confirm serializes concurrent same-token activation', () => {
  const username = `cncf${SUFFIX}`;
  const email = `concurrent_confirm_${RUN_ID}@example.com`;
  const authToken = `confirmed:${'a1'.repeat(32)}`;

  beforeAll(async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
  });

  afterAll(async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
  });

  it('two concurrent /confirm with the same auth_token + cookie → exactly one 200, createClaimedAccount called at most once', async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
    await clearRateLimitKeys(['signup-confirm', 'signup-confirm-token']);

    // Seed a confirmed pending row with a known binding hash so both requests
    // present the matching cookie.
    const pool = getAppPool()!;
    const binding = mintTestBinding();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO accounts (email, full_name, institution, field, verify_token, expires_at, signup_binding_hash)
       VALUES ($1, 'Concurrent Confirm', 'MIT', 'physics', $2, $3, $4)`,
      [email, authToken, expiresAt, binding.hash],
    );

    // Delay the chain account-creation so both requests overlap in-flight.
    // Without the advisory lock both would pass the lookup before either
    // clears verify_token, double-firing this mock.
    createClaimedAccountMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 250));
      return { block_num: 12345 };
    });

    const cookie = `${SIGNUP_BINDING_COOKIE_NAME}=${binding.cookieValue}`;
    const keys = buildKeys(username);

    const fire = () =>
      request(app)
        .post('/api/auth/confirm')
        .set('Cookie', cookie)
        .send({ auth_token: authToken, username, keys });

    const [a, b] = await Promise.all([fire(), fire()]);

    const statuses = [a.status, b.status].sort();
    // Exactly one 200; the loser sees verify_token cleared → 400 invalid token.
    const okCount = [a, b].filter((r) => r.status === 200).length;
    const rejectCount = [a, b].filter((r) => r.status === 400).length;
    expect(okCount, `expected exactly one 200, got statuses ${statuses}`).toBe(1);
    expect(rejectCount, `expected the loser to 400, got statuses ${statuses}`).toBe(1);

    const loser = [a, b].find((r) => r.status === 400)!;
    expect(loser.body.error?.code).toBe('BAD_REQUEST');
    expect(loser.body.error?.message).toMatch(/Invalid or expired auth token/);

    // The chain account-creation broadcast fired at most once (exactly once
    // for the single successful activation).
    expect(createClaimedAccountMock).toHaveBeenCalledTimes(1);

    // Exactly one activated row exists for the username.
    const rows = await pool.query<{ username: string; verify_token: string | null }>(
      'SELECT username, verify_token FROM accounts WHERE username = $1',
      [username],
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].verify_token).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// /link: concurrent same-token activation activates once.
// verifyHiveSignature runs real; the linked Hive account publishes the
// matching posting key.
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!dbReachable)('/link serializes concurrent same-token activation', () => {
  const linkUser = `cnlnk${SUFFIX}`;
  const email = `concurrent_link_${RUN_ID}@example.com`;
  const authToken = `confirmed:${'b2'.repeat(32)}`;
  const TEST_KEY = PrivateKey.fromSeed(`concurrent-link-${SUFFIX}`);
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

  it('two concurrent /link with the same auth_token + cookie + signed requests activate exactly one row (no double activation)', async () => {
    await cleanupByUsername(linkUser);
    await cleanupByEmail(email);
    await clearRateLimitKeys(['signup-link', 'signup-link-token']);

    const pool = getAppPool()!;
    const binding = mintTestBinding();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO accounts (email, full_name, institution, field, verify_token, expires_at, signup_binding_hash)
       VALUES ($1, 'Concurrent Link', 'MIT', 'physics', $2, $3, $4)`,
      [email, authToken, expiresAt, binding.hash],
    );

    // The linked Hive account exists and publishes the matching posting key.
    getAccountsMock.mockImplementation(async (names: string[]) => {
      if (names.includes(linkUser)) {
        return [{ name: linkUser, posting: { key_auths: [[TEST_PUB, 1]] } }];
      }
      return [];
    });

    // Delay the accreditation broadcast so the two requests overlap. /link has
    // no createClaimedAccount; the activation UPDATE (verify_token clear,
    // custody=self) runs under the activation lock BEFORE the broadcast. The
    // lock guarantees only one request runs that UPDATE; the loser waits for
    // release, then its re-read finds verify_token already NULL and it either
    // rejects or idempotently re-resolves via the stuck-resume path.
    broadcastJsonMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 250));
      return { id: 'mock-tx' };
    });

    const cookie = `${SIGNUP_BINDING_COOKIE_NAME}=${binding.cookieValue}`;
    const body = { auth_token: authToken };

    // Distinct timestamps so verifyHiveSignature's replay cache doesn't reject
    // the second signature.
    const tsA = new Date().toISOString();
    const tsB = new Date(Date.now() + 1000).toISOString();
    const sigA = signLink(body, tsA);
    const sigB = signLink(body, tsB);

    const fire = (ts: string, sig: string) =>
      request(app)
        .post('/api/auth/link')
        .set('X-Hive-Username', linkUser)
        .set('X-Hive-Signature', sig)
        .set('X-Hive-Timestamp', ts)
        .set('Cookie', cookie)
        .send(body);

    const [a, b] = await Promise.all([fire(tsA, sigA), fire(tsB, sigB)]);

    // Neither request 500s. At least one succeeds; the loser either rejects
    // (400) or recovers idempotently via the stuck-resume path (200, since it
    // re-finds the winner's activated row through a fresh signature). The lock
    // guarantees the activation UPDATE ran exactly once regardless (verified
    // below). The accreditation broadcast is best-effort deduped, not
    // single-fire: the HAF probe can lag the winner's just-landed custom_json,
    // so a stuck-resume loser MAY re-broadcast. The read-time
    // ROW_NUMBER() OVER (ORDER BY block_num DESC) dedup and the
    // seedAccreditationBonus Redis SET-NX are the backstops, so a duplicate is
    // low-harm.
    expect([200, 400, 409]).toContain(a.status);
    expect([200, 400, 409]).toContain(b.status);
    const okCount = [a, b].filter((r) => r.status === 200).length;
    expect(okCount, `expected at least one success, got ${[a.status, b.status]}`).toBeGreaterThanOrEqual(1);

    // The accreditation broadcast fires at most once per successful (200)
    // response: the winner always broadcasts once; a stuck-resume loser
    // re-broadcasts only when the HAF probe has not yet observed the winner's
    // custom_json. The <= okCount bound catches a regression that fans the
    // broadcast out beyond one-per-activation while tolerating the legitimate
    // best-effort re-broadcast. (400/409 losers never reach the broadcast, and
    // a 502 would already have failed the status assertions above.)
    const broadcastCalls = broadcastJsonMock.mock.calls.length;
    expect(broadcastCalls, `expected >= 1 broadcast (the winner), got ${broadcastCalls}`).toBeGreaterThanOrEqual(1);
    expect(broadcastCalls, `expected <= one broadcast per 200 (okCount=${okCount}), got ${broadcastCalls}`).toBeLessThanOrEqual(okCount);

    // Exactly one activated row: the fresh-activation INSERT->UPDATE ran once
    // (no second `custody='self'` row was created, no duplicate username).
    const rows = await pool.query<{ username: string; custody: string; verify_token: string | null }>(
      'SELECT username, custody, verify_token FROM accounts WHERE username = $1',
      [linkUser],
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].custody).toBe('self');
    expect(rows.rows[0].verify_token).toBeNull();
  });
});

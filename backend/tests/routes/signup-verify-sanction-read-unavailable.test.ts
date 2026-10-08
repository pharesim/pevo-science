/**
 * `/confirm` and `/link` when the sanction read cannot be made: the account is
 * finalized, the route answers a retriable 503 and broadcasts nothing, and
 * submitting again once HAF answers finalizes the accreditation and issues the
 * session through the stuck-resume lookup.
 *
 * Carve-out (root CLAUDE.md "Running Tests"):
 *   (a) A HAF outage cannot be produced on demand against live HAF, so
 *       `getPool()` is wrapped: per spec it returns no pool, or the real HAF
 *       pool with only the sanction query rejecting; otherwise the real pool
 *       unchanged, so the retry's reads run against live HAF. The chain-write
 *       seams (`createClaimedAccount`, the accredit broadcast) are mocked because
 *       a real broadcast per test burns claim tokens and lands non-deterministically,
 *       and `getAccounts` publishes a known posting key for the test username.
 *   (b) `verifyHiveSignature` runs real on `/link` against a request-bound
 *       signature. `/confirm` has no signature middleware; its resume path's
 *       posting-key check runs real against the published key.
 *   (c) Real-path companion: `backend/tests/routes/signup-verify.test.ts` [/api/auth/confirm]
 *       Real-path companion: `backend/tests/routes/signup-verify.test.ts` [/api/auth/link]
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { PrivateKey } from '@hiveio/dhive';
import { signRequestBound } from '../support/sign-request.js';

const { getAccountsMock, broadcastJsonMock, createClaimedAccountMock, hafMode, sanctionReadFailures } = vi.hoisted(() => ({
  getAccountsMock: vi.fn(),
  broadcastJsonMock: vi.fn(),
  createClaimedAccountMock: vi.fn(),
  hafMode: { value: 'real' as 'real' | 'absent' | 'sanction-read-fails' },
  sanctionReadFailures: { count: 0 },
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

vi.mock('../../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/db.js')>('../../src/db.js');
  return {
    ...actual,
    getPool: () => {
      if (hafMode.value === 'absent') return null;
      const pool = actual.getPool();
      if (hafMode.value === 'real' || !pool) return pool;
      return {
        query: (sql: string, params?: unknown[]) => {
          if (sql.includes('acct_ops')) {
            sanctionReadFailures.count += 1;
            return Promise.reject(new Error('HAF connection terminated'));
          }
          return pool.query(sql, params);
        },
      };
    },
  };
});

const { createApp } = await import('../../src/app.js');
const { getAppPool } = await import('../../src/app-db.js');
const { getPool } = await import('../../src/db.js');
const { config } = await import('../../src/config.js');
const { SIGNUP_BINDING_COOKIE_NAME } = await import('../../src/signup-session-binding.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');

if (!process.env.CUSTODY_ENCRYPTION_KEY || process.env.CUSTODY_ENCRYPTION_KEY.length < 32) {
  process.env.CUSTODY_ENCRYPTION_KEY = 'test-custody-encryption-key-32chars!';
}
config.pevoAdminPostingKey = config.pevoAdminPostingKey || PrivateKey.fromSeed('sanction-read-503-admin').toString();

const app = createApp();

const RUN_ID = Date.now();
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-6);
const PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$aaaaaaaaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

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
// The retry reads live HAF; without it there is nothing to recover against.
const runnable = dbReachable && getPool() !== null;

const usernames: string[] = [];

async function cleanup(username: string, email: string) {
  const pool = getAppPool()!;
  await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [username]).catch(() => {});
  await pool.query('DELETE FROM accounts WHERE username = $1 OR email = $2', [username, email]).catch(() => {});
}

/** A confirmed signup row with its session-binding cookie, as `/signup` + `/verify` leave it. */
async function seedConfirmedRow(username: string): Promise<{ authToken: string; cookie: string }> {
  const email = `${username}@example.com`;
  usernames.push(username);
  await cleanup(username, email);
  const authToken = `confirmed:${crypto.randomBytes(32).toString('hex')}`;
  const cookieValue = crypto.randomBytes(32).toString('hex');
  const bindingHash = crypto.createHash('sha256').update(cookieValue).digest();
  await getAppPool()!.query(
    `INSERT INTO accounts (email, password_hash, full_name, institution, field, orcid, verify_token, expires_at, signup_binding_hash)
     VALUES ($1, $2, 'Sanction Read Test', 'MIT', 'physics', NULL, $3, NOW() + INTERVAL '24 hours', $4)`,
    [email, PASSWORD_HASH, authToken, bindingHash],
  );
  return { authToken, cookie: `${SIGNUP_BINDING_COOKIE_NAME}=${cookieValue}` };
}

function publishPostingKey(username: string, postingPublic: string) {
  getAccountsMock.mockImplementation(async (names: string[]) =>
    names.includes(username) ? [{ name: username, posting: { key_auths: [[postingPublic, 1]] } }] : [],
  );
}

function confirmKeys(username: string) {
  const key = (role: string) => PrivateKey.fromSeed(`${username}-${role}`);
  return {
    owner_public: key('o').createPublic().toString(),
    active_public: key('a').createPublic().toString(),
    posting_public: key('p').createPublic().toString(),
    memo_public: key('m').createPublic().toString(),
    posting_private: key('p').toString(),
    memo_private: key('m').toString(),
  };
}

function expectSanctionReadUnavailable(res: request.Response) {
  expect(res.status).toBe(503);
  expect(res.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', details: { retriable: true } });
  expect(res.body.error.message.toLowerCase()).not.toContain('sanction');
  expect(res.headers['retry-after']).toBe('30');
  expect(res.body.data?.token).toBeFalsy();
  expect(broadcastJsonMock).not.toHaveBeenCalled();
}

beforeEach(async () => {
  hafMode.value = 'real';
  sanctionReadFailures.count = 0;
  getAccountsMock.mockReset().mockResolvedValue([]);
  broadcastJsonMock.mockReset().mockResolvedValue({ id: 'sanction-read-accredit-tx' });
  createClaimedAccountMock.mockReset().mockResolvedValue({ block_num: 12345 });
  await clearRateLimitKeys(['signup-confirm', 'signup-confirm-token', 'signup-link', 'signup-link-token']);
});

afterAll(async () => {
  if (!dbReachable) return;
  for (const username of usernames) await cleanup(username, `${username}@example.com`);
});

describe.skipIf(!runnable)('POST /api/auth/confirm when the sanction read cannot be made', () => {
  it('answers a retriable 503 when the sanction query fails; submitting again once HAF answers issues the session', async () => {
    const username = `sncf${SUFFIX}`;
    const { authToken, cookie } = await seedConfirmedRow(username);
    const keys = confirmKeys(username);
    hafMode.value = 'sanction-read-fails';

    const first = await request(app)
      .post('/api/auth/confirm')
      .set('Cookie', cookie)
      .send({ auth_token: authToken, username, keys });

    expectSanctionReadUnavailable(first);
    expect(sanctionReadFailures.count).toBe(1);
    expect(createClaimedAccountMock).toHaveBeenCalledTimes(1);

    // HAF answers again. The finalized row has no verify_token, so the retry
    // reaches the session through the posting-key-gated stuck-resume lookup.
    hafMode.value = 'real';
    publishPostingKey(username, keys.posting_public);
    const second = await request(app)
      .post('/api/auth/confirm')
      .send({ auth_token: authToken, username, keys });

    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ username, custody: 'light' });
    expect(second.body.data.token).toBeTruthy();
    expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(broadcastJsonMock.mock.calls[0][0].json)).toMatchObject({ action: 'accredit', account: username });
    expect(createClaimedAccountMock).toHaveBeenCalledTimes(1);
  });

  it('answers the same 503 when there is no HAF pool', async () => {
    const username = `sncn${SUFFIX}`;
    const { authToken, cookie } = await seedConfirmedRow(username);
    hafMode.value = 'absent';

    const res = await request(app)
      .post('/api/auth/confirm')
      .set('Cookie', cookie)
      .send({ auth_token: authToken, username, keys: confirmKeys(username) });

    expectSanctionReadUnavailable(res);
  });
});

describe.skipIf(!runnable)('POST /api/auth/link when the sanction read cannot be made', () => {
  function postLink(username: string, postingKey: PrivateKey, authToken: string, cookie?: string) {
    const body = { auth_token: authToken };
    const timestamp = new Date().toISOString();
    const req = request(app)
      .post('/api/auth/link')
      .set('X-Hive-Username', username)
      .set('X-Hive-Signature', signRequestBound(postingKey, 'POST', '/api/auth/link', body, timestamp))
      .set('X-Hive-Timestamp', timestamp);
    return (cookie ? req.set('Cookie', cookie) : req).send(body);
  }

  it('answers a retriable 503 when the sanction query fails; signing again once HAF answers issues the session', async () => {
    const username = `snlf${SUFFIX}`;
    const { authToken, cookie } = await seedConfirmedRow(username);
    const postingKey = PrivateKey.fromSeed(`${username}-p`);
    publishPostingKey(username, postingKey.createPublic().toString());
    hafMode.value = 'sanction-read-fails';

    const first = await postLink(username, postingKey, authToken, cookie);

    expectSanctionReadUnavailable(first);
    expect(sanctionReadFailures.count).toBe(1);

    // A fresh signature reaches the stuck-resume lookup for the finalized
    // self-custody row; the binding cookie is not needed there.
    hafMode.value = 'real';
    const second = await postLink(username, postingKey, authToken);

    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ username, custody: 'self' });
    expect(second.body.data.token).toBeTruthy();
    expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(broadcastJsonMock.mock.calls[0][0].json)).toMatchObject({ action: 'accredit', account: username });
  });

  it('answers the same 503 when there is no HAF pool', async () => {
    const username = `snln${SUFFIX}`;
    const { authToken, cookie } = await seedConfirmedRow(username);
    const postingKey = PrivateKey.fromSeed(`${username}-p`);
    publishPostingKey(username, postingKey.createPublic().toString());
    hafMode.value = 'absent';

    const res = await postLink(username, postingKey, authToken, cookie);

    expectSanctionReadUnavailable(res);
  });
});

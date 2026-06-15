import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';
import { signRequestBound as signRequestBoundShared } from '../support/sign-request.js';

// ──────────────────────────────────────────────────────────────────────────
// ORCID-binding uniqueness guard on the signup-finalize path
// (broadcastAccreditationAndSeed, shared by /api/auth/confirm and /api/auth/link).
//
// Test-mock carve-out (per root CLAUDE.md "Running Tests"):
//   (a) Why real-Hive broadcast / account-creation is impractical per-test:
//       same rationale as signup-verify.test.ts — a real accreditation
//       broadcast takes up to the broadcast timeout to resolve, burns a finite
//       claim token on account creation, and its on-chain outcome is
//       non-deterministic at test scope. So the chain-broadcasting seams
//       (getAccounts, broadcast.json, broadcastAdminCustomJson,
//       createClaimedAccount) are mocked before createApp().
//   (b) Auth/crypto runs real: the pg pool and verifyHiveSignature are real.
//       Cryptographic signature verification is NOT bypassed — the /link tests
//       sign with a real key and verifyHiveSignature verifies against the
//       account's published posting key. /confirm carries no verifyHiveSignature
//       (its resume auth is the in-handler posting-key check), so /confirm's
//       real-auth coverage here is the pg path of clause (b).
//   (c) Real-path companion + why the durable binding is represented via the
//       Redis binding cache rather than a real on-chain accredit op: the test
//       HAF node is an external, read-only SQL node (no test can INSERT an
//       on-chain op into it), and the /orcid/callback accredit flow cannot be
//       driven in-test (it round-trips the real orcid.org, which is
//       unreachable from CI). `findAccreditedAccountWithOrcid` is therefore
//       exercised REAL via its cache-first branch — a seeded
//       `${appTag}:orcid_binding:<orcid>` entry is exactly how a recent
//       on-chain accredit is represented during the HAF-indexing-lag window,
//       and is the same mechanism that protects the callback path. The
//       HAF-query branch of `findAccreditedAccountWithOrcid` (and the lock's
//       held/unavailable/timeout matrix) is covered against the callback path
//       in tests/routes/orcid.test.ts; this file pins the signup-finalize
//       guard wiring (pre-lock check -> 409, finalized-but-unaccredited state,
//       no accreditation broadcast).
// ──────────────────────────────────────────────────────────────────────────

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

import crypto from 'node:crypto';
import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { orcidVerified } from '../../src/routes/orcid.js';
import { config } from '../../src/config.js';
import { encryptKey } from '../../src/custody-crypto.js';
import { getRedis, isRedisAvailable } from '../../src/redis.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';
import { SIGNUP_BINDING_COOKIE_NAME } from '../../src/signup-session-binding.js';

if (!process.env.CUSTODY_ENCRYPTION_KEY || process.env.CUSTODY_ENCRYPTION_KEY.length < 32) {
  process.env.CUSTODY_ENCRYPTION_KEY = 'test-custody-encryption-key-32chars!';
}
// Admin key MUST be set — the guard only runs when the accreditation broadcast
// would run (an unset key short-circuits broadcastAccreditationAndSeed to 'ok').
config.pevoAdminPostingKey = config.pevoAdminPostingKey || PrivateKey.fromSeed('orcid-bind-guard-admin').toString();

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

// The binding-409 tests represent the durable binding via the Redis binding
// cache (see carve-out clause (c)); they require Redis. Without it,
// findAccreditedAccountWithOrcid falls through to the real HAF node, which has
// no synthetic-ORCID accredit op, so the 409 could not be exercised.
let redisReachable = false;
{
  const redis = getRedis();
  if (redis) {
    try {
      await redis.ping();
      redisReachable = isRedisAvailable();
    } catch {
      redisReachable = false;
    }
  }
}

async function cleanupByUsername(username: string) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM accounts WHERE username = $1', [username]).catch(() => {});
}
async function cleanupByEmail(email: string) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM accounts WHERE email = $1', [email]).catch(() => {});
}

function extractSetCookies(res: { headers: Record<string, string | string[] | undefined> }): string[] {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((entry) => entry.split(';')[0]);
}

function makeBindingForSeededRow(): { cookieValue: string; hash: Buffer; cookieHeader: string } {
  const cookieValue = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(cookieValue).digest();
  return { cookieValue, hash, cookieHeader: `${SIGNUP_BINDING_COOKIE_NAME}=${cookieValue}` };
}

async function seedOrcidNonce(nonce: string, orcidId: string, name = 'Bind Guard Researcher') {
  const payload = { orcid_id: orcidId, works_count: 5, name };
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(`${config.appTag}:orcid_verified:${nonce}`, JSON.stringify(payload), 'EX', 600);
  }
  orcidVerified.set(nonce, { ...payload, expires: Date.now() + 10 * 60_000 });
}

function orcidBindingKey(orcidId: string): string {
  return `${config.appTag}:orcid_binding:${orcidId}`;
}
async function seedOrcidBinding(orcidId: string, boundAccount: string) {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(orcidBindingKey(orcidId), boundAccount, 'EX', 120);
  }
}
async function clearOrcidBinding(orcidId: string) {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.del(orcidBindingKey(orcidId)).catch(() => {});
  }
}

// Seed a post-finalize, light-custody STUCK row carrying an ORCID: username +
// custody='light' + encrypted keys + verify_token NULL, updated_at defaulting to
// now() (inside STUCK_RECOVERY_WINDOW). This is the row a prior /confirm leaves
// when its finalize UPDATE landed but the accreditation broadcast failed. A
// /confirm retry with a non-matching auth_token takes the verify_token-NULL
// stuck-recovery fallback (isResume=true), reaching the same broadcast-time
// ORCID-binding guard as the fresh path. `orcid` is set so the guard runs.
// Mirrors seedStuckAccount in signup-verify-stuck-recovery.test.ts.
async function seedStuckLightRowWithOrcid(opts: {
  username: string;
  email: string;
  orcidId: string;
  postingPrivate: string;
  memoPrivate: string;
}) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  const postingEnc = encryptKey(opts.username, opts.postingPrivate);
  const memoEnc = encryptKey(opts.username, opts.memoPrivate);
  await pool.query(
    `INSERT INTO accounts (
       email, password_hash, full_name, institution, field,
       username, custody, verify_token, orcid,
       posting_key_enc, iv_posting, memo_key_enc, iv_memo,
       expires_at
     ) VALUES ($1, NULL, 'Bind Resume', 'MIT', 'physics',
               $2, 'light', NULL, $3,
               $4, $5, $6, $7,
               NOW() + INTERVAL '24 hours')`,
    [
      opts.email,
      opts.username,
      opts.orcidId,
      postingEnc.ciphertext, postingEnc.iv,
      memoEnc.ciphertext, memoEnc.iv,
    ],
  );
}

afterEach(() => {
  getAccountsMock.mockReset();
  getAccountsMock.mockResolvedValue([]);
  createClaimedAccountMock.mockReset();
  createClaimedAccountMock.mockResolvedValue({ block_num: 12345 });
  broadcastJsonMock.mockReset();
  broadcastJsonMock.mockResolvedValue({ id: 'mock-tx' });
});

// ──────────────────────────────────────────────────────────────────────────
// /api/auth/confirm — a fresh ORCID signup (pending `accounts` row, no username
// yet) finalizing an ORCID already accredited on chain to a DIFFERENT
// (self-custody) account must be refused with 409 ORCID_ALREADY_LINKED.
// ──────────────────────────────────────────────────────────────────────────
describe.skipIf(!dbReachable || !redisReachable)('/api/auth/confirm ORCID-binding guard', () => {
  const username = `obgcf${SUFFIX}`;
  const email = `orcid_bind_confirm_${RUN_ID}@example.com`;
  const orcidId = '0000-0002-7777-0001';
  const nonce = `orcid-bind-confirm-${RUN_ID}`;
  const otherAccount = `selfcustb${SUFFIX}`;

  beforeAll(async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
  });
  afterAll(async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
    await clearOrcidBinding(orcidId);
  });

  it('refuses to broadcast (409 ORCID_ALREADY_LINKED) when the ORCID is already accredited to a different account; account stays finalized + unaccredited', async () => {
    await clearRateLimitKeys(['auth-signup', 'signup-confirm', 'signup-confirm-token']);
    await seedOrcidNonce(nonce, orcidId);

    const signupRes = await request(app)
      .post('/api/auth/signup')
      .send({ email, full_name: 'Bind Guard', institution: 'MIT', field: 'physics', orcid_token: nonce });
    expect(signupRes.status).toBe(200);
    const authToken = signupRes.body.data.auth_token as string;
    const signupCookies = extractSetCookies(signupRes);
    expect(signupCookies.length).toBeGreaterThan(0);

    // The ORCID is already bound to a DIFFERENT account on chain (represented in
    // the recent-binding cache; see carve-out clause (c)).
    await seedOrcidBinding(orcidId, otherAccount);

    getAccountsMock.mockResolvedValue([]); // username available (fresh path)

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

    expect(confirmRes.status).toBe(409);
    expect(confirmRes.body.error?.code).toBe('ORCID_ALREADY_LINKED');
    // No accreditation broadcast for the conflicting ORCID.
    expect(broadcastJsonMock).not.toHaveBeenCalled();
    // Accreditation is an on-chain dimension orthogonal to the accounts-table
    // state machine (ARCHITECTURE.md § 6.1), so refusing the broadcast adds no
    // new row state: the account was already finalized by the time the
    // broadcast-time guard fires (createClaimedAccount ran, keys persisted,
    // verify_token cleared). It is an existing finalized state and stays
    // recoverable, just unaccredited until the ORCID conflict is resolved out
    // of band.
    expect(createClaimedAccountMock).toHaveBeenCalledTimes(1);
    const pool = getAppPool()!;
    const row = await pool.query<{ username: string | null; custody: string | null; verify_token: string | null }>(
      'SELECT username, custody, verify_token FROM accounts WHERE email = $1',
      [email],
    );
    expect(row.rows[0].username).toBe(username);
    expect(row.rows[0].custody).toBe('light');
    expect(row.rows[0].verify_token).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// /api/auth/confirm — the guard must NOT 409 when the ORCID resolves to the
// SAME account (idempotent / resume allowance: existingBinding === username).
// ──────────────────────────────────────────────────────────────────────────
describe.skipIf(!dbReachable || !redisReachable)('/api/auth/confirm ORCID-binding guard allows same-account binding', () => {
  const username = `obgsame${SUFFIX}`;
  const email = `orcid_bind_same_${RUN_ID}@example.com`;
  const orcidId = '0000-0002-7777-0002';
  const nonce = `orcid-bind-same-${RUN_ID}`;

  beforeAll(async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
  });
  afterAll(async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
    await clearOrcidBinding(orcidId);
  });

  it('broadcasts (200) when the ORCID resolves to the same account that is finalizing', async () => {
    await clearRateLimitKeys(['auth-signup', 'signup-confirm', 'signup-confirm-token']);
    await seedOrcidNonce(nonce, orcidId);

    const signupRes = await request(app)
      .post('/api/auth/signup')
      .send({ email, full_name: 'Bind Same', institution: 'MIT', field: 'physics', orcid_token: nonce });
    expect(signupRes.status).toBe(200);
    const authToken = signupRes.body.data.auth_token as string;
    const signupCookies = extractSetCookies(signupRes);

    // ORCID resolves to THIS account — must be allowed (no 409).
    await seedOrcidBinding(orcidId, username);
    // Prove the guard's lookup resolves to THIS account (a real cache hit), so
    // the 200 below is the same-account-allowance branch (existingBinding ===
    // username), NOT an unbound cache-miss passthrough that would also 200.
    expect(await getRedis()!.get(orcidBindingKey(orcidId))).toBe(username);
    getAccountsMock.mockResolvedValue([]);

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
    // The accreditation broadcast fired (the same-account binding did not block it).
    expect(broadcastJsonMock).toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// /api/auth/link — same guard on the link-finalize flavor. verifyHiveSignature
// runs real (signed request); the linked Hive account publishes the matching
// posting key.
// ──────────────────────────────────────────────────────────────────────────
describe.skipIf(!dbReachable || !redisReachable)('/api/auth/link ORCID-binding guard', () => {
  const linkUser = `obglnk${SUFFIX}`;
  const email = `orcid_bind_link_${RUN_ID}@example.com`;
  const authToken = `confirmed:${'c3'.repeat(32)}`;
  const orcidId = '0000-0002-7777-0003';
  const otherAccount = `selfcustl${SUFFIX}`;
  const TEST_KEY = PrivateKey.fromSeed(`orcid-bind-link-${SUFFIX}`);
  const TEST_PUB = TEST_KEY.createPublic().toString();

  beforeAll(async () => {
    await cleanupByUsername(linkUser);
    await cleanupByEmail(email);
  });
  afterAll(async () => {
    await cleanupByUsername(linkUser);
    await cleanupByEmail(email);
    await clearOrcidBinding(orcidId);
  });

  it('refuses to broadcast (409 ORCID_ALREADY_LINKED) when the ORCID is already accredited to a different account; account stays finalized (custody=self) + unaccredited', async () => {
    await cleanupByUsername(linkUser);
    await cleanupByEmail(email);
    await clearRateLimitKeys(['signup-link', 'signup-link-token']);

    const pool = getAppPool()!;
    const binding = makeBindingForSeededRow();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    // Pending ORCID signup row to be linked to an existing Hive account.
    await pool.query(
      `INSERT INTO accounts (email, full_name, institution, field, orcid, verify_token, expires_at, signup_binding_hash)
       VALUES ($1, 'Bind Link', 'MIT', 'physics', $2, $3, $4, $5)`,
      [email, orcidId, authToken, expiresAt, binding.hash],
    );

    // The linked Hive account exists and publishes the matching posting key
    // (verifyHiveSignature verifies against it).
    getAccountsMock.mockImplementation(async (names: string[]) => {
      if (names.includes(linkUser)) {
        return [{ name: linkUser, posting: { key_auths: [[TEST_PUB, 1]] } }];
      }
      return [];
    });

    // The ORCID is already bound to a different account on chain.
    await seedOrcidBinding(orcidId, otherAccount);

    const body = { auth_token: authToken };
    const ts = new Date().toISOString();
    const sig = signRequestBoundShared(TEST_KEY, 'POST', '/api/auth/link', body, ts);

    const res = await request(app)
      .post('/api/auth/link')
      .set('X-Hive-Username', linkUser)
      .set('X-Hive-Signature', sig)
      .set('X-Hive-Timestamp', ts)
      .set('Cookie', binding.cookieHeader)
      .send(body);

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('ORCID_ALREADY_LINKED');
    expect(broadcastJsonMock).not.toHaveBeenCalled();
    // Finalized-but-unaccredited: accreditation is an on-chain dimension
    // orthogonal to the accounts-table state machine (ARCHITECTURE.md § 6.1), so
    // the /link activation UPDATE (custody=self, verify_token NULL) ran and stuck
    // before the broadcast-time guard refused — the row is an existing finalized
    // state, not rolled back.
    const row = await pool.query<{ username: string | null; custody: string | null; verify_token: string | null }>(
      'SELECT username, custody, verify_token FROM accounts WHERE email = $1',
      [email],
    );
    expect(row.rows[0].username).toBe(linkUser);
    expect(row.rows[0].custody).toBe('self');
    expect(row.rows[0].verify_token).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// /api/auth/confirm resume (stuck-recovery) — the broadcast-time ORCID-binding
// guard fires on the resume path too. A post-finalize stuck light-custody row
// whose ORCID is NOW accredited to a DIFFERENT account must 409 on a
// /confirm-retry, not re-broadcast a duplicate accredit for the conflicting
// ORCID. The verify_token-NULL stuck-recovery fallback reaches the same guard
// site (isResume=true), so this pins that the guard is not bypassed on resume.
// ──────────────────────────────────────────────────────────────────────────
describe.skipIf(!dbReachable || !redisReachable)('/api/auth/confirm ORCID-binding guard fires on stuck-recovery resume', () => {
  const username = `obgres${SUFFIX}`;
  const email = `orcid_bind_resume_${RUN_ID}@example.com`;
  const orcidId = '0000-0002-7777-0005';
  const otherAccount = `selfcustr${SUFFIX}`;
  const posting = PrivateKey.fromSeed(`${username}-p`);
  const memo = PrivateKey.fromSeed(`${username}-m`);

  beforeAll(async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
  });
  afterAll(async () => {
    await cleanupByUsername(username);
    await cleanupByEmail(email);
    await clearOrcidBinding(orcidId);
  });

  it('refuses (409 ORCID_ALREADY_LINKED) on a stuck-recovery retry when the ORCID is now accredited to a different account; no duplicate broadcast', async () => {
    await clearRateLimitKeys(['signup-confirm', 'signup-confirm-token']);
    await seedStuckLightRowWithOrcid({
      username,
      email,
      orcidId,
      postingPrivate: posting.toString(),
      memoPrivate: memo.toString(),
    });

    // The ORCID is now bound to a DIFFERENT account on chain (recent-binding
    // cache; see carve-out clause (c)). Prove the seeded conflict is a real
    // cache hit resolving to the other account.
    await seedOrcidBinding(orcidId, otherAccount);
    expect(await getRedis()!.get(orcidBindingKey(orcidId))).toBe(otherAccount);

    // Hive advertises the matching posting key so verifyPostingKeyAuthorized
    // admits the stuck-recovery (ownership proof passes). The 409 is therefore
    // produced by the ORCID-binding guard, NOT by the ownership check.
    getAccountsMock.mockImplementation(async (names: string[]) =>
      names.includes(username)
        ? [{ name: username, posting: { key_auths: [[posting.createPublic().toString(), 1]] } }]
        : [],
    );

    const confirmRes = await request(app)
      .post('/api/auth/confirm')
      .send({
        // No row carries this verify_token -> the handler takes the
        // verify_token-NULL stuck-recovery fallback (isResume=true).
        auth_token: `confirmed:${'a7'.repeat(32)}`,
        username,
        keys: {
          owner_public: PrivateKey.fromSeed(`${username}-o`).createPublic().toString(),
          active_public: PrivateKey.fromSeed(`${username}-a`).createPublic().toString(),
          posting_public: posting.createPublic().toString(),
          memo_public: memo.createPublic().toString(),
          posting_private: posting.toString(),
          memo_private: memo.toString(),
        },
      });

    expect(confirmRes.status).toBe(409);
    expect(confirmRes.body.error?.code).toBe('ORCID_ALREADY_LINKED');
    // No duplicate accredit broadcast for the conflicting ORCID; a resume never
    // re-creates the chain account either.
    expect(broadcastJsonMock).not.toHaveBeenCalled();
    expect(createClaimedAccountMock).not.toHaveBeenCalled();
    // The stuck row is untouched: still a finalized light-custody account,
    // verify_token NULL (the guard refused without rolling the row back).
    const pool = getAppPool()!;
    const row = await pool.query<{ username: string | null; custody: string | null; verify_token: string | null }>(
      'SELECT username, custody, verify_token FROM accounts WHERE email = $1',
      [email],
    );
    expect(row.rows[0].username).toBe(username);
    expect(row.rows[0].custody).toBe('light');
    expect(row.rows[0].verify_token).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// /api/auth/link — same-account allowance (the /link counterpart to the
// /confirm same-account case above). When the ORCID resolves to the SAME Hive
// account being linked, the guard must NOT 409: the link finalizes (200,
// custody=self) and the accreditation broadcast fires. Without this, a
// regression that 409s a same-account /link re-finalize would be silent (only
// /confirm's same-account branch was covered).
// ──────────────────────────────────────────────────────────────────────────
describe.skipIf(!dbReachable || !redisReachable)('/api/auth/link ORCID-binding guard allows same-account binding', () => {
  const linkUser = `obglsame${SUFFIX}`;
  const email = `orcid_bind_link_same_${RUN_ID}@example.com`;
  const authToken = `confirmed:${'c4'.repeat(32)}`;
  const orcidId = '0000-0002-7777-0004';
  const TEST_KEY = PrivateKey.fromSeed(`orcid-bind-link-same-${SUFFIX}`);
  const TEST_PUB = TEST_KEY.createPublic().toString();

  beforeAll(async () => {
    await cleanupByUsername(linkUser);
    await cleanupByEmail(email);
  });
  afterAll(async () => {
    await cleanupByUsername(linkUser);
    await cleanupByEmail(email);
    await clearOrcidBinding(orcidId);
  });

  it('broadcasts (200, custody=self) when the ORCID resolves to the same account being linked', async () => {
    await cleanupByUsername(linkUser);
    await cleanupByEmail(email);
    await clearRateLimitKeys(['signup-link', 'signup-link-token']);

    const pool = getAppPool()!;
    const binding = makeBindingForSeededRow();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    // Pending ORCID signup row to be linked to an existing Hive account.
    await pool.query(
      `INSERT INTO accounts (email, full_name, institution, field, orcid, verify_token, expires_at, signup_binding_hash)
       VALUES ($1, 'Bind Link Same', 'MIT', 'physics', $2, $3, $4, $5)`,
      [email, orcidId, authToken, expiresAt, binding.hash],
    );

    // The linked Hive account exists and publishes the matching posting key
    // (verifyHiveSignature verifies against it).
    getAccountsMock.mockImplementation(async (names: string[]) => {
      if (names.includes(linkUser)) {
        return [{ name: linkUser, posting: { key_auths: [[TEST_PUB, 1]] } }];
      }
      return [];
    });

    // ORCID resolves to THIS account — must be allowed (no 409). Prove the
    // guard's lookup is a real cache hit resolving to linkUser, so the 200 is
    // the same-account-allowance branch (existingBinding === username), NOT an
    // unbound cache-miss passthrough that would also 200.
    await seedOrcidBinding(orcidId, linkUser);
    expect(await getRedis()!.get(orcidBindingKey(orcidId))).toBe(linkUser);

    const body = { auth_token: authToken };
    const ts = new Date().toISOString();
    const sig = signRequestBoundShared(TEST_KEY, 'POST', '/api/auth/link', body, ts);

    const res = await request(app)
      .post('/api/auth/link')
      .set('X-Hive-Username', linkUser)
      .set('X-Hive-Signature', sig)
      .set('X-Hive-Timestamp', ts)
      .set('Cookie', binding.cookieHeader)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe(linkUser);
    expect(res.body.data.custody).toBe('self');
    // The same-account binding did not block the accreditation broadcast.
    expect(broadcastJsonMock).toHaveBeenCalled();
    const row = await pool.query<{ username: string | null; custody: string | null; verify_token: string | null }>(
      'SELECT username, custody, verify_token FROM accounts WHERE email = $1',
      [email],
    );
    expect(row.rows[0].username).toBe(linkUser);
    expect(row.rows[0].custody).toBe('self');
    expect(row.rows[0].verify_token).toBeNull();
  });
});

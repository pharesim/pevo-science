/**
 * Activation failure-recovery + pool-hold tests for POST /api/auth/confirm,
 * covering the redesign that moves the createClaimedAccount broadcast out of a
 * held pg connection and behind a per-auth_token activation lock.
 *
 * Four properties:
 *
 *   (1) Facet-1 crash-resume. A failure between createClaimedAccount landing
 *       and the finalize UPDATE leaves verify_token still set but the Hive
 *       account already created. A retry must RESUME (store keys + clear
 *       verify_token) WITHOUT re-broadcasting createClaimedAccount (no second
 *       claim-token burn) and WITHOUT a permanent 409 lockout — gated on the
 *       session-binding cookie AND a posting-key ownership proof.
 *   (2) Encrypt-before-broadcast fail-fast. A misconfigured
 *       CUSTODY_ENCRYPTION_KEY must fail (500) BEFORE createClaimedAccount
 *       fires, so a key-config error never burns a claim token.
 *   (3) Pool not starved. `max` concurrent distinct-token activations blocked
 *       inside their createClaimedAccount broadcast must NOT pin pool
 *       connections — a plain pool query mid-broadcast still resolves promptly.
 *   (4) End-to-end failure-to-recovery transition. Drives the ACTUAL crash
 *       transition the property-(1) block pre-seeds: a first /confirm where
 *       createClaimedAccount succeeds, then the finalize UPDATE fails (via the
 *       production `__test_seams` injection), leaving the row in the
 *       resumeChainExists-recoverable state; a retry then resumes and finalizes.
 *       Property (1) seeds the post-crash row directly to isolate the resume
 *       branch; this block proves the transition that produces that row state.
 *
 * **Carve-out clause-(a)/(c) justification.** Mocks `createClaimedAccount`,
 * `broadcastJsonWithTimeout`, `seedAccreditationBonus`, and `getAccreditedSet`
 * at module level so the chain/broadcast outcomes can be driven deterministically
 * per-test (real account creation / Hive broadcast / HAF accreditation corpus
 * are impractical to stage per-test). The pg pool is NOT mocked — every
 * accounts-table read/write runs against real Postgres. The finalize-UPDATE
 * failure in property (4) is injected via the production `__test_seams`
 * `failNextFinalizeUpdate` hook (NODE_ENV=test gated) so the handler throws at
 * the real finalize site without a pool-boundary mock, exercising the genuine
 * activation-lock catch → 500 path against a real, unmodified row.
 *   (b) verifyHiveSignature is NOT mocked — /confirm has no signature middleware;
 *       its ownership proof is the supplied posting_private, and the real
 *       PrivateKey.fromString + PublicKey derivation + key comparison in
 *       `verifyPostingKeyAuthorized` run for real. Only the Hive `getAccounts`
 *       lookup is mocked to return a controlled on-chain account shape.
 *   (c) Real-path companion: `signup-verify.test.ts` exercises the happy-path
 *       /confirm flow end-to-end against real pg (broadcast mocked), and
 *       `signup-verify-concurrent-activation.test.ts` drives the real
 *       activation lock + real pg single-fire. The mocked blocks here cover
 *       ONLY the crash-resume / fail-fast / pool-pressure / failure-transition
 *       branches.
 */
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';
import { clearRateLimitKeys } from '../support/redis-helpers.js';

const { getAccountsMock, broadcastJsonMock, createClaimedAccountMock, seedBonusMock, accreditedSetMock } = vi.hoisted(() => ({
  getAccountsMock: vi.fn(),
  broadcastJsonMock: vi.fn(),
  createClaimedAccountMock: vi.fn(),
  seedBonusMock: vi.fn(),
  accreditedSetMock: vi.fn(),
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

vi.mock('../../src/reputation.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/reputation.js')>('../../src/reputation.js');
  return { ...actual, seedAccreditationBonus: seedBonusMock };
});

vi.mock('../../src/accreditation.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/accreditation.js')>('../../src/accreditation.js');
  return { ...actual, getAccreditedSet: accreditedSetMock };
});

import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { config } from '../../src/config.js';
import { SIGNUP_BINDING_COOKIE_NAME } from '../../src/signup-session-binding.js';
import { __test_seams as signupVerifySeams } from '../../src/routes/signup-verify.js';

if (!process.env.CUSTODY_ENCRYPTION_KEY || process.env.CUSTODY_ENCRYPTION_KEY.length < 32) {
  process.env.CUSTODY_ENCRYPTION_KEY = 'test-activation-recovery-key-32chars';
}
// deriveKey reads the live config value, so pin a valid one for the resume +
// pool tests; the fail-fast test mutates it locally and restores.
config.custodyEncryptionKey = config.custodyEncryptionKey && config.custodyEncryptionKey.length >= 32
  ? config.custodyEncryptionKey
  : 'a'.repeat(64);
config.pevoAdminPostingKey = config.pevoAdminPostingKey || PrivateKey.fromSeed('activation-recovery-admin').toString();

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

function mintBinding() {
  const cookieValue = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(cookieValue).digest();
  return { cookieValue, hash };
}

async function cleanup(username: string, email: string) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [username]).catch(() => {});
  await pool.query('DELETE FROM accounts WHERE username = $1', [username]).catch(() => {});
  await pool.query('DELETE FROM accounts WHERE email = $1', [email]).catch(() => {});
}

/**
 * Seed a state-F pending row that has NOT yet been finalized: verify_token set,
 * username NULL, no encrypted keys. This is exactly the row state a /confirm
 * attempt leaves behind if it crashes between createClaimedAccount landing and
 * the finalize UPDATE.
 */
async function seedUnfinalizedRow(email: string, bindingHash: Buffer, authToken: string) {
  const pool = getAppPool()!;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO accounts (email, full_name, institution, field, verify_token, expires_at, signup_binding_hash)
     VALUES ($1, 'Activation Recovery', 'MIT', 'physics', $2, $3, $4)`,
    [email, authToken, expiresAt, bindingHash],
  );
}

beforeEach(() => {
  getAccountsMock.mockReset().mockResolvedValue([]);
  broadcastJsonMock.mockReset().mockResolvedValue({ id: 'mock-tx' });
  createClaimedAccountMock.mockReset().mockResolvedValue({ block_num: 12345 });
  seedBonusMock.mockReset().mockResolvedValue(undefined);
  accreditedSetMock.mockReset().mockResolvedValue(new Set<string>());
});

// ─────────────────────────────────────────────────────────────────
// (1) Facet-1: chain account exists (prior attempt's broadcast landed),
//     verify_token still set → resume WITHOUT re-broadcasting.
// ─────────────────────────────────────────────────────────────────
describe.skipIf(!dbReachable)('/confirm chain-exists crash-resume (Facet 1)', () => {
  const username = `arres${SUFFIX}`;
  const email = `ar_resume_${RUN_ID}@example.com`;
  const keys = buildKeys(username);

  afterAll(async () => cleanup(username, email));

  it('resumes (stores keys, clears verify_token) without re-broadcasting createClaimedAccount or burning a second token', async () => {
    await cleanup(username, email);
    await clearRateLimitKeys(['signup-confirm', 'signup-confirm-token']);

    const binding = mintBinding();
    const authToken = `confirmed:${'c1'.repeat(32)}`;
    await seedUnfinalizedRow(email, binding.hash, authToken);

    // The prior attempt's createClaimedAccount landed: the Hive account exists
    // and publishes the matching posting key the client re-submits.
    getAccountsMock.mockImplementation(async (names: string[]) => {
      if (names.includes(username)) {
        return [{ name: username, posting: { key_auths: [[keys.posting_public, 1]] } }];
      }
      return [];
    });

    const res = await request(app)
      .post('/api/auth/confirm')
      .set('Cookie', `${SIGNUP_BINDING_COOKIE_NAME}=${binding.cookieValue}`)
      .send({ auth_token: authToken, username, keys });

    expect(res.status).toBe(200);
    expect(res.body.data?.token).toBeTruthy();
    expect(res.body.data?.custody).toBe('light');
    // No second claim-token burn: createClaimedAccount must NOT fire on resume.
    expect(createClaimedAccountMock).not.toHaveBeenCalled();
    // Accreditation still broadcasts (HAF probe found nothing — the crashed
    // attempt never reached accreditation).
    expect(broadcastJsonMock).toHaveBeenCalledTimes(1);

    // Row is now finalized: verify_token cleared, encrypted keys stored.
    const pool = getAppPool()!;
    const { rows } = await pool.query<{ verify_token: string | null; custody: string; posting_key_enc: Buffer | null }>(
      'SELECT verify_token, custody, posting_key_enc FROM accounts WHERE username = $1',
      [username],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].verify_token).toBeNull();
    expect(rows[0].custody).toBe('light');
    expect(rows[0].posting_key_enc).not.toBeNull();
  });

  it('rejects the chain-exists resume with NO binding cookie → 400 (leaked auth_token cannot bind the identity row)', async () => {
    await cleanup(username, email);
    await clearRateLimitKeys(['signup-confirm', 'signup-confirm-token']);

    const binding = mintBinding();
    const authToken = `confirmed:${'c2'.repeat(32)}`;
    await seedUnfinalizedRow(email, binding.hash, authToken);

    getAccountsMock.mockImplementation(async (names: string[]) => {
      if (names.includes(username)) {
        return [{ name: username, posting: { key_auths: [[keys.posting_public, 1]] } }];
      }
      return [];
    });

    // No Cookie header → binding check fails before any chain interaction.
    const res = await request(app)
      .post('/api/auth/confirm')
      .send({ auth_token: authToken, username, keys });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('BAD_REQUEST');
    expect(createClaimedAccountMock).not.toHaveBeenCalled();
    expect(broadcastJsonMock).not.toHaveBeenCalled();
  });

  it('rejects when the Hive account exists but the caller does NOT own its posting key → 409 DUPLICATE', async () => {
    await cleanup(username, email);
    await clearRateLimitKeys(['signup-confirm', 'signup-confirm-token']);

    const binding = mintBinding();
    const authToken = `confirmed:${'c3'.repeat(32)}`;
    await seedUnfinalizedRow(email, binding.hash, authToken);

    // The username is taken on Hive by an account whose posting key the caller
    // does NOT control — not a resume, a genuine name collision.
    const otherPub = PrivateKey.fromSeed('not-the-callers-key').createPublic().toString();
    getAccountsMock.mockImplementation(async (names: string[]) => {
      if (names.includes(username)) {
        return [{ name: username, posting: { key_auths: [[otherPub, 1]] } }];
      }
      return [];
    });

    const res = await request(app)
      .post('/api/auth/confirm')
      .set('Cookie', `${SIGNUP_BINDING_COOKIE_NAME}=${binding.cookieValue}`)
      .send({ auth_token: authToken, username, keys });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('DUPLICATE');
    expect(createClaimedAccountMock).not.toHaveBeenCalled();
    expect(broadcastJsonMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// (4) End-to-end failure-to-recovery transition.
//
// Property (1) above seeds the post-crash row state directly to isolate the
// resumeChainExists branch. This block drives the ACTUAL transition that
// produces that state: a first /confirm where createClaimedAccount succeeds and
// then the finalize UPDATE fails, leaving verify_token still set + chain account
// materialized; a retry then hits resumeChainExists and finalizes. This proves
// the failure path's interaction with the resume path end-to-end — a refactor
// that moved the finalize UPDATE before the broadcast, or changed the row state
// the failure leaves behind, would break this test but not the seeded-state one.
//
// The finalize UPDATE is failed via the production `__test_seams`
// `failNextFinalizeUpdate` injection (NODE_ENV=test gated): it throws at the
// real finalize site on the fresh path, AFTER createClaimedAccount lands but
// BEFORE the row is written, so the row is left exactly as a real mid-finalize
// crash would. The throw propagates to the activation-lock catch → 500.
//
// MUTATION-KILL: this test goes RED if any of these resume-path guards in the
// /confirm handler is reverted —
//   - the by-verify_token row lookup that re-finds the pending row on retry:
//     the failed finalize never cleared verify_token, so the retry's
//     `WHERE verify_token = $authToken` lookup still matches. Break that match
//     (so the still-set token no longer re-finds its row) and the retry falls
//     to the no-row 400 reject → the `retry.status === 200` assertion fails;
//   - the chain-account-exists check (the `getAccounts` → existingAccount gate
//     that sets resumeChainExists): drop it and resumeChainExists stays false,
//     so the retry RE-BROADCASTS createClaimedAccount → the "called EXACTLY
//     ONCE" assertion fails (a second claim-token burn);
//   - the skip-re-broadcast branch (`if (!resumeChainExists)` guarding
//     createClaimedAccount): remove the guard and the retry calls
//     createClaimedAccount again → the same once-call assertion fails.
// ─────────────────────────────────────────────────────────────────
describe.skipIf(!dbReachable)('/confirm createClaimedAccount-succeeds-then-finalize-fails → retry resumes', () => {
  const username = `artx${SUFFIX}`;
  const email = `ar_tx_${RUN_ID}@example.com`;
  const keys = buildKeys(username);

  afterAll(async () => cleanup(username, email));

  it('first /confirm 500s when the finalize UPDATE fails post-broadcast; retry hits resumeChainExists, finalizes, and never re-broadcasts createClaimedAccount', async () => {
    await cleanup(username, email);
    await clearRateLimitKeys(['signup-confirm', 'signup-confirm-token']);

    const binding = mintBinding();
    const authToken = `confirmed:${'a4'.repeat(32)}`;
    await seedUnfinalizedRow(email, binding.hash, authToken);
    const cookie = `${SIGNUP_BINDING_COOKIE_NAME}=${binding.cookieValue}`;
    const body = { auth_token: authToken, username, keys };

    // ── Request 1: fresh path. createClaimedAccount succeeds, finalize fails. ──
    // getAccounts returns [] so the handler takes the fresh path and broadcasts
    // createClaimedAccount (resumeChainExists stays false).
    getAccountsMock.mockResolvedValue([]);
    // Arm the one-shot finalize-UPDATE failure for this token: createClaimed-
    // Account resolves normally, then the finalize UPDATE throws.
    signupVerifySeams.failNextFinalizeUpdate(authToken);

    const first = await request(app)
      .post('/api/auth/confirm')
      .set('Cookie', cookie)
      .send(body);

    // The activation-lock catch turns the finalize throw into a 500.
    expect(first.status).toBe(500);
    // The irreversible chain op DID fire (that is the transition under test).
    expect(createClaimedAccountMock).toHaveBeenCalledTimes(1);

    // Post-failure row state: the finalize UPDATE never committed, so
    // verify_token is still set and no encrypted keys were stored — exactly the
    // resumeChainExists-recoverable state, not a permanent lockout.
    const pool = getAppPool()!;
    const afterFail = await pool.query<{ verify_token: string | null; posting_key_enc: Buffer | null; username: string | null }>(
      'SELECT verify_token, posting_key_enc, username FROM accounts WHERE email = $1',
      [email],
    );
    expect(afterFail.rows.length).toBe(1);
    expect(afterFail.rows[0].verify_token).toBe(authToken);
    expect(afterFail.rows[0].posting_key_enc).toBeNull();
    expect(afterFail.rows[0].username).toBeNull();

    // ── Request 2: retry. The chain account now exists (request 1's broadcast
    // landed), so getAccounts returns it with the caller's posting key. The
    // handler takes the resumeChainExists path: it finalizes WITHOUT re-
    // broadcasting createClaimedAccount. The seam is NOT re-armed, so the retry's
    // finalize UPDATE runs for real.
    getAccountsMock.mockImplementation(async (names: string[]) => {
      if (names.includes(username)) {
        return [{ name: username, posting: { key_auths: [[keys.posting_public, 1]] } }];
      }
      return [];
    });

    await clearRateLimitKeys(['signup-confirm', 'signup-confirm-token']);
    const retry = await request(app)
      .post('/api/auth/confirm')
      .set('Cookie', cookie)
      .send(body);

    expect(retry.status, JSON.stringify(retry.body?.error)).toBe(200);
    expect(retry.body.data?.token).toBeTruthy();
    expect(retry.body.data?.custody).toBe('light');

    // Single-fire preserved across the failure transition: createClaimedAccount
    // fired EXACTLY ONCE total (no second claim-token burn on the resume).
    expect(createClaimedAccountMock).toHaveBeenCalledTimes(1);

    // Row is now finalized: verify_token cleared, encrypted keys stored.
    const afterResume = await pool.query<{ verify_token: string | null; custody: string; posting_key_enc: Buffer | null }>(
      'SELECT verify_token, custody, posting_key_enc FROM accounts WHERE username = $1',
      [username],
    );
    expect(afterResume.rows.length).toBe(1);
    expect(afterResume.rows[0].verify_token).toBeNull();
    expect(afterResume.rows[0].custody).toBe('light');
    expect(afterResume.rows[0].posting_key_enc).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// (2) Encrypt-before-broadcast fail-fast.
// ─────────────────────────────────────────────────────────────────
describe.skipIf(!dbReachable)('/confirm encrypt-before-broadcast fail-fast', () => {
  const username = `arenc${SUFFIX}`;
  const email = `ar_enc_${RUN_ID}@example.com`;
  const keys = buildKeys(username);

  afterAll(async () => cleanup(username, email));

  it('a misconfigured CUSTODY_ENCRYPTION_KEY fails (500) BEFORE createClaimedAccount fires — no claim token burned', async () => {
    await cleanup(username, email);
    await clearRateLimitKeys(['signup-confirm', 'signup-confirm-token']);

    const binding = mintBinding();
    const authToken = `confirmed:${'e1'.repeat(32)}`;
    await seedUnfinalizedRow(email, binding.hash, authToken);

    // Fresh path (account does not exist) so the handler would normally
    // broadcast createClaimedAccount — but encryptKey runs first.
    getAccountsMock.mockResolvedValue([]);

    const goodKey = config.custodyEncryptionKey;
    config.custodyEncryptionKey = 'too-short'; // < 32 chars → deriveKey throws
    try {
      const res = await request(app)
        .post('/api/auth/confirm')
        .set('Cookie', `${SIGNUP_BINDING_COOKIE_NAME}=${binding.cookieValue}`)
        .send({ auth_token: authToken, username, keys });

      expect(res.status).toBe(500);
      // The irreversible chain op never ran: no claim token burned.
      expect(createClaimedAccountMock).not.toHaveBeenCalled();

      // verify_token is still set — the row is recoverable, not stuck.
      const pool = getAppPool()!;
      const { rows } = await pool.query<{ verify_token: string | null }>(
        'SELECT verify_token FROM accounts WHERE email = $1',
        [email],
      );
      expect(rows[0]?.verify_token).toBe(authToken);
    } finally {
      config.custodyEncryptionKey = goodKey;
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// (3) Pool not starved across the broadcast.
// ─────────────────────────────────────────────────────────────────
describe.skipIf(!dbReachable)('/confirm does not pin pool connections across the broadcast', () => {
  const emails: string[] = [];
  const usernames: string[] = [];

  afterAll(async () => {
    for (let i = 0; i < usernames.length; i += 1) {
      await cleanup(usernames[i], emails[i]);
    }
  });

  it('max concurrent distinct-token activations leave the pool free for other queries mid-broadcast', async () => {
    await clearRateLimitKeys(['signup-confirm', 'signup-confirm-token']);
    const pool = getAppPool()!;

    // The app pool max is 5 (app-db.ts). Fire that many concurrent distinct-
    // token activations, each blocked inside createClaimedAccount. If a
    // connection were pinned across the broadcast (the old behavior), all 5
    // would be checked out and the probe query below would block until
    // connectionTimeoutMillis. With the broadcast moved out of the held
    // connection, the probe resolves promptly.
    const N = 5;
    let releaseBroadcast!: () => void;
    const gate = new Promise<void>((resolve) => { releaseBroadcast = resolve; });
    createClaimedAccountMock.mockImplementation(async () => {
      await gate;
      return { block_num: 999 };
    });
    getAccountsMock.mockResolvedValue([]); // all fresh

    // Seed all N rows first, then dispatch all N requests concurrently. A
    // supertest Test only sends when `.then` is invoked, so we force dispatch
    // explicitly — pushing the Test objects unstarted would leave the poll loop
    // below waiting forever.
    const configs: { cookie: string; body: object }[] = [];
    for (let i = 0; i < N; i += 1) {
      const username = `arpool${SUFFIX}${i}`;
      const email = `ar_pool_${RUN_ID}_${i}@example.com`;
      usernames.push(username);
      emails.push(email);
      await cleanup(username, email);
      const binding = mintBinding();
      const authToken = `confirmed:${'f0'.repeat(31)}${i.toString().padStart(2, '0')}`;
      await seedUnfinalizedRow(email, binding.hash, authToken);
      configs.push({
        cookie: `${SIGNUP_BINDING_COOKIE_NAME}=${binding.cookieValue}`,
        body: { auth_token: authToken, username, keys: buildKeys(username) },
      });
    }
    const fired: Promise<request.Response>[] = configs.map((c) =>
      request(app)
        .post('/api/auth/confirm')
        .set('Cookie', c.cookie)
        .send(c.body)
        .then((r) => r),
    );

    // Wait until all N requests have reached (and are blocked inside) the
    // broadcast — i.e. each has done its row lookup and released its connection.
    const deadline = Date.now() + 8000;
    while (createClaimedAccountMock.mock.calls.length < N) {
      if (Date.now() > deadline) throw new Error(`only ${createClaimedAccountMock.mock.calls.length}/${N} reached broadcast`);
      await new Promise((r) => setTimeout(r, 25));
    }

    // Probe: a plain pool query must resolve promptly while all N broadcasts
    // are in flight. If connections were pinned, this would not resolve within
    // the probe budget.
    const probe = pool.query('SELECT 1 AS ok');
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('pool starved: SELECT 1 did not resolve within 2s while N broadcasts were in flight')), 2000),
    );
    await Promise.race([probe, timeout]);
    await probe; // ensure it actually resolved

    // Let the broadcasts complete and confirm every activation succeeded.
    releaseBroadcast();
    const results = await Promise.all(fired);
    for (const r of results) {
      expect(r.status, `expected 200, got ${r.status} (${JSON.stringify(r.body?.error)})`).toBe(200);
    }
    expect(createClaimedAccountMock).toHaveBeenCalledTimes(N);
  });
});

// ─────────────────────────────────────────────────────────────────
// (4) Contended same-token activation → retriable 409, not a 500.
//     The redesign replaces the prior pg `lock_timeout`→55P03→500 path: a
//     same-token request that cannot acquire the activation lock within the
//     wait budget gets a retriable 409 LOCK_HELD (it holds NO pg connection
//     while waiting), not a spurious 500.
// ─────────────────────────────────────────────────────────────────
describe.skipIf(!dbReachable)('/confirm contended same-token activation', () => {
  const username = `arlk${SUFFIX}`;
  const email = `ar_lock_${RUN_ID}@example.com`;
  const keys = buildKeys(username);

  afterAll(async () => cleanup(username, email));

  it('returns a retriable 409 LOCK_HELD (not 500) when a holder keeps the lock past the wait budget', async () => {
    await cleanup(username, email);
    await clearRateLimitKeys(['signup-confirm', 'signup-confirm-token']);

    const binding = mintBinding();
    const authToken = `confirmed:${'d4'.repeat(32)}`;
    await seedUnfinalizedRow(email, binding.hash, authToken);
    getAccountsMock.mockResolvedValue([]); // fresh path

    // Holder blocks inside createClaimedAccount, holding the activation lock
    // for longer than a concurrent same-token waiter's wait budget.
    let releaseHolder!: () => void;
    const gate = new Promise<void>((resolve) => { releaseHolder = resolve; });
    createClaimedAccountMock.mockImplementation(async () => {
      await gate;
      return { block_num: 7 };
    });

    const cookie = `${SIGNUP_BINDING_COOKIE_NAME}=${binding.cookieValue}`;
    const body = { auth_token: authToken, username, keys };

    // Fire the holder; wait until it is blocked inside the broadcast (lock held).
    const holder = request(app).post('/api/auth/confirm').set('Cookie', cookie).send(body).then((r) => r);
    const deadline = Date.now() + 8000;
    while (createClaimedAccountMock.mock.calls.length < 1) {
      if (Date.now() > deadline) throw new Error('holder did not reach the broadcast');
      await new Promise((r) => setTimeout(r, 25));
    }

    // Loser: same auth_token. It cannot acquire the SET-NX lock and exhausts
    // its wait budget → retriable 409 LOCK_HELD. Critically NOT a 500.
    const loser = await request(app).post('/api/auth/confirm').set('Cookie', cookie).send(body);
    expect(loser.status).toBe(409);
    expect(loser.body.error?.code).toBe('LOCK_HELD');
    expect(loser.body.error?.details?.retriable).toBe(true);
    // The loser never touched the chain or the broadcast — only the holder did.
    expect(createClaimedAccountMock).toHaveBeenCalledTimes(1);

    // Unblock the holder; it finalizes normally.
    releaseHolder();
    const holderRes = await holder;
    expect(holderRes.status).toBe(200);
  }, 20_000);
});

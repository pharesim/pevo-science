/**
 * Stuck-account recovery (Option C) tests for /api/auth/confirm.
 *
 * Covers the recovery scenarios for a user whose first /confirm broadcast
 * failed after the verify_token was already consumed (the stuck state):
 *
 *   (a) Stuck /confirm → recovery via /confirm-retry → successful session.
 *   (b) Stuck /confirm → broadcast-actually-landed-during-timeout → retry
 *       probes HAF, finds the custom_json, issues JWT without
 *       re-broadcasting.
 *   (c) Stuck /confirm → permanent error class (TypeError from seed) →
 *       recovery surfaces the operator-required code path, no auto-retry.
 *
 * **Carve-out clause-(a)/(c) justification.** Mocks
 * `broadcastJsonWithTimeout`, `seedAccreditationBonus`, and
 * `getAccreditedSet` at module level so the broadcast-outcome path can be
 * driven deterministically per-test.
 *
 *   (a) Real path impractical: broadcast outcomes are non-deterministic
 *       at unit test scope; the timeout-ambiguous path requires inducing
 *       a 30s timeout against Hive, which cannot be done reliably; the
 *       HAF probe path requires seed-and-wait corpus state. Each test
 *       below drives one branch deterministically.
 *   (b) verifyHiveSignature is NOT mocked for /confirm (the /confirm
 *       route doesn't require Hive signature; auth proof for the
 *       stuck-resume is via the supplied posting_private). The real
 *       PrivateKey.fromString + PublicKey derivation + Hive account
 *       lookup runs in `verifyPostingKeyAuthorized`; only the Hive
 *       database client is mocked to return a controlled account shape.
 *   (c) Real-path companion: `signup-verify.test.ts` exercises the
 *       happy-path /confirm flow end-to-end against real pg + real Hive
 *       account-creation (with broadcast mocked). The mocked block here
 *       covers ONLY the stuck-recovery branches not reachable on the
 *       first-attempt path.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';

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
  return {
    ...actual,
    seedAccreditationBonus: seedBonusMock,
  };
});

vi.mock('../../src/accreditation.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/accreditation.js')>('../../src/accreditation.js');
  return {
    ...actual,
    getAccreditedSet: accreditedSetMock,
  };
});

import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { config } from '../../src/config.js';
import { encryptKey } from '../../src/custody-crypto.js';

if (!process.env.CUSTODY_ENCRYPTION_KEY || process.env.CUSTODY_ENCRYPTION_KEY.length < 32) {
  process.env.CUSTODY_ENCRYPTION_KEY = 'test-custody-encryption-key-32chars!';
}
config.pevoAdminPostingKey = config.pevoAdminPostingKey || PrivateKey.fromSeed('stuck-recovery-admin').toString();

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

async function cleanupByUsername(username: string) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [username]).catch(() => {});
  await pool.query('DELETE FROM accounts WHERE username = $1', [username]).catch(() => {});
}

async function seedStuckAccount(opts: {
  username: string;
  email: string;
  postingPrivate: string;
  memoPrivate: string;
}) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await cleanupByUsername(opts.username);
  await pool.query('DELETE FROM accounts WHERE email = $1', [opts.email]).catch(() => {});

  const postingEnc = encryptKey(opts.username, opts.postingPrivate);
  const memoEnc = encryptKey(opts.username, opts.memoPrivate);

  // Mirror the post-step-2 state: username + custody='light' + encrypted
  // keys + verify_token = NULL. This is what the prior /confirm attempt
  // leaves in pg after step 2 completes but the broadcast fails.
  await pool.query(
    `INSERT INTO accounts (
       email, password_hash, full_name, institution, field,
       username, custody, verify_token,
       posting_key_enc, iv_posting, memo_key_enc, iv_memo,
       expires_at
     ) VALUES ($1, NULL, 'Stuck Recovery Test', 'MIT', 'physics',
               $2, 'light', NULL,
               $3, $4, $5, $6,
               NOW() + INTERVAL '24 hours')`,
    [
      opts.email,
      opts.username,
      postingEnc.ciphertext, postingEnc.iv,
      memoEnc.ciphertext, memoEnc.iv,
    ],
  );
}

function makeKeys(username: string) {
  const owner = PrivateKey.fromSeed(`${username}-o`);
  const active = PrivateKey.fromSeed(`${username}-a`);
  const posting = PrivateKey.fromSeed(`${username}-p`);
  const memo = PrivateKey.fromSeed(`${username}-m`);
  return {
    owner_public: owner.createPublic().toString(),
    active_public: active.createPublic().toString(),
    posting_public: posting.createPublic().toString(),
    memo_public: memo.createPublic().toString(),
    posting_private: posting.toString(),
    memo_private: memo.toString(),
  };
}

beforeEach(() => {
  // Default mocks: all resolved. Each test overrides as needed.
  getAccountsMock.mockReset();
  broadcastJsonMock.mockReset().mockResolvedValue({ id: 'mock-tx-default' });
  createClaimedAccountMock.mockReset().mockResolvedValue({ block_num: 12345 });
  seedBonusMock.mockReset().mockResolvedValue(undefined);
  accreditedSetMock.mockReset().mockResolvedValue(new Set<string>());
});

afterEach(() => {
  // No persistent fixtures; each test reseeds in beforeEach inside its block.
});

describe.skipIf(!dbReachable)('signup-verify /confirm stuck-account recovery (Option C)', () => {
  // Use the same username across tests but reseed in each test so retries
  // (vitest retry:1) work cleanly.
  const username = `stuck${SUFFIX}`;
  const email = `stuck_${RUN_ID}@example.com`;
  const keys = makeKeys(username);

  afterAll(async () => cleanupByUsername(username));

  it('(a) stuck /confirm → broadcast retry succeeds → 200 + JWT', async (ctx) => {
    if (!dbReachable) return ctx.skip(true, 'pg unreachable');
    await seedStuckAccount({ username, email, postingPrivate: keys.posting_private, memoPrivate: keys.memo_private });

    // Stuck-recovery: the verify_token lookup fails (already cleared).
    // The username-keyed fallback finds the stuck row. The supplied
    // posting_private's pubkey is matched against the Hive account's
    // authorized posting keys. Hive shows the public key.
    getAccountsMock.mockImplementation(async (names: string[]) => {
      if (names.includes(username)) {
        return [{
          name: username,
          posting: { key_auths: [[keys.posting_public, 1]] },
        }];
      }
      return [];
    });
    broadcastJsonMock.mockResolvedValueOnce({ id: 'stuck-retry-tx-success' });
    seedBonusMock.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .post('/api/auth/confirm')
      .send({
        auth_token: `confirmed:${'a1b2c3d4'.repeat(8)}`, // already-consumed token; lookup fails, fallback fires
        username,
        keys,
      });

    expect(res.status).toBe(200);
    expect(res.body.data?.token).toBeTruthy();
    expect(res.body.data?.username).toBe(username);
    expect(res.body.data?.custody).toBe('light');
    // Broadcast was called (HAF probe found no existing accreditation,
    // so the retry re-broadcast).
    expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
    expect(seedBonusMock).toHaveBeenCalledTimes(1);
    // createClaimedAccount must NOT fire on stuck-resume (chain step 1
    // is single-use; replay would raise HAFSQL-side error per AC #3).
    expect(createClaimedAccountMock).not.toHaveBeenCalled();
  });

  it('(b) stuck /confirm → HAF probe finds existing accreditation → 200 + JWT without re-broadcasting', async (ctx) => {
    if (!dbReachable) return ctx.skip(true, 'pg unreachable');
    await seedStuckAccount({ username, email, postingPrivate: keys.posting_private, memoPrivate: keys.memo_private });

    getAccountsMock.mockImplementation(async (names: string[]) => {
      if (names.includes(username)) {
        return [{
          name: username,
          posting: { key_auths: [[keys.posting_public, 1]] },
        }];
      }
      return [];
    });
    // HAF probe returns: this user IS already accredited (the prior
    // ambiguous-outcome broadcast actually landed on chain).
    accreditedSetMock.mockResolvedValueOnce(new Set([username]));
    seedBonusMock.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .post('/api/auth/confirm')
      .send({
        auth_token: `confirmed:${'a1b2c3d4'.repeat(8)}`,
        username,
        keys,
      });

    expect(res.status).toBe(200);
    expect(res.body.data?.token).toBeTruthy();
    // Per AC #4: a retry that follows a partial-success state MUST NOT
    // double-broadcast if the original actually landed.
    expect(broadcastJsonMock).not.toHaveBeenCalled();
    expect(createClaimedAccountMock).not.toHaveBeenCalled();
    // Seed still runs — it's idempotent under SET NX so a re-seed is safe.
    expect(seedBonusMock).toHaveBeenCalledTimes(1);
  });

  it('(c) stuck /confirm → permanent TypeError from seed → 502 POST_BROADCAST_OPERATOR_REQUIRED', async (ctx) => {
    if (!dbReachable) return ctx.skip(true, 'pg unreachable');
    await seedStuckAccount({ username, email, postingPrivate: keys.posting_private, memoPrivate: keys.memo_private });

    getAccountsMock.mockImplementation(async (names: string[]) => {
      if (names.includes(username)) {
        return [{
          name: username,
          posting: { key_auths: [[keys.posting_public, 1]] },
        }];
      }
      return [];
    });
    broadcastJsonMock.mockResolvedValueOnce({ id: 'stuck-retry-tx-permanent' });
    seedBonusMock.mockRejectedValueOnce(new TypeError('reputation seed shape regression on retry'));

    const res = await request(app)
      .post('/api/auth/confirm')
      .send({
        auth_token: `confirmed:${'a1b2c3d4'.repeat(8)}`,
        username,
        keys,
      });

    // Permanent severity → POST_BROADCAST_OPERATOR_REQUIRED (a permanent-class
    // post-broadcast seed failure routes to the operator-required path).
    expect(res.status).toBe(502);
    expect(res.body.error?.code).toBe('POST_BROADCAST_OPERATOR_REQUIRED');
    expect(res.body.error?.details).toMatchObject({
      retriable: false,
      outcome: 'confirmed',
      tx_id: 'stuck-retry-tx-permanent',
      failed_step: 'reputation_seed',
    });
    // No JWT — dangling-JWT class stays closed.
    expect(res.body.data?.token).toBeFalsy();
    // No infinite-retry loop: createClaimedAccount must NOT fire (single-use chain op).
    expect(createClaimedAccountMock).not.toHaveBeenCalled();
  });

  it('stuck /confirm with wrong posting_private → 400 (auth proof rejects)', async (ctx) => {
    if (!dbReachable) return ctx.skip(true, 'pg unreachable');
    await seedStuckAccount({ username, email, postingPrivate: keys.posting_private, memoPrivate: keys.memo_private });

    // Hive account shows a DIFFERENT posting public key — the supplied
    // posting_private doesn't match. The fallback rejects.
    const otherPublic = PrivateKey.fromSeed('not-the-real-key').createPublic().toString();
    getAccountsMock.mockImplementation(async (names: string[]) => {
      if (names.includes(username)) {
        return [{
          name: username,
          posting: { key_auths: [[otherPublic, 1]] },
        }];
      }
      return [];
    });

    const res = await request(app)
      .post('/api/auth/confirm')
      .send({
        auth_token: `confirmed:${'a1b2c3d4'.repeat(8)}`,
        username,
        keys,
      });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('BAD_REQUEST');
    expect(broadcastJsonMock).not.toHaveBeenCalled();
    expect(createClaimedAccountMock).not.toHaveBeenCalled();
  });
});

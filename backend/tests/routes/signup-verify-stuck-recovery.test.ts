/**
 * Stuck-account recovery (Option C) tests for /api/auth/confirm and /api/auth/link.
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
 *   (d) Steady-state (stale `updated_at`) finalized row → recovery NOT
 *       admitted: the STUCK_RECOVERY_WINDOW recency guard rejects a
 *       long-since-completed account (400, no JWT). Inverse of the
 *       fresh-row (a)/(b) cases, which seed updated_at = now() and so
 *       fall inside the window.
 *
 * **Carve-out clause-(a)/(c) justification.** Mocks
 * `broadcastJsonWithTimeout`, `seedAccreditationBonus`, `getAccreditedSet`, and
 * `hasUnliftedSanction` at module level so the broadcast-outcome path and the
 * ever-sanctioned refusal can be driven deterministically per-test.
 * `SANCTIONED_ACCREDIT_MESSAGE` flows from the real module (the accreditation.js
 * mock spreads `...actual`), so it cannot drift from the source export.
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
 *       The /link stuck-recovery test DOES drive the real verifyHiveSignature
 *       middleware with a real `signRequestBound` signature (an auth-focused
 *       path per clause (b)): the crypto recovery + posting-key match run for
 *       real; only the chain `getAccounts` posting-key lookup is mocked to
 *       supply the public key that recovery is checked against. The middleware
 *       and the signature recovery are never mocked.
 *   (c) Real-path companion: `signup-verify.test.ts` exercises the
 *       happy-path /confirm flow end-to-end against real pg + real Hive
 *       account-creation (with broadcast mocked). The mocked block here
 *       covers ONLY the stuck-recovery branches not reachable on the
 *       first-attempt path.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';
import { signRequestBound } from '../support/sign-request.js';

const { getAccountsMock, broadcastJsonMock, createClaimedAccountMock, seedBonusMock, accreditedSetMock, hasUnliftedSanctionMock } = vi.hoisted(() => ({
  getAccountsMock: vi.fn(),
  broadcastJsonMock: vi.fn(),
  createClaimedAccountMock: vi.fn(),
  seedBonusMock: vi.fn(),
  accreditedSetMock: vi.fn(),
  hasUnliftedSanctionMock: vi.fn(),
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
    hasUnliftedSanction: hasUnliftedSanctionMock,
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

/**
 * Seed a fully-finalized light-custody row exactly like {@link seedStuckAccount}
 * but with `updated_at` stamped at a STALE value (default 2h ago), i.e. OUTSIDE
 * the STUCK_RECOVERY_WINDOW ('1 hour'). This is the steady-state row a long-since
 * completed signup leaves behind. The stuck-recovery lookup's
 * `AND updated_at > NOW() - INTERVAL '1 hour'` guard must reject it, so a /confirm
 * retry against such a row cannot mint a fresh session (the steady-state recovery
 * bypass the recency guard closes). Mirrors seedStuckAccount's column set; only
 * updated_at differs.
 */
async function seedStaleFinalizedAccount(opts: {
  username: string;
  email: string;
  postingPrivate: string;
  memoPrivate: string;
  staleInterval?: string;
}) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await cleanupByUsername(opts.username);
  await pool.query('DELETE FROM accounts WHERE email = $1', [opts.email]).catch(() => {});

  const postingEnc = encryptKey(opts.username, opts.postingPrivate);
  const memoEnc = encryptKey(opts.username, opts.memoPrivate);

  await pool.query(
    `INSERT INTO accounts (
       email, password_hash, full_name, institution, field,
       username, custody, verify_token,
       posting_key_enc, iv_posting, memo_key_enc, iv_memo,
       expires_at, updated_at
     ) VALUES ($1, NULL, 'Stale Finalized Test', 'MIT', 'physics',
               $2, 'light', NULL,
               $3, $4, $5, $6,
               NOW() + INTERVAL '24 hours', NOW() - INTERVAL '${opts.staleInterval ?? '2 hours'}')`,
    [
      opts.email,
      opts.username,
      postingEnc.ciphertext, postingEnc.iv,
      memoEnc.ciphertext, memoEnc.iv,
    ],
  );
}

/**
 * Seed a fully-finalized SELF-custody row stamped STALE (default 2h ago), i.e.
 * OUTSIDE the STUCK_RECOVERY_WINDOW. This is the steady-state row a long-since
 * completed /link leaves: `custody='self'`, `verify_token` NULL, `upgraded_at`
 * set, no server-held keys (self-custody users hold their own). The /link
 * stuck-recovery lookup's `AND updated_at > NOW() - INTERVAL '1 hour'` guard
 * must reject it, so a real-signed /link retry against such a row cannot mint a
 * fresh session (the steady-state recovery bypass the recency guard closes).
 */
async function seedStaleSelfCustodyAccount(opts: {
  username: string;
  email: string;
  staleInterval?: string;
}) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await cleanupByUsername(opts.username);
  await pool.query('DELETE FROM accounts WHERE email = $1', [opts.email]).catch(() => {});

  await pool.query(
    `INSERT INTO accounts (
       email, password_hash, full_name, institution, field,
       username, custody, verify_token, upgraded_at, signup_binding_hash,
       expires_at, updated_at
     ) VALUES ($1, NULL, 'Link Stale Self Test', 'MIT', 'physics',
               $2, 'self', NULL, NOW() - INTERVAL '${opts.staleInterval ?? '2 hours'}', NULL,
               NOW() + INTERVAL '24 hours', NOW() - INTERVAL '${opts.staleInterval ?? '2 hours'}')`,
    [opts.email, opts.username],
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
  hasUnliftedSanctionMock.mockReset().mockResolvedValue(false);
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

  it('refuses the accreditation broadcast for a sanctioned account (403 ACCREDITATION_SANCTIONED, no broadcast)', async (ctx) => {
    if (!dbReachable) return ctx.skip(true, 'pg unreachable');
    // A self-service signup-verify must NOT lift a moderation sanction; only a
    // deliberate admin accredit lifts it. broadcastAccreditationAndSeed refuses
    // before broadcasting and returns 'handled' (403), without leaking the reason.
    await seedStuckAccount({ username, email, postingPrivate: keys.posting_private, memoPrivate: keys.memo_private });
    getAccountsMock.mockImplementation(async (names: string[]) =>
      names.includes(username) ? [{ name: username, posting: { key_auths: [[keys.posting_public, 1]] } }] : [],
    );
    hasUnliftedSanctionMock.mockResolvedValue(true);

    const res = await request(app)
      .post('/api/auth/confirm')
      .send({ auth_token: `confirmed:${'a1b2c3d4'.repeat(8)}`, username, keys });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCREDITATION_SANCTIONED');
    expect(res.body.error.message.toLowerCase()).not.toContain('sanction');
    expect(broadcastJsonMock).not.toHaveBeenCalled();
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

// ─────────────────────────────────────────────────────────────────
// Steady-state recovery bypass closed (recency guard).
//
// The fresh-row stuck tests above seed a row whose updated_at defaults to now()
// (inside STUCK_RECOVERY_WINDOW = '1 hour'), so they exercise the recovery-
// ADMITTED (200) side. This block is the INVERSE: a fully-finalized light-custody
// row stamped STALE (updated_at = 2h ago) is a steady-state completed account,
// not a mid-crash one. The stuck-recovery lookup's
// `AND updated_at > NOW() - INTERVAL '1 hour'` guard must exclude it, so a
// /confirm retry carrying a (non-matching) auth_token + the owner's keys gets
// the generic 400 "invalid or expired" reject and NO JWT — an attacker who holds
// the victim's posting key cannot re-mint a session against a long-since-finalized
// account through the recovery path.
//
// getAccounts is stubbed to return the VALID authorized account for this
// username, so the posting-key ownership proof WOULD pass if the stuck-lookup
// reached it. That isolates the recency guard: the 400 is caused SOLELY by the
// window guard excluding the stale row, NOT by an independent ownership-probe
// failure. Remove the `AND updated_at > NOW() - INTERVAL '1 hour'` clause and
// this test flips to 200 (recovery admitted) — the mutation a `getAccounts → []`
// stub would silently survive.
// ─────────────────────────────────────────────────────────────────
describe.skipIf(!dbReachable)('signup-verify /confirm stale-finalized row is NOT recoverable', () => {
  const username = `stale${SUFFIX}`;
  const email = `stale_${RUN_ID}@example.com`;
  const keys = makeKeys(username);

  afterAll(async () => cleanupByUsername(username));

  it('a fully-finalized light row stamped 2h-stale is rejected (400, no JWT) — recency guard blocks the steady-state recovery bypass', async (ctx) => {
    if (!dbReachable) return ctx.skip(true, 'pg unreachable');
    // Steady-state completed account: username + keys + custody='light',
    // verify_token NULL, but last mutated 2h ago (outside the 1h window).
    await seedStaleFinalizedAccount({
      username,
      email,
      postingPrivate: keys.posting_private,
      memoPrivate: keys.memo_private,
    });

    // Force the token-not-found -> stuck-lookup path: a non-matching auth_token
    // (no row carries this verify_token). getAccounts returns the VALID account
    // whose authorized posting key matches the supplied posting_private, so the
    // ownership proof would PASS if the stuck-lookup reached it. It does not: the
    // recency guard excludes the 2h-stale row first, so the 400 isolates the
    // guard (remove the guard and this test goes 200).
    getAccountsMock.mockImplementation(async (names: string[]) => {
      if (names.includes(username)) {
        return [{ name: username, posting: { key_auths: [[keys.posting_public, 1]] } }];
      }
      return [];
    });

    const res = await request(app)
      .post('/api/auth/confirm')
      .send({
        auth_token: `confirmed:${'f5'.repeat(32)}`, // no row carries this verify_token
        username,
        keys,
      });

    // Recovery NOT admitted: the stale row falls outside STUCK_RECOVERY_WINDOW,
    // so the stuck-lookup returns 0 rows and the handler takes the generic
    // invalid-token reject.
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('BAD_REQUEST');
    // No session minted for a steady-state account via recovery.
    expect(res.body.data?.token).toBeFalsy();
    // No chain ops: neither account creation nor accreditation fired.
    expect(createClaimedAccountMock).not.toHaveBeenCalled();
    expect(broadcastJsonMock).not.toHaveBeenCalled();

    // The stale row is untouched: still finalized, verify_token still NULL,
    // not converted into a fresh session-bearing state.
    const pool = getAppPool()!;
    const { rows } = await pool.query<{ verify_token: string | null; custody: string }>(
      'SELECT verify_token, custody FROM accounts WHERE username = $1',
      [username],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].verify_token).toBeNull();
    expect(rows[0].custody).toBe('light');
  });
});

// ─────────────────────────────────────────────────────────────────
// /link mirror: stale-finalized SELF-custody row is NOT recoverable.
//
// The /link stuck-recovery lookup (username-keyed, gated on a FRESH Hive
// signature via `hiveAuthMethod === 'signature'`) carries the SAME recency
// guard as /confirm: `AND updated_at > NOW() - INTERVAL '1 hour'`. Until now
// only /confirm had a stale-row exclusion test; the /link guard could be
// deleted with no test going red. This drives a REAL verifyHiveSignature
// signed /link (carve-out clause (b): the crypto recovery + key-match run for
// real; only the chain `getAccounts` posting-key lookup is mocked, supplying
// the public key the real signature is checked against — the middleware itself
// is never mocked). A 2h-stale self-custody row plus a non-matching auth_token
// must take the generic 400, NOT a recovered session: an attacker holding a
// victim's posting key cannot re-mint a session against a long-since-linked
// account through the recovery path. Remove the recency guard and this flips
// to a recovered 200 — that is the mutation it isolates.
// ─────────────────────────────────────────────────────────────────
describe.skipIf(!dbReachable)('signup-verify /link stale-finalized self-custody row is NOT recoverable', () => {
  const username = `lnkstale${SUFFIX}`;
  const email = `lnkstale_${RUN_ID}@example.com`;
  // The posting key the real /link signature is signed with; getAccounts is
  // stubbed to advertise its public half so verifyHiveSignature's recovery
  // matches and the handler sees hiveAuthMethod='signature'.
  const postingPrivate = PrivateKey.fromSeed(`${username}-p`);
  const postingPublic = postingPrivate.createPublic().toString();

  afterAll(async () => cleanupByUsername(username));

  it('a 2h-stale self-custody row is rejected (400, no JWT) under a real signed /link — recency guard blocks the bypass', async (ctx) => {
    if (!dbReachable) return ctx.skip(true, 'pg unreachable');
    await seedStaleSelfCustodyAccount({ username, email });

    // verifyHiveSignature fetches the account's posting pubkey via getAccounts.
    // Return the VALID key so the REAL signature verifies and the handler reaches
    // the signature-gated stuck branch. The crypto proof is NOT mocked.
    getAccountsMock.mockImplementation(async (names: string[]) => {
      if (names.includes(username)) {
        return [{ name: username, posting: { key_auths: [[postingPublic, 1]] } }];
      }
      return [];
    });

    const body = { auth_token: `linkstuck:${'9a'.repeat(32)}` }; // no row carries this verify_token
    const timestamp = new Date().toISOString();
    const signature = signRequestBound(postingPrivate, 'POST', '/api/auth/link', body, timestamp);

    const res = await request(app)
      .post('/api/auth/link')
      .set('X-Hive-Username', username)
      .set('X-Hive-Signature', signature)
      .set('X-Hive-Timestamp', timestamp)
      .send(body);

    // Recovery NOT admitted: the stale self row falls outside STUCK_RECOVERY_WINDOW,
    // so the username-keyed stuck-lookup returns 0 rows and the handler takes the
    // generic 400. The real signature DID verify (else this would be 401), so the
    // 400 isolates the recency guard, not an auth failure.
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('BAD_REQUEST');
    expect(res.body.data?.token).toBeFalsy();
    // No accreditation broadcast — the recovery never proceeded.
    expect(broadcastJsonMock).not.toHaveBeenCalled();

    // The stale row is untouched: still finalized self-custody, verify_token NULL.
    const pool = getAppPool()!;
    const { rows } = await pool.query<{ verify_token: string | null; custody: string }>(
      'SELECT verify_token, custody FROM accounts WHERE username = $1',
      [username],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].verify_token).toBeNull();
    expect(rows[0].custody).toBe('self');
  });
});

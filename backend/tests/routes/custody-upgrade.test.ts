/**
 * Real-path integration tests for POST /api/custody/upgrade after
 * BACKEND-CUSTODY-UPGRADE-SEED-PHRASE-REAUTH.
 *
 * Carve-out justification (root CLAUDE.md "Running Tests"):
 *   (a) Why a real path is impractical for one mock target: `getAccounts` hits
 *       Hive's mainnet which (i) does not have arbitrary test accounts seeded
 *       and (ii) does not respect a per-test posting/active/owner key set we
 *       can pre-commit to the chain. Real Postgres, real Redis, real
 *       `verifyHiveSignature` middleware (Bearer JWT path with
 *       config.sessionSecret), and real signature verification via
 *       `Signature.fromString().recover()` are used throughout. The ONLY mock
 *       target is `hiveClient.database.getAccounts` (a Hive read), which gives
 *       us deterministic control over the on-chain key set the route compares
 *       against. The rest of the proof verification chain (signature recover,
 *       pubkey binding check, timing-safe compare) runs against the same dhive
 *       cryptoUtils the production handler uses.
 *   (b) `verifyHiveSignature` is NOT mocked. The route's bearer-JWT path is
 *       exercised by minting JWTs signed with `config.sessionSecret`, the same
 *       path the real `/api/auth/login` produces. The signature verification
 *       under test is the seed-phrase-derived signature in the request body,
 *       which is fully real-path (real PrivateKey.fromSeed → real
 *       Signature.fromString → real recover + comparison against the mocked
 *       chain key set).
 *   (c) Real-path companions: `custody.test.ts` exercises the same JWT path
 *       and middleware on `/broadcast` against real Postgres; auth tests
 *       elsewhere exercise the un-mocked Hive signature path on other routes.
 *       The risk class this file owns (proof shape, freshness window, binding,
 *       chain-key matching, state A/B/C/D coverage) is exercised here against
 *       real Postgres rows + real cryptography.
 *
 * State coverage (ARCHITECTURE.md § 6.1):
 *   - State A (custody='light', password_hash=SET, orcid=NULL) — happy path.
 *   - State B (custody='light', password_hash=SET, orcid=SET) — happy path.
 *   - State C (custody='light', password_hash=NULL, orcid=SET) — happy path
 *     (NEW: previously blocked by argon2 hash requirement, now eligible).
 *   - State D (upgraded_at SET) — 409 ALREADY_UPGRADED.
 *
 * Rejection paths:
 *   - Missing derived_pubkey / signed_proof / signed_at — 400 VALIDATION_ERROR.
 *   - Expired signed_at (> 60s window, past or future) — 401 UNAUTHORIZED.
 *   - Malformed signed_proof — 401 UNAUTHORIZED.
 *   - Pubkey binding mismatch (signature recovers different key than declared)
 *     — 401 UNAUTHORIZED.
 *   - derived_pubkey not in chain key set (wrong username, key not rotated)
 *     — 401 UNAUTHORIZED.
 *   - Hive getAccounts throws — 503 SERVICE_UNAVAILABLE (transient retry).
 *   - JWT subject has no DB row — 401 UNAUTHORIZED (stale-session canary
 *     pins the `rows.length === 0` guard).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { PrivateKey, cryptoUtils } from '@hiveio/dhive';

const { getAccountsMock } = vi.hoisted(() => ({
  getAccountsMock: vi.fn(),
}));

vi.mock('../../src/hive.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/hive.js')>('../../src/hive.js');
  return {
    ...actual,
    hiveClient: {
      database: { getAccounts: getAccountsMock },
      broadcast: actual.hiveClient.broadcast,
    },
  };
});

const { createApp } = await import('../../src/app.js');
const { getAppPool } = await import('../../src/app-db.js');
const { config } = await import('../../src/config.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');

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

// Hive usernames: /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/. Use base36 suffix.
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const STATE_A_USER = `upga${SUFFIX}user`;
const STATE_B_USER = `upgb${SUFFIX}user`;
const STATE_C_USER = `upgc${SUFFIX}user`;
const STATE_D_USER = `upgd${SUFFIX}user`;
const REJECT_USER = `upgr${SUFFIX}user`;
const ALL_USERS = [STATE_A_USER, STATE_B_USER, STATE_C_USER, STATE_D_USER, REJECT_USER];
const KNOWN_PASSWORD = 'KnownPassword1';

function bearerForLight(username: string): string {
  const token = jwt.sign({ sub: username, custody: 'light' }, config.sessionSecret, { expiresIn: '5m' });
  return `Bearer ${token}`;
}

/** Build a valid proof body for `username` using `wif`. The returned body
 *  matches the production-reachable shape the SPA sends after the on-chain
 *  account_update has rotated the chain's posting/active/owner keys to the
 *  pubkeys derived from the new seed phrase. */
function buildProofBody(
  username: string,
  wif: string,
  opts: { signedAtOverride?: string } = {},
): { derived_pubkey: string; signed_proof: string; signed_at: string } {
  const priv = PrivateKey.fromString(wif);
  const pub = priv.createPublic().toString();
  const signedAt = opts.signedAtOverride ?? new Date().toISOString();
  const challenge = `${config.appTag}-custody-upgrade|v1|${username}|${signedAt}`;
  const sig = priv.sign(cryptoUtils.sha256(challenge));
  return {
    derived_pubkey: pub,
    signed_proof: sig.toString(),
    signed_at: signedAt,
  };
}

/** Build a fake on-chain account whose posting key contains `pubkey`. */
function fakeChainAccount(pubkey: string) {
  return {
    posting: {
      weight_threshold: 1,
      account_auths: [],
      key_auths: [[pubkey, 1]],
    },
    active: {
      weight_threshold: 1,
      account_auths: [],
      key_auths: [['STM7otherActive00000000000000000000000000000000000000', 1]],
    },
    owner: {
      weight_threshold: 1,
      account_auths: [],
      key_auths: [['STM7otherOwner00000000000000000000000000000000000000', 1]],
    },
  };
}

async function cleanup(pool: NonNullable<ReturnType<typeof getAppPool>>) {
  await pool.query(`DELETE FROM custody_audit_log WHERE username = ANY($1)`, [ALL_USERS]).catch(() => {});
  await pool.query(`DELETE FROM accounts WHERE username = ANY($1)`, [ALL_USERS]).catch(() => {});
}

describe.skipIf(!dbReachable)(
  'BACKEND-CUSTODY-UPGRADE-SEED-PHRASE-REAUTH: /api/custody/upgrade with seed-phrase-derived-key proof',
  () => {
    let realHash: string;
    // One WIF per user — its public key is what we tell the mocked Hive
    // chain account contains. Each test signs with the WIF and submits the
    // derived pubkey.
    const wifA = PrivateKey.fromSeed(`upga-${RUN_ID}`).toString();
    const wifB = PrivateKey.fromSeed(`upgb-${RUN_ID}`).toString();
    const wifC = PrivateKey.fromSeed(`upgc-${RUN_ID}`).toString();
    const wifD = PrivateKey.fromSeed(`upgd-${RUN_ID}`).toString();
    const wifR = PrivateKey.fromSeed(`upgr-${RUN_ID}`).toString();
    const wifOther = PrivateKey.fromSeed(`other-${RUN_ID}`).toString();

    beforeAll(async () => {
      if (!dbReachable) return;
      realHash = await argon2.hash(KNOWN_PASSWORD, { type: argon2.argon2id });
    });

    beforeEach(async () => {
      if (!dbReachable) return;
      const pool = getAppPool()!;
      await cleanup(pool);
      await clearRateLimitKeys(['custody-upgrade']);
      getAccountsMock.mockReset();

      // Seed state A: light + password + no ORCID + no upgraded_at.
      await pool.query(
        `INSERT INTO accounts (email, username, password_hash, custody, orcid, verify_token, expires_at)
         VALUES ($1, $2, $3, 'light', NULL, NULL, $4)`,
        [
          `upgrade_A_${RUN_ID}@example.com`,
          STATE_A_USER,
          realHash,
          new Date(Date.now() + 24 * 60 * 60 * 1000),
        ],
      );
      // Seed state B: light + password + ORCID + no upgraded_at.
      await pool.query(
        `INSERT INTO accounts (email, username, password_hash, custody, orcid, verify_token, expires_at)
         VALUES ($1, $2, $3, 'light', $4, NULL, $5)`,
        [
          `upgrade_B_${RUN_ID}@example.com`,
          STATE_B_USER,
          realHash,
          '0000-0000-0000-0001',
          new Date(Date.now() + 24 * 60 * 60 * 1000),
        ],
      );
      // Seed state C: light + null password + ORCID + no upgraded_at
      // (passwordless ORCID-only — previously blocked from upgrading).
      await pool.query(
        `INSERT INTO accounts (email, username, password_hash, custody, orcid, verify_token, expires_at)
         VALUES ($1, $2, NULL, 'light', $3, NULL, $4)`,
        [
          `upgrade_C_${RUN_ID}@example.com`,
          STATE_C_USER,
          '0000-0000-0000-0002',
          new Date(Date.now() + 24 * 60 * 60 * 1000),
        ],
      );
      // Seed state D: already-upgraded — upgraded_at SET.
      await pool.query(
        `INSERT INTO accounts (email, username, password_hash, custody, orcid, verify_token, upgraded_at, expires_at)
         VALUES ($1, $2, $3, 'self', NULL, NULL, NOW(), $4)`,
        [
          `upgrade_D_${RUN_ID}@example.com`,
          STATE_D_USER,
          realHash,
          new Date(Date.now() + 24 * 60 * 60 * 1000),
        ],
      );
      // Seed reject baseline: light + password + no ORCID + no upgraded_at.
      // Used for all 400/401 rejection cases so the per-account upgradeLimiter
      // (1/hr) doesn't collide across them — we clear the rate-limit bucket in
      // beforeEach, so this account can be exercised multiple times.
      await pool.query(
        `INSERT INTO accounts (email, username, password_hash, custody, orcid, verify_token, expires_at)
         VALUES ($1, $2, $3, 'light', NULL, NULL, $4)`,
        [
          `upgrade_R_${RUN_ID}@example.com`,
          REJECT_USER,
          realHash,
          new Date(Date.now() + 24 * 60 * 60 * 1000),
        ],
      );
    });

    afterAll(async () => {
      if (!dbReachable) return;
      const pool = getAppPool()!;
      await cleanup(pool);
    });

    // ─── Happy paths: A / B / C upgrade with valid proof ───────────────

    it('State A (light + password + no ORCID): upgrades successfully with valid proof', async () => {
      const pool = getAppPool()!;
      const proof = buildProofBody(STATE_A_USER, wifA);
      getAccountsMock.mockResolvedValue([fakeChainAccount(proof.derived_pubkey)]);

      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', bearerForLight(STATE_A_USER))
        .send(proof);

      expect(res.status).toBe(200);
      expect(res.body.data?.custody).toBe('self');
      expect(typeof res.body.data?.token).toBe('string');
      expect(typeof res.body.data?.expires_at).toBe('string');

      const { rows } = await pool.query<{ upgraded_at: Date | null; posting_key_enc: Buffer | null; iv_posting: Buffer | null; memo_key_enc: Buffer | null; iv_memo: Buffer | null }>(
        'SELECT upgraded_at, posting_key_enc, iv_posting, memo_key_enc, iv_memo FROM accounts WHERE username = $1',
        [STATE_A_USER],
      );
      expect(rows[0].upgraded_at).not.toBeNull();
      expect(rows[0].posting_key_enc).toBeNull();
      expect(rows[0].iv_posting).toBeNull();
      expect(rows[0].memo_key_enc).toBeNull();
      expect(rows[0].iv_memo).toBeNull();
    });

    it('State B (light + password + ORCID): upgrades successfully with valid proof', async () => {
      const pool = getAppPool()!;
      const proof = buildProofBody(STATE_B_USER, wifB);
      getAccountsMock.mockResolvedValue([fakeChainAccount(proof.derived_pubkey)]);

      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', bearerForLight(STATE_B_USER))
        .send(proof);

      expect(res.status).toBe(200);
      expect(res.body.data?.custody).toBe('self');

      const { rows } = await pool.query<{ upgraded_at: Date | null }>(
        'SELECT upgraded_at FROM accounts WHERE username = $1',
        [STATE_B_USER],
      );
      expect(rows[0].upgraded_at).not.toBeNull();
    });

    it('State C (passwordless ORCID-only): upgrades successfully with valid proof — previously blocked branch', async () => {
      const pool = getAppPool()!;
      const proof = buildProofBody(STATE_C_USER, wifC);
      getAccountsMock.mockResolvedValue([fakeChainAccount(proof.derived_pubkey)]);

      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', bearerForLight(STATE_C_USER))
        .send(proof);

      expect(res.status).toBe(200);
      expect(res.body.data?.custody).toBe('self');

      const { rows } = await pool.query<{ upgraded_at: Date | null; password_hash: string | null }>(
        'SELECT upgraded_at, password_hash FROM accounts WHERE username = $1',
        [STATE_C_USER],
      );
      expect(rows[0].upgraded_at).not.toBeNull();
      // password_hash is preserved (still NULL — § 6.2: "preserved").
      expect(rows[0].password_hash).toBeNull();
    });

    // ─── State D: already-upgraded ─────────────────────────────────────

    it('State D (already upgraded): returns 409 ALREADY_UPGRADED', async () => {
      const proof = buildProofBody(STATE_D_USER, wifD);
      getAccountsMock.mockResolvedValue([fakeChainAccount(proof.derived_pubkey)]);

      const res = await request(app)
        .post('/api/custody/upgrade')
        // State D row has custody='self', so middleware will see custody='self'
        // via the JWT — but we use a custody:'light' JWT here to ensure the
        // 409 fires at the DB-level upgraded_at check, not at the JWT-custody
        // gate. Real-world: a user with state D would have been re-issued
        // a custody:'self' JWT, hitting the 403 FORBIDDEN gate before this
        // check. The 409 path defends against stale-JWT replay specifically.
        .set('Authorization', bearerForLight(STATE_D_USER))
        .send(proof);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_UPGRADED');
    });

    // ─── Rejection paths ───────────────────────────────────────────────

    it('Missing derived_pubkey: returns 400 VALIDATION_ERROR', async () => {
      const proof = buildProofBody(REJECT_USER, wifR);
      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', bearerForLight(REJECT_USER))
        .send({ signed_proof: proof.signed_proof, signed_at: proof.signed_at });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/derived_pubkey/);
    });

    it('Missing signed_proof: returns 400 VALIDATION_ERROR', async () => {
      const proof = buildProofBody(REJECT_USER, wifR);
      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', bearerForLight(REJECT_USER))
        .send({ derived_pubkey: proof.derived_pubkey, signed_at: proof.signed_at });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/signed_proof/);
    });

    it('Missing signed_at: returns 400 VALIDATION_ERROR', async () => {
      const proof = buildProofBody(REJECT_USER, wifR);
      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', bearerForLight(REJECT_USER))
        .send({ derived_pubkey: proof.derived_pubkey, signed_proof: proof.signed_proof });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/signed_at/);
    });

    it('Expired signed_at (> 60s old): returns 401 UNAUTHORIZED', async () => {
      // Signed 5 minutes ago — outside the 60s freshness window. The signature
      // itself is otherwise valid; the freshness gate catches it.
      const oldTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const proof = buildProofBody(REJECT_USER, wifR, { signedAtOverride: oldTs });
      getAccountsMock.mockResolvedValue([fakeChainAccount(proof.derived_pubkey)]);

      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', bearerForLight(REJECT_USER))
        .send(proof);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    // Round-3 hold item 3: clock-skew tolerance is an Option-A 5s forward
    // skew. A timestamp 30s in the future exceeds the 5s tolerance and
    // must reject. The symmetric `Math.abs(...) < 60s` form this replaced
    // would have accepted +30s and doubled the replay race window; the
    // zero-skew form locked out users with 100ms of normal forward drift.
    // This test pins the bounded forward window.
    it('Future-dated signed_at (> 5s skew tolerance): returns 401 UNAUTHORIZED', async () => {
      const futureTs = new Date(Date.now() + 30_000).toISOString();
      const proof = buildProofBody(REJECT_USER, wifR, { signedAtOverride: futureTs });
      getAccountsMock.mockResolvedValue([fakeChainAccount(proof.derived_pubkey)]);

      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', bearerForLight(REJECT_USER))
        .send(proof);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('Malformed signed_proof (bad hex): returns 401 UNAUTHORIZED', async () => {
      const proof = buildProofBody(REJECT_USER, wifR);
      getAccountsMock.mockResolvedValue([fakeChainAccount(proof.derived_pubkey)]);

      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', bearerForLight(REJECT_USER))
        .send({ ...proof, signed_proof: 'zzznot-a-hex-signature' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('Pubkey binding mismatch (declared derived_pubkey differs from signature-recovered): returns 401', async () => {
      // Sign with wifR but declare a different pubkey (from wifOther). The
      // signature recovers wifR's pubkey, which doesn't match the declared
      // derived_pubkey → binding violation.
      const realProof = buildProofBody(REJECT_USER, wifR);
      const otherPub = PrivateKey.fromString(wifOther).createPublic().toString();
      getAccountsMock.mockResolvedValue([fakeChainAccount(realProof.derived_pubkey)]);

      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', bearerForLight(REJECT_USER))
        .send({ ...realProof, derived_pubkey: otherPub });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('derived_pubkey not in chain key set: returns 401 UNAUTHORIZED', async () => {
      // Valid signature + valid binding, but the chain account returned by
      // getAccounts does NOT contain the derived pubkey in any auth slot
      // (posting/active/owner). This simulates "user's JWT is for account X
      // but the proof was for account Y" (or "the on-chain rotation hasn't
      // landed yet"). The recovered pubkey matches derived_pubkey but neither
      // appears in the chain key set.
      const proof = buildProofBody(REJECT_USER, wifR);
      const otherPub = PrivateKey.fromString(wifOther).createPublic().toString();
      getAccountsMock.mockResolvedValue([fakeChainAccount(otherPub)]);

      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', bearerForLight(REJECT_USER))
        .send(proof);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('Chain getAccounts returns empty array: returns 401 UNAUTHORIZED (no on-chain account)', async () => {
      const proof = buildProofBody(REJECT_USER, wifR);
      getAccountsMock.mockResolvedValue([]);

      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', bearerForLight(REJECT_USER))
        .send(proof);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('Self-custody JWT: returns 403 FORBIDDEN before any proof check', async () => {
      const proof = buildProofBody(REJECT_USER, wifR);
      const selfJwt = jwt.sign({ sub: REJECT_USER, custody: 'self' }, config.sessionSecret, { expiresIn: '5m' });
      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', `Bearer ${selfJwt}`)
        .send(proof);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      // Proof never reached the verifier — getAccounts must not have been called.
      expect(getAccountsMock).not.toHaveBeenCalled();
    });

    // ─── Hive RPC failure path (503 SERVICE_UNAVAILABLE) ───────────────
    // Round-2 hold item 1: the existing suite covers `getAccounts` returning
    // an empty array and returning a mismatched key set, but the throw path
    // (Hive RPC unreachable) was not exercised. Hive RPC failures are routine
    // in production; the 503 branch is reachable.

    it('Hive getAccounts throws: returns 503 SERVICE_UNAVAILABLE', async () => {
      const proof = buildProofBody(STATE_A_USER, wifA);
      getAccountsMock.mockRejectedValueOnce(new Error('rpc unreachable'));

      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', bearerForLight(STATE_A_USER))
        .send(proof);

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    });

    // BACKEND-CUSTODY-UPGRADE-LIMITER-SKIP-FAILED P0 canary: the upgrade
    // limiter at custody.ts:50 uses `skipFailedRequests: true` so a 5xx
    // response refunds the per-account slot. Without it, a transient Hive
    // RPC blip burns the user's only retry attempt for the hour and leaves
    // them locked out with chain rotated to new keys but backend retaining
    // stale encrypted keys (catastrophic data-loss UX — they cannot retry
    // for an hour). This test pins the slot-refund behaviour.
    it('Hive getAccounts throws then recovers: 503 refunds limiter slot so the retry succeeds', async () => {
      const proof = buildProofBody(STATE_A_USER, wifA);
      // First call fails with 503; default mock then returns the chain key
      // set so the retry is a valid upgrade.
      getAccountsMock.mockRejectedValueOnce(new Error('rpc unreachable'));
      getAccountsMock.mockResolvedValue([fakeChainAccount(proof.derived_pubkey)]);

      const firstRes = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', bearerForLight(STATE_A_USER))
        .send(proof);
      expect(firstRes.status).toBe(503);

      // Retry immediately with a freshly signed proof (the original
      // signed_at would still be within the 60s window but signing again
      // mirrors the SPA's retry path).
      const retryProof = buildProofBody(STATE_A_USER, wifA);
      const retryRes = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', bearerForLight(STATE_A_USER))
        .send(retryProof);

      // If the limiter had NOT refunded the slot, this would be 429. The
      // 200 here is the load-bearing assertion against the
      // seed-phrase-loss cascade documented in
      // backend-custody-upgrade-limiter-skip-failed.
      expect(retryRes.status).toBe(200);
    });

    // ─── Stale JWT / missing DB row (401 canary) ───────────────────────
    // Round-2 hold item 6: after the SELECT shape change to just
    // `upgraded_at`, `rows[0]` access requires the `rows.length === 0`
    // guard. A mutation dropping that guard would TypeError on the next-line
    // property access → outer catch → 500. This test pins the 401 path so
    // any such silent regression flips a CI assertion.

    it('No DB row for JWT subject: returns 401 UNAUTHORIZED (stale session)', async () => {
      const pool = getAppPool()!;
      const stranger = `upgs${SUFFIX}user`;
      // Cleanup in case a previous run left a row (defensive — beforeEach
      // does not seed this username and afterAll does not target it).
      await pool.query(`DELETE FROM accounts WHERE username = $1`, [stranger]).catch(() => {});
      const proof = buildProofBody(stranger, wifR);
      // getAccounts is short-circuited by the missing-row check, but ensure
      // the mock is configured so any leak would be visible.
      getAccountsMock.mockResolvedValue([fakeChainAccount(proof.derived_pubkey)]);

      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', bearerForLight(stranger))
        .send(proof);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      // Missing-row check fires before the Hive lookup.
      expect(getAccountsMock).not.toHaveBeenCalled();
    });
  },
);

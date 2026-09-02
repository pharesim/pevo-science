/**
 * The account revocation epoch on `POST /api/ipfs/upload-token`.
 *
 * That route is the only surface that reaches `consumeFreshAuthProof` with
 * `acceptSession: true`, so it is the only place `req.hiveSessionsInvalidatedAt`
 * reaches a session-window consume through the proof middleware. Deleting the
 * `sessionsInvalidatedAtMs` property from the surface literal inside
 * `consumeFreshAuthProof` used to typecheck and silently un-revoke every
 * pre-rotation upload window while the whole suite stayed green: the custody
 * broadcast route passes the epoch through its own separate
 * `consumeSessionFreshAuthToken` call, so its tests cannot observe this one.
 *
 * Why the epoch and not the sweep. `invalidateSessionFreshAuthTokens` is
 * best-effort across the Redis tiers, while `accounts.sessions_invalidated_at`
 * is committed by the same Postgres transaction as the rotation. Every spec here
 * stamps the column WITHOUT calling the sweep, reproducing the state a missed,
 * re-planted, or Redis-down sweep leaves behind: the proof stays fully present
 * and structurally valid in the store, and only Postgres knows it is dead.
 *
 * Mocks (per root CLAUDE.md "Carve-out for deterministic edge-case coverage"):
 *   (a) None. `verifyHiveSignature` runs REAL, which is the point: it is the
 *       component that reads `sessions_invalidated_at` and publishes
 *       `req.hiveSessionsInvalidatedAt`. Bearer JWTs are signed with the real
 *       session secret, Postgres and Redis are real, and the fresh-auth mint and
 *       consume are real.
 *   (b) The auth focus is the JWT branch of the middleware plus the fresh-auth
 *       gate, and neither is bypassed.
 *   (c) The declared descriptor is deliberately invalid, so every request stops
 *       at the handler's sha256 shape check. That check sits AFTER
 *       `requireFreshAuth` and BEFORE the accreditation HAF read, which makes
 *       the 401-versus-400 discrimination the whole assertion: 401
 *       FRESH_AUTH_REQUIRED means the gate rejected, 400 BAD_REQUEST means the
 *       gate passed. No HAF dependency, and no assertion here duplicates the
 *       upload-token minting covered by the sibling upload-token suite.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const { createApp } = await import('../../src/app.js');
const { getAppPool } = await import('../../src/app-db.js');
const { config } = await import('../../src/config.js');
const {
  issueSessionFreshAuthToken,
  SESSION_FRESH_AUTH_ABSOLUTE_SECONDS,
  _resetFreshAuthMemStoreForTests,
} = await import('../../src/lib/fresh-auth.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');

const app = createApp();

const RUN_ID = Date.now();
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
// Run-unique: `accounts.username` is UNIQUE, and two workers sharing one row
// would have one run's epoch stamp revoke the other run's window.
const USER = `iput${SUFFIX}`;
const USER_EMAIL = `ipfs_upload_token_epoch_${RUN_ID}@example.com`;

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

/** Structurally invalid on purpose: the handler's sha256 shape check rejects it
 *  at descriptor validation, which sits after `requireFreshAuth` and before the
 *  accreditation read. So a 401 means the gate rejected and a 400 means the gate
 *  passed, both deterministic and neither needing HAF. */
const DESCRIPTOR = { file_sha256: 'not-a-valid-sha256', mimetype: 'application/pdf', size: 1234 };

async function removeAccount(): Promise<void> {
  if (!dbReachable) return;
  await getAppPool()!
    .query('DELETE FROM accounts WHERE username = $1 OR email = $2', [USER, USER_EMAIL])
    .catch(() => {});
}

/** Stamp `accounts.sessions_invalidated_at` directly, WITHOUT calling the Redis
 *  sweep. The omission is the point: it reproduces the state
 *  `invalidateSessionFreshAuthTokens` leaves behind when it cannot do its job.
 *  TIMESTAMPTZ plus `to_timestamp()` round-trips a millisecond value back
 *  through `Date.getTime()` exactly, which the equal-instant spec depends on. */
async function stampRevocationEpoch(username: string, atMs: number): Promise<void> {
  await getAppPool()!.query(
    'UPDATE accounts SET sessions_invalidated_at = to_timestamp($1) WHERE username = $2',
    [atMs / 1000, username],
  );
}

/** A bearer token whose `iat` is after `afterMs`, so the JWT itself survives the
 *  same revocation stamp that kills the window. This is the realistic shape: the
 *  user resets their password and logs in again, so they hold a valid session.
 *  What must not come back with it is the upload window they had open before the
 *  reset. A JWT minted at or before the epoch second would be refused inside
 *  `verifyHiveSignature` and never reach the fresh-auth gate. */
function bearerIssuedAfter(username: string, afterMs: number): string {
  const token = jwt.sign(
    { sub: username, custody: 'light', iat: Math.floor(afterMs / 1000) + 2 },
    config.sessionSecret,
    { expiresIn: '5m' },
  );
  return `Bearer ${token}`;
}

/** The window's own `issued_at`, recovered exactly. The mint reports the
 *  absolute deadline as the mint instant plus the cap, never clamped, so this
 *  inverts to the stored entry's anchor to the millisecond. Needed because the
 *  epoch comparison is "at or before", and the only way to pin the "at" half is
 *  to stamp the epoch at exactly this value. */
function windowIssuedAtMs(absoluteExpiresAtIso: string): number {
  return Date.parse(absoluteExpiresAtIso) - SESSION_FRESH_AUTH_ABSOLUTE_SECONDS * 1000;
}

function postToken(auth: string, proofToken: string) {
  return request(app)
    .post('/api/ipfs/upload-token')
    .set('Authorization', auth)
    .send({ ...DESCRIPTOR, fresh_auth_proof: proofToken });
}

beforeEach(async () => {
  if (!dbReachable) return;
  _resetFreshAuthMemStoreForTests();
  await clearRateLimitKeys(['ipfs-upload-token']);
  const pool = getAppPool()!;
  // The seed row is load-bearing twice over: the middleware's revocation SELECT
  // returns zero rows for an unseeded account and publishes null (no cut-off at
  // all), and the epoch stamp is an UPDATE that would otherwise match nothing.
  // Delete on email as well as username, because email is NOT NULL UNIQUE and a
  // row left by a crashed prior run would fail the INSERT.
  await pool
    .query('DELETE FROM accounts WHERE username = $1 OR email = $2', [USER, USER_EMAIL])
    .catch(() => {});
  await pool.query(
    `INSERT INTO accounts (email, username, custody, verify_token, expires_at)
     VALUES ($1, $2, 'light', NULL, $3)`,
    [USER_EMAIL, USER, new Date(Date.now() + 24 * 60 * 60 * 1000)],
  );
});

afterAll(async () => {
  await removeAccount();
  await clearRateLimitKeys(['ipfs-upload-token']);
});

describe.skipIf(!dbReachable)(
  'POST /api/ipfs/upload-token — the account revocation epoch closes a pre-rotation window',
  () => {
    it('a window minted before the epoch is rejected with 401 + reason expired, even though the proof is still in the store', async () => {
      const proof = await issueSessionFreshAuthToken(USER, 'password');
      const epochMs = Date.now();
      await stampRevocationEpoch(USER, epochMs);

      const res = await postToken(bearerIssuedAfter(USER, epochMs), proof.token);

      expect(res.status).toBe(401);
      // FRESH_AUTH_REQUIRED, not SESSION_INVALIDATED and not BAD_REQUEST, is the
      // load-bearing discriminator: it proves the JWT itself survived the stamp
      // and the rejection came from the session-window epoch comparison rather
      // than from the middleware's own JWT revocation check or from descriptor
      // validation.
      expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(res.body.error.details?.reason).toBe('expired');
    });

    it('a window minted AFTER the epoch passes the gate and reaches descriptor validation', async () => {
      // The control that keeps the check honest. Without it, a comparison that
      // rejected every window whenever the column was non-null would pass the
      // spec above and lock every account out of uploading for good after its
      // first password reset.
      const epochMs = Date.now();
      await stampRevocationEpoch(USER, epochMs);
      // Past the epoch, so the new window's anchor is strictly after it.
      await new Promise((r) => setTimeout(r, 20));
      const proof = await issueSessionFreshAuthToken(USER, 'password');

      const res = await postToken(bearerIssuedAfter(USER, epochMs), proof.token);

      // 400, not 401: the fresh-auth gate passed and the handler ran, stopping
      // at descriptor validation.
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    });

    it('an epoch stamped at exactly the window issued_at closes it, and a slide does not move it out of range', async () => {
      const proof = await issueSessionFreshAuthToken(USER, 'password');
      const issuedAtMs = windowIssuedAtMs(proof.absolute_expires_at);

      // First consume: no epoch is stamped yet, so the gate passes and the
      // window slides its idle deadline forward.
      const first = await postToken(bearerIssuedAfter(USER, issuedAtMs), proof.token);
      expect(first.status).toBe(400);
      expect(first.body.error.code).toBe('BAD_REQUEST');

      // The slide's Redis write is deliberately detached from the consume and
      // the Redis tier is the preferred read, so settle before the second
      // request or it can race the pre-slide copy.
      await new Promise((r) => setTimeout(r, 50));

      // Stamp the epoch at EXACTLY the window's anchor. Two invariants ride on
      // this one line. First, the comparison is "at or before": an epoch equal
      // to the anchor must close the window, which is what a reset landing in
      // the millisecond a window was minted actually produces. Second, the
      // anchor is carried through every slide unchanged; if a slide rewrote it
      // to the consume time, the window just slid past this epoch and would come
      // back to life, ageing out of its own revocation.
      await stampRevocationEpoch(USER, issuedAtMs);

      const second = await postToken(bearerIssuedAfter(USER, issuedAtMs), proof.token);
      expect(second.status).toBe(401);
      expect(second.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(second.body.error.details?.reason).toBe('expired');
    });
  },
);

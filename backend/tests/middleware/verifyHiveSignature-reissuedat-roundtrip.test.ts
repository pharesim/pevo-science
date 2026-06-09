/**
 * Real-path round-trip pin for the same-second JWT-revocation exemption:
 * `reissuedAt` (embedded at mint) MUST equal `sessions_invalidated_at.getTime()`
 * (read back from Postgres) for the freshly reissued recover token to survive
 * `verifyHiveSignature`'s `iat <= invalidatedAtSec && reissuedAt !== invalidatedAtMs`
 * revocation gate.
 *
 * Why this exists: the sibling
 * `verifyHiveSignature-replay-revocation-hardening.test.ts` proves the gate's
 * LOGIC with a mocked pool that returns the SAME constant the token embeds, so
 * it is tautological for the round-trip — it never exercises the
 * recover -> Postgres -> middleware path and would stay green if a future change
 * switched `recover.ts` from a Node `Date` to SQL `NOW()` (microsecond precision)
 * or rounded `reissuedAt` to seconds, silently logging out every user
 * immediately after a password reset. This is the CLAUDE.md test-carve-out
 * clause-(c) real-path companion that pins the actual round-trip.
 *
 * Flow: drive a genuine reissue via POST /api/auth/recover/verify (memo-key
 * phase 2 — purely DB-seeded, no ORCID/Redis nonce), read the stored
 * `sessions_invalidated_at`, decode the reissued JWT, assert
 * `reissuedAt === stored.getTime()`, then present the reissued token to the REAL
 * `verifyHiveSignature` (it SURVIVES, 200) alongside a pre-reset token minted in
 * the same integer second with no `reissuedAt` (it is REVOKED, 401).
 *
 * Test-mock carve-out (per root CLAUDE.md "Running Tests"):
 *   (a) Justification: the app Postgres pool (`getAppPool`) is NOT mocked — the
 *       DB round-trip is the entire point. `getRedis`/`isRedisAvailable` (shared
 *       cache helpers, enumerated carve-out scope) are stubbed to the in-memory
 *       fallback so the byIp `recoverLimiter` is process-local and cannot 429
 *       under cross-file Redis bucket contention; the JWT branch of
 *       `verifyHiveSignature` and the `/recover/verify` handler use no Redis, so
 *       this stub does not touch the behavior under test.
 *   (b) `verifyHiveSignature` is NOT mocked. The focus IS authentication /
 *       session-revocation behavior, so the real middleware and real
 *       `jsonwebtoken` verification run against real Postgres rows;
 *       `MOCK_VERIFY_SIGNATURE` is deliberately not used.
 *   (c) This file is itself the real-path companion for the mocked hardening
 *       suite's same-second item.
 *
 * Skips cleanly when the app Postgres is unreachable (mirrors recover.test.ts).
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import request from 'supertest';
import express, { type Request, type Response } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../../src/config.js';

// In-memory rate-limit / cache fallback so the byIp recoverLimiter is
// process-local (see carve-out (a)). verifyHiveSignature's JWT branch and the
// /recover/verify handler do not consult Redis.
vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
}));

const { getAppPool } = await import('../../src/app-db.js');
const { verifyHiveSignature } = await import('../../src/middleware/verifyHiveSignature.js');
const recoverRouter = (await import('../../src/routes/recover.js')).default;

const app = express();
app.use(express.json());
app.use('/api/auth', recoverRouter);
app.post('/probe', verifyHiveSignature, (req: Request, res: Response) =>
  res.status(200).json({ ok: true, hiveUsername: req.hiveUsername }),
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

const USERNAME_PREFIX = 'reissue_rt_';

async function cleanup() {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  try {
    await pool.query('DELETE FROM pending_recovery WHERE username LIKE $1', [`${USERNAME_PREFIX}%`]);
    await pool.query('DELETE FROM custody_audit_log WHERE username LIKE $1', [`${USERNAME_PREFIX}%`]);
    await pool.query('DELETE FROM accounts WHERE username LIKE $1', [`${USERNAME_PREFIX}%`]);
  } catch { /* ignore */ }
}

afterAll(async () => { await cleanup(); });

describe('verifyHiveSignature — reissuedAt <-> sessions_invalidated_at round-trip (real Postgres)', () => {
  it.skipIf(!dbReachable)(
    'reissued recover/verify token survives same-second revocation; reissuedAt equals the round-tripped stored ms',
    async () => {
      const pool = getAppPool()!;
      const username = `${USERNAME_PREFIX}${Date.now()}`;
      const oldEmail = `${username}_old@example.com`;
      const newEmail = `${username}_new@example.com`;

      // Seed a light account (verify_token NULL, not upgraded) and a staged
      // memo-key recovery row whose verify token we control.
      await pool.query(
        `INSERT INTO accounts (email, username, custody, verify_token) VALUES ($1, $2, 'light', NULL)`,
        [oldEmail, username],
      );
      const verifyToken = crypto.randomBytes(32).toString('hex');
      const disputeToken = crypto.randomBytes(32).toString('hex');
      const verifyTokenHash = crypto.createHash('sha256').update(verifyToken).digest();
      const disputeTokenHash = crypto.createHash('sha256').update(disputeToken).digest();
      const future = new Date(Date.now() + 3_600_000);
      await pool.query(
        `INSERT INTO pending_recovery
           (username, new_email, new_password_hash, verify_token_hash, verify_expires_at,
            dispute_token_hash, dispute_expires_at)
         VALUES ($1, $2, NULL, $3, $4, $5, $6)`,
        [username, newEmail, verifyTokenHash, future, disputeTokenHash, future],
      );

      // Drive the actual reissue (writes sessions_invalidated_at from a Node Date
      // and embeds reissuedAt = that exact epoch-ms).
      const res = await request(app).post('/api/auth/recover/verify').send({ token: verifyToken });
      expect(res.status).toBe(200);
      const reissued = res.body.data.token as string;
      expect(typeof reissued).toBe('string');

      // Read back the stored invalidation timestamp.
      const { rows } = await pool.query<{ sessions_invalidated_at: Date | null }>(
        'SELECT sessions_invalidated_at FROM accounts WHERE username = $1',
        [username],
      );
      const stored = rows[0]?.sessions_invalidated_at;
      expect(stored).toBeInstanceOf(Date);
      const storedMs = (stored as Date).getTime();

      // DECISIVE round-trip assertion: the reissued token's reissuedAt is the
      // exact millisecond read back from Postgres. A NOW()/seconds-rounding
      // regression in recover.ts turns this red.
      const decoded = jwt.decode(reissued) as { reissuedAt?: number; iat?: number } | null;
      expect(decoded?.reissuedAt).toBe(storedMs);

      // The reissued token SURVIVES the real verifyHiveSignature same-second gate.
      const survive = await request(app)
        .post('/probe')
        .set('Authorization', `Bearer ${reissued}`)
        .send({});
      expect(survive.status).toBe(200);
      expect(survive.body.hiveUsername).toBe(username);

      // A pre-reset token minted in the SAME integer second (no reissuedAt) is
      // revoked — proving the survival above is the reissuedAt identity match,
      // not a second-grained iat accident.
      const invalidatedSec = Math.floor(storedMs / 1000);
      const preReset = jwt.sign(
        { sub: username, custody: 'light', iat: invalidatedSec, exp: 9_999_999_999 },
        config.sessionSecret,
      );
      const revoked = await request(app)
        .post('/probe')
        .set('Authorization', `Bearer ${preReset}`)
        .send({});
      expect(revoked.status).toBe(401);
      expect(revoked.body.error.code).toBe('SESSION_INVALIDATED');
    },
  );
});

/**
 * Real-path round-trip pin for the ORCID-recovery reissue writer: `reissuedAt`
 * (embedded at mint) MUST equal `sessions_invalidated_at.getTime()` (read back
 * from Postgres) for the freshly reissued ORCID-recovery token to survive
 * `verifyHiveSignature`'s same-second revocation gate.
 *
 * Why this exists: `recover.ts` has TWO reissue writers that share the identical
 * Node-`Date` + `reissuedAt` idiom — the memo-key `/recover/verify` path (pinned
 * by the sibling `verifyHiveSignature-reissuedat-roundtrip.test.ts`) and the
 * ORCID-recovery `/recover` branch (pinned HERE). A `NOW()`/seconds-rounding
 * regression isolated to the ORCID branch would NOT turn the memo-key test red,
 * so this drives the ORCID branch's round-trip directly.
 *
 * Test-mock carve-out (per root CLAUDE.md "Running Tests"):
 *   (a) Justification: the app Postgres pool (`getAppPool`) is NOT mocked — the DB
 *       round-trip is the entire point. `getRedis`/`isRedisAvailable` (shared cache
 *       helpers, enumerated carve-out scope) are stubbed to the in-memory fallback
 *       so the byIp `recoverLimiter` is process-local AND the ORCID branch falls
 *       through to `orcid.js`'s in-memory `orcidVerified` map, which we seed
 *       deterministically. The real path resolves the verified ORCID from a live
 *       OAuth nonce in Redis, which is impractical to mint per-test; seeding the
 *       in-memory fallback exercises the same reissue write + read-back for real.
 *   (b) `verifyHiveSignature` is NOT mocked. The focus IS authentication /
 *       session-revocation behavior, so the real middleware and real `jsonwebtoken`
 *       run against real Postgres rows; `MOCK_VERIFY_SIGNATURE` is not used.
 *   (c) This file is the ORCID-branch real-path companion to the memo-key test.
 *
 * Skips cleanly when the app Postgres is unreachable (mirrors recover.test.ts).
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import request from 'supertest';
import express, { type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../src/config.js';

// In-memory rate-limit / cache fallback so the byIp recoverLimiter is
// process-local and the ORCID branch reads the in-memory orcidVerified map
// instead of Redis (see carve-out (a)).
vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
}));

const { getAppPool } = await import('../../src/app-db.js');
const { verifyHiveSignature } = await import('../../src/middleware/verifyHiveSignature.js');
const recoverRouter = (await import('../../src/routes/recover.js')).default;
const { orcidVerified } = await import('../../src/routes/orcid.js');

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

const USERNAME_PREFIX = 'reissue_orcid_rt_';

async function cleanup() {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  try {
    await pool.query('DELETE FROM custody_audit_log WHERE username LIKE $1', [`${USERNAME_PREFIX}%`]);
    await pool.query('DELETE FROM accounts WHERE username LIKE $1', [`${USERNAME_PREFIX}%`]);
  } catch { /* ignore */ }
}

afterAll(async () => { await cleanup(); });

describe('verifyHiveSignature — reissuedAt <-> sessions_invalidated_at round-trip on the ORCID-recovery reissue (real Postgres)', () => {
  it.skipIf(!dbReachable)(
    'reissued ORCID-recovery token survives same-second revocation; reissuedAt equals the round-tripped stored ms',
    async () => {
      const pool = getAppPool()!;
      const runId = Date.now();
      const username = `${USERNAME_PREFIX}${runId}`;
      const oldEmail = `${username}_old@example.com`;
      const newEmail = `${username}_new@example.com`;
      const orcidId = `0000-0003-${String(runId).slice(-4)}-0009`;
      const orcidToken = `orcid-nonce-${runId}`;

      // Seed a reachable account state named by its dimension tuple:
      // (custody=light, password-unset, ORCID-set, not upgraded) — the
      // ORCID-verified light account the set-password path already documents as
      // reachable. The ORCID-recovery branch reads custody + orcid + upgraded_at.
      await pool.query(
        `INSERT INTO accounts (email, username, custody, password_hash, orcid, verify_token)
         VALUES ($1, $2, 'light', NULL, $3, NULL)`,
        [oldEmail, username, orcidId],
      );

      // Seed the in-memory ORCID-verified nonce the recover ORCID branch consults
      // when Redis is unavailable (stubbed above). The branch resolves this entry's
      // orcid_id and requires it to equal account.orcid.
      orcidVerified.set(orcidToken, { orcid_id: orcidId, works_count: 1, name: 'RT Tester', expires: Date.now() + 600_000 });

      // Drive the actual ORCID reissue (writes sessions_invalidated_at from a Node
      // Date and embeds reissuedAt = that exact epoch-ms).
      const res = await request(app)
        .post('/api/auth/recover')
        .send({ username, orcid_token: orcidToken, new_email: newEmail });
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

      // DECISIVE round-trip assertion: the reissued token's reissuedAt is the exact
      // millisecond read back from Postgres. A NOW()/seconds-rounding regression in
      // the recover.ts ORCID branch turns this red.
      const decoded = jwt.decode(reissued) as { reissuedAt?: number; iat?: number } | null;
      expect(decoded?.reissuedAt).toBe(storedMs);

      // End-to-end sanity: the real reissued token is accepted by the real
      // verifyHiveSignature (NOT the discrimination proof — its sign-time iat is
      // nondeterministic across a second boundary, see the control tokens below).
      const survive = await request(app)
        .post('/probe')
        .set('Authorization', `Bearer ${reissued}`)
        .send({});
      expect(survive.status).toBe(200);
      expect(survive.body.hiveUsername).toBe(username);

      // Deterministic discrimination of the reissuedAt exemption: two control
      // tokens minted at the SAME integer second as the stored invalidation,
      // differing ONLY in the reissuedAt claim. The one carrying
      // reissuedAt === storedMs must SURVIVE; the one without it must be REVOKED —
      // so survival is pinned to the reissuedAt identity, not a second-grained iat.
      const invalidatedSec = Math.floor(storedMs / 1000);
      const controlWithReissue = jwt.sign(
        { sub: username, custody: 'light', iat: invalidatedSec, reissuedAt: storedMs, exp: 9_999_999_999 },
        config.sessionSecret,
      );
      const controlSurvive = await request(app)
        .post('/probe')
        .set('Authorization', `Bearer ${controlWithReissue}`)
        .send({});
      expect(controlSurvive.status).toBe(200);
      expect(controlSurvive.body.hiveUsername).toBe(username);

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

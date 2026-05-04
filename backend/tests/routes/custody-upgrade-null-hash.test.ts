/**
 * Mutation-fence test for the BACKEND-ORCID-CUSTODY-DEFAULT-INVARIANT fix
 * (Option A): the orcid.ts JWT mint now uses `custody: account.custody`
 * (no `|| 'light'` default), so ORCID-only accounts (custody=NULL,
 * password_hash=NULL) carry `custody: null` in the JWT. The middleware
 * (`verifyHiveSignature.ts:84`) coerces null → `'self'` via `||`, which
 * fails the `/api/custody/upgrade` `custody !== 'light'` gate and 403s
 * before any password-hash branch is reached. The previous round-2 null-
 * guard (`if (!account.password_hash)` with `burnSentinel`) is unreachable
 * through any documented path after this fix.
 *
 * Originally filed as round-2 hold of BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT
 * to lock the wall-time / status / audit-log convergence between the null-
 * hash sub-branch and the wrong-password branch. ADV-R4-3 from the cluster-A
 * round-3 review surfaced that the prior test seeded `custody='light'`
 * directly in the DB, masking the orcid-coercion path. After Option A:
 * the production-reachable shape (custody=NULL → JWT custody=null →
 * middleware coerces to 'self' → 403) is what this test now locks.
 *
 * Mutation kills:
 *   - "drop the orcid.ts `||` default removal and re-introduce coercion to
 *     'light'": the JWT mint with `custody: 'light'` would let the request
 *     pass the gate and reach the password-verify branch, returning 401.
 *     Asserting 403 FORBIDDEN here kills that mutation.
 *   - "drop the middleware `|| 'self'` fallback at line 84": the JWT with
 *     `custody: null` would propagate as `req.hiveCustody = undefined`,
 *     which still fails the `'light'` gate (still 403), so this test does
 *     not directly fence the middleware fallback. The middleware fallback
 *     is a defense-in-depth line; its primary mutation fence is the unit
 *     contract that JWTs may be null (asserted by the JWT minted below).
 *
 * Real-DB testing path: this file follows the same shape as recover.test.ts
 * (real argon2, real pg pool, real verifyHiveSignature middleware). The
 * synthetic-mock carve-out documented in root CLAUDE.md does NOT apply
 * here. `verifyHiveSignature` is satisfied by minting a real Bearer JWT
 * with `config.sessionSecret`, the same path orcid.ts mints.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { config } from '../../src/config.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';

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

// Hive usernames: /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/.
// Use a 4-char base36 suffix so two test usernames stay under 16 chars.
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const ORCID_USER = `orcd${SUFFIX}user`;
const WRONG_PWD_USER = `upwp${SUFFIX}user`;
const ORCID_EMAIL = `upgrade_orcidonly_${RUN_ID}@example.com`;
const WRONG_PWD_EMAIL = `upgrade_wrongpwd_${RUN_ID}@example.com`;
const KNOWN_PASSWORD = 'KnownPassword1';

// Mint the JWT shape orcid.ts now produces for ORCID-only accounts after
// BACKEND-ORCID-CUSTODY-DEFAULT-INVARIANT (Option A): `custody: null`. This
// is the production-reachable JWT shape this test is locked to.
function bearerForOrcidOnly(username: string): string {
  const token = jwt.sign({ sub: username, custody: null }, config.sessionSecret, { expiresIn: '5m' });
  return `Bearer ${token}`;
}

// Mint a `custody: 'light'` JWT for the wrong-password baseline (the
// production shape for a real light-custody account: signup-verify mints
// custody='light' and the row has custody='light' + a real password_hash).
function bearerForLight(username: string): string {
  const token = jwt.sign({ sub: username, custody: 'light' }, config.sessionSecret, { expiresIn: '5m' });
  return `Bearer ${token}`;
}

describe.skipIf(!dbReachable)(
  'BACKEND-ORCID-CUSTODY-DEFAULT-INVARIANT: /api/custody/upgrade ORCID-only JWT shape is gated at custody !== "light"',
  () => {
    let realHash: string;

    beforeAll(async () => {
      if (!dbReachable) return;
      realHash = await argon2.hash(KNOWN_PASSWORD, { type: argon2.argon2id });
    });

    beforeEach(async () => {
      if (!dbReachable) return;
      const pool = getAppPool()!;
      await pool.query('DELETE FROM custody_audit_log WHERE username IN ($1, $2)', [ORCID_USER, WRONG_PWD_USER]).catch(() => {});
      await pool.query('DELETE FROM accounts WHERE username IN ($1, $2)', [ORCID_USER, WRONG_PWD_USER]).catch(() => {});

      // Seed the production-reachable ORCID-only shape: custody=NULL +
      // password_hash=NULL + no upgraded_at. This matches the shape an
      // account inserted by ORCID-only signup carries (`accounts.custody`
      // is nullable per backend/migrations/001_schema.sql; orcid.ts does
      // not write 'light' on signup, so the column stays NULL).
      try {
        await pool.query(
          `INSERT INTO accounts (email, username, password_hash, custody, verify_token, expires_at)
           VALUES ($1, $2, NULL, NULL, NULL, $3)`,
          [ORCID_EMAIL, ORCID_USER, new Date(Date.now() + 24 * 60 * 60 * 1000)],
        );
      } catch (err) {
        throw new Error(
          `Failed to seed ORCID-only account ${ORCID_USER}: ${(err as Error).message}`,
        );
      }

      // Seed the wrong-password baseline: custody='light' + a real argon2
      // hash for KNOWN_PASSWORD + no upgraded_at. The mutation fence checks
      // that the wrong-password branch's response shape (401 + 'Invalid
      // password' + audit-log) is what real light-custody users see when
      // they fail upgrade — the contract this test fixes versus the
      // ORCID-only 403 shape.
      try {
        await pool.query(
          `INSERT INTO accounts (email, username, password_hash, custody, verify_token, expires_at)
           VALUES ($1, $2, $3, 'light', NULL, $4)`,
          [WRONG_PWD_EMAIL, WRONG_PWD_USER, realHash, new Date(Date.now() + 24 * 60 * 60 * 1000)],
        );
      } catch (err) {
        throw new Error(
          `Failed to seed wrong-password account ${WRONG_PWD_USER}: ${(err as Error).message}`,
        );
      }
    });

    afterAll(async () => {
      if (!dbReachable) return;
      const pool = getAppPool()!;
      await pool.query('DELETE FROM custody_audit_log WHERE username IN ($1, $2)', [ORCID_USER, WRONG_PWD_USER]).catch(() => {});
      await pool.query('DELETE FROM accounts WHERE username IN ($1, $2)', [ORCID_USER, WRONG_PWD_USER]).catch(() => {});
    });

    it('ORCID-only JWT (custody: null) is rejected at the custody !== "light" gate with 403 FORBIDDEN', async () => {
      if (!dbReachable) return;
      const pool = getAppPool()!;
      await clearRateLimitKeys(['custody-upgrade']);

      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', bearerForOrcidOnly(ORCID_USER))
        .send({ password: 'AnyPassword1' });

      // Status + envelope: the gate fires before the password-verify branch
      // can run, so the response is the route's standard FORBIDDEN error.
      // A regression that re-introduced `custody: account.custody || 'light'`
      // in orcid.ts would let the JWT pass the gate and return 401 instead
      // of 403 — that is the mutation this assertion kills.
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.message).toBe('Only custodial accounts can upgrade');

      // No audit-log entry: the gate at custody.ts:234 returns before
      // `logCustodyBroadcast(username, 'upgrade_failure')` is called.
      // A future regression that moved the audit-log call above the gate
      // would surface as a count of 1 here.
      const { rows: auditRows } = await pool.query(
        `SELECT operation_type FROM custody_audit_log WHERE username = $1`,
        [ORCID_USER],
      );
      expect(auditRows.length).toBe(0);
    });

    it('wrong-password branch returns 401 UNAUTHORIZED + Invalid password (light-custody baseline)', async () => {
      if (!dbReachable) return;
      const pool = getAppPool()!;
      await clearRateLimitKeys(['custody-upgrade']);

      const res = await request(app)
        .post('/api/custody/upgrade')
        .set('Authorization', bearerForLight(WRONG_PWD_USER))
        .send({ password: 'WrongPassword1' });

      // The wrong-password branch is the contract for real light-custody
      // accounts. Locking the 401 + 'Invalid password' shape here makes any
      // drift between the two branches visible.
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toBe('Invalid password');

      // The wrong-password branch DOES emit `upgrade_failure` (custody.ts:296).
      // Poll briefly for the fire-and-forget audit-log INSERT to settle.
      const sql = `SELECT operation_type FROM custody_audit_log
                   WHERE username = $1 AND operation_type = 'upgrade_failure'`;
      const start = Date.now();
      let auditRows: { operation_type: string }[] = [];
      while (Date.now() - start < 1500) {
        const { rows } = await pool.query(sql, [WRONG_PWD_USER]);
        if (rows.length >= 1) {
          await new Promise((r) => setTimeout(r, 100));
          const { rows: settled } = await pool.query(sql, [WRONG_PWD_USER]);
          auditRows = settled;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(auditRows.length).toBe(1);
    });
  },
);

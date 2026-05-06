/**
 * Round-4 hold #18 of `backend-coauthor-trust-model` — pin the null-
 * `password_hash` branch in `POST /api/custody/fresh-auth`.
 *
 * The branch returns 401 UNAUTHORIZED uniformly to avoid becoming a
 * password-existence oracle for ORCID-only / hybrid accounts. Without a
 * test, mutating the branch to return 404/403 (or any status that
 * differentiates from the wrong-password 401) would not be caught,
 * exposing the oracle.
 *
 * The shape mirrors `custody-upgrade-null-hash.test.ts` (real-DB pattern):
 *   - Real argon2 (a sibling 'wrong password' branch verifies a real hash).
 *   - Real pg pool against the test Postgres.
 *   - Real verifyHiveSignature middleware (JWT minted with config.sessionSecret).
 *   - No synthetic-mock carve-out (this isn't an edge-case-via-mock; it's
 *     a real-path branch with two seeded DB shapes).
 *
 * Mutation kills:
 *   - "drop the null-hash uniform-401 and return 403/404 instead": the
 *     status assertion fails.
 *   - "leak the null-hash discriminator via a different error code or
 *     message": the byte-equivalent envelope assertion below fails.
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

const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const NULL_HASH_USER = `nhsa${SUFFIX}user`;
const REAL_HASH_USER = `nhsb${SUFFIX}user`;
const NULL_HASH_EMAIL = `freshauth_nullhash_${RUN_ID}@example.com`;
const REAL_HASH_EMAIL = `freshauth_realhash_${RUN_ID}@example.com`;
const KNOWN_PASSWORD = 'KnownPassword1';

function bearerForLight(username: string): string {
  const token = jwt.sign({ sub: username, custody: 'light' }, config.sessionSecret, { expiresIn: '5m' });
  return `Bearer ${token}`;
}

describe.skipIf(!dbReachable)(
  'POST /api/custody/fresh-auth — null password_hash branch (round-4 hold #18)',
  () => {
    let realHash: string;

    beforeAll(async () => {
      if (!dbReachable) return;
      realHash = await argon2.hash(KNOWN_PASSWORD, { type: argon2.argon2id });
    });

    beforeEach(async () => {
      if (!dbReachable) return;
      const pool = getAppPool()!;
      await pool.query(
        'DELETE FROM accounts WHERE username IN ($1, $2)',
        [NULL_HASH_USER, REAL_HASH_USER],
      ).catch(() => {});

      // Seed the ORCID-only / hybrid shape: custody='light' but
      // password_hash=NULL. (The production-reachable shape arrives via
      // `verifyHiveSignature` minting `custody: 'light'` for an account
      // that an admin rolled into light-mode without setting a password.)
      await pool.query(
        `INSERT INTO accounts (email, username, password_hash, custody, verify_token, expires_at)
         VALUES ($1, $2, NULL, 'light', NULL, $3)`,
        [NULL_HASH_EMAIL, NULL_HASH_USER, new Date(Date.now() + 24 * 60 * 60 * 1000)],
      );

      // Seed the wrong-password baseline so the test can assert byte-
      // equivalence between the two 401 responses.
      await pool.query(
        `INSERT INTO accounts (email, username, password_hash, custody, verify_token, expires_at)
         VALUES ($1, $2, $3, 'light', NULL, $4)`,
        [REAL_HASH_EMAIL, REAL_HASH_USER, realHash, new Date(Date.now() + 24 * 60 * 60 * 1000)],
      );

      await clearRateLimitKeys(['custody-fresh-auth']);
    });

    afterAll(async () => {
      if (!dbReachable) return;
      const pool = getAppPool()!;
      await pool.query(
        'DELETE FROM accounts WHERE username IN ($1, $2)',
        [NULL_HASH_USER, REAL_HASH_USER],
      ).catch(() => {});
    });

    it('null password_hash → 401 UNAUTHORIZED with the same envelope shape as wrong-password', async () => {
      // Round-5 hold #3: /api/custody/fresh-auth now requires the per-op
      // target binding (`action`, `root_author`, `root_permlink`) on
      // every issuance request. Both legs of this oracle-parity test
      // supply identical target fields so the only behavioral
      // difference is the password-hash status (null vs valid hash).
      const targetFields = {
        action: 'author_accept',
        root_author: 'someroot',
        root_permlink: 'somepermlink-v1',
      };
      const nullHashRes = await request(app)
        .post('/api/custody/fresh-auth')
        .set('Authorization', bearerForLight(NULL_HASH_USER))
        .send({ password: 'AnyPassword1', ...targetFields });

      expect(nullHashRes.status).toBe(401);
      expect(nullHashRes.body.error.code).toBe('UNAUTHORIZED');
      expect(nullHashRes.body.error.message).toBe('Invalid password');

      // Wrong-password baseline. The route must return the SAME envelope
      // (status, code, message) so the route is not an oracle that leaks
      // whether the account has a password set.
      const wrongPwdRes = await request(app)
        .post('/api/custody/fresh-auth')
        .set('Authorization', bearerForLight(REAL_HASH_USER))
        .send({ password: 'WrongPassword1', ...targetFields });

      expect(wrongPwdRes.status).toBe(401);
      expect(wrongPwdRes.body.error.code).toBe('UNAUTHORIZED');
      expect(wrongPwdRes.body.error.message).toBe('Invalid password');

      // Byte-equivalent envelope assertion: status, error code, and
      // message all match. (We don't assert latency parity here — that
      // requires a tighter timing harness; the important security
      // invariant is the envelope shape.)
      expect(nullHashRes.status).toBe(wrongPwdRes.status);
      expect(nullHashRes.body.error.code).toBe(wrongPwdRes.body.error.code);
      expect(nullHashRes.body.error.message).toBe(wrongPwdRes.body.error.message);
    });
  },
);

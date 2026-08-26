/**
 * Session invalidation closes open session-proof windows.
 *
 * `accounts.sessions_invalidated_at` (`agents/docs/ARCHITECTURE.md` § 6.7) is
 * the bearer-JWT revocation mechanism: a password reset or an account recovery
 * stamps it, and `verifyHiveSignature` then rejects every token minted at or
 * before that second. On its own that is not enough once a session-kind
 * fresh-auth proof is windowed (§ 6.4.1): the proof is target-less and
 * multi-use for up to its absolute cap, so revoking tokens while leaving a live
 * window standing has not actually cut off the compromised session. Every
 * writer of `sessions_invalidated_at` must also call
 * `invalidateSessionFreshAuthTokens`.
 *
 * There are three such writers, and this suite drives all three end to end
 * through their real routes:
 *   - `POST /api/auth/reset` — the emailed password-reset token.
 *   - `POST /api/auth/recover` — the ORCID branch, which reissues a JWT.
 *   - `POST /api/auth/recover/verify` — phase 2 of memo-key recovery, which
 *     applies the staged swap inside a transaction and then reissues a JWT.
 *
 * "The window is closed" is asserted by consuming the proof through the real
 * `consumeSessionFreshAuthToken` against the real store, which is the same
 * store and the same call the broadcast route makes. A blast-radius test pins
 * the other direction: an unrelated account's window must survive.
 *
 * The static half of the guarantee lives in the last describe block: any future
 * writer of `sessions_invalidated_at`, anywhere under `src/`, must also sweep
 * the proofs from the same function. A wiring omission is the realistic failure
 * here, not a bug inside the helper (which `tests/lib/fresh-auth.test.ts`
 * covers directly), and an omission in a handler written months from now is
 * exactly what an end-to-end test of today's three routes cannot catch.
 *
 * Note what the sweep is and is not. It reclaims storage; it is NOT the
 * authoritative close. That is the revocation-epoch check inside the session
 * consume, which rejects any window minted at or before
 * `sessions_invalidated_at` straight from Postgres. The wiring canary still
 * matters — a writer that skips the sweep leaves dead windows occupying Redis
 * until their cap, and the sweep is what makes the end-to-end assertions below
 * hold for a caller that never re-presents the proof through the middleware.
 *
 * Mocks (per root CLAUDE.md "Carve-out for deterministic edge-case coverage"):
 *   (a) None. Postgres, Redis, argon2, the fresh-auth store, and all three
 *       routes run for real. The two token-bearing flows are set up by writing
 *       the row the mailed link would have produced — a `reset_token` on the
 *       account and a `pending_recovery` staging row — rather than by mocking
 *       the SMTP transporter to read the link back out, so no third-party
 *       surface is stubbed at all. The ORCID branch consumes a verification
 *       receipt seeded directly into the same store the OAuth callback writes.
 *   (b) No auth middleware is involved: all three routes are unauthenticated,
 *       because the recovery or reset factor IS the authentication.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import path from 'node:path';
import { occurrencesOf, sourcesUnder } from '../support/enclosing-symbol.js';

const { createApp } = await import('../../src/app.js');
const { getAppPool } = await import('../../src/app-db.js');
const { config } = await import('../../src/config.js');
const { getRedis, isRedisAvailable } = await import('../../src/redis.js');
const { orcidVerified } = await import('../../src/routes/orcid.js');
const { consumeSessionFreshAuthToken, issueSessionFreshAuthToken } = await import(
  '../../src/lib/fresh-auth.js'
);
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');

const app = createApp();

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

const RUN = Date.now();
const USER = `sesinval_${RUN}`;
const BYSTANDER = `sesinval_by_${RUN}`;
const EMAIL = `sesinval_${RUN}@example.com`;
const BYSTANDER_EMAIL = `sesinval_by_${RUN}@example.com`;
const PASSWORD = 'OriginalPass1';
const ORCID_ID = '0000-0002-4444-5555';

async function seedAccounts() {
  const pool = getAppPool()!;
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, custody, verify_token, orcid)
     VALUES ($1, $2, $3, 'light', NULL, $4)`,
    [EMAIL, USER, passwordHash, ORCID_ID],
  );
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, custody, verify_token)
     VALUES ($1, $2, $3, 'light', NULL)`,
    [BYSTANDER_EMAIL, BYSTANDER, passwordHash],
  );
}

async function cleanup() {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM pending_recovery WHERE username LIKE $1', ['sesinval_%']).catch(() => {});
  await pool.query('DELETE FROM custody_audit_log WHERE username LIKE $1', ['sesinval_%']).catch(() => {});
  await pool.query('DELETE FROM accounts WHERE username LIKE $1', ['sesinval_%']).catch(() => {});
}

/** Restore the seeded baseline so each test starts from the same account state
 *  regardless of which swap the previous one applied. */
async function resetAccountState() {
  const pool = getAppPool()!;
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await pool.query(
    `UPDATE accounts
     SET email = $1, password_hash = $2, orcid = $3,
         sessions_invalidated_at = NULL, upgraded_at = NULL,
         reset_token = NULL, reset_token_expires_at = NULL
     WHERE username = $4`,
    [EMAIL, passwordHash, ORCID_ID, USER],
  );
  await pool.query('DELETE FROM pending_recovery WHERE username = $1', [USER]).catch(() => {});
}

/** Write the ORCID verification receipt the OAuth callback would have left, so
 *  the recover route's ORCID branch can consume it without a live provider. */
async function seedOrcidReceipt(nonce: string): Promise<void> {
  const payload = { orcid_id: ORCID_ID, works_count: 5, name: 'Test' };
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(`${config.appTag}:orcid_verified:${nonce}`, JSON.stringify(payload), 'EX', 600);
  }
  orcidVerified.set(nonce, { ...payload, expires: Date.now() + 600_000 });
}

/** Assert a proof no longer consumes. Uses the same helper and the same store
 *  the broadcast route uses, so this is the property the route would observe. */
async function expectWindowClosed(token: string, username: string): Promise<void> {
  const result = await consumeSessionFreshAuthToken(token, username);
  expect(result.valid).toBe(false);
  if (!result.valid) {
    expect(result.reason).toBe('expired');
  }
}

beforeAll(async () => {
  await cleanup();
  if (!dbReachable) return;
  await seedAccounts();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await clearRateLimitKeys(['auth-reset', 'auth-recover', 'auth-login']);
  await resetAccountState();
});

describe('session invalidation closes outstanding session-proof windows', () => {
  it.skipIf(!dbReachable)('POST /api/auth/reset closes the window', async () => {
    const pool = getAppPool()!;
    const resetToken = crypto.randomBytes(24).toString('hex');
    await pool.query(
      `UPDATE accounts
       SET reset_token = $1, reset_token_expires_at = NOW() + INTERVAL '1 hour'
       WHERE username = $2`,
      [resetToken, USER],
    );

    const issued = await issueSessionFreshAuthToken(USER, 'password');
    expect((await consumeSessionFreshAuthToken(issued.token, USER)).valid).toBe(true);

    const res = await request(app)
      .post('/api/auth/reset')
      .send({ token: resetToken, password: 'BrandNewPass1' });
    expect(res.status).toBe(200);

    await expectWindowClosed(issued.token, USER);
  });

  it.skipIf(!dbReachable)('POST /api/auth/recover (ORCID branch) closes the window', async () => {
    const nonce = `sesinval-orcid-${Date.now()}`;
    await seedOrcidReceipt(nonce);

    const issued = await issueSessionFreshAuthToken(USER, 'orcid');
    expect((await consumeSessionFreshAuthToken(issued.token, USER)).valid).toBe(true);

    const res = await request(app)
      .post('/api/auth/recover')
      .send({
        username: USER,
        new_email: `sesinval_orcid_new_${Date.now()}@example.com`,
        new_password: 'RecoveredPass1',
        orcid_token: nonce,
      });
    expect(res.status).toBe(200);
    // The route reissues a JWT. The window must already be gone by the time the
    // caller holds that token, or the reissue hands back a session with a
    // pre-existing broadcast window still attached to it.
    expect(res.body.data.token).toBeDefined();

    await expectWindowClosed(issued.token, USER);
  });

  it.skipIf(!dbReachable)('POST /api/auth/recover/verify closes the window', async () => {
    const pool = getAppPool()!;
    const verifyToken = crypto.randomBytes(24).toString('hex');
    const verifyHash = crypto.createHash('sha256').update(verifyToken).digest();
    const disputeHash = crypto.createHash('sha256').update('unused-dispute-token').digest();
    const newPasswordHash = await argon2.hash('VerifiedPass1', { type: argon2.argon2id });
    await pool.query(
      `INSERT INTO pending_recovery
         (username, new_email, new_password_hash, verify_token_hash, verify_expires_at,
          dispute_token_hash, dispute_expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 hour', $5, NOW() + INTERVAL '48 hours')`,
      [USER, `sesinval_verify_new_${Date.now()}@example.com`, newPasswordHash, verifyHash, disputeHash],
    );

    const issued = await issueSessionFreshAuthToken(USER, 'password');
    expect((await consumeSessionFreshAuthToken(issued.token, USER)).valid).toBe(true);

    const res = await request(app)
      .post('/api/auth/recover/verify')
      .send({ token: verifyToken });
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeDefined();

    await expectWindowClosed(issued.token, USER);
  });

  it.skipIf(!dbReachable)('an unrelated account keeps its window', async () => {
    // Blast-radius pin. A sweep that cleared the whole store, or keyed on
    // anything other than the username, would log out every light account
    // whenever one of them reset a password.
    const pool = getAppPool()!;
    const resetToken = crypto.randomBytes(24).toString('hex');
    await pool.query(
      `UPDATE accounts
       SET reset_token = $1, reset_token_expires_at = NOW() + INTERVAL '1 hour'
       WHERE username = $2`,
      [resetToken, USER],
    );

    const bystanderProof = await issueSessionFreshAuthToken(BYSTANDER, 'password');
    const targetProof = await issueSessionFreshAuthToken(USER, 'password');

    const res = await request(app)
      .post('/api/auth/reset')
      .send({ token: resetToken, password: 'AnotherNewPass1' });
    expect(res.status).toBe(200);

    await expectWindowClosed(targetProof.token, USER);
    expect((await consumeSessionFreshAuthToken(bystanderProof.token, BYSTANDER)).valid).toBe(true);
  });
});

describe('every writer of the revocation column also closes session-proof windows', () => {
  // Standing wiring canary. The three routes above are today's writers; the
  // failure this guards against is a fourth one added later that stamps
  // `sessions_invalidated_at` and stops there, leaving a live broadcast window
  // attached to a session the operator believes they cut off. That omission is
  // invisible to every test in this file, because those tests name their routes.
  //
  // Two granularity properties this scan needs, both of which a
  // whole-file-tests-whole-file version silently lacked:
  //
  //   - It walks ALL of `src/` recursively, not a flat listing of `src/routes`.
  //     A writer added under `src/lib`, or in any subdirectory, was previously
  //     not scanned at all.
  //   - It pairs each WRITE with a sweep in the SAME enclosing symbol. Testing
  //     "this file contains a write" against "this file contains a sweep" means
  //     a second, unswept writer added to `recover.ts` — which already sweeps
  //     from two other handlers — passes untouched.

  /** A WRITE to the revocation column: the column name followed by `=`, which
   *  matches both the SQL `SET sessions_invalidated_at = NOW()` form and the
   *  parameterized `sessions_invalidated_at = $3` form. A SELECT of the column
   *  has no `=` after it and does not match. */
  const REVOCATION_WRITE_RE = /sessions_invalidated_at\s*=/;
  const SWEEP_CALL_RE = /invalidateSessionFreshAuthTokens\s*\(/;

  const sources = sourcesUnder(path.resolve(__dirname, '..', '..', 'src'));

  it('the scan reaches the whole source tree, not just the top of src/routes', () => {
    // Without this, a bad path or a non-recursive walk would make the assertion
    // below vacuously true for everything it failed to visit.
    expect(sources.length).toBeGreaterThan(20);
    const rels = sources.map((s) => s.rel);
    expect(rels).toContain('routes/auth.ts');
    expect(rels).toContain('routes/recover.ts');
    // A file in a subdirectory, proving the walk descends.
    expect(rels).toContain('lib/fresh-auth.ts');
  });

  it('no writer of the revocation column skips the proof sweep', () => {
    const writes = occurrencesOf(sources, REVOCATION_WRITE_RE);
    const sweeps = new Set(occurrencesOf(sources, SWEEP_CALL_RE).keys);
    // The middleware READS the column on every request; the pattern spares a
    // SELECT, so it is not expected to appear here at all.
    expect(writes.keys.length, `revocation-column writes:\n${writes.sites.join('\n')}`)
      .toBeGreaterThan(0);
    const offenders = writes.keys.filter((key) => !sweeps.has(key));
    expect(
      offenders,
      'these functions write sessions_invalidated_at but never call ' +
        'invalidateSessionFreshAuthTokens, so they revoke bearer tokens while ' +
        'leaving an open broadcast window attached to the session they claim to ' +
        `have cut off:\n${offenders.join('\n')}\n\nall writes:\n${writes.sites.join('\n')}`,
    ).toEqual([]);
  });

  it('the matchers fire on a write and spare a read', () => {
    // Planted positives and negatives, so a mangled pattern cannot leave the
    // scan silently matching nothing while the suite stays green.
    expect(REVOCATION_WRITE_RE.test('SET sessions_invalidated_at = NOW()')).toBe(true);
    expect(REVOCATION_WRITE_RE.test('             sessions_invalidated_at = $3')).toBe(true);
    expect(REVOCATION_WRITE_RE.test('SELECT sessions_invalidated_at FROM accounts')).toBe(false);
    expect(SWEEP_CALL_RE.test('await invalidateSessionFreshAuthTokens(account.username);')).toBe(true);
    expect(SWEEP_CALL_RE.test('  invalidateSessionFreshAuthTokens,')).toBe(false);
  });

  it('a write and a sweep in different functions of one file do not pair up', () => {
    // The granularity the assertion above rests on. Under the previous
    // whole-file form these two synthetic handlers passed, because the file
    // contained both a write and a sweep somewhere.
    const lines = [
      "router.post('/sweeps', async (req, res) => {",
      '  await pool.query(`UPDATE accounts SET sessions_invalidated_at = NOW()`);',
      '  await invalidateSessionFreshAuthTokens(username);',
      '});',
      '',
      "router.post('/forgets', async (req, res) => {",
      '  await pool.query(`UPDATE accounts SET sessions_invalidated_at = NOW()`);',
      '});',
    ];
    const file = [{ rel: 'routes/synthetic.ts', lines }];
    const writes = occurrencesOf(file, REVOCATION_WRITE_RE);
    const sweeps = new Set(occurrencesOf(file, SWEEP_CALL_RE).keys);
    expect(writes.keys).toEqual([
      'routes/synthetic.ts#POST /forgets',
      'routes/synthetic.ts#POST /sweeps',
    ]);
    expect(writes.keys.filter((k) => !sweeps.has(k))).toEqual([
      'routes/synthetic.ts#POST /forgets',
    ]);
  });
});

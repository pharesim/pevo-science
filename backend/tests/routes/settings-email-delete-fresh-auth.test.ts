/**
 * Pin the fresh-auth gate on DELETE /api/settings/email (account erasure).
 *
 * Threat the gate closes (per ARCHITECTURE.md § 6.5 invariant #1 + § 6.4):
 * DELETE /api/settings/email is the de-facto account-erasure / right-to-
 * erasure path — it runs `DELETE FROM accounts WHERE username = $1` plus
 * related deletes and anonymizes `custody_audit_log`. Mounted with
 * `verifyHiveSignature` only, a replayed Bearer JWT alone would erase the
 * account. The gate requires a fresh-auth body proof on the JWT path,
 * bound to a distinct `delete_account` action target so a proof minted for
 * another action (change-email / set-password) cannot be replayed here.
 *
 * Auth focus: this suite's focus IS authentication — it must distinguish a
 * replayable Bearer JWT from a fresh per-request Hive signature, and it
 * asserts that the delete-account proof's target binding is enforced. Per
 * the root CLAUDE.md test carve-out (clause b), auth-focused suites must
 * NOT mock `verifyHiveSignature`; the cryptographic verification runs real.
 *
 * What runs real vs. stubbed:
 *   - `verifyHiveSignature` runs REAL on both branches:
 *       * JWT path: a real JWT minted against `config.sessionSecret` and
 *         verified by the real `jsonwebtoken` library inside the middleware.
 *       * Keychain (signature) path: a real request-bound Hive signature
 *         produced by `signRequestBound` and verified via real cryptographic
 *         recovery + posting-key match inside the middleware.
 *   - `hiveClient.database.getAccounts` is stubbed (vi.mock('../../src/hive.js'))
 *     to publish a deterministic test posting key for the Keychain-path user.
 *     Running real getAccounts against the live chain per-test would couple
 *     the test to a real on-chain account's keys, unrelated to the gate
 *     predicate under test. The cryptographic recovery + timing-safe key
 *     match still run real; only the chain key-lookup is stubbed — the same
 *     approach as `tests/middleware/verifyHiveSignature-authmethod.test.ts`
 *     and `routes/auth.test.ts`.
 *   - DB (Postgres app pool) + Redis + the fresh-auth lib run real.
 *
 * Coverage shape:
 *   - JWT path, no proof → 401 FRESH_AUTH_REQUIRED + reason 'missing';
 *     account NOT erased.
 *   - JWT path, valid delete_account proof (state A: password) → 200;
 *     account erased AND the companion cascade is gone
 *     (notification_preferences + pending_recovery rows deleted,
 *     custody_audit_log anonymized so no row stays bound to the username).
 *   - JWT path, valid delete_account proof (state C: orcid) → 200; same
 *     account-erased + cascade assertions as state A.
 *   - JWT path, valid delete_account proof (state B: password AND orcid),
 *     password mechanism → 200; account erased. Pins the mechanismAccepted
 *     OR-branch (password leg) on a both-factors account.
 *   - JWT path, valid delete_account proof (state B), orcid mechanism → 200;
 *     account erased. Pins the mechanismAccepted OR-branch (orcid leg).
 *   - JWT path, change_email proof (cross-action) → 403 + reason
 *     'target_mismatch'; account NOT erased.
 *   - JWT path, set_password proof (cross-action) → 403 + reason
 *     'target_mismatch'; account NOT erased.
 *   - JWT path, wrong mechanism (state A + orcid proof) → 401 + reason
 *     'wrong_mechanism'; account NOT erased.
 *   - Keychain (real-signature) path, no body proof → 200; account erased
 *     (no regression for self-custody / state-D Keychain users).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { PrivateKey } from '@hiveio/dhive';

// Deterministic test keypair for the Keychain (real-signature) path. The
// stubbed getAccounts publishes TEST_PUBLIC_KEY as the posting key for the
// signature-path username so the middleware's recovery + key-match succeeds
// against a signature produced by TEST_PRIVATE_KEY.
const TEST_PRIVATE_KEY = PrivateKey.fromSeed('pevo-settings-delete-test-seed-deterministic');
const TEST_PUBLIC_KEY = TEST_PRIVATE_KEY.createPublic().toString();
const RUN_ID = Date.now();
const SIG_USER = `semdsig${(RUN_ID % 100000).toString(36)}`.slice(0, 16);

vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: {
      getAccounts: vi.fn().mockImplementation((names: string[]) => {
        if (names.includes(SIG_USER)) {
          return Promise.resolve([
            { name: SIG_USER, posting: { key_auths: [[TEST_PUBLIC_KEY, 1]] } },
          ]);
        }
        return Promise.resolve([]);
      }),
    },
  },
}));

const { createApp } = await import('../../src/app.js');
const { getAppPool } = await import('../../src/app-db.js');
const { config } = await import('../../src/config.js');
const {
  _resetFreshAuthMemStoreForTests,
  issueFreshAuthToken,
  deleteAccountFreshAuthTarget,
  changeEmailFreshAuthTarget,
  setPasswordFreshAuthTarget,
} = await import('../../src/lib/fresh-auth.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');
const { signRequestBound } = await import('../support/sign-request.js');

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

const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const STATE_A_USER = `semda${SUFFIX}usr`;
const STATE_B_USER = `semdb${SUFFIX}usr`;
const STATE_C_USER = `semdc${SUFFIX}usr`;
const STATE_A_EMAIL = `setting_delete_a_${RUN_ID}@example.com`;
const STATE_B_EMAIL = `setting_delete_b_${RUN_ID}@example.com`;
const STATE_C_EMAIL = `setting_delete_c_${RUN_ID}@example.com`;
const SIG_EMAIL = `setting_delete_sig_${RUN_ID}@example.com`;
const STATE_B_ORCID = `0000-0003-${(RUN_ID % 10000).toString().padStart(4, '0')}-0003`;
const STATE_C_ORCID = `0000-0003-${(RUN_ID % 10000).toString().padStart(4, '0')}-0002`;

const FAKE_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$placeholderplaceholder$placeholderplaceholderplaceholderplaceholder';

function bearerFor(username: string): string {
  return jwt.sign({ sub: username, custody: 'light' }, config.sessionSecret, { expiresIn: '5m' });
}

async function deleteUserRows(username: string) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [username]).catch(() => {});
  await pool.query('DELETE FROM pending_recovery WHERE username = $1', [username]).catch(() => {});
  await pool.query('DELETE FROM notification_preferences WHERE username = $1', [username]).catch(() => {});
  await pool.query('DELETE FROM accounts WHERE username = $1', [username]).catch(() => {});
}

async function cleanupAll() {
  for (const u of [STATE_A_USER, STATE_B_USER, STATE_C_USER, SIG_USER]) {
    await deleteUserRows(u);
  }
}

// Seed the three companion rows the DELETE handler cascades: a
// notification_preferences row, a two-phase pending_recovery staging row, and
// a prior custody_audit_log row. The happy-path tests assert these are erased
// (prefs + staging deleted, audit row anonymized so none stays bound to the
// username) — the mutation-kill for the handler's cascade deletes and the
// anonymize-on-delete UPDATE, which the JWT fresh-auth path is the only place
// that exercises them after the gate.
async function seedCompanionRows(username: string, email: string) {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query(
    `INSERT INTO notification_preferences (username, email) VALUES ($1, $2)`,
    [username, email],
  );
  // pending_recovery stores SHA-256 token digests (raw 32 bytes), not the
  // plaintext tokens; the exact digest values are irrelevant to the cascade
  // assertion, so random bytes suffice.
  const verifyTokenHash = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest();
  const disputeTokenHash = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest();
  await pool.query(
    `INSERT INTO pending_recovery
       (username, new_email, new_password_hash,
        verify_token_hash, verify_expires_at,
        dispute_token_hash, dispute_expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours', $5, NOW() + INTERVAL '48 hours')`,
    [username, `staged_${email}`, 'argon2-hash-placeholder', verifyTokenHash, disputeTokenHash],
  );
  await pool.query(
    `INSERT INTO custody_audit_log (username, operation_type, user_agent, session_id)
     VALUES ($1, 'login_failure', 'fake-ua-hash', 'fake-session-id')`,
    [username],
  );
}

// Assert the DELETE cascade fully erased the companion rows: the
// notification_preferences and pending_recovery rows are gone, and no
// custody_audit_log row stays bound to the username (the handler anonymizes
// them in-place by NULLing the username link rather than deleting, so the
// assertion is "no row still bound" rather than "no row at all").
async function expectCascadeErased(username: string) {
  const pool = getAppPool()!;
  const prefs = await pool.query(
    'SELECT username FROM notification_preferences WHERE username = $1',
    [username],
  );
  expect(prefs.rows.length).toBe(0);
  const staging = await pool.query(
    'SELECT id FROM pending_recovery WHERE username = $1',
    [username],
  );
  expect(staging.rows.length).toBe(0);
  const auditStillBound = await pool.query(
    'SELECT id FROM custody_audit_log WHERE username = $1',
    [username],
  );
  expect(auditStillBound.rows.length).toBe(0);
}

async function seedStateA() {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await deleteUserRows(STATE_A_USER);
  // State A: password registered, no ORCID.
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, orcid, custody, verify_token)
     VALUES ($1, $2, $3, NULL, 'light', NULL)`,
    [STATE_A_EMAIL, STATE_A_USER, FAKE_PASSWORD_HASH],
  );
}

async function seedStateB() {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await deleteUserRows(STATE_B_USER);
  // State B: BOTH password AND ORCID registered. Exercises the
  // mechanismAccepted OR branch — a delete_account proof is accepted via
  // either the password leg or the orcid leg.
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, orcid, custody, verify_token)
     VALUES ($1, $2, $3, $4, 'light', NULL)`,
    [STATE_B_EMAIL, STATE_B_USER, FAKE_PASSWORD_HASH, STATE_B_ORCID],
  );
}

async function seedStateC() {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await deleteUserRows(STATE_C_USER);
  // State C: ORCID only, no password.
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, orcid, custody, verify_token)
     VALUES ($1, $2, NULL, $3, 'light', NULL)`,
    [STATE_C_EMAIL, STATE_C_USER, STATE_C_ORCID],
  );
}

async function seedSigUser() {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await deleteUserRows(SIG_USER);
  // Self-custody Keychain user (state D shape: password + orcid preserved is
  // irrelevant on the signature path — no body proof is consumed).
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, orcid, custody, verify_token)
     VALUES ($1, $2, $3, NULL, 'self', NULL)`,
    [SIG_EMAIL, SIG_USER, FAKE_PASSWORD_HASH],
  );
}

async function rowExists(username: string): Promise<boolean> {
  const pool = getAppPool()!;
  const { rows } = await pool.query<{ id: number }>(
    'SELECT id FROM accounts WHERE username = $1',
    [username],
  );
  return rows.length > 0;
}

describe.skipIf(!dbReachable)('DELETE /api/settings/email — JWT-path fresh-auth gate', () => {
  beforeEach(async () => {
    _resetFreshAuthMemStoreForTests();
    await clearRateLimitKeys(['settings-write', 'settings-read']);
    await seedStateA();
    await seedStateB();
    await seedStateC();
  });

  afterAll(async () => {
    await cleanupAll();
  });

  it('JWT path, no proof → 401 FRESH_AUTH_REQUIRED (reason missing), account NOT erased', async () => {
    const res = await request(app)
      .delete('/api/settings/email')
      .set('Authorization', `Bearer ${bearerFor(STATE_A_USER)}`)
      .set('X-Hive-Username', STATE_A_USER)
      .send({ confirm: true });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
    expect(res.body.error.details?.reason).toBe('missing');

    expect(await rowExists(STATE_A_USER)).toBe(true);
  });

  it('JWT path, valid delete_account proof (state A, password) → 200, account + cascade erased', async () => {
    await seedCompanionRows(STATE_A_USER, STATE_A_EMAIL);
    const issued = await issueFreshAuthToken(
      STATE_A_USER,
      'password',
      deleteAccountFreshAuthTarget(STATE_A_USER),
    );
    const res = await request(app)
      .delete('/api/settings/email')
      .set('Authorization', `Bearer ${bearerFor(STATE_A_USER)}`)
      .set('X-Hive-Username', STATE_A_USER)
      .send({ confirm: true, fresh_auth_proof: issued.token });
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);

    expect(await rowExists(STATE_A_USER)).toBe(false);
    await expectCascadeErased(STATE_A_USER);
  });

  it('JWT path, valid delete_account proof (state C, orcid) → 200, account + cascade erased', async () => {
    await seedCompanionRows(STATE_C_USER, STATE_C_EMAIL);
    const issued = await issueFreshAuthToken(
      STATE_C_USER,
      'orcid',
      deleteAccountFreshAuthTarget(STATE_C_USER),
    );
    const res = await request(app)
      .delete('/api/settings/email')
      .set('Authorization', `Bearer ${bearerFor(STATE_C_USER)}`)
      .set('X-Hive-Username', STATE_C_USER)
      .send({ confirm: true, fresh_auth_proof: issued.token });
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);

    expect(await rowExists(STATE_C_USER)).toBe(false);
    await expectCascadeErased(STATE_C_USER);
  });

  it('JWT path, valid delete_account proof (state B, password mechanism) → 200, account erased', async () => {
    // State B has BOTH password and orcid registered. A password-mechanism
    // proof is accepted via the password leg of the mechanismAccepted OR.
    const issued = await issueFreshAuthToken(
      STATE_B_USER,
      'password',
      deleteAccountFreshAuthTarget(STATE_B_USER),
    );
    const res = await request(app)
      .delete('/api/settings/email')
      .set('Authorization', `Bearer ${bearerFor(STATE_B_USER)}`)
      .set('X-Hive-Username', STATE_B_USER)
      .send({ confirm: true, fresh_auth_proof: issued.token });
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);

    expect(await rowExists(STATE_B_USER)).toBe(false);
  });

  it('JWT path, valid delete_account proof (state B, orcid mechanism) → 200, account erased', async () => {
    // Same state-B account, the orcid leg of the mechanismAccepted OR. Pins
    // that either registered factor authorizes erasure on a both-factors
    // account (the password leg above and this orcid leg are the two arms of
    // the OR branch that is otherwise exercised only transitively).
    const issued = await issueFreshAuthToken(
      STATE_B_USER,
      'orcid',
      deleteAccountFreshAuthTarget(STATE_B_USER),
    );
    const res = await request(app)
      .delete('/api/settings/email')
      .set('Authorization', `Bearer ${bearerFor(STATE_B_USER)}`)
      .set('X-Hive-Username', STATE_B_USER)
      .send({ confirm: true, fresh_auth_proof: issued.token });
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);

    expect(await rowExists(STATE_B_USER)).toBe(false);
  });

  it('JWT path, change_email proof (cross-action) → 403 target_mismatch, account NOT erased', async () => {
    // A proof minted for the change-email action has a different target hash
    // than the delete-account proof (the `action` field is length-prefixed
    // into the hash). The bind rejects the cross-action replay so a proof
    // the user obtained to change their email cannot erase their account.
    const issued = await issueFreshAuthToken(
      STATE_A_USER,
      'password',
      changeEmailFreshAuthTarget(STATE_A_USER),
    );
    const res = await request(app)
      .delete('/api/settings/email')
      .set('Authorization', `Bearer ${bearerFor(STATE_A_USER)}`)
      .set('X-Hive-Username', STATE_A_USER)
      .send({ confirm: true, fresh_auth_proof: issued.token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
    expect(res.body.error.details?.reason).toBe('target_mismatch');

    expect(await rowExists(STATE_A_USER)).toBe(true);
  });

  it('JWT path, set_password proof (cross-action) → 403 target_mismatch, account NOT erased', async () => {
    // set_password and delete_account both bind to (action, username, '');
    // collision-freedom hinges entirely on the `action` discriminator. This
    // pins that a set-password proof cannot authorize an erasure.
    const issued = await issueFreshAuthToken(
      STATE_A_USER,
      'password',
      setPasswordFreshAuthTarget(STATE_A_USER),
    );
    const res = await request(app)
      .delete('/api/settings/email')
      .set('Authorization', `Bearer ${bearerFor(STATE_A_USER)}`)
      .set('X-Hive-Username', STATE_A_USER)
      .send({ confirm: true, fresh_auth_proof: issued.token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
    expect(res.body.error.details?.reason).toBe('target_mismatch');

    expect(await rowExists(STATE_A_USER)).toBe(true);
  });

  it('JWT path, wrong mechanism (state A + orcid proof) → 401 wrong_mechanism, account NOT erased', async () => {
    // State A has no ORCID registered. An ORCID-mechanism proof is
    // structurally invalid even if it verifies cryptographically and binds
    // to the right target — the account has no ORCID factor to base it on.
    const issued = await issueFreshAuthToken(
      STATE_A_USER,
      'orcid',
      deleteAccountFreshAuthTarget(STATE_A_USER),
    );
    const res = await request(app)
      .delete('/api/settings/email')
      .set('Authorization', `Bearer ${bearerFor(STATE_A_USER)}`)
      .set('X-Hive-Username', STATE_A_USER)
      .send({ confirm: true, fresh_auth_proof: issued.token });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
    expect(res.body.error.details?.reason).toBe('wrong_mechanism');

    expect(await rowExists(STATE_A_USER)).toBe(true);
  });
});

describe.skipIf(!dbReachable)('DELETE /api/settings/email — Keychain (real-signature) path skips body-proof', () => {
  beforeEach(async () => {
    _resetFreshAuthMemStoreForTests();
    await clearRateLimitKeys(['settings-write', 'settings-read']);
    await seedSigUser();
  });

  afterAll(async () => {
    await cleanupAll();
  });

  it('real Hive signature, no body proof → 200, account erased', async () => {
    // The middleware runs real cryptographic recovery + posting-key match
    // against the stubbed getAccounts key for SIG_USER. With no Bearer
    // header, req.hiveAuthMethod is 'signature' and the route's isJwtPath is
    // false, so the body-proof gate is skipped: a fresh signed request is
    // itself the proof. This is the no-regression guard for self-custody /
    // state-D Keychain users.
    const timestamp = new Date().toISOString();
    const body = { confirm: true };
    const signature = signRequestBound(
      TEST_PRIVATE_KEY,
      'DELETE',
      '/api/settings/email',
      body,
      timestamp,
    );

    const res = await request(app)
      .delete('/api/settings/email')
      .set('X-Hive-Username', SIG_USER)
      .set('X-Hive-Signature', signature)
      .set('X-Hive-Timestamp', timestamp)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);

    expect(await rowExists(SIG_USER)).toBe(false);
  });
});

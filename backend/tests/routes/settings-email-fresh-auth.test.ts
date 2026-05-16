/**
 * BACKEND-SETTINGS-EMAIL-REAUTH-FRESH-AUTH — pin the JWT-path fresh-auth gate
 * on POST /api/settings/email (change-email branch).
 *
 * Threat the gate closes (per ARCHITECTURE.md § 6.5 invariant #1): a stolen
 * JWT must not be a one-step takeover. Without the gate, an attacker swaps
 * the registered email, walks `/auth/reset-request` + `/auth/reset` to
 * choose a password, then uses `/custody/fresh-auth` + `/custody/broadcast`
 * to broadcast as the victim.
 *
 * Coverage shape:
 *  - Happy path A (password registered, no ORCID) with `password`-mechanism proof.
 *  - Happy path B (password + ORCID) with `password` proof and with `orcid`
 *    proof (both factors accepted).
 *  - Happy path C (ORCID only) with `orcid` proof.
 *  - Missing proof on JWT path → 401 FRESH_AUTH_REQUIRED + reason 'missing'.
 *  - Cross-user proof → 403 + reason 'username_mismatch'.
 *  - Cross-target proof (consent-op proof masqueraded as change-email) →
 *    403 + reason 'target_mismatch'.
 *  - State A + 'orcid'-mechanism proof → 401 + reason 'wrong_mechanism'.
 *  - State C + 'password'-mechanism proof → 401 + reason 'wrong_mechanism'.
 *  - Expired / unknown proof → 401 + reason 'expired'.
 *  - Single-use: second use of same proof → 401 + reason 'expired'.
 *  - Keychain path (no Authorization header) → no body proof required,
 *    change-email succeeds.
 *  - Add-flow no-row branch via Keychain path → INSERT new row, no proof
 *    required (regression guard for acceptance criterion #6).
 *
 * Mocks (per root CLAUDE.md "Carve-out for deterministic edge-case coverage"):
 *
 *   (a) Justification: this suite's focus is the change-email fresh-auth
 *   gate's authorization shape — proof present? bound to right user?
 *   target hash matches? mechanism matches registered factors? It is NOT
 *   focused on cryptographic signature verification, which is covered by
 *   real-signed-request tests in `auth.test.ts` and sibling auth-focused
 *   suites. The MOCK_VERIFY_SIGNATURE fixture preserves the
 *   401-on-missing-header gate and the username-extraction behavior; only
 *   the cryptographic signature check is bypassed. The route's JWT-vs-
 *   Keychain discriminator reads `req.headers['authorization']` directly,
 *   so Bearer presence/absence drives the gate behavior under test
 *   independent of whether the JWT cryptographically verifies. nodemailer
 *   is also mocked so the route's sendVerificationEmail() resolves without
 *   live SMTP — SMTP shape is covered by `lib/smtp.test.ts`.
 *
 *   (b) verifyHiveSignature is mocked via MOCK_VERIFY_SIGNATURE; this is a
 *   non-auth-focused suite (the fresh-auth body-proof gate is the
 *   in-scope security predicate, not the upstream signature/JWT
 *   verification). Per the clause-b refinement, this is permitted because
 *   the suite's focus is downstream behavior (the route's discrimination
 *   and consume-side checks), not cryptographic verification.
 *
 *   (c) Risk-class real-path companion: the cryptographic signature path
 *   of the same route is exercised in `auth.test.ts` and the
 *   register/login flows that sign real canonical messages; the JWT-
 *   verify path is exercised against real `jsonwebtoken` verification in
 *   `settings-set-password.test.ts` (which mints real JWTs against
 *   config.sessionSecret and uses the real verifyHiveSignature middleware).
 *   The follow-up task `backend-verifyhive-authmethod-discriminator.md`
 *   carries the additional real-path-companion coverage for the explicit
 *   discriminator field once introduced.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

vi.mock('../../src/lib/smtp.js', () => ({
  createSmtpTransporter: () => ({
    sendMail: vi.fn().mockResolvedValue({ messageId: 'mock-message' }),
  }),
}));

// Override the `config.smtpHost` falsy-short-circuit inside the route's
// `sendVerificationEmail`. The route checks `if (!config.smtpHost) throw`
// before calling the (mocked) transporter; without this stub the happy
// paths land a 500 when the project's `.env` ships SMTP_HOST empty. We
// mock the config module's exported `config` object's `smtpHost` field
// only — every other field passes through to the real config.
vi.mock('../../src/config.js', async () => {
  const real = await vi.importActual<typeof import('../../src/config.js')>(
    '../../src/config.js',
  );
  return {
    ...real,
    config: { ...real.config, smtpHost: real.config.smtpHost || 'localhost' },
  };
});

const { createApp } = await import('../../src/app.js');
const { getAppPool } = await import('../../src/app-db.js');
const { config } = await import('../../src/config.js');
const {
  _resetFreshAuthMemStoreForTests,
  issueFreshAuthToken,
  changeEmailFreshAuthTarget,
} = await import('../../src/lib/fresh-auth.js');
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

const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const STATE_A_USER = `sema${SUFFIX}usr`;
const STATE_B_USER = `semb${SUFFIX}usr`;
const STATE_C_USER = `semc${SUFFIX}usr`;
const OTHER_USER = `semo${SUFFIX}usr`;
const NO_ROW_USER = `semn${SUFFIX}usr`;
const STATE_A_EMAIL = `setting_email_a_${RUN_ID}@example.com`;
const STATE_B_EMAIL = `setting_email_b_${RUN_ID}@example.com`;
const STATE_C_EMAIL = `setting_email_c_${RUN_ID}@example.com`;
const OTHER_EMAIL = `setting_email_o_${RUN_ID}@example.com`;
const NEW_EMAIL_A = `setting_email_a_new_${RUN_ID}@example.com`;
const NEW_EMAIL_B = `setting_email_b_new_${RUN_ID}@example.com`;
const NEW_EMAIL_C = `setting_email_c_new_${RUN_ID}@example.com`;
const NEW_EMAIL_NOROW = `setting_email_norow_${RUN_ID}@example.com`;

const STATE_B_ORCID = `0000-0003-${(RUN_ID % 10000).toString().padStart(4, '0')}-0001`;
const STATE_C_ORCID = `0000-0003-${(RUN_ID % 10000).toString().padStart(4, '0')}-0002`;

const FAKE_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$placeholderplaceholder$placeholderplaceholderplaceholderplaceholder';

function bearerFor(username: string, custody: 'light' | 'self' = 'light'): string {
  const token = jwt.sign({ sub: username, custody }, config.sessionSecret, { expiresIn: '5m' });
  return `Bearer ${token}`;
}

async function cleanupAll() {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  const usernames = [STATE_A_USER, STATE_B_USER, STATE_C_USER, OTHER_USER, NO_ROW_USER];
  for (const u of usernames) {
    await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [u]).catch(() => {});
    await pool.query('DELETE FROM notification_preferences WHERE username = $1', [u]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username = $1', [u]).catch(() => {});
  }
}

async function seedStates() {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  // State A: password registered, no ORCID.
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, orcid, custody, verify_token)
     VALUES ($1, $2, $3, NULL, 'light', NULL)`,
    [STATE_A_EMAIL, STATE_A_USER, FAKE_PASSWORD_HASH],
  );
  // State B: password + ORCID.
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, orcid, custody, verify_token)
     VALUES ($1, $2, $3, $4, 'light', NULL)`,
    [STATE_B_EMAIL, STATE_B_USER, FAKE_PASSWORD_HASH, STATE_B_ORCID],
  );
  // State C: ORCID only, no password.
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, orcid, custody, verify_token)
     VALUES ($1, $2, NULL, $3, 'light', NULL)`,
    [STATE_C_EMAIL, STATE_C_USER, STATE_C_ORCID],
  );
  // Other user for cross-user proof tests (state A shape).
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, orcid, custody, verify_token)
     VALUES ($1, $2, $3, NULL, 'light', NULL)`,
    [OTHER_EMAIL, OTHER_USER, FAKE_PASSWORD_HASH],
  );
}

describe.skipIf(!dbReachable)('POST /api/settings/email — JWT-path fresh-auth gate', () => {
  beforeAll(async () => {
    await cleanupAll();
    await seedStates();
    await clearRateLimitKeys(['settings-write', 'settings-read']);
  });

  beforeEach(async () => {
    _resetFreshAuthMemStoreForTests();
    await clearRateLimitKeys(['settings-write', 'settings-read']);
    if (!dbReachable) return;
    const pool = getAppPool()!;
    // Reset pending_email between tests so each assertion starts clean.
    await pool.query(
      `UPDATE accounts SET pending_email = NULL, pending_email_token = NULL, pending_email_expires_at = NULL
       WHERE username IN ($1, $2, $3, $4)`,
      [STATE_A_USER, STATE_B_USER, STATE_C_USER, OTHER_USER],
    ).catch(() => {});
  });

  afterAll(async () => {
    await cleanupAll();
  });

  // ─── Happy paths ──────────────────────────────────────────────────────

  it('state A: password-mechanism proof → 200 + pending_email written', async () => {
    const issued = await issueFreshAuthToken(
      STATE_A_USER,
      'password',
      changeEmailFreshAuthTarget(STATE_A_USER),
    );
    const res = await request(app)
      .post('/api/settings/email')
      .set('Authorization', bearerFor(STATE_A_USER))
      .set('X-Hive-Username', STATE_A_USER)
      .send({ email: NEW_EMAIL_A, fresh_auth_proof: issued.token });
    expect(res.status).toBe(200);

    const pool = getAppPool()!;
    const { rows } = await pool.query<{ pending_email: string | null }>(
      'SELECT pending_email FROM accounts WHERE username = $1',
      [STATE_A_USER],
    );
    expect(rows[0].pending_email).toBe(NEW_EMAIL_A);
  });

  it('state B: password-mechanism proof → 200', async () => {
    const issued = await issueFreshAuthToken(
      STATE_B_USER,
      'password',
      changeEmailFreshAuthTarget(STATE_B_USER),
    );
    const res = await request(app)
      .post('/api/settings/email')
      .set('Authorization', bearerFor(STATE_B_USER))
      .set('X-Hive-Username', STATE_B_USER)
      .send({ email: NEW_EMAIL_B, fresh_auth_proof: issued.token });
    expect(res.status).toBe(200);

    const pool = getAppPool()!;
    const { rows } = await pool.query<{ pending_email: string | null }>(
      'SELECT pending_email FROM accounts WHERE username = $1',
      [STATE_B_USER],
    );
    expect(rows[0].pending_email).toBe(NEW_EMAIL_B);
  });

  it('state B: orcid-mechanism proof → 200 (both factors accepted)', async () => {
    const issued = await issueFreshAuthToken(
      STATE_B_USER,
      'orcid',
      changeEmailFreshAuthTarget(STATE_B_USER),
    );
    const res = await request(app)
      .post('/api/settings/email')
      .set('Authorization', bearerFor(STATE_B_USER))
      .set('X-Hive-Username', STATE_B_USER)
      .send({ email: NEW_EMAIL_B, fresh_auth_proof: issued.token });
    expect(res.status).toBe(200);
  });

  it('state C: orcid-mechanism proof → 200', async () => {
    const issued = await issueFreshAuthToken(
      STATE_C_USER,
      'orcid',
      changeEmailFreshAuthTarget(STATE_C_USER),
    );
    const res = await request(app)
      .post('/api/settings/email')
      .set('Authorization', bearerFor(STATE_C_USER))
      .set('X-Hive-Username', STATE_C_USER)
      .send({ email: NEW_EMAIL_C, fresh_auth_proof: issued.token });
    expect(res.status).toBe(200);

    const pool = getAppPool()!;
    const { rows } = await pool.query<{ pending_email: string | null }>(
      'SELECT pending_email FROM accounts WHERE username = $1',
      [STATE_C_USER],
    );
    expect(rows[0].pending_email).toBe(NEW_EMAIL_C);
  });

  // ─── Negative paths ───────────────────────────────────────────────────

  it('missing proof on JWT path → 401 FRESH_AUTH_REQUIRED + reason missing', async () => {
    const res = await request(app)
      .post('/api/settings/email')
      .set('Authorization', bearerFor(STATE_A_USER))
      .set('X-Hive-Username', STATE_A_USER)
      .send({ email: NEW_EMAIL_A });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
    expect(res.body.error.details?.reason).toBe('missing');

    const pool = getAppPool()!;
    const { rows } = await pool.query<{ pending_email: string | null }>(
      'SELECT pending_email FROM accounts WHERE username = $1',
      [STATE_A_USER],
    );
    expect(rows[0].pending_email).toBeNull();
  });

  it('cross-user proof (minted for OTHER, replayed against STATE_A) → 403 username_mismatch', async () => {
    // Attacker mints a proof for their own account and tries to use it
    // against a different victim's JWT. The proof's stored username must
    // equal the JWT subject; this asserts the bind.
    const issued = await issueFreshAuthToken(
      OTHER_USER,
      'password',
      changeEmailFreshAuthTarget(OTHER_USER),
    );
    const res = await request(app)
      .post('/api/settings/email')
      .set('Authorization', bearerFor(STATE_A_USER))
      .set('X-Hive-Username', STATE_A_USER)
      .send({ email: NEW_EMAIL_A, fresh_auth_proof: issued.token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
    expect(res.body.error.details?.reason).toBe('username_mismatch');
  });

  it('cross-target proof (consent-op author_accept masqueraded as change-email) → 403 target_mismatch', async () => {
    // Even when the proof was minted for the same username, a proof bound
    // to a consent-op target (author_accept on some paper) has a different
    // target hash than the change-email proof. The bind catches this.
    const issued = await issueFreshAuthToken(
      STATE_A_USER,
      'password',
      { action: 'author_accept', root_author: 'someroot', root_permlink: 'paper-v1' },
    );
    const res = await request(app)
      .post('/api/settings/email')
      .set('Authorization', bearerFor(STATE_A_USER))
      .set('X-Hive-Username', STATE_A_USER)
      .send({ email: NEW_EMAIL_A, fresh_auth_proof: issued.token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
    expect(res.body.error.details?.reason).toBe('target_mismatch');
  });

  it('state A: orcid-mechanism proof → 401 wrong_mechanism', async () => {
    // State A has no ORCID registered. An ORCID-mechanism proof is
    // structurally invalid even if it verifies cryptographically — the
    // account has no ORCID factor to base it on.
    const issued = await issueFreshAuthToken(
      STATE_A_USER,
      'orcid',
      changeEmailFreshAuthTarget(STATE_A_USER),
    );
    const res = await request(app)
      .post('/api/settings/email')
      .set('Authorization', bearerFor(STATE_A_USER))
      .set('X-Hive-Username', STATE_A_USER)
      .send({ email: NEW_EMAIL_A, fresh_auth_proof: issued.token });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
    expect(res.body.error.details?.reason).toBe('wrong_mechanism');
  });

  it('state C: password-mechanism proof → 401 wrong_mechanism', async () => {
    // State C has no password_hash registered. A password-mechanism proof
    // is structurally invalid — state C has no password to base a fresh-
    // auth-via-password proof on.
    const issued = await issueFreshAuthToken(
      STATE_C_USER,
      'password',
      changeEmailFreshAuthTarget(STATE_C_USER),
    );
    const res = await request(app)
      .post('/api/settings/email')
      .set('Authorization', bearerFor(STATE_C_USER))
      .set('X-Hive-Username', STATE_C_USER)
      .send({ email: NEW_EMAIL_C, fresh_auth_proof: issued.token });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
    expect(res.body.error.details?.reason).toBe('wrong_mechanism');
  });

  it('expired / unknown proof → 401 expired', async () => {
    // A token that was never issued has the same wire shape as one whose
    // TTL elapsed — consume returns 'expired' for both. The route maps
    // both to 401 (per the consume contract).
    const fakeProof = Array.from({ length: 64 })
      .map(() => Math.floor(Math.random() * 16).toString(16))
      .join('');
    const res = await request(app)
      .post('/api/settings/email')
      .set('Authorization', bearerFor(STATE_A_USER))
      .set('X-Hive-Username', STATE_A_USER)
      .send({ email: NEW_EMAIL_A, fresh_auth_proof: fakeProof });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
    expect(res.body.error.details?.reason).toBe('expired');
  });

  it('proof is single-use: second use of same token → 401 expired', async () => {
    const issued = await issueFreshAuthToken(
      STATE_A_USER,
      'password',
      changeEmailFreshAuthTarget(STATE_A_USER),
    );
    const first = await request(app)
      .post('/api/settings/email')
      .set('Authorization', bearerFor(STATE_A_USER))
      .set('X-Hive-Username', STATE_A_USER)
      .send({ email: NEW_EMAIL_A, fresh_auth_proof: issued.token });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/settings/email')
      .set('Authorization', bearerFor(STATE_A_USER))
      .set('X-Hive-Username', STATE_A_USER)
      .send({ email: NEW_EMAIL_A, fresh_auth_proof: issued.token });
    expect(second.status).toBe(401);
    expect(second.body.error.details?.reason).toBe('expired');
  });
});

describe.skipIf(!dbReachable)('POST /api/settings/email — Keychain path skips body-proof', () => {
  beforeAll(async () => {
    await cleanupAll();
    await seedStates();
    await clearRateLimitKeys(['settings-write', 'settings-read']);
  });

  beforeEach(async () => {
    _resetFreshAuthMemStoreForTests();
    await clearRateLimitKeys(['settings-write', 'settings-read']);
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query(
      `UPDATE accounts SET pending_email = NULL, pending_email_token = NULL, pending_email_expires_at = NULL
       WHERE username IN ($1, $2, $3, $4)`,
      [STATE_A_USER, STATE_B_USER, STATE_C_USER, OTHER_USER],
    ).catch(() => {});
    // Ensure no-row user has no row.
    await pool.query('DELETE FROM accounts WHERE username = $1', [NO_ROW_USER]).catch(() => {});
  });

  afterAll(async () => {
    await cleanupAll();
  });

  it('Keychain path (no Authorization header) change-email → 200 without body proof', async () => {
    // MOCK_VERIFY_SIGNATURE extracts username from X-Hive-Username and
    // proceeds. The route's isJwtPath discriminator sees no Bearer token,
    // so the body-proof gate is skipped. Acceptance criterion #5: Keychain-
    // signature-authenticated requests do NOT require a body proof.
    const res = await request(app)
      .post('/api/settings/email')
      .set('X-Hive-Username', STATE_A_USER)
      .send({ email: NEW_EMAIL_A });
    expect(res.status).toBe(200);

    const pool = getAppPool()!;
    const { rows } = await pool.query<{ pending_email: string | null }>(
      'SELECT pending_email FROM accounts WHERE username = $1',
      [STATE_A_USER],
    );
    expect(rows[0].pending_email).toBe(NEW_EMAIL_A);
  });

  it('Keychain path: Add-flow no-row branch → INSERT new row, no proof required', async () => {
    // Acceptance criterion #6: the Add-flow no-row branch (INSERT new row
    // for a Keychain user with no accounts row yet) is unchanged
    // behaviorally. No Bearer + no row → INSERT path, no body proof.
    const res = await request(app)
      .post('/api/settings/email')
      .set('X-Hive-Username', NO_ROW_USER)
      .send({ email: NEW_EMAIL_NOROW });
    expect(res.status).toBe(200);

    const pool = getAppPool()!;
    const { rows } = await pool.query<{ verify_token: string | null }>(
      'SELECT verify_token FROM accounts WHERE username = $1',
      [NO_ROW_USER],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].verify_token).not.toBeNull();
  });
});

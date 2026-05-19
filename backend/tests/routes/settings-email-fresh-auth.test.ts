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
import argon2 from 'argon2';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

// Shared sendMail spy so individual tests can queue a one-shot rejection via
// `smtpMock.sendMail.mockRejectedValueOnce(...)`. Default behavior is success.
// vi.hoisted is required because vi.mock factories cannot capture outer
// references; the hoisted block runs before the vi.mock factory.
const smtpMock = vi.hoisted(() => ({
  sendMail: vi.fn().mockResolvedValue({ messageId: 'mock-message' }),
}));

vi.mock('../../src/lib/smtp.js', () => ({
  createSmtpTransporter: () => ({
    sendMail: smtpMock.sendMail,
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
  setPasswordFreshAuthTarget,
} = await import('../../src/lib/fresh-auth.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');
const { logger } = await import('../../src/logger.js');

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

    const pool = getAppPool()!;
    const { rows } = await pool.query<{ pending_email: string | null }>(
      'SELECT pending_email FROM accounts WHERE username = $1',
      [STATE_B_USER],
    );
    expect(rows[0].pending_email).toBe(NEW_EMAIL_B);
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

  it('cross-target proof (set_password masqueraded as change-email) → 403 target_mismatch', async () => {
    // Defense-in-depth pin against a future refactor that consolidates
    // both `set_password` and `change_email` (both bind to (action,
    // username, '')) into a single `nonBroadcastFreshAuthTarget(username)`
    // helper. Collision-freedom hinges entirely on the `action` field in
    // `computeFreshAuthTargetHash`; a refactor that drops the
    // discriminator would silently authorize set-password proofs at the
    // /email surface. This test catches the regression at the route
    // boundary.
    const issued = await issueFreshAuthToken(
      STATE_A_USER,
      'password',
      setPasswordFreshAuthTarget(STATE_A_USER),
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
    // proceeds. With no Bearer header it sets req.hiveAuthMethod = 'signature'
    // (mirroring the real middleware), and the route's isJwtPath discriminator
    // sees 'signature', so the body-proof gate is skipped. Acceptance
    // criterion #5: Keychain-signature-authenticated requests do NOT require
    // a body proof.
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

// ────────────────────────────────────────────────────────────────────
// BACKEND-VERIFYHIVE-AUTHMETHOD-DISCRIMINATOR — downstream-consumption pin
//
// Acceptance criterion #6 (second half): assert the route consumes
// req.hiveAuthMethod (set by the middleware) rather than re-parsing the
// Authorization header. The discriminator's wire behavior is already
// asserted by the JWT-path / Keychain-path describes above; this block
// pins that the field-driven discrimination matches the header-presence
// gate that drives MOCK_VERIFY_SIGNATURE's hiveAuthMethod assignment, so
// a future drift where the route reverts to header re-parsing while the
// middleware stops setting the field would surface as a test failure.
//
// (The real-path companion lives in
// `backend/tests/middleware/verifyHiveSignature-authmethod.test.ts`,
// which runs the production verifyHiveSignature and pins both branches.)
// ────────────────────────────────────────────────────────────────────

describe.skipIf(!dbReachable)(
  'POST /api/settings/email — req.hiveAuthMethod drives discrimination (not header re-parse)',
  () => {
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
    });

    afterAll(async () => {
      await cleanupAll();
    });

    it('Bearer present → hiveAuthMethod = "jwt" → fresh-auth gate fires (missing proof = 401)', async () => {
      // The mock fixture sets req.hiveAuthMethod = 'jwt' when an
      // Authorization: Bearer header is present. The route reads this
      // field as isJwtPath and engages the body-proof gate.
      const res = await request(app)
        .post('/api/settings/email')
        .set('Authorization', bearerFor(STATE_A_USER))
        .set('X-Hive-Username', STATE_A_USER)
        .send({ email: NEW_EMAIL_A });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(res.body.error.details?.reason).toBe('missing');
    });

    it('Bearer absent → hiveAuthMethod = "signature" → gate skipped (200 without proof)', async () => {
      // Same mock fixture: with no Bearer header, req.hiveAuthMethod is
      // 'signature' and isJwtPath is false. The body-proof gate is
      // skipped and the change-email succeeds.
      const res = await request(app)
        .post('/api/settings/email')
        .set('X-Hive-Username', STATE_A_USER)
        .send({ email: NEW_EMAIL_A });
      expect(res.status).toBe(200);
    });
  },
);

// ────────────────────────────────────────────────────────────────────
// BACKEND-CHANGE-EMAIL-MINT-PATH-AND-FOLLOWUPS — end-to-end mint→consume
// round-trips through both newly-widened mint surfaces.
//
// The other describes in this file mint proofs by calling
// `issueFreshAuthToken` directly (bypassing the route's auth + validation)
// to focus on the consume-side gate at /api/settings/email. These tests
// exercise the full path: the request body reaches POST /api/orcid/start
// (or POST /api/custody/fresh-auth) with `action: 'change_email'`, the
// validation widening accepts it, the proof is minted bound to
// `changeEmailFreshAuthTarget(username)`, and the SPA submits it to
// /api/settings/email which completes the change.
//
// The orcid round-trip stubs the OAuth token-exchange + pub.orcid.org
// fetches (mirroring the pattern in orcid.test.ts), but every other
// dependency (DB, Redis, fresh-auth lib) runs real. The custody
// round-trip re-seeds the state-A user's password_hash with a real
// argon2 hash so the route's argon2.verify runs against a known plaintext.
// ────────────────────────────────────────────────────────────────────

describe.skipIf(!dbReachable)(
  'POST /api/settings/email — round-trip through new change_email mint surfaces',
  () => {
    const RT_PASSWORD = 'StateA-roundtrip-pwd-1';
    let rtPasswordHash: string;

    beforeAll(async () => {
      await cleanupAll();
      await seedStates();
      // Real argon2 hash for STATE_A_USER so /api/custody/fresh-auth's
      // argon2.verify path runs end-to-end. Hashed once per describe block;
      // re-seeded into the row in beforeEach so other tests' FAKE hash
      // never bleeds into this round-trip.
      rtPasswordHash = await argon2.hash(RT_PASSWORD, { type: argon2.argon2id });
      // Patch ORCID credentials — the dev .env leaves these empty and the
      // /api/orcid/start handler short-circuits with 500 if either is
      // missing. Mirrors the pattern at orcid.test.ts:207-209.
      config.orcidClientId = 'test-orcid-client-id';
      config.orcidClientSecret = 'test-orcid-client-secret';
      await clearRateLimitKeys([
        'settings-write',
        'settings-read',
        'custody-fresh-auth',
        'orcid-start',
        'orcid-callback',
      ]);
    });

    beforeEach(async () => {
      _resetFreshAuthMemStoreForTests();
      await clearRateLimitKeys([
        'settings-write',
        'settings-read',
        'custody-fresh-auth',
        'orcid-start',
        'orcid-callback',
      ]);
      if (!dbReachable) return;
      const pool = getAppPool()!;
      // Re-seed STATE_A's password_hash with the real argon2 hash so
      // /api/custody/fresh-auth's argon2.verify succeeds against RT_PASSWORD.
      await pool.query(
        'UPDATE accounts SET password_hash = $1 WHERE username = $2',
        [rtPasswordHash, STATE_A_USER],
      );
      // Reset pending_email between tests so each assertion starts clean.
      await pool.query(
        `UPDATE accounts SET pending_email = NULL, pending_email_token = NULL, pending_email_expires_at = NULL
         WHERE username IN ($1, $2, $3, $4)`,
        [STATE_A_USER, STATE_B_USER, STATE_C_USER, OTHER_USER],
      ).catch(() => {});
    });

    afterAll(async () => {
      vi.unstubAllGlobals();
      await cleanupAll();
    });

    it('custody /fresh-auth (action=change_email) → /api/settings/email → 200 + pending_email written', async () => {
      // Mint side: state-A user submits password + change_email action.
      // The route's widened validation accepts change_email; the issued
      // proof binds to changeEmailFreshAuthTarget(STATE_A_USER) via the
      // server-synthesized target (no root_author/root_permlink in body).
      const mintRes = await request(app)
        .post('/api/custody/fresh-auth')
        .set('Authorization', bearerFor(STATE_A_USER))
        .set('X-Hive-Username', STATE_A_USER)
        .send({ password: RT_PASSWORD, action: 'change_email' });
      expect(mintRes.status).toBe(200);
      expect(mintRes.body.status).toBe('ok');
      expect(mintRes.body.data.fresh_auth_proof).toMatch(/^[0-9a-f]{64}$/);
      expect(mintRes.body.data.mechanism).toBe('password');

      // Consume side: submit the proof to /api/settings/email.
      const consumeRes = await request(app)
        .post('/api/settings/email')
        .set('Authorization', bearerFor(STATE_A_USER))
        .set('X-Hive-Username', STATE_A_USER)
        .send({ email: NEW_EMAIL_A, fresh_auth_proof: mintRes.body.data.fresh_auth_proof });
      expect(consumeRes.status).toBe(200);

      const pool = getAppPool()!;
      const { rows } = await pool.query<{ pending_email: string | null }>(
        'SELECT pending_email FROM accounts WHERE username = $1',
        [STATE_A_USER],
      );
      expect(rows[0].pending_email).toBe(NEW_EMAIL_A);
    });

    it('orcid /start (action=change_email) → /callback → /api/settings/email → 200 + pending_email written', async () => {
      // Stub fetch so the OAuth token-exchange returns STATE_C_ORCID and
      // pub.orcid.org returns enough external works to satisfy the
      // accreditation precondition (handleFreshAuth itself does not gate
      // on works, but the shared installer keeps the stub general). Mirrors
      // the pattern in orcid.test.ts:251-277.
      const worksCount = config.orcidMinWorks;
      const group = Array.from({ length: worksCount }, (_, i) => ({
        'work-summary': [
          { source: { 'source-orcid': { path: `9999-9999-9999-${String(i).padStart(4, '0')}` } } },
        ],
      }));
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL) => {
          const u = typeof url === 'string' ? url : url.toString();
          if (u.includes('/oauth/token')) {
            return new Response(
              JSON.stringify({ orcid: STATE_C_ORCID, name: 'Test User', access_token: 'tk' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (u.includes('pub.orcid.org')) {
            return new Response(
              JSON.stringify({ group }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          throw new Error(`Unexpected fetch URL in test: ${u}`);
        }),
      );

      try {
        // /start: widened validation accepts action='change_email' without
        // root_author/root_permlink. Returns redirect_url carrying state.
        const startRes = await request(app)
          .post('/api/orcid/start')
          .set('Authorization', bearerFor(STATE_C_USER))
          .set('X-Hive-Username', STATE_C_USER)
          .send({ mode: 'fresh_auth', action: 'change_email' });
        expect(startRes.status).toBe(200);
        const redirectUrl = startRes.body.data.redirect_url as string;
        const state = new URL(redirectUrl).searchParams.get('state');
        expect(state).toMatch(/^[0-9a-f]{32}$/);

        // /callback: completes OAuth round-trip, calls handleFreshAuth,
        // mints the proof bound to changeEmailFreshAuthTarget(STATE_C_USER).
        const callbackRes = await request(app)
          .post('/api/orcid/callback')
          .set('Authorization', bearerFor(STATE_C_USER))
          .set('X-Hive-Username', STATE_C_USER)
          .send({ code: 'fake-oauth-code', state });
        expect(callbackRes.status).toBe(200);
        expect(callbackRes.body.data.mode).toBe('fresh_auth');
        expect(callbackRes.body.data.mechanism).toBe('orcid');
        expect(callbackRes.body.data.action).toBe('change_email');
        expect(callbackRes.body.data.fresh_auth_proof).toMatch(/^[0-9a-f]{64}$/);

        // Consume at /api/settings/email.
        const consumeRes = await request(app)
          .post('/api/settings/email')
          .set('Authorization', bearerFor(STATE_C_USER))
          .set('X-Hive-Username', STATE_C_USER)
          .send({
            email: NEW_EMAIL_C,
            fresh_auth_proof: callbackRes.body.data.fresh_auth_proof,
          });
        expect(consumeRes.status).toBe(200);

        const pool = getAppPool()!;
        const { rows } = await pool.query<{ pending_email: string | null }>(
          'SELECT pending_email FROM accounts WHERE username = $1',
          [STATE_C_USER],
        );
        expect(rows[0].pending_email).toBe(NEW_EMAIL_C);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  },
);

// ────────────────────────────────────────────────────────────────────
// Change-flow SMTP-fail: prior pending_email triple is restored (not
// nulled), and the response status is 200 (not 500). Differential test
// — the Add-flow SMTP-fail spec lives in `settings.test.ts` under
// `settings.email_post.smtp_send_failed log shape` and covers the
// no-existing-row INSERT-then-DELETE branch; this spec covers the
// existing-row UPDATE-then-restore branch.
//
// The restore UPDATE's WHERE-clause scoping by the just-written token
// (`AND pending_email_token = <just-written>`) is asserted indirectly:
// the single-request scenario below must restore the prior values, which
// only happens when the WHERE-scoping matches THIS request's just-written
// row state.
// ────────────────────────────────────────────────────────────────────

describe.skipIf(!dbReachable)(
  'POST /api/settings/email — Change-flow SMTP fail restores prior pending_email',
  () => {
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
    });

    afterAll(async () => {
      await cleanupAll();
    });

    it('seeded prior pending_email + second change SMTP fails → 200, prior values restored (not nulled, not the new email)', async () => {
      // Seed: a prior successful change-email leaves the row with a
      // non-NULL (pending_email, pending_email_token, pending_email_expires_at)
      // triple representing a still-valid 24h verify link in the user's inbox.
      const firstProof = await issueFreshAuthToken(
        STATE_A_USER,
        'password',
        changeEmailFreshAuthTarget(STATE_A_USER),
      );
      const firstRes = await request(app)
        .post('/api/settings/email')
        .set('Authorization', bearerFor(STATE_A_USER))
        .set('X-Hive-Username', STATE_A_USER)
        .send({ email: NEW_EMAIL_A, fresh_auth_proof: firstProof.token });
      expect(firstRes.status).toBe(200);

      const pool = getAppPool()!;
      const { rows: priorRows } = await pool.query<{
        pending_email: string | null;
        pending_email_token: string | null;
        pending_email_expires_at: Date | null;
      }>(
        'SELECT pending_email, pending_email_token, pending_email_expires_at FROM accounts WHERE username = $1',
        [STATE_A_USER],
      );
      const priorPendingEmail = priorRows[0].pending_email;
      const priorPendingToken = priorRows[0].pending_email_token;
      expect(priorPendingEmail).toBe(NEW_EMAIL_A);
      expect(priorPendingToken).not.toBeNull();

      // Second change-request: queue a one-shot SMTP rejection on the
      // shared sendMail mock so this request's send fails.
      const secondProof = await issueFreshAuthToken(
        STATE_A_USER,
        'password',
        changeEmailFreshAuthTarget(STATE_A_USER),
      );
      smtpMock.sendMail.mockRejectedValueOnce(new Error('SMTP connection refused'));

      const secondRes = await request(app)
        .post('/api/settings/email')
        .set('Authorization', bearerFor(STATE_A_USER))
        .set('X-Hive-Username', STATE_A_USER)
        .send({ email: NEW_EMAIL_B, fresh_auth_proof: secondProof.token });

      // SMTP-fail returns uniform 200 per Option A of the status-code
      // oracle convention. The body is the same as a successful send so a
      // JWT-only attacker can't read identity-registration state from the
      // status-code differential.
      expect(secondRes.status).toBe(200);

      // pending_email/token/expires_at restored to the prior snapshot via
      // the SMTP-fail rollback path. NOT the new email (no working verify
      // link was sent for it) and NOT NULL (which would destroy the prior
      // valid 24h verify link still in the user's inbox).
      const { rows: afterRows } = await pool.query<{
        pending_email: string | null;
        pending_email_token: string | null;
      }>(
        'SELECT pending_email, pending_email_token FROM accounts WHERE username = $1',
        [STATE_A_USER],
      );
      expect(afterRows[0].pending_email).toBe(priorPendingEmail);
      expect(afterRows[0].pending_email_token).toBe(priorPendingToken);
      expect(afterRows[0].pending_email).not.toBe(NEW_EMAIL_B);
    });
  },
);

// ────────────────────────────────────────────────────────────────────
// Account-existence enumeration oracle closure: a JWT-bearing request
// with no `fresh_auth_proof` must return uniform 401 FRESH_AUTH_REQUIRED
// regardless of whether the candidate `new_email` is registered to
// another account. Without the handler reorder that fires the fresh-auth
// consume BEFORE the duplicate-email SELECT, a JWT-only attacker could
// read registration state from the 409-vs-401 status differential. This
// spec pins the load-bearing ordering — a regression reverting the
// reorder would surface 409 for a registered-email probe.
// ────────────────────────────────────────────────────────────────────

describe.skipIf(!dbReachable)(
  'POST /api/settings/email — JWT-no-proof returns uniform 401 (closes 401-vs-409 oracle)',
  () => {
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
    });

    afterAll(async () => {
      await cleanupAll();
    });

    it('JWT, no proof, new_email IS registered to ANOTHER account → 401 (not 409)', async () => {
      // OTHER_EMAIL is registered to OTHER_USER. A JWT-bearing STATE_A_USER
      // probes that address with no proof. The fresh-auth gate must fire
      // BEFORE the duplicate-email SELECT, so the response is 401
      // FRESH_AUTH_REQUIRED — the same response a probe for an unregistered
      // email returns. Without the handler reorder, this returns 409
      // DUPLICATE and leaks that OTHER_EMAIL is registered.
      const res = await request(app)
        .post('/api/settings/email')
        .set('Authorization', bearerFor(STATE_A_USER))
        .set('X-Hive-Username', STATE_A_USER)
        .send({ email: OTHER_EMAIL });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(res.body.error.details?.reason).toBe('missing');
    });

    it('JWT, no proof, new_email is UNREGISTERED → 401 (uniformity companion)', async () => {
      // Same envelope shape as the registered-email probe above; the
      // status code and error code must match so an attacker can't
      // distinguish the two cases via response inspection.
      const unregistered = `unregistered_probe_${RUN_ID}@example.com`;
      const res = await request(app)
        .post('/api/settings/email')
        .set('Authorization', bearerFor(STATE_A_USER))
        .set('X-Hive-Username', STATE_A_USER)
        .send({ email: unregistered });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(res.body.error.details?.reason).toBe('missing');
    });
  },
);

// ────────────────────────────────────────────────────────────────────
// Concurrent-overwrite WHERE-scope direct test: simulate a concurrent
// change-email request landing between this request's UPDATE and its
// SMTP-fail restore by mutating the row from inside the sendMail mock.
// The restore UPDATE's `AND pending_email_token = <just-written>` clause
// must no-op (no row matches the just-written token any more), preserving
// the concurrent winner's state. A mutation dropping the scope clause
// would let this request's restore clobber the concurrent winner.
// ────────────────────────────────────────────────────────────────────

describe.skipIf(!dbReachable)(
  'POST /api/settings/email — SMTP-fail restore no-ops when concurrent request already overwrote',
  () => {
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
    });

    afterAll(async () => {
      await cleanupAll();
    });

    it('concurrent overwrite mid-flight → restore no-ops, concurrent winner state survives', async () => {
      // Concurrent winner state: simulate request "C" landing between
      // request "B"'s UPDATE and its sendMail call by mutating the row
      // from inside the sendMail rejection callback. The mutation writes
      // NEW_EMAIL_C + TOKEN_C, which means request B's restore (scoped
      // by ITS just-written token) finds no matching row.
      const NEW_EMAIL_C_LOCAL = `setting_email_concurrent_${RUN_ID}@example.com`;
      const TOKEN_C = 'concurrent_winner_token_' + RUN_ID.toString(16);
      const EXPIRES_C = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const proof = await issueFreshAuthToken(
        STATE_A_USER,
        'password',
        changeEmailFreshAuthTarget(STATE_A_USER),
      );

      smtpMock.sendMail.mockImplementationOnce(async () => {
        const pool = getAppPool()!;
        await pool.query(
          `UPDATE accounts
             SET pending_email = $1,
                 pending_email_token = $2,
                 pending_email_expires_at = $3
             WHERE username = $4`,
          [NEW_EMAIL_C_LOCAL, TOKEN_C, EXPIRES_C, STATE_A_USER],
        );
        throw new Error('SMTP fail after concurrent overwrite');
      });

      const res = await request(app)
        .post('/api/settings/email')
        .set('Authorization', bearerFor(STATE_A_USER))
        .set('X-Hive-Username', STATE_A_USER)
        .send({ email: NEW_EMAIL_B, fresh_auth_proof: proof.token });
      expect(res.status).toBe(200);

      // The concurrent winner's state survives: the restore UPDATE's
      // WHERE-clause did not match (its token-scope referenced request
      // B's just-written token, not TOKEN_C).
      const pool = getAppPool()!;
      const { rows } = await pool.query<{
        pending_email: string | null;
        pending_email_token: string | null;
      }>(
        'SELECT pending_email, pending_email_token FROM accounts WHERE username = $1',
        [STATE_A_USER],
      );
      expect(rows[0].pending_email).toBe(NEW_EMAIL_C_LOCAL);
      expect(rows[0].pending_email_token).toBe(TOKEN_C);
    });

    it('concurrent overwrite mid-flight → smtp_fail_restore_raced warn fires (distinct from smtp_send_failed)', async () => {
      // Observability pin: when the restore UPDATE no-ops (race path),
      // the route emits a second warn with a distinct event discriminator
      // so operators can distinguish "rolled back" from "raced and
      // skipped." The base smtp_send_failed warn fires on every SMTP
      // failure; this companion fires only on the race path.
      const NEW_EMAIL_C_LOCAL = `setting_email_concurrent_obs_${RUN_ID}@example.com`;
      const TOKEN_C = 'concurrent_obs_token_' + RUN_ID.toString(16);
      const EXPIRES_C = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const proof = await issueFreshAuthToken(
        STATE_A_USER,
        'password',
        changeEmailFreshAuthTarget(STATE_A_USER),
      );

      smtpMock.sendMail.mockImplementationOnce(async () => {
        const pool = getAppPool()!;
        await pool.query(
          `UPDATE accounts
             SET pending_email = $1,
                 pending_email_token = $2,
                 pending_email_expires_at = $3
             WHERE username = $4`,
          [NEW_EMAIL_C_LOCAL, TOKEN_C, EXPIRES_C, STATE_A_USER],
        );
        throw new Error('SMTP fail with raced-restore observability');
      });

      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(
        () => undefined as unknown as void,
      );

      try {
        const res = await request(app)
          .post('/api/settings/email')
          .set('Authorization', bearerFor(STATE_A_USER))
          .set('X-Hive-Username', STATE_A_USER)
          .send({ email: NEW_EMAIL_B, fresh_auth_proof: proof.token });
        expect(res.status).toBe(200);

        // Both warn emissions present:
        //   1. settings.email_post.smtp_send_failed (always on SMTP fail)
        //   2. settings.email_post.smtp_fail_restore_raced (only on race)
        const events = warnSpy.mock.calls
          .map((call) => {
            const [obj] = call;
            return obj && typeof obj === 'object'
              ? (obj as { event?: string }).event
              : undefined;
          })
          .filter(Boolean);
        expect(events).toContain('settings.email_post.smtp_send_failed');
        expect(events).toContain('settings.email_post.smtp_fail_restore_raced');
      } finally {
        warnSpy.mockRestore();
      }
    });
  },
);

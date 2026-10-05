/**
 * State G rows (ARCHITECTURE.md section 6.1) while their settings-registered
 * email is still unverified, and the two email-verification links that share
 * the `accounts.verify_token` column.
 *
 * A state G row is a self-custody Keychain account whose `accounts` row exists
 * only because it registered an email through `POST /api/settings/email`'s add
 * flow: `username` set, `custody` and `upgraded_at` NULL, and a random hex
 * `verify_token` until the mailed link is clicked. Signup rows (states E and F)
 * carry `username` NULL, a random hex token in E and a `confirmed:` token in F.
 * The specs pin:
 *
 *  - `POST /api/auth/verify` (the signup link) answers a state G token, live or
 *    expired, exactly as it answers an unknown token, and neither confirms nor
 *    deletes the row. It answers a state F row's `confirmed:` auth_token the
 *    same way, sets no binding cookie, and leaves the row's token and
 *    `signup_binding_hash` as they were.
 *  - `GET /api/settings/email/verify/:token` (the settings link) answers a
 *    state E or state F token with the same generic 400 as an unknown token and
 *    leaves the signup row's token intact, while the settings add flow's own
 *    token still verifies end to end.
 *  - Its change branch also clears a hex `verify_token`: proving control of the
 *    new address verifies the row's email.
 *  - `POST /api/settings/email` on an unverified state G row re-issues the
 *    add-flow verification (new email, token and expiry) instead of writing
 *    the pending change. A pending-change triple the row carried from before
 *    the re-issue branch existed is cleared, and its link then gets the
 *    unknown-token 400. When the re-issued mail fails to send, the email,
 *    token, expiry and pending-change triple the request found are restored.
 *  - `POST /api/settings/email` answers 409 DUPLICATE and sends no mail for an
 *    address a pending signup row holds. A caller with no row gets none
 *    created (add flow), and an unverified state G caller keeps its email,
 *    token and expiry (re-issue).
 *  - `POST /api/settings/set-password` refuses an ORCID-linked unverified
 *    state G row with 409 PENDING_UNVERIFIED and writes no password, without
 *    spending the presented ORCID proof: once the email is verified, the same
 *    proof sets the password.
 *
 * Mocks (per root CLAUDE.md "Carve-out for deterministic edge-case coverage"):
 *
 *   (a) Justification: the focus is which row a token or a request reaches and
 *   what that branch writes, not cryptographic verification. The SMTP
 *   transporter factory (`createSmtpTransporter`) is mocked so the route's
 *   verification mail resolves without a live SMTP server and the mailed
 *   link's token can be read back from the `sendMail` call, which is what lets
 *   the add-flow specs follow the real link rather than reading the token from
 *   the database. One spec queues a single `sendMail` rejection to reach the
 *   SMTP-fail restore. `config.smtpHost` is stubbed to a non-empty value only
 *   because the route refuses to build a mail without one; every other config
 *   field is the real one. The database, Redis, the fresh-auth primitive and
 *   both link handlers run real.
 *
 *   (b) `verifyHiveSignature` is mocked via the project-wide
 *   `MOCK_VERIFY_SIGNATURE` fixture, so cryptographic signature and JWT
 *   verification are bypassed for `POST /api/settings/email` and
 *   `POST /api/settings/set-password`. The fixture keeps the 401 on a missing
 *   username header and mirrors the `req.hiveAuthMethod` discriminator
 *   (`'signature'` with no Bearer header), which is all these specs depend on.
 *   The two link handlers carry no auth middleware, so nothing is bypassed
 *   there.
 *
 *   (c) Real-path companion: `backend/tests/routes/settings-set-password.test.ts` [setPasswordFreshAuthTarget]
 *       Real-path companion: `backend/tests/middleware/verifyHiveSignature-authmethod.test.ts` [hiveAuthMethod]
 *       Real-path companion: `backend/tests/routes/settings.test.ts` [smtp_send_failed]
 *   The first drives `POST /api/settings/set-password` through the real
 *   `verifyHiveSignature` with JWTs signed against `config.sessionSecret`. The
 *   second pins both success branches of the real middleware, including the
 *   discriminator the settings email route reads. The third runs the settings
 *   add flow through the real SMTP helper to its send-failure rollback.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

const smtpMock = vi.hoisted(() => ({
  sendMail: vi.fn().mockResolvedValue({ messageId: 'mock-message' }),
}));

vi.mock('../../src/lib/smtp.js', () => ({
  createSmtpTransporter: () => ({
    sendMail: smtpMock.sendMail,
  }),
}));

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
const { issueFreshAuthToken, setPasswordFreshAuthTarget } = await import(
  '../../src/lib/fresh-auth.js'
);
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');
const { SIGNUP_BINDING_COOKIE_NAME } = await import('../../src/signup-session-binding.js');

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

const RUN_ID = Date.now();
const SUFFIX = (RUN_ID % 1000000).toString(36);
const FAKE_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$placeholderplaceholder$placeholderplaceholderplaceholderplaceholder';

// Every row a spec seeds or creates is keyed by an email carrying this marker,
// so cleanup reaches signup rows (username NULL) as well as state G rows.
const EMAIL_MARKER = `stateg_${RUN_ID}`;
let seq = 0;
function uniq(label: string): { username: string; email: string } {
  seq += 1;
  return {
    username: `sg${label}${SUFFIX}${seq}`,
    email: `${EMAIL_MARKER}_${label}_${seq}@example.com`,
  };
}

function hexToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function mailedTokenFor(to: string): string | undefined {
  for (const call of smtpMock.sendMail.mock.calls) {
    const [mail] = call as [{ to?: string; text?: string }];
    if (mail?.to === to) {
      const match = /\/settings\/verify-email\/([0-9a-f]+)/.exec(mail.text ?? '');
      if (match) return match[1];
    }
  }
  return undefined;
}

type AccountRow = {
  id: number;
  email: string;
  username: string | null;
  verify_token: string | null;
  expires_at: Date | null;
  password_hash: string | null;
  pending_email: string | null;
  pending_email_token: string | null;
  pending_email_expires_at: Date | null;
  signup_binding_hash: Buffer | null;
};

async function rowByEmail(email: string): Promise<AccountRow | undefined> {
  const { rows } = await getAppPool()!.query<AccountRow>(
    `SELECT id, email, username, verify_token, expires_at, password_hash,
            pending_email, pending_email_token, pending_email_expires_at, signup_binding_hash
       FROM accounts WHERE email = $1`,
    [email],
  );
  return rows[0];
}

async function rowByUsername(username: string): Promise<AccountRow | undefined> {
  const { rows } = await getAppPool()!.query<AccountRow>(
    `SELECT id, email, username, verify_token, expires_at, password_hash,
            pending_email, pending_email_token, pending_email_expires_at, signup_binding_hash
       FROM accounts WHERE username = $1`,
    [username],
  );
  return rows[0];
}

type PendingChange = { email: string; token: string; expiresAt: Date };

// State G as the settings add flow INSERTs it: username set, custody and
// upgraded_at NULL, password_hash NULL, a hex token until the link is clicked.
// `pending` adds the legacy shape of a row that took the change flow while
// its email was still unverified: a pending_email triple beside the hex token.
async function seedUnverifiedG(opts: {
  username: string;
  email: string;
  token: string;
  expiresAt: Date;
  orcid?: string;
  pending?: PendingChange;
}): Promise<void> {
  await getAppPool()!.query(
    `INSERT INTO accounts (email, username, verify_token, expires_at, orcid,
                           pending_email, pending_email_token, pending_email_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      opts.email,
      opts.username,
      opts.token,
      opts.expiresAt,
      opts.orcid ?? null,
      opts.pending?.email ?? null,
      opts.pending?.token ?? null,
      opts.pending?.expiresAt ?? null,
    ],
  );
}

// A pending email signup row (state E): username NULL, a hex token until the
// signup link is clicked.
async function seedSignupE(email: string): Promise<void> {
  await getAppPool()!.query(
    `INSERT INTO accounts (email, password_hash, verify_token, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
    [email, FAKE_PASSWORD_HASH, hexToken()],
  );
}

async function cleanupAll(): Promise<void> {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  const like = `${EMAIL_MARKER}_%`;
  await pool
    .query(
      `DELETE FROM custody_audit_log WHERE username IN (
         SELECT username FROM accounts WHERE email LIKE $1 OR pending_email LIKE $1)`,
      [like],
    )
    .catch(() => {});
  await pool
    .query('DELETE FROM accounts WHERE email LIKE $1 OR pending_email LIKE $1', [like])
    .catch(() => {});
}

describe.skipIf(!dbReachable)('state G rows with an unverified email', () => {
  beforeAll(async () => {
    await cleanupAll();
  });

  beforeEach(async () => {
    smtpMock.sendMail.mockClear();
    await clearRateLimitKeys(['settings-write', 'settings-read', 'signup-verify']);
  });

  afterAll(async () => {
    await cleanupAll();
  });

  // ─── POST /api/auth/verify: signup rows only ──────────────────────────

  describe('POST /api/auth/verify', () => {
    it('answers a state G token exactly as an unknown token and leaves the row untouched', async () => {
      const g = uniq('av');
      const token = hexToken();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await seedUnverifiedG({ ...g, token, expiresAt });

      const unknown = await request(app).post('/api/auth/verify').send({ token: hexToken() });
      const res = await request(app).post('/api/auth/verify').send({ token });

      expect(res.status).toBe(unknown.status);
      expect(res.body).toEqual(unknown.body);
      const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
      expect(cookies.some((c) => c.startsWith(`${SIGNUP_BINDING_COOKIE_NAME}=`))).toBe(false);

      const row = await rowByUsername(g.username);
      expect(row?.verify_token).toBe(token);
      expect(row?.expires_at?.getTime()).toBe(expiresAt.getTime());
      expect(row?.signup_binding_hash).toBeNull();
    });

    it('does not delete an expired state G row and answers as for an unknown token', async () => {
      const g = uniq('ax');
      const token = hexToken();
      await seedUnverifiedG({ ...g, token, expiresAt: new Date(Date.now() - 60 * 60 * 1000) });

      const unknown = await request(app).post('/api/auth/verify').send({ token: hexToken() });
      const res = await request(app).post('/api/auth/verify').send({ token });

      expect(res.status).toBe(unknown.status);
      expect(res.body).toEqual(unknown.body);
      const row = await rowByUsername(g.username);
      expect(row).toBeDefined();
      expect(row?.verify_token).toBe(token);
    });

    it("answers a state F row's confirmed: auth_token exactly as an unknown token and mints no binding", async () => {
      const f = uniq('af');
      const token = `confirmed:${hexToken()}`;
      const bindingHash = crypto.randomBytes(32);
      await getAppPool()!.query(
        `INSERT INTO accounts (email, password_hash, verify_token, expires_at, signup_binding_hash)
         VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours', $4)`,
        [f.email, FAKE_PASSWORD_HASH, token, bindingHash],
      );

      const unknown = await request(app).post('/api/auth/verify').send({ token: hexToken() });
      const res = await request(app).post('/api/auth/verify').send({ token });

      expect(unknown.status).toBe(400);
      expect(res.status).toBe(unknown.status);
      expect(res.body).toEqual(unknown.body);
      const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
      expect(cookies.some((c) => c.startsWith(`${SIGNUP_BINDING_COOKIE_NAME}=`))).toBe(false);

      const row = await rowByEmail(f.email);
      expect(row?.verify_token).toBe(token);
      expect(row?.signup_binding_hash?.equals(bindingHash)).toBe(true);
    });
  });

  // ─── POST /api/settings/set-password ──────────────────────────────────

  describe('POST /api/settings/set-password', () => {
    it('refuses an ORCID-linked, null-hash state G row whose email is unverified', async () => {
      const g = uniq('sp');
      const orcid = `0000-0004-${(RUN_ID % 10000).toString().padStart(4, '0')}-${(seq % 10000)
        .toString()
        .padStart(4, '0')}`;
      await seedUnverifiedG({
        ...g,
        token: hexToken(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        orcid,
      });
      // A valid ORCID proof, so the only thing standing between this request
      // and a written password is the unverified-email refusal.
      const issued = await issueFreshAuthToken(
        g.username,
        'orcid',
        setPasswordFreshAuthTarget(g.username),
      );
      const bearer = jwt.sign({ sub: g.username, custody: 'self' }, config.sessionSecret, {
        expiresIn: '5m',
      });

      const res = await request(app)
        .post('/api/settings/set-password')
        .set('Authorization', `Bearer ${bearer}`)
        .set('X-Hive-Username', g.username)
        .send({ password: 'UnverifiedG1pass', fresh_auth_proof: issued.token });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PENDING_UNVERIFIED');
      expect(res.body.error.message).toBe('Verify your email before setting a password.');
      const row = await rowByUsername(g.username);
      expect(row?.password_hash).toBeNull();

      // The refusal left the proof unspent: once the email is verified, the
      // same proof sets the password.
      await getAppPool()!.query(
        'UPDATE accounts SET verify_token = NULL, expires_at = NULL WHERE username = $1',
        [g.username],
      );
      const retry = await request(app)
        .post('/api/settings/set-password')
        .set('Authorization', `Bearer ${bearer}`)
        .set('X-Hive-Username', g.username)
        .send({ password: 'UnverifiedG1pass', fresh_auth_proof: issued.token });
      expect(retry.status).toBe(200);
      const after = await rowByUsername(g.username);
      expect(after?.password_hash).not.toBeNull();
    });
  });

  // ─── POST /api/settings/email on an unverified state G row ────────────

  describe('POST /api/settings/email', () => {
    it('re-issues the add-flow verification instead of writing a pending change, and the new link verifies', async () => {
      const g = uniq('re');
      const oldToken = hexToken();
      const oldExpiry = new Date(Date.now() + 60 * 1000);
      const pending: PendingChange = {
        email: `${EMAIL_MARKER}_re_pend_${seq}@example.com`,
        token: hexToken(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      };
      await seedUnverifiedG({ ...g, token: oldToken, expiresAt: oldExpiry, pending });
      const newEmail = `${EMAIL_MARKER}_re_new_${seq}@example.com`;

      const res = await request(app)
        .post('/api/settings/email')
        .set('X-Hive-Username', g.username)
        .send({ email: newEmail });
      expect(res.status).toBe(200);

      const row = await rowByUsername(g.username);
      expect(row?.email).toBe(newEmail);
      expect(row?.verify_token).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.verify_token).not.toBe(oldToken);
      expect(row?.expires_at?.getTime()).toBeGreaterThan(oldExpiry.getTime());
      expect(row?.pending_email).toBeNull();
      expect(row?.pending_email_token).toBeNull();
      expect(row?.pending_email_expires_at).toBeNull();

      // The dropped pending change's link now gets the unknown-token answer.
      const unknown = await request(app).get(`/api/settings/email/verify/${hexToken()}`);
      const stale = await request(app).get(`/api/settings/email/verify/${pending.token}`);
      expect(unknown.status).toBe(400);
      expect(stale.status).toBe(unknown.status);
      expect(stale.body).toEqual(unknown.body);
      expect((await rowByUsername(g.username))?.email).toBe(newEmail);

      const mailed = mailedTokenFor(newEmail);
      expect(mailed).toBe(row?.verify_token);

      const verify = await request(app).get(`/api/settings/email/verify/${mailed}`);
      expect(verify.status).toBe(200);
      expect(verify.body.data.verified).toBe(true);
      const after = await rowByUsername(g.username);
      expect(after?.email).toBe(newEmail);
      expect(after?.verify_token).toBeNull();
      expect(after?.expires_at).toBeNull();
    });

    it('restores the row it found when the re-issued verification mail fails to send', async () => {
      const g = uniq('rf');
      const oldToken = hexToken();
      const oldExpiry = new Date(Date.now() + 60 * 1000);
      const pending: PendingChange = {
        email: `${EMAIL_MARKER}_rf_pend_${seq}@example.com`,
        token: hexToken(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      };
      await seedUnverifiedG({ ...g, token: oldToken, expiresAt: oldExpiry, pending });
      const newEmail = `${EMAIL_MARKER}_rf_new_${seq}@example.com`;
      smtpMock.sendMail.mockRejectedValueOnce(new Error('synthetic SMTP failure'));

      const res = await request(app)
        .post('/api/settings/email')
        .set('X-Hive-Username', g.username)
        .send({ email: newEmail });
      expect(res.status).toBe(200);

      const row = await rowByUsername(g.username);
      expect(row?.email).toBe(g.email);
      expect(row?.verify_token).toBe(oldToken);
      expect(row?.expires_at?.getTime()).toBe(oldExpiry.getTime());
      expect(row?.pending_email).toBe(pending.email);
      expect(row?.pending_email_token).toBe(pending.token);
      expect(row?.pending_email_expires_at?.getTime()).toBe(pending.expiresAt.getTime());
    });

    it('answers 409 DUPLICATE when a caller with no row adds an address a pending signup row holds', async () => {
      const caller = uniq('dn');
      const held = uniq('dnheld');
      await seedSignupE(held.email);
      const mailsBefore = smtpMock.sendMail.mock.calls.length;

      const res = await request(app)
        .post('/api/settings/email')
        .set('X-Hive-Username', caller.username)
        .send({ email: held.email });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE');
      expect(await rowByUsername(caller.username)).toBeUndefined();
      expect(smtpMock.sendMail.mock.calls.length).toBe(mailsBefore);
    });

    it('answers 409 DUPLICATE when an unverified state G row re-adds an address a pending signup row holds', async () => {
      const g = uniq('dr');
      const held = uniq('drheld');
      const token = hexToken();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await seedUnverifiedG({ ...g, token, expiresAt });
      await seedSignupE(held.email);
      const mailsBefore = smtpMock.sendMail.mock.calls.length;

      const res = await request(app)
        .post('/api/settings/email')
        .set('X-Hive-Username', g.username)
        .send({ email: held.email });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE');
      const row = await rowByUsername(g.username);
      expect(row?.email).toBe(g.email);
      expect(row?.verify_token).toBe(token);
      expect(row?.expires_at?.getTime()).toBe(expiresAt.getTime());
      expect(smtpMock.sendMail.mock.calls.length).toBe(mailsBefore);
    });
  });

  // ─── GET /api/settings/email/verify/:token ────────────────────────────

  describe('GET /api/settings/email/verify/:token', () => {
    it("answers a state E row's hex token with the unknown-token 400 and keeps the row's token", async () => {
      const e = uniq('ve');
      const token = hexToken();
      await getAppPool()!.query(
        `INSERT INTO accounts (email, password_hash, verify_token, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
        [e.email, FAKE_PASSWORD_HASH, token],
      );

      const unknown = await request(app).get(`/api/settings/email/verify/${hexToken()}`);
      const res = await request(app).get(`/api/settings/email/verify/${token}`);

      expect(unknown.status).toBe(400);
      expect(res.status).toBe(unknown.status);
      expect(res.body).toEqual(unknown.body);
      const row = await rowByEmail(e.email);
      expect(row?.verify_token).toBe(token);
      expect(row?.expires_at).not.toBeNull();
    });

    it("answers an expired state E row's token with the same unknown-token 400", async () => {
      const e = uniq('vx');
      const token = hexToken();
      await getAppPool()!.query(
        `INSERT INTO accounts (email, password_hash, verify_token, expires_at)
         VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour')`,
        [e.email, FAKE_PASSWORD_HASH, token],
      );

      const unknown = await request(app).get(`/api/settings/email/verify/${hexToken()}`);
      const res = await request(app).get(`/api/settings/email/verify/${token}`);

      expect(res.status).toBe(unknown.status);
      expect(res.body).toEqual(unknown.body);
      const row = await rowByEmail(e.email);
      expect(row?.verify_token).toBe(token);
    });

    it("answers a state F row's confirmed: token with the unknown-token 400 and keeps the row's token", async () => {
      const f = uniq('vf');
      const token = `confirmed:${hexToken()}`;
      await getAppPool()!.query(
        `INSERT INTO accounts (email, password_hash, verify_token, expires_at, signup_binding_hash)
         VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours', $4)`,
        [f.email, FAKE_PASSWORD_HASH, token, crypto.randomBytes(32)],
      );

      const unknown = await request(app).get(`/api/settings/email/verify/${hexToken()}`);
      const res = await request(app).get(`/api/settings/email/verify/${encodeURIComponent(token)}`);

      expect(res.status).toBe(unknown.status);
      expect(res.body).toEqual(unknown.body);
      const row = await rowByEmail(f.email);
      expect(row?.verify_token).toBe(token);
    });

    it("verifies the settings add flow's own token through the mailed link", async () => {
      const g = uniq('va');

      const add = await request(app)
        .post('/api/settings/email')
        .set('X-Hive-Username', g.username)
        .send({ email: g.email });
      expect(add.status).toBe(200);
      const mailed = mailedTokenFor(g.email);
      expect(mailed).toBeDefined();
      expect((await rowByUsername(g.username))?.verify_token).toBe(mailed);

      const res = await request(app).get(`/api/settings/email/verify/${mailed}`);
      expect(res.status).toBe(200);
      expect(res.body.data.verified).toBe(true);
      const row = await rowByUsername(g.username);
      expect(row?.verify_token).toBeNull();
      expect(row?.expires_at).toBeNull();
    });

    it('clears a hex verify_token when the change branch verifies a row that took the change flow while unverified', async () => {
      const g = uniq('vc');
      const changeToken = hexToken();
      const newEmail = `${EMAIL_MARKER}_vc_new_${seq}@example.com`;
      await getAppPool()!.query(
        `INSERT INTO accounts (email, username, verify_token, expires_at,
                               pending_email, pending_email_token, pending_email_expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours', $4, $5, NOW() + INTERVAL '24 hours')`,
        [g.email, g.username, hexToken(), newEmail, changeToken],
      );

      const res = await request(app).get(`/api/settings/email/verify/${changeToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.verified).toBe(true);

      const row = await rowByUsername(g.username);
      expect(row?.email).toBe(newEmail);
      expect(row?.pending_email).toBeNull();
      expect(row?.pending_email_token).toBeNull();
      expect(row?.verify_token).toBeNull();
      expect(row?.expires_at).toBeNull();
    });
  });
});

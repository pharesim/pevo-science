/**
 * The signup verification link (`POST /api/auth/verify`) confirms a pending
 * signup row E only for that row's password, and
 * `POST /api/auth/signup` writes no row for an `orcid_token` that does not
 * resolve, so every row the email path writes carries a password. The specs
 * pin:
 *
 *  - A wrong password answers 401 UNAUTHORIZED, sets no binding cookie and
 *    leaves the row as it was. The signup password answers 200 `choose` and
 *    sets the cookie.
 *  - A missing or non-string password answers 400 VALIDATION_ERROR and leaves
 *    the row as it was.
 *  - A pending row with no password answers the wrong-password 401 and stays
 *    as it was.
 *  - `/signup` with an institutional address, no password and an
 *    `orcid_token` that does not resolve answers 400 and writes no row.
 *  - The signup and resend verification mails say the link asks for the
 *    signup password.
 *
 * Mocks (per root CLAUDE.md "Carve-out for deterministic edge-case coverage"):
 *
 *   (a) Justification. The SMTP transporter factory (`createSmtpTransporter`)
 *   is mocked so `/signup` and `/resend-verification` mail without a live
 *   SMTP server, and so the specs follow the mailed link's token instead of
 *   reading it from the database. `config.smtpHost` is given a value when the
 *   project `.env` leaves it empty, because both routes refuse to build a mail
 *   without one. Postgres, Redis, argon2 and the routes under test run real.
 *
 *   (b) These routes carry no auth middleware, so nothing is bypassed.
 *
 *   (c) Real-path companion: `backend/tests/routes/recover.test.ts` [smtp-fail-test.invalid]
 *   It drives the resend route into its sendMail branch through the real SMTP
 *   helper module.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';

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
const SIGNUP_PASSWORD = 'SignupPassword1';
const OTHER_PASSWORD = 'SomeoneElse99';
const PASSWORD_SENTENCE = /asks for the password you chose when you signed up/;

const createdEmails = new Set<string>();
let seq = 0;

// An institutional address no earlier call (and no earlier attempt of a
// retried spec) has used.
function freshEmail(tag: string): string {
  seq += 1;
  const email = `verify_pw_${RUN_ID}_${tag}_${seq}@mit.edu`;
  createdEmails.add(email);
  return email;
}

type AccountRow = Record<string, unknown>;

async function rowByEmail(email: string): Promise<AccountRow | undefined> {
  const { rows } = await getAppPool()!.query<AccountRow>('SELECT * FROM accounts WHERE email = $1', [email]);
  return rows[0];
}

function lastMailText(): string {
  const calls = smtpMock.sendMail.mock.calls;
  expect(calls.length, 'expected a verification mail').toBeGreaterThan(0);
  return (calls[calls.length - 1][0] as { text: string }).text;
}

function tokenFromMail(text: string): string {
  const match = text.match(/\/signup\/verify\?token=([0-9a-f]{64})/);
  expect(match, 'expected a signup verification link in the mail').not.toBeNull();
  return match![1];
}

function bindingCookieSet(res: request.Response): boolean {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return cookies.some((c) => c.startsWith(`${SIGNUP_BINDING_COOKIE_NAME}=`));
}

// Sign up on the email path with the signup password and return the token
// the verification mail carries.
async function signUp(email: string): Promise<string> {
  const res = await request(app).post('/api/auth/signup').send({
    email,
    password: SIGNUP_PASSWORD,
    full_name: 'Verify Password',
    institution: 'MIT',
    field: 'physics',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return tokenFromMail(lastMailText());
}

afterAll(async () => {
  if (!dbReachable || createdEmails.size === 0) return;
  await getAppPool()!.query('DELETE FROM accounts WHERE email = ANY($1)', [[...createdEmails]]);
});

describe.skipIf(!dbReachable)('the signup verification link requires the signup password', () => {
  beforeEach(async () => {
    smtpMock.sendMail.mockClear();
    await clearRateLimitKeys(['auth-signup', 'signup-verify', 'auth-resend']);
  });

  it('answers a wrong password with 401 and leaves the row as it was, and confirms with the signup password', async () => {
    const email = freshEmail('wrong');
    const token = await signUp(email);
    const mailText = lastMailText();
    const before = await rowByEmail(email);
    expect(before?.verify_token).toBe(token);

    const wrong = await request(app).post('/api/auth/verify').send({ token, password: OTHER_PASSWORD });

    expect(wrong.status, JSON.stringify(wrong.body)).toBe(401);
    expect(wrong.body.error.code).toBe('UNAUTHORIZED');
    expect(bindingCookieSet(wrong)).toBe(false);
    expect(await rowByEmail(email)).toEqual(before);

    const right = await request(app).post('/api/auth/verify').send({ token, password: SIGNUP_PASSWORD });

    expect(right.status, JSON.stringify(right.body)).toBe(200);
    expect(right.body.data.flow).toBe('choose');
    expect(String(right.body.data.auth_token)).toMatch(/^confirmed:/);
    expect(bindingCookieSet(right)).toBe(true);
    const after = await rowByEmail(email);
    expect(after?.verify_token).toBe(right.body.data.auth_token);
    expect(after?.signup_binding_hash).not.toBeNull();
    expect(mailText).toMatch(PASSWORD_SENTENCE);
  });

  it('answers a missing or non-string password with 400 VALIDATION_ERROR and leaves the row as it was', async () => {
    const email = freshEmail('missing');
    const token = await signUp(email);
    const before = await rowByEmail(email);

    for (const body of [{ token }, { token, password: 12345678 }]) {
      const res = await request(app).post('/api/auth/verify').send(body);

      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(bindingCookieSet(res)).toBe(false);
    }
    expect(await rowByEmail(email)).toEqual(before);
  });

  it('answers a pending row with no password with the wrong-password 401 and leaves it as it was', async () => {
    // The shape `/signup` wrote, before it refused an unresolved
    // `orcid_token`, for an institutional address sent with no password.
    const email = freshEmail('nohash');
    const token = await signUp(email);
    await getAppPool()!.query('UPDATE accounts SET password_hash = NULL WHERE email = $1', [email]);
    const before = await rowByEmail(email);

    const res = await request(app).post('/api/auth/verify').send({ token, password: SIGNUP_PASSWORD });

    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(bindingCookieSet(res)).toBe(false);
    expect(await rowByEmail(email)).toEqual(before);
  });

  it('mails a resent link that asks for the signup password', async () => {
    const email = freshEmail('resend');
    await signUp(email);
    smtpMock.sendMail.mockClear();

    const res = await request(app)
      .post('/api/auth/resend-verification')
      .send({ email, password: SIGNUP_PASSWORD });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(smtpMock.sendMail).toHaveBeenCalledTimes(1);
    expect(lastMailText()).toMatch(PASSWORD_SENTENCE);
  });
});

describe.skipIf(!dbReachable)('POST /api/auth/signup refuses an orcid_token that does not resolve', () => {
  beforeEach(async () => {
    smtpMock.sendMail.mockClear();
    await clearRateLimitKeys(['auth-signup']);
  });

  it('answers 400 and writes no row for an institutional address sent with no password', async () => {
    const email = freshEmail('orcid');

    const res = await request(app).post('/api/auth/signup').send({
      email,
      orcid_token: `unresolved-${RUN_ID}-${seq}`,
      full_name: 'Stale Orcid',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toMatch(/ORCID/);
    expect(await rowByEmail(email)).toBeUndefined();
    expect(smtpMock.sendMail).not.toHaveBeenCalled();
  });
});

/**
 * State G rows on the signup-side auth routes (`routes/auth.ts`).
 *
 * A state G row (ARCHITECTURE.md section 6.1) belongs to a self-custody
 * Keychain account that registered an email through the add flow of
 * `POST /api/settings/email`: `username` set, `custody` NULL, `upgraded_at`
 * NULL, and a random hex `verify_token` until the mailed link is clicked. The
 * hex token is the same shape a pending signup row E carries, so every
 * signup-side route that reads `verify_token` without also reading `username`
 * mistakes the G row for a pending signup. Signup rows (E and F) always carry
 * `username` NULL, which is the discriminator these specs pin:
 *
 *   - `/login`: a G row with a password and an unverified email logs in
 *     (200 + JWT), even past `expires_at`, and the row is not deleted. Signup
 *     row E keeps its PENDING_UNVERIFIED and SIGNUP_EXPIRED answers.
 *   - `/login` NO_PASSWORD_SET: one uniform message for every passwordless
 *     row, a passwordless G row and a pending ORCID-path signup row F among
 *     them.
 *   - `/resend-verification`: a G row is treated as not pending (uniform
 *     message, no token rewrite, no mail), and that answer still pays the
 *     argon2 verify.
 *   - `/signup`: a G row that carries a password or an ORCID answers 409
 *     DUPLICATE, keeps the stored row unchanged, and pays the same argon2.hash
 *     burn as the other duplicate 409s. A factor-less G row whose email is
 *     unverified holds nothing but the email claim, and it yields to a signup
 *     that will proceed: the signup deletes it and writes its own signup row
 *     (E on the email path, F on the ORCID path). A signup that fails the
 *     accreditation gate, or whose own row is never written (a verified ORCID
 *     that another account already holds), leaves the G row in place. A G row
 *     written after the duplicate pre-check, before the upsert, is left
 *     untouched by the upsert and the signup answers 409 DUPLICATE.
 *
 * Every G row here is created through the real settings registration path: a
 * `POST /api/settings/email` add-flow request signed with a request-bound Hive
 * signature that the real `verifyHiveSignature` middleware verifies. Where a
 * spec needs a G row that carries a password (and the ORCID that
 * `/settings/set-password` requires first), those two columns are written
 * directly after registration. That is the legacy shape of a row that acquired
 * factors while its email was still unverified: `/settings/set-password` and
 * the ORCID link callback now refuse to add a factor to such a row.
 *
 * Every spec draws a fresh username, email and ORCID from `fresh()`, because
 * vitest re-runs a failed `it` body in place and an earlier attempt's row would
 * otherwise still hold them.
 *
 * Mocks (per root CLAUDE.md "Carve-out for deterministic edge-case coverage"):
 *
 *   (a) Justification. `hiveClient.database.getAccounts` is stubbed to publish
 *   a deterministic posting key for this file's usernames: running it against
 *   the live chain would couple the specs to a real on-chain account's keys,
 *   which are unrelated to the account-state branches under test, and no
 *   suite here runs that lookup live. The SMTP transporter is mocked (and
 *   `config.smtpHost` given a value when the project `.env` leaves it empty)
 *   so the settings add flow's verification mail resolves instead of rolling
 *   the new row back, and so the resend and signup specs can observe whether
 *   a mail was sent at all. One signup spec wraps the app pool's `query` to
 *   insert a G row immediately before the signup upsert runs: a write inside
 *   the window between the duplicate pre-check and the upsert cannot be
 *   placed deterministically any other way. The wrapper changes no result;
 *   every statement still runs against the real database.
 *
 *   (b) `verifyHiveSignature` is NOT mocked: the settings registration runs
 *   the real cryptographic recovery and posting-key match against a signature
 *   produced by `signRequestBound`. Only the chain key lookup is stubbed, the
 *   same approach as the other real-signature route suites.
 *
 *   (c) Real-path companion: `backend/tests/routes/recover.test.ts` [smtp-fail-test.invalid]
 *       Real-path companion: `backend/tests/routes/settings.test.ts` [smtp_send_failed]
 *   The first sets `config.smtpHost` and drives the resend route into its
 *   sendMail branch through the real SMTP helper module, with
 *   `nodemailer.createTransport` spied to return a transport whose sendMail
 *   rejects; the second runs the settings add flow through the real SMTP
 *   helper to its send-failure rollback. Postgres, Redis, argon2 and the
 *   routes under test run real here.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { PrivateKey } from '@hiveio/dhive';

const TEST_PRIVATE_KEY = PrivateKey.fromSeed('pevo-auth-state-g-rows-test-seed-deterministic');
const TEST_PUBLIC_KEY = TEST_PRIVATE_KEY.createPublic().toString();
const RUN_ID = Date.now();
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
// Every username this file signs for starts with this prefix, so the stubbed
// key lookup can publish TEST_PUBLIC_KEY for exactly those accounts.
const G_USER_PREFIX = `stg${SUFFIX}`;

vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: {
      getAccounts: vi.fn().mockImplementation((names: string[]) => {
        const name = names[0];
        if (typeof name === 'string' && name.startsWith(G_USER_PREFIX)) {
          return Promise.resolve([
            { name, posting: { key_auths: [[TEST_PUBLIC_KEY, 1]] } },
          ]);
        }
        return Promise.resolve([]);
      }),
    },
  },
}));

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
const { getRedis, isRedisAvailable } = await import('../../src/redis.js');
const { orcidVerified } = await import('../../src/routes/orcid.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');
const { signRequestBound } = await import('../support/sign-request.js');
const { TIMING_ORACLE_FLOOR_MS } = await import('../support/timing-constants.js');

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

const ORCID_BAND = `0000-0008-${(RUN_ID % 10000).toString().padStart(4, '0')}`;
const RESEND_UNIFORM_MESSAGE = 'If that email has a pending signup, a new verification link has been sent.';
const NO_PASSWORD_SET_MESSAGE =
  'This account has no password. Use another sign-in method, such as ORCID or Hive Keychain.';

const createdUsernames = new Set<string>();
const createdEmails = new Set<string>();

let seq = 0;

interface Identity {
  username: string;
  email: string;
  orcid: string;
}

// A username, email and ORCID no earlier call (and no earlier attempt of a
// retried spec) has used. Every value is tracked for the afterAll cleanup.
function fresh(tag: string, domain = 'example.com'): Identity {
  seq += 1;
  const username = `${G_USER_PREFIX}${tag}${seq.toString(36)}`;
  const email = `state_g_${RUN_ID}_${tag}_${seq}@${domain}`;
  createdUsernames.add(username);
  createdEmails.add(email);
  return { username, email, orcid: `${ORCID_BAND}-${seq.toString().padStart(4, '0')}` };
}

function hexToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

type AccountRow = Record<string, unknown>;

async function rowByEmail(email: string): Promise<AccountRow | undefined> {
  const { rows } = await getAppPool()!.query<AccountRow>('SELECT * FROM accounts WHERE email = $1', [email]);
  return rows[0];
}

async function rowByUsername(username: string): Promise<AccountRow | undefined> {
  const { rows } = await getAppPool()!.query<AccountRow>('SELECT * FROM accounts WHERE username = $1', [username]);
  return rows[0];
}

// Create a state G row the way production does: the add flow of
// POST /api/settings/email on the Keychain (request-bound signature) path, for
// a username that has no accounts row yet.
async function registerEmailViaSettings(username: string, email: string): Promise<AccountRow> {
  await clearRateLimitKeys(['settings-write']);
  const body = { email };
  const timestamp = new Date().toISOString();
  const signature = signRequestBound(TEST_PRIVATE_KEY, 'POST', '/api/settings/email', body, timestamp);
  const res = await request(app)
    .post('/api/settings/email')
    .set('X-Hive-Username', username)
    .set('X-Hive-Signature', signature)
    .set('X-Hive-Timestamp', timestamp)
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const row = await rowByEmail(email);
  expect(row, 'settings add flow should have created the row').toBeDefined();
  // The section 6.1 state G shape while the email is unverified.
  expect(row!.username).toBe(username);
  expect(row!.verify_token).toMatch(/^[0-9a-f]{64}$/);
  expect(row!.custody).toBeNull();
  expect(row!.upgraded_at).toBeNull();
  expect(row!.password_hash).toBeNull();
  expect(row!.orcid).toBeNull();
  return row!;
}

// Give a registered G row the password (and the ORCID set-password requires
// first) of a legacy row that acquired both while its email was unverified.
async function addLegacyFactors(username: string, password: string, orcid: string): Promise<void> {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await getAppPool()!.query(
    'UPDATE accounts SET password_hash = $1, orcid = $2 WHERE username = $3',
    [passwordHash, orcid, username],
  );
}

// A verified-ORCID nonce as the ORCID callback stores it: Redis first when it
// is up, which is the store /signup reads first, and the in-memory map too.
async function seedOrcidNonce(orcid: string): Promise<string> {
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = { orcid_id: orcid, works_count: 5, name: 'Orcid Holder' };
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(`${config.appTag}:orcid_verified:${nonce}`, JSON.stringify(payload), 'EX', 600);
  }
  orcidVerified.set(nonce, { ...payload, expires: Date.now() + 10 * 60_000 });
  return nonce;
}

async function cleanupAll(): Promise<void> {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  for (const u of createdUsernames) {
    await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [u]).catch(() => {});
    await pool.query('DELETE FROM notification_preferences WHERE username = $1', [u]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username = $1', [u]).catch(() => {});
  }
  for (const e of createdEmails) {
    await pool.query('DELETE FROM accounts WHERE email = $1', [e]).catch(() => {});
  }
}

afterAll(async () => {
  await cleanupAll();
});

describe.skipIf(!dbReachable)('POST /api/auth/login on a state G row', () => {
  beforeEach(async () => {
    await clearRateLimitKeys(['auth-login']);
  });

  it('logs in a G row with a password and an unverified email (200 + JWT, self custody claim)', async () => {
    const g = fresh('l1');
    const password = 'StateGLogin1';
    await registerEmailViaSettings(g.username, g.email);
    await addLegacyFactors(g.username, password, g.orcid);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email_or_username: g.username, password });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.username).toBe(g.username);
    // custody NULL on a finalized row derives to the claim that grants
    // nothing server-side.
    expect(res.body.data.custody).toBe('self');
    const claims = jwt.verify(res.body.data.token, config.sessionSecret) as { sub: string; custody: string };
    expect(claims.sub).toBe(g.username);
    expect(claims.custody).toBe('self');
  });

  it('logs in an expired unverified G row and does not delete it', async () => {
    const g = fresh('l2');
    const password = 'StateGLogin2';
    const registered = await registerEmailViaSettings(g.username, g.email);
    await addLegacyFactors(g.username, password, g.orcid);
    await getAppPool()!.query(
      `UPDATE accounts SET expires_at = NOW() - INTERVAL '1 hour' WHERE username = $1`,
      [g.username],
    );

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email_or_username: g.email, password });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.username).toBe(g.username);
    const after = await rowByEmail(g.email);
    expect(after, 'login must never delete a G row').toBeDefined();
    expect(after!.id).toBe(registered.id);
    expect(after!.verify_token).toBe(registered.verify_token);
  });

  it('keeps PENDING_UNVERIFIED and the SIGNUP_EXPIRED delete for signup row E', async () => {
    const pool = getAppPool()!;
    const password = 'StateESignup1';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const pendingEmail = fresh('ep').email;
    const expiredEmail = fresh('ex').email;
    await pool.query(
      `INSERT INTO accounts (email, password_hash, full_name, institution, field, verify_token, expires_at)
       VALUES ($1, $2, 'State E', 'MIT', 'physics', $3, NOW() + INTERVAL '1 hour')`,
      [pendingEmail, passwordHash, hexToken()],
    );
    await pool.query(
      `INSERT INTO accounts (email, password_hash, full_name, institution, field, verify_token, expires_at)
       VALUES ($1, $2, 'State E', 'MIT', 'physics', $3, NOW() - INTERVAL '1 hour')`,
      [expiredEmail, passwordHash, hexToken()],
    );

    const pending = await request(app)
      .post('/api/auth/login')
      .send({ email_or_username: pendingEmail, password });
    expect(pending.status).toBe(409);
    expect(pending.body.error.code).toBe('PENDING_UNVERIFIED');

    const expired = await request(app)
      .post('/api/auth/login')
      .send({ email_or_username: expiredEmail, password });
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe('SIGNUP_EXPIRED');
    expect(await rowByEmail(expiredEmail)).toBeUndefined();
    expect(await rowByEmail(pendingEmail)).toBeDefined();
  });

  it('answers a passwordless G row and a pending ORCID-path signup row F with the same NO_PASSWORD_SET message', async () => {
    const g = fresh('l3');
    await registerEmailViaSettings(g.username, g.email);
    // An ORCID-path signup row F: `confirmed:` token, ORCID set, no password,
    // no username. The null-hash check runs before the pending-signup checks,
    // so this row reaches the same branch.
    const f = fresh('lf');
    await getAppPool()!.query(
      `INSERT INTO accounts (email, password_hash, full_name, institution, field, orcid, verify_token, expires_at)
       VALUES ($1, NULL, 'State F', 'MIT', 'physics', $2, $3, NOW() + INTERVAL '1 hour')`,
      [f.email, f.orcid, `confirmed:${hexToken()}`],
    );

    const gRes = await request(app)
      .post('/api/auth/login')
      .send({ email_or_username: g.username, password: 'AnythingValid1' });
    const fRes = await request(app)
      .post('/api/auth/login')
      .send({ email_or_username: f.email, password: 'AnythingValid1' });

    for (const res of [gRes, fRes]) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error.code).toBe('NO_PASSWORD_SET');
      expect(res.body.error.message).toBe(NO_PASSWORD_SET_MESSAGE);
    }
  });
});

describe.skipIf(!dbReachable)('POST /api/auth/resend-verification on a state G row', () => {
  beforeEach(async () => {
    await clearRateLimitKeys(['auth-resend']);
  });

  it('treats a G row as not pending: uniform message, no token rewrite, no mail, argon2 verify paid', async () => {
    const g = fresh('r1');
    const password = 'StateGResend1';
    await registerEmailViaSettings(g.username, g.email);
    await addLegacyFactors(g.username, password, g.orcid);
    const before = await rowByEmail(g.email);
    smtpMock.sendMail.mockClear();

    // Warm the argon2 path so the measured call is steady-state cost.
    await request(app).post('/api/auth/resend-verification').send({ email: g.email, password });
    await clearRateLimitKeys(['auth-resend']);

    const start = Date.now();
    const res = await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: g.email, password });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe(RESEND_UNIFORM_MESSAGE);
    expect(elapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
    const after = await rowByEmail(g.email);
    expect(after!.verify_token).toBe(before!.verify_token);
    expect(after!.expires_at).toEqual(before!.expires_at);
    expect(smtpMock.sendMail).not.toHaveBeenCalled();
  });

  it('still re-issues a pending signup row E (control: the spy sees a resend)', async () => {
    const password = 'StateEResend1';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const email = fresh('re').email;
    const oldToken = hexToken();
    await getAppPool()!.query(
      `INSERT INTO accounts (email, password_hash, full_name, institution, field, verify_token, expires_at)
       VALUES ($1, $2, 'State E', 'MIT', 'physics', $3, NOW() + INTERVAL '1 hour')`,
      [email, passwordHash, oldToken],
    );
    smtpMock.sendMail.mockClear();

    const res = await request(app)
      .post('/api/auth/resend-verification')
      .send({ email, password });

    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe(RESEND_UNIFORM_MESSAGE);
    const after = await rowByEmail(email);
    expect(after!.verify_token).not.toBe(oldToken);
    expect(smtpMock.sendMail).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!dbReachable)('POST /api/auth/signup for an email an unverified G row holds', () => {
  beforeEach(async () => {
    await clearRateLimitKeys(['auth-signup']);
  });

  function signupBody(email: string): Record<string, string> {
    return {
      email,
      password: 'NewOwner1Password',
      full_name: 'Not The Owner',
      institution: 'MIT',
      field: 'physics',
    };
  }

  it('evicts a factor-less G row and writes the signup row E for that address', async () => {
    // An institutional domain, so the signup clears the accreditation gate.
    const g = fresh('s1', 'mit.edu');
    const registered = await registerEmailViaSettings(g.username, g.email);
    smtpMock.sendMail.mockClear();

    const res = await request(app).post('/api/auth/signup').send(signupBody(g.email));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await rowByUsername(g.username), 'the G row should be gone').toBeUndefined();
    const after = await rowByEmail(g.email);
    expect(after, 'the signup should have written its own row').toBeDefined();
    expect(after!.id).not.toBe(registered.id);
    expect(after!.username).toBeNull();
    expect(after!.custody).toBeNull();
    expect(after!.verify_token).toMatch(/^[0-9a-f]{64}$/);
    expect(after!.verify_token).not.toBe(registered.verify_token);
    expect(after!.password_hash).not.toBeNull();
    expect(smtpMock.sendMail).toHaveBeenCalledTimes(1);
    expect(smtpMock.sendMail.mock.calls[0][0]).toMatchObject({ to: g.email });
  });

  it('answers 409 DUPLICATE for a G row carrying a factor, pays the argon2.hash burn, and leaves the row unchanged', async () => {
    const g = fresh('s2', 'mit.edu');
    await registerEmailViaSettings(g.username, g.email);
    await addLegacyFactors(g.username, 'LegacyOwner1', g.orcid);
    const before = await rowByEmail(g.email);
    smtpMock.sendMail.mockClear();

    // Warm the argon2 path so the measured call is steady-state cost.
    await request(app).post('/api/auth/signup').send(signupBody(g.email));
    await clearRateLimitKeys(['auth-signup']);

    const start = Date.now();
    const res = await request(app).post('/api/auth/signup').send(signupBody(g.email));
    const elapsed = Date.now() - start;

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE');
    expect(elapsed).toBeGreaterThanOrEqual(TIMING_ORACLE_FLOOR_MS);
    expect(await rowByEmail(g.email)).toEqual(before);
    expect(smtpMock.sendMail).not.toHaveBeenCalled();
  });

  it('keeps a factor-less G row when the signup fails the accreditation gate (422)', async () => {
    // A non-institutional domain and no ORCID, so the signup cannot proceed.
    const g = fresh('s3', 'gmail.com');
    const registered = await registerEmailViaSettings(g.username, g.email);
    smtpMock.sendMail.mockClear();

    const res = await request(app).post('/api/auth/signup').send(signupBody(g.email));

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await rowByEmail(g.email)).toEqual(registered);
    expect(smtpMock.sendMail).not.toHaveBeenCalled();
  });

  it('keeps a factor-less G row when the signup row is never written (its ORCID is already linked elsewhere)', async () => {
    const g = fresh('s4');
    const registered = await registerEmailViaSettings(g.username, g.email);
    // A state C row already holding the ORCID the signup presents, so the
    // signup's own insert trips the ORCID unique index after the eviction.
    const holder = fresh('s4h');
    await getAppPool()!.query(
      `INSERT INTO accounts (email, username, password_hash, full_name, institution, field, orcid, custody, verify_token)
       VALUES ($1, $2, NULL, 'Orcid Holder', 'MIT', 'physics', $3, 'light', NULL)`,
      [holder.email, holder.username, holder.orcid],
    );
    const nonce = await seedOrcidNonce(holder.orcid);

    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: g.email, orcid_token: nonce, full_name: 'Not The Owner' });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('ORCID_ALREADY_LINKED');
    expect(await rowByEmail(g.email)).toEqual(registered);
  });

  it('evicts a factor-less G row on the ORCID path and writes the signup row F for that address', async () => {
    const g = fresh('s5');
    const registered = await registerEmailViaSettings(g.username, g.email);
    // An ORCID no row holds, so the signup's own row can be written.
    const nonce = await seedOrcidNonce(g.orcid);

    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: g.email, orcid_token: nonce, full_name: 'Not The Owner' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.flow).toBe('choose');
    expect(await rowByUsername(g.username), 'the G row should be gone').toBeUndefined();
    const after = await rowByEmail(g.email);
    expect(after, 'the signup should have written its own row').toBeDefined();
    expect(after!.id).not.toBe(registered.id);
    expect(after!.username).toBeNull();
    expect(after!.orcid).toBe(g.orcid);
    expect(String(after!.verify_token)).toMatch(/^confirmed:/);
  });

  it('leaves a G row that appears after the duplicate pre-check untouched and answers 409 DUPLICATE', async () => {
    // The pre-check finds no row for this address, and a G row is written
    // before the signup's upsert runs: the window the argon2.hash between the
    // two opens. Wrapping the app pool's query method is the only way to put
    // that write in the window deterministically; every statement, the
    // inserted G row included, still runs against the real database.
    const g = fresh('s6', 'mit.edu');
    const gToken = hexToken();
    const pool = getAppPool()!;
    const originalQuery = pool.query.bind(pool) as (...args: any[]) => Promise<any>;
    let inserted = false;
    const spy = vi.spyOn(pool, 'query').mockImplementation((async (...args: any[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : '';
      if (!inserted && sql.includes('ON CONFLICT (email) DO UPDATE')) {
        inserted = true;
        await originalQuery(
          'INSERT INTO accounts (email, username, verify_token, expires_at) VALUES ($1, $2, $3, $4)',
          [g.email, g.username, gToken, new Date(Date.now() + 24 * 60 * 60 * 1000)],
        );
      }
      return originalQuery(...args);
    }) as any);
    smtpMock.sendMail.mockClear();

    let res;
    try {
      res = await request(app).post('/api/auth/signup').send(signupBody(g.email));
    } finally {
      spy.mockRestore();
    }

    expect(inserted, 'the signup should have reached its upsert').toBe(true);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE');
    const after = await rowByUsername(g.username);
    expect(after, 'the G row should still exist').toBeDefined();
    expect(after!.password_hash).toBeNull();
    expect(after!.orcid).toBeNull();
    expect(after!.verify_token).toBe(gToken);
    expect(smtpMock.sendMail).not.toHaveBeenCalled();
  });
});

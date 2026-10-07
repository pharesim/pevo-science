/**
 * Writes that move a row's email or drop its password clear its password reset
 * token.
 *
 * `POST /api/auth/reset` finds its row by the token alone. So every statement
 * that moves a row's `email` or sets its `password_hash` to NULL also clears
 * `reset_token` and `reset_token_expires_at`; otherwise a token mailed to the
 * old address, or one issued before the password was dropped and a new one
 * set, would still rotate the password. Each spec issues a token, runs a
 * writer through its route, and then presents the token: it gets the answer
 * an unknown token gets and does not change the password.
 *
 * Writers covered, by route: ORCID recovery with and without a new password,
 * the seed-phrase recovery's apply step, the change-email confirmation swap,
 * the settings re-issue for an unverified state G row and that re-issue's
 * restore when its mail fails, and both signup upserts over a pending row E.
 * `POST /api/auth/reset-request` writes its token only while the row still
 * matches its lookup, so a recovery that commits between the two leaves no
 * token either.
 *
 * Tokens are issued by `POST /api/auth/reset-request` where it serves the row.
 * It does not serve an unverified state G row, so for those the token is
 * written directly.
 *
 * Mocks (per root CLAUDE.md "Carve-out for deterministic edge-case coverage"):
 *
 *   (a) Justification. `hiveClient.database.getAccounts` is stubbed to publish
 *   a deterministic posting key for this file's usernames, so the settings
 *   route runs on the Keychain signature path: running it live would couple
 *   the specs to a real on-chain account's keys. The SMTP transporter is
 *   mocked (and `config.smtpHost` given a value when the project `.env`
 *   leaves it empty) to capture the mailed links and to fail one send
 *   deterministically. The verified ORCID nonce and the ORCID set-password
 *   proof are written directly, because the OAuth round trips that mint them
 *   need the remote ORCID provider. One spec wraps the app pool's `query` to
 *   run an ORCID recovery immediately before the reset-request's token
 *   write: a write inside the window between that route's lookup and its
 *   token write cannot be placed deterministically any other way. The
 *   wrapper changes no result; every statement still runs against the real
 *   database.
 *
 *   (b) `verifyHiveSignature` is NOT mocked: the settings route runs the real
 *   signature recovery against `signRequestBound` signatures, and the
 *   set-password route the real JWT path.
 *
 *   (c) Real-path companion: `backend/tests/routes/recover.test.ts` [smtp-fail-test.invalid]
 *   It drives the reset-request route into its sendMail branch through the
 *   real SMTP helper module, with only `nodemailer.createTransport` spied.
 *   Postgres, Redis, argon2 and every route under test run real here.
 *
 * Every spec draws a fresh username, email and ORCID from `fresh()`, because
 * vitest re-runs a failed `it` body in place and an earlier attempt's row
 * would otherwise still hold them.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import argon2 from 'argon2';
import { PrivateKey } from '@hiveio/dhive';

const TEST_PRIVATE_KEY = PrivateKey.fromSeed('pevo-reset-token-account-writes-test-seed');
const TEST_PUBLIC_KEY = TEST_PRIVATE_KEY.createPublic().toString();
const RUN_ID = Date.now();
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
// Every username this file signs for starts with this prefix, so the stubbed
// key lookup can publish TEST_PUBLIC_KEY for exactly those accounts.
const USER_PREFIX = `rtw${SUFFIX}`;

vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: {
      getAccounts: vi.fn().mockImplementation((names: string[]) => {
        const name = names[0];
        if (typeof name === 'string' && name.startsWith(USER_PREFIX)) {
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
const { encryptKey } = await import('../../src/custody-crypto.js');
const { getRedis, isRedisAvailable } = await import('../../src/redis.js');
const { orcidVerified } = await import('../../src/routes/orcid.js');
const { issueFreshAuthToken, setPasswordFreshAuthTarget } = await import('../../src/lib/fresh-auth.js');
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

const hasCustodyKey = !!process.env.CUSTODY_ENCRYPTION_KEY && process.env.CUSTODY_ENCRYPTION_KEY.length >= 32;

const ORCID_BAND = `0000-0011-${(RUN_ID % 10000).toString().padStart(4, '0')}`;
const OLD_PASSWORD = 'OldWriterPass123';
const WRITER_PASSWORD = 'WriterSetPass456';
const RESET_PASSWORD = 'ResetAttempt789';
const MEMO_KEY = '5JexampleMemoKeyForResetTokenAccountWrites12345678';

const createdUsernames = new Set<string>();
const createdEmails = new Set<string>();
const nonces: string[] = [];
let seq = 0;

interface Identity {
  username: string;
  email: string;
  newEmail: string;
  orcid: string;
}

function fresh(domain = 'example.com'): Identity {
  seq += 1;
  const username = `${USER_PREFIX}${seq.toString(36)}`;
  const email = `rtw_${RUN_ID}_${seq}@${domain}`;
  const newEmail = `rtw_new_${RUN_ID}_${seq}@example.com`;
  createdUsernames.add(username);
  createdEmails.add(email);
  createdEmails.add(newEmail);
  return { username, email, newEmail, orcid: `${ORCID_BAND}-${seq.toString().padStart(4, '0')}` };
}

function hexToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

interface AccountRow {
  email: string | null;
  username: string | null;
  password_hash: string | null;
  verify_token: string | null;
  reset_token: string | null;
  reset_token_expires_at: Date | null;
}

async function rowByEmail(email: string): Promise<AccountRow> {
  const { rows } = await getAppPool()!.query<AccountRow>(
    'SELECT email, username, password_hash, verify_token, reset_token, reset_token_expires_at FROM accounts WHERE email = $1',
    [email],
  );
  expect(rows, `row for ${email}`).toHaveLength(1);
  return rows[0];
}

async function hashOf(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

// A light row with a password and an encrypted memo key: state A without an
// ORCID, state B with one (ARCHITECTURE.md section 6.1).
async function seedLight(id: Identity, withOrcid: boolean): Promise<void> {
  const memoEnc = encryptKey(id.username, MEMO_KEY);
  await getAppPool()!.query(
    `INSERT INTO accounts (email, username, password_hash, orcid, custody, memo_key_enc, iv_memo, verify_token)
     VALUES ($1, $2, $3, $4, 'light', $5, $6, NULL)`,
    [id.email, id.username, await hashOf(OLD_PASSWORD), withOrcid ? id.orcid : null, memoEnc.ciphertext, memoEnc.iv],
  );
}

// A state G row whose settings-registered email is unverified, in the legacy
// shape that acquired a password, holding `resetToken`.
async function seedUnverifiedG(id: Identity, verifyToken: string, resetToken: string): Promise<void> {
  await getAppPool()!.query(
    `INSERT INTO accounts (email, username, password_hash, verify_token, expires_at, reset_token, reset_token_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id.email, id.username, await hashOf(OLD_PASSWORD), verifyToken,
      new Date(Date.now() + 3_600_000), resetToken, new Date(Date.now() + 3_600_000),
    ],
  );
}

// A pending signup row E: a password, a hex verify_token, no username.
async function seedSignupE(id: Identity): Promise<void> {
  await getAppPool()!.query(
    `INSERT INTO accounts (email, password_hash, verify_token, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [id.email, await hashOf(OLD_PASSWORD), hexToken(), new Date(Date.now() + 3_600_000)],
  );
}

async function seedOrcidNonce(orcidId: string): Promise<string> {
  const nonce = `rtw-nonce-${RUN_ID}-${nonces.length}`;
  const payload = { orcid_id: orcidId, works_count: 5, name: 't' };
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(`${config.appTag}:orcid_verified:${nonce}`, JSON.stringify(payload), 'EX', 600);
  }
  orcidVerified.set(nonce, { ...payload, expires: Date.now() + 600_000 });
  nonces.push(nonce);
  return nonce;
}

function mailedTo(to: string, pattern: RegExp): string {
  for (const call of smtpMock.sendMail.mock.calls) {
    const [mail] = call as [{ to?: string; text?: string }];
    if (mail?.to === to) {
      const match = pattern.exec(mail.text ?? '');
      if (match) return match[1];
    }
  }
  throw new Error(`no mail to ${to} matching ${pattern}`);
}

const SETTINGS_LINK = /\/settings\/verify-email\/([0-9a-f]+)/;

async function issueResetToken(email: string): Promise<string> {
  await clearRateLimitKeys(['auth-reset-request']);
  const res = await request(app).post('/api/auth/reset-request').send({ email });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const row = await rowByEmail(email);
  expect(row.reset_token).toMatch(/^[0-9a-f]{64}$/);
  return row.reset_token!;
}

// `POST /api/settings/email` on the Keychain signature path.
async function signedEmailPost(username: string, email: string): Promise<request.Response> {
  await clearRateLimitKeys(['settings-write']);
  const body = { email };
  const timestamp = new Date().toISOString();
  const signature = signRequestBound(TEST_PRIVATE_KEY, 'POST', '/api/settings/email', body, timestamp);
  return request(app)
    .post('/api/settings/email')
    .set('X-Hive-Username', username)
    .set('X-Hive-Signature', signature)
    .set('X-Hive-Timestamp', timestamp)
    .send(body);
}

async function followSettingsLink(token: string): Promise<void> {
  await clearRateLimitKeys(['settings-read']);
  const res = await request(app).get(`/api/settings/email/verify/${token}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

// The writer cleared the token: the row holds none, `POST /api/auth/reset`
// answers it as an unknown token, and the password is still `password`
// (NULL for none).
async function expectTokenDead(email: string, token: string, password: string | null): Promise<void> {
  const row = await rowByEmail(email);
  expect(row.reset_token).toBeNull();
  expect(row.reset_token_expires_at).toBeNull();

  await clearRateLimitKeys(['auth-reset']);
  const unknown = await request(app).post('/api/auth/reset').send({ token: hexToken(), password: RESET_PASSWORD });
  const res = await request(app).post('/api/auth/reset').send({ token, password: RESET_PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(400);
  expect(res.body).toEqual(unknown.body);

  const after = await rowByEmail(email);
  if (password === null) {
    expect(after.password_hash).toBeNull();
  } else {
    expect(await argon2.verify(after.password_hash!, password)).toBe(true);
  }
}

afterAll(async () => {
  for (const nonce of nonces) {
    orcidVerified.delete(nonce);
    const redis = getRedis();
    if (redis && isRedisAvailable()) await redis.del(`${config.appTag}:orcid_verified:${nonce}`).catch(() => {});
  }
  if (!dbReachable) return;
  const pool = getAppPool()!;
  const usernames = [...createdUsernames];
  await pool.query('DELETE FROM pending_recovery WHERE username = ANY($1)', [usernames]);
  await pool.query('DELETE FROM custody_audit_log WHERE username = ANY($1)', [usernames]);
  await pool.query('DELETE FROM accounts WHERE username = ANY($1) OR email = ANY($2)', [usernames, [...createdEmails]]);
});

describe('a reset token does not outlive a write that moves its email or drops its password', () => {
  it.skipIf(!dbReachable || !hasCustodyKey)('ORCID recovery with a new password', async () => {
    const id = fresh();
    await seedLight(id, true);
    const token = await issueResetToken(id.email);

    await clearRateLimitKeys(['auth-recover']);
    const nonce = await seedOrcidNonce(id.orcid);
    const res = await request(app)
      .post('/api/auth/recover')
      .send({ username: id.username, new_email: id.newEmail, new_password: WRITER_PASSWORD, orcid_token: nonce });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    await expectTokenDead(id.newEmail, token, WRITER_PASSWORD);
  });

  it.skipIf(!dbReachable || !hasCustodyKey)('ORCID recovery without a password, then a password set in settings', async () => {
    const id = fresh();
    await seedLight(id, true);
    const token = await issueResetToken(id.email);

    await clearRateLimitKeys(['auth-recover']);
    const nonce = await seedOrcidNonce(id.orcid);
    const recovered = await request(app)
      .post('/api/auth/recover')
      .send({ username: id.username, new_email: id.newEmail, orcid_token: nonce });
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect((await rowByEmail(id.newEmail)).password_hash).toBeNull();

    // The password comes back through the real set-password route, so the
    // row has a password again when the token is presented.
    await clearRateLimitKeys(['settings-write']);
    const proof = await issueFreshAuthToken(id.username, 'orcid', setPasswordFreshAuthTarget(id.username));
    const set = await request(app)
      .post('/api/settings/set-password')
      .set('Authorization', `Bearer ${recovered.body.data.token}`)
      .send({ password: WRITER_PASSWORD, fresh_auth_proof: proof.token });
    expect(set.status, JSON.stringify(set.body)).toBe(200);

    await expectTokenDead(id.newEmail, token, WRITER_PASSWORD);
  });

  it.skipIf(!dbReachable || !hasCustodyKey)('seed-phrase recovery', async () => {
    const id = fresh();
    await seedLight(id, false);
    const token = await issueResetToken(id.email);

    await clearRateLimitKeys(['auth-recover']);
    const staged = await request(app)
      .post('/api/auth/recover')
      .send({ username: id.username, new_email: id.newEmail, new_password: WRITER_PASSWORD, memo_key: MEMO_KEY });
    expect(staged.status, JSON.stringify(staged.body)).toBe(200);
    const verifyToken = mailedTo(id.newEmail, /\/recover\/verify\?token=([0-9a-f]+)/);
    const applied = await request(app).post('/api/auth/recover/verify').send({ token: verifyToken });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);

    await expectTokenDead(id.newEmail, token, WRITER_PASSWORD);
  });

  it.skipIf(!dbReachable || !hasCustodyKey)('change-email confirmation', async () => {
    const id = fresh();
    await seedLight(id, false);
    const token = await issueResetToken(id.email);

    const queued = await signedEmailPost(id.username, id.newEmail);
    expect(queued.status, JSON.stringify(queued.body)).toBe(200);
    await followSettingsLink(mailedTo(id.newEmail, SETTINGS_LINK));

    await expectTokenDead(id.newEmail, token, OLD_PASSWORD);
  });

  it.skipIf(!dbReachable)('settings re-issue for an unverified state G row, then the new address verified', async () => {
    const id = fresh();
    const token = hexToken();
    await seedUnverifiedG(id, hexToken(), token);

    const reissued = await signedEmailPost(id.username, id.newEmail);
    expect(reissued.status, JSON.stringify(reissued.body)).toBe(200);
    // Verifying the address makes the row one reset serves, so a token the
    // re-issue left in place would rotate the password here.
    await followSettingsLink(mailedTo(id.newEmail, SETTINGS_LINK));

    await expectTokenDead(id.newEmail, token, OLD_PASSWORD);
  });

  it.skipIf(!dbReachable)('settings re-issue whose mail fails, restoring the earlier address, then that address verified', async () => {
    const id = fresh();
    const priorVerifyToken = hexToken();
    await seedUnverifiedG(id, priorVerifyToken, hexToken());

    // Write a token while the re-issued mail is in flight; the restore that
    // follows writes the earlier address back.
    const token = hexToken();
    smtpMock.sendMail.mockImplementationOnce(async () => {
      await getAppPool()!.query(
        'UPDATE accounts SET reset_token = $1, reset_token_expires_at = $2 WHERE username = $3',
        [token, new Date(Date.now() + 3_600_000), id.username],
      );
      throw new Error('smtp down');
    });
    const reissued = await signedEmailPost(id.username, id.newEmail);
    expect(reissued.status, JSON.stringify(reissued.body)).toBe(200);
    expect((await rowByEmail(id.email)).verify_token).toBe(priorVerifyToken);

    await followSettingsLink(priorVerifyToken);

    await expectTokenDead(id.email, token, OLD_PASSWORD);
  });

  it.skipIf(!dbReachable)('ORCID signup without a password over a pending row E', async () => {
    const id = fresh();
    await seedSignupE(id);
    const token = await issueResetToken(id.email);

    await clearRateLimitKeys(['auth-signup']);
    const nonce = await seedOrcidNonce(id.orcid);
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: id.email, orcid_token: nonce, full_name: 'Signup Retry' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    await expectTokenDead(id.email, token, null);
  });

  it.skipIf(!dbReachable)('email signup over a pending row E', async () => {
    const id = fresh('mit.edu');
    await seedSignupE(id);
    const token = await issueResetToken(id.email);

    await clearRateLimitKeys(['auth-signup']);
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: id.email, password: WRITER_PASSWORD, full_name: 'Signup Retry', institution: 'MIT', field: 'physics' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    await expectTokenDead(id.email, token, WRITER_PASSWORD);
  });

  it.skipIf(!dbReachable || !hasCustodyKey)('ORCID recovery committing between reset-request\'s lookup and its token write', async () => {
    const id = fresh();
    await seedLight(id, true);
    const nonce = await seedOrcidNonce(id.orcid);

    const pool = getAppPool()!;
    const originalQuery = pool.query.bind(pool) as (...args: any[]) => Promise<any>;
    let recovered: request.Response | undefined;
    const spy = vi.spyOn(pool, 'query').mockImplementation((async (...args: any[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : '';
      if (!recovered && sql.includes('SET reset_token = $1')) {
        await clearRateLimitKeys(['auth-recover']);
        recovered = await request(app)
          .post('/api/auth/recover')
          .send({ username: id.username, new_email: id.newEmail, new_password: WRITER_PASSWORD, orcid_token: nonce });
      }
      return originalQuery(...args);
    }) as any);
    await clearRateLimitKeys(['auth-reset-request']);
    let requested: request.Response;
    try {
      requested = await request(app).post('/api/auth/reset-request').send({ email: id.email });
    } finally {
      spy.mockRestore();
    }

    expect(recovered, 'the recovery should have run inside the reset-request').toBeDefined();
    expect(recovered!.status, JSON.stringify(recovered!.body)).toBe(200);
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);
    const mailed = mailedTo(id.email, /[?&]token=([0-9a-f]{64})/);

    await expectTokenDead(id.newEmail, mailed, WRITER_PASSWORD);
  });
});

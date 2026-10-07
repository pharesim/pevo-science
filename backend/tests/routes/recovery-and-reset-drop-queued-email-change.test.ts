/**
 * Recovery and password reset drop a queued email change.
 *
 * Someone who holds only an account's password can queue an email change: log
 * in, take a `change_email` fresh-auth proof with the password, and post an
 * address of their own to `POST /api/settings/email`, which mails the
 * confirmation link to that address alone. The owner evicts them by ORCID
 * recovery, seed-phrase recovery or password reset. Each eviction clears the
 * queued change, so the link answers as an unknown token does and the row
 * keeps the email the eviction left it with.
 *
 * The queuing side runs through the real routes: `POST /api/auth/login`,
 * `POST /api/custody/fresh-auth` and `POST /api/settings/email` on the real
 * `verifyHiveSignature` JWT path. The evictions run through their real routes
 * too.
 *
 * Mocks (per root CLAUDE.md "Carve-out for deterministic edge-case coverage"):
 *
 *   (a) Justification. `POST /api/settings/email` restores the row when its
 *   change mail fails to send, and the seed-phrase recovery stores only a
 *   digest of its verify token, which reaches the caller by mail alone. The
 *   SMTP transporter (`createSmtpTransporter`) is mocked so those mails
 *   resolve and can be read, and `config.smtpHost` is given a value when the
 *   project `.env` leaves it empty, so each route takes its mail-send branch.
 *   The verified ORCID nonce is written straight into Redis and the
 *   in-memory fallback, the shape `POST /api/orcid/callback` writes, because
 *   the OAuth round trip that mints it needs the remote ORCID provider. No
 *   auth middleware is mocked. Postgres, Redis, argon2, the memo-key decrypt
 *   and every route under test run real.
 *
 *   (c) Real-path companion: `backend/tests/routes/recover.test.ts` [smtp-fail-test.invalid]
 *   It drives the reset-request route into its sendMail branch through the
 *   real SMTP helper module, with only `nodemailer.createTransport` spied.
 *
 * Every spec draws a fresh username, email and ORCID from `fresh()`, because
 * vitest re-runs a failed `it` body in place and an earlier attempt's row
 * would otherwise still hold them.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import argon2 from 'argon2';

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

const hasCustodyKey = !!process.env.CUSTODY_ENCRYPTION_KEY && process.env.CUSTODY_ENCRYPTION_KEY.length >= 32;

const RUN_ID = Date.now();
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const ORCID_BAND = `0000-0010-${(RUN_ID % 10000).toString().padStart(4, '0')}`;
const PASSWORD = 'QueuedChange1Pass';
const OWNER_PASSWORD = 'OwnerTakesBack2Pass';
const MEMO_KEY = '5JexampleMemoKeyForQueuedEmailChangeEviction123456';

const createdUsernames = new Set<string>();
const nonces: string[] = [];
let seq = 0;

interface Identity {
  username: string;
  email: string;
  orcid: string;
  attackerEmail: string;
  ownerNewEmail: string;
}

function fresh(): Identity {
  seq += 1;
  const username = `qec${SUFFIX}${seq.toString(36)}`;
  createdUsernames.add(username);
  return {
    username,
    email: `qec_owner_${RUN_ID}_${seq}@example.com`,
    orcid: `${ORCID_BAND}-${seq.toString().padStart(4, '0')}`,
    attackerEmail: `qec_attacker_${RUN_ID}_${seq}@example.com`,
    ownerNewEmail: `qec_owner_new_${RUN_ID}_${seq}@example.com`,
  };
}

function hexToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

interface AccountRow {
  email: string | null;
  pending_email: string | null;
  pending_email_token: string | null;
  pending_email_expires_at: Date | null;
}

async function rowByUsername(username: string): Promise<AccountRow> {
  const { rows } = await getAppPool()!.query<AccountRow>(
    'SELECT email, pending_email, pending_email_token, pending_email_expires_at FROM accounts WHERE username = $1',
    [username],
  );
  expect(rows, `row for ${username}`).toHaveLength(1);
  return rows[0];
}

// A state B row (ARCHITECTURE.md section 6.1): light, with a password and an
// ORCID. It carries an encrypted memo key so the seed-phrase recovery can run.
let passwordHash: Promise<string> | undefined;

async function seedStateB(id: Identity): Promise<void> {
  passwordHash ??= argon2.hash(PASSWORD, { type: argon2.argon2id });
  const memoEnc = encryptKey(id.username, MEMO_KEY);
  await getAppPool()!.query(
    `INSERT INTO accounts (email, username, password_hash, orcid, custody, memo_key_enc, iv_memo, verify_token)
     VALUES ($1, $2, $3, $4, 'light', $5, $6, NULL)`,
    [id.email, id.username, await passwordHash, id.orcid, memoEnc.ciphertext, memoEnc.iv],
  );
}

async function seedOrcidNonce(orcidId: string): Promise<string> {
  const nonce = `qec-nonce-${RUN_ID}-${nonces.length}`;
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

// Queue a change to the attacker's address with nothing but the password, and
// return the token of the link mailed to that address.
async function queueChangeWithPassword(id: Identity): Promise<string> {
  await clearRateLimitKeys(['auth-login', 'custody-fresh-auth', 'settings-write']);
  const login = await request(app).post('/api/auth/login').send({ username: id.username, password: PASSWORD });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  const bearer = `Bearer ${login.body.data.token}`;

  const proof = await request(app)
    .post('/api/custody/fresh-auth')
    .set('Authorization', bearer)
    .send({ password: PASSWORD, action: 'change_email' });
  expect(proof.status, JSON.stringify(proof.body)).toBe(200);

  const queued = await request(app)
    .post('/api/settings/email')
    .set('Authorization', bearer)
    .send({ email: id.attackerEmail, fresh_auth_proof: proof.body.data.fresh_auth_proof });
  expect(queued.status, JSON.stringify(queued.body)).toBe(200);

  const linkToken = mailedTo(id.attackerEmail, /\/settings\/verify-email\/([0-9a-f]+)/);
  const row = await rowByUsername(id.username);
  expect(row.pending_email).toBe(id.attackerEmail);
  expect(row.pending_email_token).toBe(linkToken);
  expect(row.pending_email_expires_at).not.toBeNull();
  return linkToken;
}

// The queued link answers exactly as an unknown token does, and the row keeps
// `expectedEmail` with no change queued.
async function expectChangeDropped(id: Identity, linkToken: string, expectedEmail: string): Promise<void> {
  await clearRateLimitKeys(['settings-read']);
  const unknown = await request(app).get(`/api/settings/email/verify/${hexToken()}`);
  const stale = await request(app).get(`/api/settings/email/verify/${linkToken}`);
  expect(unknown.status).toBe(400);
  expect(stale.status, JSON.stringify(stale.body)).toBe(unknown.status);
  expect(stale.body).toEqual(unknown.body);

  const row = await rowByUsername(id.username);
  expect(row.email).toBe(expectedEmail);
  expect(row.pending_email).toBeNull();
  expect(row.pending_email_token).toBeNull();
  expect(row.pending_email_expires_at).toBeNull();
}

afterAll(async () => {
  for (const nonce of nonces) {
    orcidVerified.delete(nonce);
    const redis = getRedis();
    if (redis && isRedisAvailable()) await redis.del(`${config.appTag}:orcid_verified:${nonce}`).catch(() => {});
  }
  if (!dbReachable || createdUsernames.size === 0) return;
  const pool = getAppPool()!;
  const usernames = [...createdUsernames];
  await pool.query('DELETE FROM pending_recovery WHERE username = ANY($1)', [usernames]);
  await pool.query('DELETE FROM custody_audit_log WHERE username = ANY($1)', [usernames]);
  await pool.query('DELETE FROM accounts WHERE username = ANY($1)', [usernames]);
});

describe('an eviction drops an email change queued with the password alone', () => {
  it.skipIf(!dbReachable || !hasCustodyKey)('ORCID recovery', async () => {
    const id = fresh();
    await seedStateB(id);
    const linkToken = await queueChangeWithPassword(id);

    await clearRateLimitKeys(['auth-recover']);
    const nonce = await seedOrcidNonce(id.orcid);
    const recovered = await request(app)
      .post('/api/auth/recover')
      .send({ username: id.username, new_email: id.ownerNewEmail, new_password: OWNER_PASSWORD, orcid_token: nonce });
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);

    await expectChangeDropped(id, linkToken, id.ownerNewEmail);
  });

  it.skipIf(!dbReachable || !hasCustodyKey)('seed-phrase recovery', async () => {
    const id = fresh();
    await seedStateB(id);
    const linkToken = await queueChangeWithPassword(id);

    await clearRateLimitKeys(['auth-recover']);
    const staged = await request(app)
      .post('/api/auth/recover')
      .send({ username: id.username, new_email: id.ownerNewEmail, new_password: OWNER_PASSWORD, memo_key: MEMO_KEY });
    expect(staged.status, JSON.stringify(staged.body)).toBe(200);
    expect(staged.body.data.recovery).toBe('pending_verification');

    const verifyToken = mailedTo(id.ownerNewEmail, /\/recover\/verify\?token=([0-9a-f]+)/);
    const applied = await request(app).post('/api/auth/recover/verify').send({ token: verifyToken });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);

    await expectChangeDropped(id, linkToken, id.ownerNewEmail);
  });

  it.skipIf(!dbReachable || !hasCustodyKey)('password reset', async () => {
    const id = fresh();
    await seedStateB(id);
    const linkToken = await queueChangeWithPassword(id);

    await clearRateLimitKeys(['auth-reset-request', 'auth-reset']);
    const requested = await request(app).post('/api/auth/reset-request').send({ email: id.email });
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);
    const resetToken = mailedTo(id.email, /[?&]token=([0-9a-f]{64})/);
    const reset = await request(app).post('/api/auth/reset').send({ token: resetToken, password: OWNER_PASSWORD });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);

    await expectChangeDropped(id, linkToken, id.email);
  });
});

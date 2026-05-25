/**
 * Two-phase memo-key recovery: full phase-1 → phase-2 apply path, the
 * never-verified expiry path, the old-email dispute path, and the
 * upgraded-account ORCID-recovery severance.
 *
 * Threat closed (per ARCHITECTURE.md § 6.4 "Recover" + § 6.5): a seed-phrase
 * holder must not silently rebind `email` to an attacker-controlled mailbox.
 * Phase 1 stages the swap and mails a verify token to the NEW email; the swap
 * only applies once that token is presented (phase 2). The OLD email gets a
 * dispute link that voids the staged swap. ORCID recovery is severed once the
 * account upgrades to self-custody (state D) — the original ORCID link must
 * not recover an account no longer under platform custody.
 *
 * Mocks (per root CLAUDE.md "Carve-out for deterministic edge-case coverage"):
 *
 *   (a) Justification: the phase-1 verify/dispute tokens travel only inside
 *   the emailed link; this real-infra suite cannot read a live mailbox, so it
 *   mocks the SMTP transporter (`createSmtpTransporter`) to capture the URLs
 *   the route mails and extract the tokens. The mock is a third-party-library
 *   surface (nodemailer transporter) explicitly in the carve-out's mock-target
 *   scope. SMTP shape itself is covered by `lib/smtp.test.ts`. `config.smtpHost`
 *   is stubbed to a non-empty value so the route takes the mail-send branch
 *   rather than the SMTP-not-configured warn branch. No auth middleware is
 *   mocked — `/api/auth/recover*` is unauthenticated (the recovery factor IS
 *   the auth), so there is no `verifyHiveSignature` to bypass; the real route
 *   plumbing, real argon2, real Postgres, and the real memo-key decrypt path
 *   all run.
 *
 *   (c) Risk-class real-path companion: the cryptographic memo-key decrypt +
 *   constant-time compare path is exercised against real `decryptKey` and the
 *   real DB in `recover.test.ts` (phase-1 staging, wrong-memo-key 401,
 *   unknown-username timing). This suite reuses that same real path for
 *   phase 1; only the emailed-token capture is mocked.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';

// Capture the URLs the route mails. The two recovery mails carry distinct
// link paths (`/recover/verify?token=` and `/recover/dispute?token=`); the
// helper below pulls the token out of whichever was sent.
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
const { encryptKey } = await import('../../src/custody-crypto.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');
const { fetchSettledAuditRows } = await import('../support/audit-log-poll-settle.js');

const app = createApp();

const hasCustodyKey = !!process.env.CUSTODY_ENCRYPTION_KEY && process.env.CUSTODY_ENCRYPTION_KEY.length >= 32;

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
const USER = `recover2p_${RUN}`;
const OLD_EMAIL = `recover2p_old_${RUN}@example.com`;
const PASSWORD = 'OldPassword1';
const MEMO_KEY = '5JexampleMemoKeyForTwoPhaseRecoveryTest123456789';

/** Pull a token out of the mailed link by matching the route fragment. */
function tokenFromMail(linkFragment: string): string | null {
  for (const call of smtpMock.sendMail.mock.calls) {
    const text: string = call[0]?.text ?? '';
    const m = text.match(new RegExp(`${linkFragment}\\?token=([a-f0-9]+)`));
    if (m) return m[1];
  }
  return null;
}

async function seedAccount() {
  const pool = getAppPool()!;
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const memoEnc = encryptKey(USER, MEMO_KEY);
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, custody, memo_key_enc, iv_memo, verify_token)
     VALUES ($1, $2, $3, 'light', $4, $5, NULL)`,
    [OLD_EMAIL, USER, passwordHash, memoEnc.ciphertext, memoEnc.iv],
  );
}

async function cleanup() {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM pending_recovery WHERE username LIKE $1', ['recover2p_%']).catch(() => {});
  await pool.query('DELETE FROM custody_audit_log WHERE username LIKE $1', ['recover2p_%']).catch(() => {});
  await pool.query('DELETE FROM accounts WHERE username LIKE $1', ['recover2p_%']).catch(() => {});
}

afterAll(async () => { await cleanup(); });

describe('two-phase memo-key recovery — full flow', () => {
  beforeAll(async () => {
    await cleanup();
    if (!dbReachable || !hasCustodyKey) return;
    await seedAccount();
  });

  beforeEach(async () => {
    if (!dbReachable || !hasCustodyKey) return;
    smtpMock.sendMail.mockClear();
    await clearRateLimitKeys(['auth-recover', 'auth-login']);
    const pool = getAppPool()!;
    await pool.query('DELETE FROM pending_recovery WHERE username = $1', [USER]).catch(() => {});
    await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [USER]).catch(() => {});
    // Reset the account email/password to the seeded baseline so each test
    // starts from a clean A-state regardless of a prior test's apply.
    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    await pool.query(
      'UPDATE accounts SET email = $1, password_hash = $2, sessions_invalidated_at = NULL, upgraded_at = NULL WHERE username = $3',
      [OLD_EMAIL, passwordHash, USER],
    );
  });

  it.skipIf(!dbReachable || !hasCustodyKey)('phase 1 stages + mails both links; phase 2 applies the swap', async () => {
    const newEmail = `recover2p_new_${Date.now()}@example.com`;
    const newPassword = 'BrandNewPass1';

    const p1 = await request(app)
      .post('/api/auth/recover')
      .send({ username: USER, new_email: newEmail, new_password: newPassword, memo_key: MEMO_KEY });
    expect(p1.status).toBe(200);
    expect(p1.body.data.recovery).toBe('pending_verification');
    expect(p1.body.data.token).toBeUndefined();

    // Two mails: verify to new, dispute to old. Old email mail names only the
    // new email DOMAIN, never the full new address.
    const verifyCall = smtpMock.sendMail.mock.calls.find((c) => c[0]?.to === newEmail);
    const disputeCall = smtpMock.sendMail.mock.calls.find((c) => c[0]?.to === OLD_EMAIL);
    expect(verifyCall).toBeTruthy();
    expect(disputeCall).toBeTruthy();
    const newDomain = newEmail.split('@')[1];
    expect(disputeCall![0].text).toContain(newDomain);
    expect(disputeCall![0].text).not.toContain(newEmail.split('@')[0]); // local-part not leaked

    const verifyToken = tokenFromMail('/recover/verify');
    expect(verifyToken).toBeTruthy();

    // Account unchanged at this point.
    const pool = getAppPool()!;
    let acct = await pool.query('SELECT email, password_hash FROM accounts WHERE username = $1', [USER]);
    expect(acct.rows[0].email).toBe(OLD_EMAIL);

    // Phase 2: present the verify token.
    const p2 = await request(app)
      .post('/api/auth/recover/verify')
      .send({ token: verifyToken });
    expect(p2.status).toBe(200);
    expect(p2.body.data.token).toBeDefined();
    expect(p2.body.data.username).toBe(USER);

    // Swap applied: new email, new password, sessions invalidated.
    acct = await pool.query('SELECT email, sessions_invalidated_at FROM accounts WHERE username = $1', [USER]);
    expect(acct.rows[0].email).toBe(newEmail);
    expect(acct.rows[0].sessions_invalidated_at).not.toBeNull();

    const loginNew = await request(app).post('/api/auth/login').send({ username: USER, password: newPassword });
    expect(loginNew.status).toBe(200);

    // Audit row written with the forensic digests in the reused columns.
    const auditRows = await fetchSettledAuditRows(pool, USER, 'account_recovery');
    expect(auditRows.length).toBe(1);

    // Staging row consumed (single-use): replaying the verify token fails.
    const replay = await request(app).post('/api/auth/recover/verify').send({ token: verifyToken });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('INVALID_TOKEN');
  });

  it.skipIf(!dbReachable || !hasCustodyKey)('never-verified staged swap expires — no apply', async () => {
    const newEmail = `recover2p_expire_${Date.now()}@example.com`;
    const p1 = await request(app)
      .post('/api/auth/recover')
      .send({ username: USER, new_email: newEmail, new_password: 'ExpirePass1', memo_key: MEMO_KEY });
    expect(p1.status).toBe(200);

    const verifyToken = tokenFromMail('/recover/verify');
    expect(verifyToken).toBeTruthy();

    // Force-expire the verify window (simulate the token never being opened
    // in time). The dispute window is separate and longer; expiring verify is
    // the "link never clicked" failure path.
    const pool = getAppPool()!;
    await pool.query(
      `UPDATE pending_recovery SET verify_expires_at = NOW() - INTERVAL '1 minute' WHERE username = $1`,
      [USER],
    );

    const p2 = await request(app).post('/api/auth/recover/verify').send({ token: verifyToken });
    expect(p2.status).toBe(400);
    expect(p2.body.error.code).toBe('INVALID_TOKEN');

    // Account email unchanged — swap never applied.
    const acct = await pool.query('SELECT email FROM accounts WHERE username = $1', [USER]);
    expect(acct.rows[0].email).toBe(OLD_EMAIL);
  });

  it.skipIf(!dbReachable || !hasCustodyKey)('old-email dispute voids the staged swap — phase 2 then refuses', async () => {
    const newEmail = `recover2p_disp_${Date.now()}@example.com`;
    const p1 = await request(app)
      .post('/api/auth/recover')
      .send({ username: USER, new_email: newEmail, new_password: 'DisputePass1', memo_key: MEMO_KEY });
    expect(p1.status).toBe(200);

    const verifyToken = tokenFromMail('/recover/verify');
    const disputeToken = tokenFromMail('/recover/dispute');
    expect(verifyToken).toBeTruthy();
    expect(disputeToken).toBeTruthy();

    // Old owner disputes.
    const disp = await request(app).post('/api/auth/recover/dispute').send({ token: disputeToken });
    expect(disp.status).toBe(200);
    expect(disp.body.data.disputed).toBe(true);

    // Phase 2 now refuses to apply the disputed swap.
    const p2 = await request(app).post('/api/auth/recover/verify').send({ token: verifyToken });
    expect(p2.status).toBe(400);
    expect(p2.body.error.code).toBe('INVALID_TOKEN');

    const pool = getAppPool()!;
    const acct = await pool.query('SELECT email FROM accounts WHERE username = $1', [USER]);
    expect(acct.rows[0].email).toBe(OLD_EMAIL);

    const disputeAudit = await fetchSettledAuditRows(pool, USER, 'recovery_dispute');
    expect(disputeAudit.length).toBe(1);
  });
});

// ── ORCID recovery severed after upgrade-to-self-custody (state D) ──

describe('ORCID recovery is severed after upgrade-to-self-custody', () => {
  const UP_USER = `recover2p_upgraded_${RUN}`;
  const UP_EMAIL = `recover2p_upgraded_${RUN}@example.com`;
  const ORCID_ID = '0000-0003-4444-5555';

  beforeAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    // Upgraded account: custody='self', upgraded_at set, orcid preserved
    // (state D per ARCHITECTURE.md § 6.1). Encrypted keys nulled at upgrade.
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, orcid, upgraded_at, verify_token)
       VALUES ($1, $2, NULL, 'self', $3, NOW(), NULL)`,
      [UP_EMAIL, UP_USER, ORCID_ID],
    );
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [UP_USER]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username = $1', [UP_USER]).catch(() => {});
  });

  it.skipIf(!dbReachable)('upgraded account cannot be recovered via the original ORCID link', async () => {
    await clearRateLimitKeys(['auth-recover']);
    // Seed a valid ORCID-verified nonce that matches the account's orcid, so
    // the ONLY thing standing between the attacker and a successful recover is
    // the upgraded_at gate. Mutation-kill: drop the gate and this passes (200).
    const { getRedis, isRedisAvailable } = await import('../../src/redis.js');
    const { config } = await import('../../src/config.js');
    const { orcidVerified } = await import('../../src/routes/orcid.js');
    const nonce = `recover2p-up-nonce-${Date.now()}`;
    const payload = { orcid_id: ORCID_ID, works_count: 5, name: 't' };
    const redis = getRedis();
    if (redis && isRedisAvailable()) {
      await redis.set(`${config.appTag}:orcid_verified:${nonce}`, JSON.stringify(payload), 'EX', 600);
    }
    orcidVerified.set(nonce, { ...payload, expires: Date.now() + 600_000 });

    const res = await request(app)
      .post('/api/auth/recover')
      .send({
        username: UP_USER,
        new_email: `recover2p_up_attacker_${Date.now()}@example.com`,
        orcid_token: nonce,
      });
    // Severed: 401 UNAUTHORIZED, NOT a 200 recover.
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');

    // Email unchanged — no swap applied.
    const pool = getAppPool()!;
    const acct = await pool.query('SELECT email FROM accounts WHERE username = $1', [UP_USER]);
    expect(acct.rows[0].email).toBe(UP_EMAIL);
  });
});

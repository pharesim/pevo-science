/**
 * Test header — carve-out justifications for the structured-log spy assertions
 * appended to this file (BE-LOG-SHAPE-CONVERGENCE-SIBLING-FILES item 2):
 *
 * (a) Real-path impracticality: each `*.failed` outer-catch event in
 *     `backend/src/routes/settings.ts` exists for unforeseen runtime errors
 *     (DB outage, transaction rollback, etc.). Driving them via real
 *     infrastructure would require taking Postgres down mid-request, which
 *     also flakes every other in-flight spec. The deterministic way to fire
 *     each catch is to monkey-patch `getAppPool().query` to reject on the
 *     first call only (restored in finally), mirroring the
 *     `auth-log-shape.test.ts` pattern. The SMTP-failure spec uses
 *     `vi.spyOn(nodemailer, 'createTransport')` + a per-test `sendMail`
 *     rejection, mirroring `auth-log-shape.test.ts` `auth.signup.smtp_send_failed`.
 * (b) `verifyHiveSignature` IS mocked via the project-wide `MOCK_VERIFY_SIGNATURE`
 *     fixture (the existing setup at the top of this file). The fixture
 *     preserves the 401-on-missing-header gate and the username-extraction
 *     behavior; only the cryptographic check is bypassed. The spy specs below
 *     focus on log-shape behavior downstream of auth, NOT on cryptographic
 *     verification — the carve-out clause (b) refinement applies. Real-path
 *     companion coverage of `verifyHiveSignature` against signed requests
 *     lives in `auth.test.ts` and `auth-log-shape.test.ts` (the auth surface
 *     exercises the real middleware end-to-end).
 * (c) Same-risk-class real-path coverage: behavioral coverage of the same
 *     settings routes (DB row reads, deletes, transactions) lives in the
 *     existing DB-backed specs above against real Postgres. These spy specs
 *     are the complementary log-shape pin that catches event/route renames or
 *     `err: <Error>.message`-style regressions that pass every behavioral
 *     check while breaking operator dashboards. Pattern is identical to
 *     `auth-log-shape.test.ts`.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import nodemailer from 'nodemailer';
import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { logger } from '../../src/logger.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

// Helper: search a spy's call list for the first call with matching event
// discriminator. Mirrors `auth-log-shape.test.ts` `findEvent`. Returns the
// structured-fields object (the first arg) or undefined.
function findEvent(
  spy: ReturnType<typeof vi.fn>,
  event: string,
): Record<string, unknown> | undefined {
  for (const call of spy.mock.calls) {
    const [obj] = call;
    if (obj && typeof obj === 'object' && (obj as { event?: string }).event === event) {
      return obj as Record<string, unknown>;
    }
  }
  return undefined;
}

const app = createApp();

// Unique test username per run to avoid collisions
const TEST_USER = `settings_test_${Date.now()}`;
const TEST_EMAIL = `settings_test_${Date.now()}@example.com`;
const OTHER_EMAIL = `settings_other_${Date.now()}@example.com`;

// Check if app DB is actually reachable (synchronous-ish via top-level await)
let dbReachable = false;
{
  const pool = getAppPool();
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbReachable = true;
      // Run migration for pending_email columns if needed
      await pool.query(`
        ALTER TABLE accounts ALTER COLUMN password_hash DROP NOT NULL;
        ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pending_email TEXT;
        ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pending_email_token TEXT;
        ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pending_email_expires_at TIMESTAMPTZ;
      `).catch(() => {}); // Ignore if already applied
    } catch {
      dbReachable = false;
    }
  }
}

async function cleanup() {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  try {
    await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [TEST_USER]);
    await pool.query('DELETE FROM notification_preferences WHERE username = $1', [TEST_USER]);
    await pool.query('DELETE FROM accounts WHERE username = $1', [TEST_USER]);
  } catch { /* ignore */ }
}

afterAll(async () => { await cleanup(); });

// ─── Auth + validation tests (no DB needed) ─────────────────

describe('GET /api/settings/email', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .get('/api/settings/email');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/settings/email', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/settings/email')
      .send({ email: 'test@example.com' });
    expect(res.status).toBe(401);
  });

  it('rejects invalid email', async () => {
    const res = await request(app)
      .post('/api/settings/email')
      .set('X-Hive-Username', TEST_USER)
      .send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects missing email', async () => {
    const res = await request(app)
      .post('/api/settings/email')
      .set('X-Hive-Username', TEST_USER)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/settings/email', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .delete('/api/settings/email')
      .send({ confirm: true });
    expect(res.status).toBe(401);
  });

  it('rejects without confirm: true', async () => {
    const res = await request(app)
      .delete('/api/settings/email')
      .set('X-Hive-Username', TEST_USER)
      .send({ confirm: false });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ─── DB-dependent tests ─────────────────────────────────────

describe('Settings email (with DB)', () => {
  beforeAll(async () => { await cleanup(); });

  it.skipIf(!dbReachable)('GET returns hasEmail: false for unknown user', async () => {
    const res = await request(app)
      .get('/api/settings/email')
      .set('X-Hive-Username', TEST_USER);
    expect(res.status).toBe(200);
    expect(res.body.data.hasEmail).toBe(false);
    expect(res.body.data.custody).toBe('self');
  });

  it.skipIf(!dbReachable)('GET returns email status for existing account', async () => {
    const pool = getAppPool()!;
    await pool.query(
      `INSERT INTO accounts (email, username, verify_token) VALUES ($1, $2, NULL)`,
      [TEST_EMAIL, TEST_USER],
    );

    const res = await request(app)
      .get('/api/settings/email')
      .set('X-Hive-Username', TEST_USER);
    expect(res.status).toBe(200);
    expect(res.body.data.hasEmail).toBe(true);
    expect(res.body.data.verified).toBe(true);
    expect(res.body.data.pendingChange).toBe(false);
    expect(res.body.data.email).toMatch(/^s\*\*\*\d@\*\*\*\.com$/);

    await pool.query('DELETE FROM accounts WHERE username = $1', [TEST_USER]);
  });

  it.skipIf(!dbReachable)('POST rejects duplicate email used by another account', async () => {
    const pool = getAppPool()!;
    const otherUser = `settings_other_${Date.now()}`;
    await pool.query(
      `INSERT INTO accounts (email, username, verify_token) VALUES ($1, $2, NULL)`,
      [TEST_EMAIL, otherUser],
    );

    const res = await request(app)
      .post('/api/settings/email')
      .set('X-Hive-Username', TEST_USER)
      .send({ email: TEST_EMAIL });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE');

    await pool.query('DELETE FROM accounts WHERE username = $1', [otherUser]);
  });

  it.skipIf(!dbReachable)('verify token - add flow', async () => {
    const pool = getAppPool()!;
    const token = 'test_verify_token_' + Date.now();
    await pool.query(
      `INSERT INTO accounts (email, username, verify_token, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
      [TEST_EMAIL, TEST_USER, token],
    );

    const res = await request(app)
      .get(`/api/settings/email/verify/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.verified).toBe(true);

    const { rows } = await pool.query(
      'SELECT verify_token FROM accounts WHERE username = $1',
      [TEST_USER],
    );
    expect(rows[0].verify_token).toBeNull();

    await pool.query('DELETE FROM accounts WHERE username = $1', [TEST_USER]);
  });

  it.skipIf(!dbReachable)('verify token - change flow', async () => {
    const pool = getAppPool()!;
    const token = 'test_change_token_' + Date.now();
    await pool.query(
      `INSERT INTO accounts (email, username, verify_token, pending_email, pending_email_token, pending_email_expires_at)
       VALUES ($1, $2, NULL, $3, $4, NOW() + INTERVAL '24 hours')`,
      [TEST_EMAIL, TEST_USER, OTHER_EMAIL, token],
    );

    const res = await request(app)
      .get(`/api/settings/email/verify/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.verified).toBe(true);

    const { rows } = await pool.query(
      'SELECT email, pending_email FROM accounts WHERE username = $1',
      [TEST_USER],
    );
    expect(rows[0].email).toBe(OTHER_EMAIL);
    expect(rows[0].pending_email).toBeNull();

    await pool.query('DELETE FROM accounts WHERE username = $1', [TEST_USER]);
  });

  it.skipIf(!dbReachable)('verify token - rejects expired', async () => {
    const pool = getAppPool()!;
    const token = 'test_expired_token_' + Date.now();
    await pool.query(
      `INSERT INTO accounts (email, username, verify_token, expires_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour')`,
      [TEST_EMAIL, TEST_USER, token],
    );

    const res = await request(app)
      .get(`/api/settings/email/verify/${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TOKEN');

    await pool.query('DELETE FROM accounts WHERE username = $1', [TEST_USER]);
  });

  it.skipIf(!dbReachable)('verify token - rejects unknown token', async () => {
    const res = await request(app)
      .get('/api/settings/email/verify/nonexistent_token');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it.skipIf(!dbReachable)('DELETE deletes account and associated data', async () => {
    const pool = getAppPool()!;
    await pool.query(
      `INSERT INTO accounts (email, username, verify_token) VALUES ($1, $2, NULL)`,
      [TEST_EMAIL, TEST_USER],
    );
    await pool.query(
      `INSERT INTO notification_preferences (username, email) VALUES ($1, $2)`,
      [TEST_USER, TEST_EMAIL],
    );

    const res = await request(app)
      .delete('/api/settings/email')
      .set('X-Hive-Username', TEST_USER)
      .send({ confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);

    const { rows: accRows } = await pool.query(
      'SELECT id FROM accounts WHERE username = $1',
      [TEST_USER],
    );
    expect(accRows.length).toBe(0);

    const { rows: prefRows } = await pool.query(
      'SELECT username FROM notification_preferences WHERE username = $1',
      [TEST_USER],
    );
    expect(prefRows.length).toBe(0);
  });

  it.skipIf(!dbReachable)('DELETE sweeps the pending_recovery staging row', async () => {
    // A two-phase recovery staging row carries the would-be new email
    // (plaintext) plus an offline-crackable argon2id hash. Under data
    // minimization it must not outlive the deleted account. This pins that the
    // email-delete transaction removes the row (the row-count assertion is the
    // mutation-kill for the sweep). The follow-on phase-2 verify is an
    // integration sanity check that no swap can apply once the account is gone;
    // note its 400 is driven by the account-gone re-resolution branch in the
    // verify handler, NOT by the row sweep (with the sweep dropped, the row
    // survives but the accounts row is still deleted in the same transaction,
    // so verify hits the same account-gone path and still returns 400).
    const pool = getAppPool()!;
    const username = `settings_pendrec_${Date.now()}`;
    const oldEmail = `settings_pendrec_${Date.now()}@example.com`;
    const stagedNewEmail = `settings_pendrec_new_${Date.now()}@example.com`;

    // The plaintext verify token only ever travels in the mailed link; the row
    // stores its SHA-256. Build a token here so we can replay it at phase 2.
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const verifyTokenHash = crypto.createHash('sha256').update(verifyToken).digest();
    const disputeTokenHash = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest();

    try {
      await pool.query(
        `INSERT INTO accounts (email, username, verify_token) VALUES ($1, $2, NULL)`,
        [oldEmail, username],
      );
      await pool.query(
        `INSERT INTO pending_recovery
           (username, new_email, new_password_hash,
            verify_token_hash, verify_expires_at,
            dispute_token_hash, dispute_expires_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours', $5, NOW() + INTERVAL '48 hours')`,
        [username, stagedNewEmail, 'argon2-hash-placeholder', verifyTokenHash, disputeTokenHash],
      );

      // Sanity: the staging row exists before the delete.
      const before = await pool.query('SELECT id FROM pending_recovery WHERE username = $1', [username]);
      expect(before.rows.length).toBe(1);

      const res = await request(app)
        .delete('/api/settings/email')
        .set('X-Hive-Username', username)
        .send({ confirm: true });
      expect(res.status).toBe(200);
      expect(res.body.data.deleted).toBe(true);

      // The staging row was swept by the email-delete transaction.
      // Mutation-kill: dropping the DELETE leaves this row alive.
      const after = await pool.query('SELECT id FROM pending_recovery WHERE username = $1', [username]);
      expect(after.rows.length).toBe(0);

      // Phase-2 verify is rejected because the account no longer exists (the
      // account-gone re-resolution branch returns 400), not because of the row
      // sweep. No account was recreated and no swap applied.
      const p2 = await request(app).post('/api/auth/recover/verify').send({ token: verifyToken });
      expect(p2.status).toBe(400);
      expect(p2.body.error.code).toBe('INVALID_TOKEN');

      const acct = await pool.query('SELECT id FROM accounts WHERE username = $1', [username]);
      expect(acct.rows.length).toBe(0);
    } finally {
      await pool.query('DELETE FROM pending_recovery WHERE username = $1', [username]).catch(() => {});
      await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [username]).catch(() => {});
      await pool.query('DELETE FROM accounts WHERE username = $1', [username]).catch(() => {});
    }
  });

  it.skipIf(!dbReachable)(
    'DELETE anonymizes audit history instead of wiping it (forensics + right-to-erasure)',
    async () => {
      // Seed: an account row plus two prior custody_audit_log rows for the
      // same username. One simulates a consent-op broadcast that ran the
      // fresh-auth gate (PII-derived columns populated AND forensic columns
      // tx_id/auth_mechanism set); one is a non-broadcast event. After
      // DELETE /api/settings/email both seeded rows must SURVIVE (no row is
      // DELETEd, only anonymized) with username/user_agent/session_id NULLed,
      // while the forensic columns tx_id/auth_mechanism retain their seeded
      // values. The handler's own `email_deleted` row is likewise anonymized,
      // which the username-scoped "no rows still bound" assertion below
      // covers: an un-anonymized email_deleted row would keep the username
      // link, and a wrong INSERT-after-UPDATE order would leave it bound.
      const pool = getAppPool()!;
      const username = `anon_audit_${Date.now()}`;
      const email = `anon_audit_${Date.now()}@example.com`;
      await pool.query(
        `INSERT INTO accounts (email, username, verify_token) VALUES ($1, $2, NULL)`,
        [email, username],
      );
      const seededTxId = `seeded-tx-${username}`;
      const {
        rows: [{ id: acceptId }],
      } = await pool.query<{ id: number }>(
        `INSERT INTO custody_audit_log
           (username, operation_type, user_agent, session_id, tx_id, auth_mechanism)
         VALUES ($1, 'author_accept', 'fake-ua-hash', 'fake-session-id', $2, 'orcid')
         RETURNING id`,
        [username, seededTxId],
      );
      const {
        rows: [{ id: loginFailId }],
      } = await pool.query<{ id: number }>(
        `INSERT INTO custody_audit_log (username, operation_type, user_agent, session_id)
         VALUES ($1, 'login_failure', 'fake-ua-2', 'fake-session-2')
         RETURNING id`,
        [username],
      );

      try {
        const res = await request(app)
          .delete('/api/settings/email')
          .set('X-Hive-Username', username)
          .send({ confirm: true });
        expect(res.status).toBe(200);
        expect(res.body.data.deleted).toBe(true);

        // No rows remain bound to the deleted username. This also covers the
        // handler's just-inserted `email_deleted` row: it is INSERTed with
        // the username and then swept by the anonymize UPDATE, so a row still
        // bound here would mean either it was never anonymized or the INSERT
        // ran after the UPDATE (the inverted order the handler guards against).
        const { rows: stillBound } = await pool.query(
          'SELECT id FROM custody_audit_log WHERE username = $1',
          [username],
        );
        expect(stillBound.length).toBe(0);

        // The accounts row is gone (right-to-erasure on the primary
        // PII-bearing table).
        const { rows: accRows } = await pool.query(
          'SELECT id FROM accounts WHERE username = $1',
          [username],
        );
        expect(accRows.length).toBe(0);

        // The two seeded rows SURVIVE the delete (anonymized, not wiped),
        // pinned by id so the assertion is deterministic under parallel
        // sibling test load against the shared DB.
        const { rows: survivors } = await pool.query<{
          id: number;
          operation_type: string;
          username: string | null;
          user_agent: string | null;
          session_id: string | null;
          tx_id: string | null;
          auth_mechanism: string | null;
        }>(
          `SELECT id, operation_type, username, user_agent, session_id, tx_id, auth_mechanism
             FROM custody_audit_log
            WHERE id IN ($1, $2)
            ORDER BY id`,
          [acceptId, loginFailId],
        );
        // Both present: nothing was DELETEd, only anonymized.
        expect(survivors.length).toBe(2);
        for (const r of survivors) {
          expect(r.username).toBeNull();
          expect(r.user_agent).toBeNull();
          expect(r.session_id).toBeNull();
        }
        // Forensic columns SURVIVE the anonymize: the seeded author_accept
        // row keeps its tx_id and auth_mechanism. This guards against a
        // regression that adds a forensic column to the `SET ... = NULL`
        // clause. tx_id is a public-ledger reference the user themselves
        // signed and is retained by design.
        const acceptRow = survivors.find((r) => r.id === acceptId)!;
        expect(acceptRow.operation_type).toBe('author_accept');
        expect(acceptRow.tx_id).toBe(seededTxId);
        expect(acceptRow.auth_mechanism).toBe('orcid');
      } finally {
        // Cleanup pinned to the rows we own. The handler's anonymized
        // `email_deleted` row (server-assigned id inside the handler txn,
        // username NULLed) is left for the custody-audit-retention-sweep to
        // collect by created_at; sweeping by operation_type/time window here
        // could clobber a concurrent sibling's anonymized rows on the shared DB.
        await pool
          .query('DELETE FROM custody_audit_log WHERE id IN ($1, $2)', [acceptId, loginFailId])
          .catch(() => {});
        await pool.query('DELETE FROM accounts WHERE username = $1', [username]).catch(() => {});
      }
    },
  );

  it.skipIf(!dbReachable)('DELETE returns 401 when no account row exists for the authed user', async () => {
    // SEC-004-BE finding #2: 404 → 401 on authed-endpoint missing-own-row.
    // The distinguishing 404 leaked account deletion to an authed session-
    // holder. Treat missing-own-row as "session no longer valid" instead.
    const res = await request(app)
      .delete('/api/settings/email')
      .set('X-Hive-Username', TEST_USER)
      .send({ confirm: true });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

// ─── BE-LOG-SHAPE-CONVERGENCE-SIBLING-FILES (item 2) ─────────
// Mutation-killing spy assertions on the 7 structured-log emissions in
// `backend/src/routes/settings.ts`. Each spec triggers the catch path (or the
// warn branch for the light-account login-loss event), spies on the logger,
// and pins the canonical fields per
// `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md`
// and `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`. Without
// these specs, an event/route rename or an `err: <Error> → err: <Error>.message`
// regression would pass every behavioral check while breaking operator
// dashboards. Pattern mirrors `auth-log-shape.test.ts` exactly.

describe('settings.email_get.failed log shape', () => {
  it.skipIf(!dbReachable)('fires from outer catch with route + username + err', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(
      () => undefined as unknown as void,
    );
    // Inject a query failure by patching the live pool's `query` to throw on
    // the next call only. Restored in finally.
    const pool = getAppPool()!;
    const origQuery = pool.query.bind(pool);
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...args: unknown[]) => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new Error('synthetic db failure for email_get.failed'));
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return origQuery(...(args as [any]));
    };

    try {
      await clearRateLimitKeys(['settings-read']);
      const res = await request(app)
        .get('/api/settings/email')
        .set('X-Hive-Username', TEST_USER);
      expect(res.status).toBe(500);

      const fields = findEvent(errorSpy as never, 'settings.email_get.failed');
      expect(fields).toBeDefined();
      expect(fields).toMatchObject({
        event: 'settings.email_get.failed',
        route: 'settings.email-get',
        username: TEST_USER,
      });
      expect(fields!.err).toBeInstanceOf(Error);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pool as any).query = origQuery;
      errorSpy.mockRestore();
    }
  });
});

describe('settings.email_post.smtp_send_failed log shape', () => {
  it.skipIf(!dbReachable)(
    'fires on sendMail throw with route + email_hash + username + err: <Error>',
    async () => {
      // Drive: ensure config.smtpHost is non-empty so sendVerificationEmail
      // proceeds to createSmtpTransporter (it short-circuits on empty host).
      // Then stub createTransport so sendMail rejects.
      const { config } = await import('../../src/config.js');
      const prevHost = config.smtpHost;
      config.smtpHost = config.smtpHost || 'smtp-fail-test.invalid';
      const sendMailSpy = vi.fn().mockRejectedValue(new Error('SMTP connection refused'));
      const transportSpy = vi
        .spyOn(nodemailer, 'createTransport')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValue({ sendMail: sendMailSpy } as any);
      // SMTP-fail emits at `warn` (not `error`) per Option A of the
      // status-code-oracle convention documented at
      // `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md`.
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(
        () => undefined as unknown as void,
      );

      try {
        await clearRateLimitKeys(['settings-write']);
        const username = `smtp_fail_${Date.now()}`;
        const email = `smtp_fail_${Date.now()}@example.com`;
        const res = await request(app)
          .post('/api/settings/email')
          .set('X-Hive-Username', username)
          .send({ email });
        // SMTP-fail returns uniform 200 (not 500) so a JWT-only attacker
        // cannot read identity registration state from the 500-vs-200
        // differential. The DB row is rolled back so the user has no
        // pending state without a verify link.
        expect(res.status).toBe(200);

        const fields = findEvent(warnSpy as never, 'settings.email_post.smtp_send_failed');
        expect(fields).toBeDefined();
        expect(fields).toMatchObject({
          event: 'settings.email_post.smtp_send_failed',
          route: 'settings.email-post',
          username,
        });
        // CNPD: email_hash, NOT plaintext email.
        expect(typeof fields!.email_hash).toBe('string');
        expect(fields).not.toHaveProperty('email');
        // `err` MUST be the Error instance, not its `.message` string.
        // Pino's err serializer fires only when err is an Error instance;
        // a regression to passing `err.message` would emit a string in the
        // log without the stack/cause fields the serializer adds.
        expect(fields!.err).toBeInstanceOf(Error);

        // Cleanup the seeded row written before the SMTP failure rolled it back.
        const pool = getAppPool()!;
        await pool.query('DELETE FROM accounts WHERE username = $1', [username]).catch(() => {});
      } finally {
        warnSpy.mockRestore();
        transportSpy.mockRestore();
        config.smtpHost = prevHost;
      }
    },
  );
});

describe('settings.email_post.failed log shape', () => {
  it.skipIf(!dbReachable)('fires from outer catch with route + email_hash + username + err', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(
      () => undefined as unknown as void,
    );
    const pool = getAppPool()!;
    const origQuery = pool.query.bind(pool);
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...args: unknown[]) => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new Error('synthetic db failure for email_post.failed'));
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return origQuery(...(args as [any]));
    };

    try {
      await clearRateLimitKeys(['settings-write']);
      const username = `email_post_fail_${Date.now()}`;
      const email = `email_post_fail_${Date.now()}@example.com`;
      const res = await request(app)
        .post('/api/settings/email')
        .set('X-Hive-Username', username)
        .send({ email });
      expect(res.status).toBe(500);

      const fields = findEvent(errorSpy as never, 'settings.email_post.failed');
      expect(fields).toBeDefined();
      expect(fields).toMatchObject({
        event: 'settings.email_post.failed',
        route: 'settings.email-post',
        username,
      });
      expect(typeof fields!.email_hash).toBe('string');
      expect(fields).not.toHaveProperty('email');
      expect(fields!.err).toBeInstanceOf(Error);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pool as any).query = origQuery;
      errorSpy.mockRestore();
    }
  });
});

describe('settings.email_verify.failed log shape', () => {
  it.skipIf(!dbReachable)('fires from outer catch with route + err', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(
      () => undefined as unknown as void,
    );
    const pool = getAppPool()!;
    const origQuery = pool.query.bind(pool);
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...args: unknown[]) => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new Error('synthetic db failure for email_verify.failed'));
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return origQuery(...(args as [any]));
    };

    try {
      await clearRateLimitKeys(['settings-read']);
      const res = await request(app)
        .get('/api/settings/email/verify/some_token_for_log_shape');
      expect(res.status).toBe(500);

      const fields = findEvent(errorSpy as never, 'settings.email_verify.failed');
      expect(fields).toBeDefined();
      expect(fields).toMatchObject({
        event: 'settings.email_verify.failed',
        route: 'settings.email-verify',
      });
      expect(fields!.err).toBeInstanceOf(Error);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pool as any).query = origQuery;
      errorSpy.mockRestore();
    }
  });
});

describe('settings.email_delete.light_account_login_loss log shape', () => {
  it.skipIf(!dbReachable)(
    'fires warn branch on light-account DELETE /email with route + username',
    async () => {
      // Drive: seed a light-account row (custody='light', upgraded_at=NULL)
      // so the SELECT returns rows[0] matching the warn-branch condition at
      // settings.ts:315 (`row.custody === 'light' && !row.upgraded_at`).
      // The transaction proceeds normally after the warn fires; we assert the
      // warn shape, then the row is deleted by the route's transaction (so no
      // explicit cleanup needed beyond the file-level afterAll).
      const pool = getAppPool()!;
      const username = `light_delete_${Date.now()}`;
      const email = `light_delete_${Date.now()}@example.com`;
      await pool.query(
        `INSERT INTO accounts (email, username, verify_token, custody, upgraded_at)
         VALUES ($1, $2, NULL, 'light', NULL)`,
        [email, username],
      );

      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(
        () => undefined as unknown as void,
      );

      try {
        await clearRateLimitKeys(['settings-write']);
        const res = await request(app)
          .delete('/api/settings/email')
          .set('X-Hive-Username', username)
          .send({ confirm: true });
        expect(res.status).toBe(200);
        expect(res.body.data.deleted).toBe(true);

        const fields = findEvent(warnSpy as never, 'settings.email_delete.light_account_login_loss');
        expect(fields).toBeDefined();
        expect(fields).toMatchObject({
          event: 'settings.email_delete.light_account_login_loss',
          route: 'settings.email-delete',
          username,
        });
      } finally {
        warnSpy.mockRestore();
        // Defensive cleanup in case the route's transaction did not run.
        await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [username]).catch(() => {});
        await pool.query('DELETE FROM accounts WHERE username = $1', [username]).catch(() => {});
      }
    },
  );
});

describe('settings.email_delete.failed log shape', () => {
  it.skipIf(!dbReachable)('fires from outer catch with route + username + err', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(
      () => undefined as unknown as void,
    );
    const pool = getAppPool()!;
    const origQuery = pool.query.bind(pool);
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...args: unknown[]) => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new Error('synthetic db failure for email_delete.failed'));
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return origQuery(...(args as [any]));
    };

    try {
      await clearRateLimitKeys(['settings-write']);
      const username = `email_delete_fail_${Date.now()}`;
      const res = await request(app)
        .delete('/api/settings/email')
        .set('X-Hive-Username', username)
        .send({ confirm: true });
      expect(res.status).toBe(500);

      const fields = findEvent(errorSpy as never, 'settings.email_delete.failed');
      expect(fields).toBeDefined();
      expect(fields).toMatchObject({
        event: 'settings.email_delete.failed',
        route: 'settings.email-delete',
        username,
      });
      expect(fields!.err).toBeInstanceOf(Error);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pool as any).query = origQuery;
      errorSpy.mockRestore();
    }
  });
});

describe('settings.set_password.failed log shape', () => {
  it.skipIf(!dbReachable)('fires from outer catch with route + username + err', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(
      () => undefined as unknown as void,
    );
    const pool = getAppPool()!;
    const origQuery = pool.query.bind(pool);
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...args: unknown[]) => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new Error('synthetic db failure for set_password.failed'));
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return origQuery(...(args as [any]));
    };

    try {
      await clearRateLimitKeys(['settings-write']);
      const username = `set_pw_fail_${Date.now()}`;
      const res = await request(app)
        .post('/api/settings/set-password')
        .set('X-Hive-Username', username)
        .send({ password: 'ValidPassword1' });
      expect(res.status).toBe(500);

      const fields = findEvent(errorSpy as never, 'settings.set_password.failed');
      expect(fields).toBeDefined();
      expect(fields).toMatchObject({
        event: 'settings.set_password.failed',
        route: 'settings.set-password',
        username,
      });
      expect(fields!.err).toBeInstanceOf(Error);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pool as any).query = origQuery;
      errorSpy.mockRestore();
    }
  });
});

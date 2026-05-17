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
      // Round-2 item 4: SMTP-fail emits at `warn` (not `error`) per Option A
      // of timing-equalization-smtp-failure-mode-oracle-2026-04-22.md.
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
        // Round-2 item 4: SMTP-fail returns uniform 200 (not 500) so a
        // JWT-only attacker cannot read identity registration state from
        // the 500-vs-200 differential. The DB row is rolled back so the
        // user has no pending state without a verify link.
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
        // Round-1 hold-fix item 1: err MUST be the Error instance, not its
        // .message string. Pino's err serializer fires only when err is an
        // Error instance.
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

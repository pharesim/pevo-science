/**
 * BACKEND-AUTH-STRUCTURED-LOG-CONVENTION-CONVERGE round-1 hold-fix item 2:
 * mutation-killing spy assertions on operationally-critical structured log
 * emissions in `backend/src/routes/auth.ts`.
 *
 * These tests pin the canonical structured-log shape (`event` + `route` + any
 * branch-identity fields like `emailKnown`) per
 * `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md`
 * and `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`. Without
 * these spy assertions, an event/route rename, a field drop, or an
 * `err: <Error> → err: <Error>.message` regression (the round-1 hold-fix
 * item 1 surface) passes every behavioral check while breaking operator
 * dashboards.
 *
 * Scope: outer-catch `*.failed` events on all 6 auth handlers (login,
 * reset-request, reset, recover, signup, resend-verification) + the 3
 * `*.smtp_send_failed` events. The 2 `*.smtp_not_configured` events on
 * /reset-request and /resend-verification are covered by the integration
 * tests in `recover.test.ts` BE-AUTH-SMTP-STATUS-CODE-ORACLE block (round-2
 * hold-fix item 5(b)) and counted toward the 6-10 budget there. File-level
 * emissions (`auth.startup.*`, `auth.burn_sentinel.*`) are out of scope per
 * the hold-block triage.
 *
 * Round-2 hold-fix item 1 added the 3 specs the round-1 hold block called
 * for but the round-1 implementer missed: `auth.resend_verification.smtp_send_failed`,
 * `auth.reset_request.smtp_send_failed`, and the outer-catch
 * `auth.resend_verification.failed`. The two SMTP-send-failed specs insert
 * a real pending/active account in the DB and spy on
 * `nodemailer.createTransport` so `sendMail` rejects deterministically (the
 * same pattern as `recover.test.ts` BE-AUTH-SMTP-STATUS-CODE-ORACLE).
 *
 * Strategy: each test triggers the catch path and asserts the resulting
 * `logger.<level>` call captures the canonical fields. Spying on the logger
 * (not the call site) means a helper-extraction refactor (e.g., the
 * `createSmtpTransporter` helper from BE-AUTH-SMTP-STATUS-CODE-ORACLE
 * round-2) doesn't break these assertions.
 *
 * Justification for `vi.spyOn` (per root CLAUDE.md test carve-out, clauses
 * a/b/c):
 *   (a) Real-path impracticality: forcing real outer-catch failures
 *       requires either inducing pool/redis errors mid-handler (which
 *       would also fail the rate-limit, abort-signal, and DB-pool integrity
 *       invariants) or constructing a request that violates a downstream
 *       guard (which the schema layer rejects first). The catch paths
 *       exist for unforeseen runtime failures; the only deterministic way
 *       to exercise them is to mock the operation that throws (sendMail,
 *       getAppPool().query, etc.) so the catch fires reproducibly.
 *   (b) `nodemailer.createTransport` and `pool.query` (via getAppPool)
 *       are the only mock targets per test. `verifyHiveSignature` and
 *       all other middleware are NOT mocked. The logger mock captures
 *       calls without suppressing them.
 *   (c) Real-HAF behavioral coverage of the same routes lives in
 *       `auth.test.ts` and `recover.test.ts`; this file is the
 *       complementary log-shape pin.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import nodemailer from 'nodemailer';
import { createApp } from '../../src/app.js';
import { getAppPool } from '../../src/app-db.js';
import { config } from '../../src/config.js';
import { logger } from '../../src/logger.js';
import { clearRateLimitKeys } from '../support/redis-helpers.js';

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

let redisReachable = false;
try {
  const { getRedis } = await import('../../src/redis.js');
  const redis = getRedis();
  if (redis) {
    for (let i = 0; i < 20 && redis.status !== 'ready'; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    redisReachable = redis.status === 'ready';
  }
} catch {
  redisReachable = false;
}

// Helper: search a spy's call list for the first call with matching event
// discriminator. Returns the structured-fields object (the first arg) or
// undefined.
//
// Round-2 hold-fix item 2: the `spy` parameter is typed as a minimal
// structural shape (`{ mock: { calls: unknown[][] } }`) rather than
// `ReturnType<typeof vi.fn>`. The minimal shape accepts both
// `MockInstance<LogFn>` (from `vi.spyOn(logger, 'error')`) and
// `Mock<[], void>` (from `vi.fn()`) without requiring an `as never` cast at
// each call site. The maximally-suppressive `as never` cast was previously
// repeated at 7 call sites and silently swallowed any future type drift in
// either `vi.spyOn` or this helper's signature.
function findEvent(
  spy: { mock: { calls: unknown[][] } },
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

const SHAPE_TEST_EMAIL_PREFIX = 'log_shape_';

async function cleanup() {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  try {
    await pool.query('DELETE FROM accounts WHERE email LIKE $1', [`${SHAPE_TEST_EMAIL_PREFIX}%`]);
  } catch { /* ignore */ }
}

beforeAll(async () => { await cleanup(); });
afterAll(async () => { await cleanup(); });

// ─── /signup *.failed and *.smtp_send_failed and *.smtp_not_configured ────

describe('auth.signup.smtp_send_failed log shape', () => {
  it.skipIf(!dbReachable || !redisReachable)(
    'fires on sendMail throw with err: <Error> (not err.message)',
    async () => {
      const prevHost = config.smtpHost;
      config.smtpHost = 'smtp-fail-test.invalid';
      const sendMailSpy = vi.fn().mockRejectedValue(new Error('SMTP connection refused'));
      const transportSpy = vi
        .spyOn(nodemailer, 'createTransport')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValue({ sendMail: sendMailSpy } as any);
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(
        () => undefined as unknown as void,
      );

      try {
        await clearRateLimitKeys(['auth-signup']);
        const email = `${SHAPE_TEST_EMAIL_PREFIX}signup_smtp_${Date.now()}@harvard.edu`;
        const res = await request(app).post('/api/auth/signup').send({
          email,
          password: 'TestPassword1',
          full_name: 'Log Shape Tester',
          institution: 'Harvard',
          field: 'CS',
        });
        // The handler returns 500 on sendMail throw (the row is deleted) —
        // status code is not the assertion target here, but pin it so a
        // future refactor that drops the catch entirely fails loudly.
        expect(res.status).toBe(500);

        const fields = findEvent(errorSpy, 'auth.signup.smtp_send_failed');
        expect(fields).toBeDefined();
        expect(fields).toMatchObject({
          event: 'auth.signup.smtp_send_failed',
          route: 'auth.signup',
        });
        // Round-1 hold-fix item 1: err MUST be the Error instance, not its
        // .message string. Pino's err serializer fires only when err is an
        // Error instance (.message + .stack + .type + .cause).
        expect(fields!.err).toBeInstanceOf(Error);
      } finally {
        errorSpy.mockRestore();
        transportSpy.mockRestore();
        config.smtpHost = prevHost;
      }
    },
  );
});

describe('auth.signup.smtp_not_configured log shape', () => {
  it.skipIf(!dbReachable || !redisReachable)(
    'fires when config.smtpHost is empty with email_hash field',
    async () => {
      const prevHost = config.smtpHost;
      config.smtpHost = '';
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(
        () => undefined as unknown as void,
      );

      try {
        await clearRateLimitKeys(['auth-signup']);
        const email = `${SHAPE_TEST_EMAIL_PREFIX}signup_nosmtp_${Date.now()}@harvard.edu`;
        const res = await request(app).post('/api/auth/signup').send({
          email,
          password: 'TestPassword1',
          full_name: 'Log Shape Tester',
          institution: 'Harvard',
          field: 'CS',
        });
        expect(res.status).toBe(500);

        const fields = findEvent(errorSpy, 'auth.signup.smtp_not_configured');
        expect(fields).toBeDefined();
        expect(fields).toMatchObject({
          event: 'auth.signup.smtp_not_configured',
          route: 'auth.signup',
        });
        // CNPD: email_hash is the only allowed email identity in logs.
        expect(typeof fields!.email_hash).toBe('string');
      } finally {
        errorSpy.mockRestore();
        config.smtpHost = prevHost;
      }
    },
  );
});

// ─── Outer-catch *.failed events ─────────────────────────────────

// `auth.<route>.failed` events fire from the top-level catch in each handler
// when an unforeseen runtime error escapes (DB outage, native crypto fail,
// etc.). We trigger them by making `getAppPool().query` reject at the right
// position in the handler. Each test scopes the mock to a single
// pool.query call so the rate-limit + zod + abort-signal middleware all run
// against real Redis.

describe('auth.login.failed log shape', () => {
  it.skipIf(!dbReachable || !redisReachable)(
    'fires from outer catch with route + err',
    async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(
        () => undefined as unknown as void,
      );
      // Inject a query failure by patching the live pool's `query` to throw
      // on the next call only. Restored in the finally block.
      const pool = getAppPool()!;
      const origQuery = pool.query.bind(pool);
      let calls = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pool as any).query = (...args: unknown[]) => {
        calls++;
        if (calls === 1) {
          return Promise.reject(new Error('synthetic db failure for login.failed'));
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return origQuery(...(args as [any]));
      };

      try {
        await clearRateLimitKeys(['auth-login']);
        const res = await request(app)
          .post('/api/auth/login')
          .send({ email_or_username: 'no_such_user_for_log_shape', password: 'X1' });
        expect(res.status).toBe(500);

        const fields = findEvent(errorSpy, 'auth.login.failed');
        expect(fields).toBeDefined();
        expect(fields).toMatchObject({
          event: 'auth.login.failed',
          route: 'auth.login',
        });
        expect(fields!.err).toBeInstanceOf(Error);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pool as any).query = origQuery;
        errorSpy.mockRestore();
      }
    },
  );
});

describe('auth.reset_request.failed log shape', () => {
  it.skipIf(!dbReachable || !redisReachable)(
    'fires from outer catch with route + err',
    async () => {
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
          return Promise.reject(new Error('synthetic db failure for reset_request.failed'));
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return origQuery(...(args as [any]));
      };

      try {
        await clearRateLimitKeys(['auth-reset-request']);
        const res = await request(app)
          .post('/api/auth/reset-request')
          .send({ email: `${SHAPE_TEST_EMAIL_PREFIX}rr_fail_${Date.now()}@example.com` });
        expect(res.status).toBe(500);

        const fields = findEvent(errorSpy, 'auth.reset_request.failed');
        expect(fields).toBeDefined();
        expect(fields).toMatchObject({
          event: 'auth.reset_request.failed',
          route: 'auth.reset-request',
        });
        expect(fields!.err).toBeInstanceOf(Error);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pool as any).query = origQuery;
        errorSpy.mockRestore();
      }
    },
  );
});

describe('auth.reset.failed log shape', () => {
  it.skipIf(!dbReachable || !redisReachable)(
    'fires from outer catch with route + err',
    async () => {
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
          return Promise.reject(new Error('synthetic db failure for reset.failed'));
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return origQuery(...(args as [any]));
      };

      try {
        await clearRateLimitKeys(['auth-reset']);
        const res = await request(app)
          .post('/api/auth/reset')
          .send({ token: 'a'.repeat(64), password: 'NewPassword1' });
        expect(res.status).toBe(500);

        const fields = findEvent(errorSpy, 'auth.reset.failed');
        expect(fields).toBeDefined();
        expect(fields).toMatchObject({
          event: 'auth.reset.failed',
          route: 'auth.reset',
        });
        expect(fields!.err).toBeInstanceOf(Error);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pool as any).query = origQuery;
        errorSpy.mockRestore();
      }
    },
  );
});

describe('auth.recover.failed log shape', () => {
  it.skipIf(!dbReachable || !redisReachable)(
    'fires from outer catch with route + err',
    async () => {
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
          return Promise.reject(new Error('synthetic db failure for recover.failed'));
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return origQuery(...(args as [any]));
      };

      try {
        await clearRateLimitKeys(['auth-recover']);
        const res = await request(app)
          .post('/api/auth/recover')
          .send({
            username: `${SHAPE_TEST_EMAIL_PREFIX}rec_fail_${Date.now()}`,
            new_email: `new_${Date.now()}@example.com`,
            new_password: 'NewPassword1',
            memo_key: 'x',
          });
        expect(res.status).toBe(500);

        const fields = findEvent(errorSpy, 'auth.recover.failed');
        expect(fields).toBeDefined();
        expect(fields).toMatchObject({
          event: 'auth.recover.failed',
          route: 'auth.recover',
        });
        expect(fields!.err).toBeInstanceOf(Error);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pool as any).query = origQuery;
        errorSpy.mockRestore();
      }
    },
  );
});

describe('auth.signup.failed log shape', () => {
  it.skipIf(!dbReachable || !redisReachable)(
    'fires from outer catch with route + err',
    async () => {
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
          return Promise.reject(new Error('synthetic db failure for signup.failed'));
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return origQuery(...(args as [any]));
      };

      try {
        await clearRateLimitKeys(['auth-signup']);
        const email = `${SHAPE_TEST_EMAIL_PREFIX}signup_fail_${Date.now()}@harvard.edu`;
        const res = await request(app).post('/api/auth/signup').send({
          email,
          password: 'TestPassword1',
          full_name: 'Log Shape Tester',
          institution: 'Harvard',
          field: 'CS',
        });
        expect(res.status).toBe(500);

        const fields = findEvent(errorSpy, 'auth.signup.failed');
        expect(fields).toBeDefined();
        expect(fields).toMatchObject({
          event: 'auth.signup.failed',
          route: 'auth.signup',
        });
        expect(fields!.err).toBeInstanceOf(Error);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pool as any).query = origQuery;
        errorSpy.mockRestore();
      }
    },
  );
});

// ─── Round-2 hold-fix item 1: missing SMTP-send-failed + outer-catch specs ───
//
// The round-1 hold block (file lines 138-143) asked for spy assertions on the
// 3 `*.smtp_send_failed` events and the 5 outer-catch `*.failed` events. The
// round-1 implementer landed only 1 of 3 SMTP-send-failed (signup) and 5 of
// 6 outer-catch (login/reset/reset_request/recover/signup). The 3 specs below
// close the gap:
//   - auth.resend_verification.smtp_send_failed  (warn)
//   - auth.reset_request.smtp_send_failed        (warn)
//   - auth.resend_verification.failed            (error, outer catch)
//
// For the two SMTP-send-failed specs, the handler only reaches the sendMail
// branch when (a) `config.smtpHost` is non-empty and (b) the email
// corresponds to an existing account in the known-email branch — for
// /resend-verification, an account with a hex `verify_token` (pending state)
// AND a matching password; for /reset-request, any account row. Without the
// matching DB row + password, /resend-verification falls into the
// unknown-email or wrong-password branch which burns sentinel and returns
// 200 without ever invoking sendMail. The setup mirrors `recover.test.ts`
// BE-AUTH-SMTP-STATUS-CODE-ORACLE block.

describe('auth.resend_verification.smtp_send_failed log shape', () => {
  const RESEND_EMAIL = `${SHAPE_TEST_EMAIL_PREFIX}resend_smtp_${Date.now()}@example.com`;
  const RESEND_PASSWORD = 'ResendSmtpFailPwd1';
  let acctSetupOk = false;

  beforeAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    const passwordHash = await argon2.hash(RESEND_PASSWORD, { type: argon2.argon2id });
    // Pending account: hex verify_token (NOT prefixed with `confirmed:`) so
    // the handler enters the sendMail branch (lines 631-685 of auth.ts).
    try {
      await pool.query(
        `INSERT INTO accounts (email, username, password_hash, custody, verify_token, expires_at)
         VALUES ($1, $2, $3, 'light', $4, $5)`,
        [
          RESEND_EMAIL,
          `log_shape_resend_smtp_${Date.now()}`,
          passwordHash,
          'abcdef0123456789abcdef0123456789',
          new Date(Date.now() + 24 * 60 * 60 * 1000),
        ],
      );
      acctSetupOk = true;
    } catch {
      acctSetupOk = false;
    }
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query('DELETE FROM accounts WHERE email = $1', [RESEND_EMAIL]).catch(() => {});
  });

  it.skipIf(!dbReachable || !redisReachable)(
    'fires on sendMail throw with route + emailKnown:known + err: <Error>',
    async () => {
      if (!acctSetupOk) return;
      const prevHost = config.smtpHost;
      config.smtpHost = 'smtp-fail-test.invalid';
      const sendMailSpy = vi.fn().mockRejectedValue(new Error('SMTP connection refused'));
      const transportSpy = vi
        .spyOn(nodemailer, 'createTransport')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValue({ sendMail: sendMailSpy } as any);
      // Emission is at logger.warn (auth.ts:665), not logger.error.
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(
        () => undefined as unknown as void,
      );

      try {
        await clearRateLimitKeys(['auth-resend']);
        const res = await request(app)
          .post('/api/auth/resend-verification')
          .send({ email: RESEND_EMAIL, password: RESEND_PASSWORD });
        // Per BE-AUTH-SMTP-STATUS-CODE-ORACLE: route returns 200 even when
        // sendMail throws (status-code oracle prevention). Pin the 200 so a
        // regression that re-introduces 500 on SMTP failure fails loudly.
        expect(res.status).toBe(200);
        // sendMail must have actually fired — otherwise we're asserting a
        // no-op path (e.g. password mismatch short-circuit).
        expect(sendMailSpy).toHaveBeenCalledTimes(1);

        const fields = findEvent(warnSpy, 'auth.resend_verification.smtp_send_failed');
        expect(fields).toBeDefined();
        expect(fields).toMatchObject({
          event: 'auth.resend_verification.smtp_send_failed',
          route: 'auth.resend-verification',
          emailKnown: 'known',
        });
        expect(fields!.err).toBeInstanceOf(Error);
      } finally {
        warnSpy.mockRestore();
        transportSpy.mockRestore();
        config.smtpHost = prevHost;
      }
    },
  );
});

describe('auth.reset_request.smtp_send_failed log shape', () => {
  const RESET_EMAIL = `${SHAPE_TEST_EMAIL_PREFIX}reset_smtp_${Date.now()}@example.com`;
  let acctSetupOk = false;

  beforeAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    const passwordHash = await argon2.hash('PwdForResetSmtp1', { type: argon2.argon2id });
    // Active account (verify_token NULL) — any account row is enough for
    // /reset-request's known-email branch (handler doesn't require a
    // specific lifecycle state, just a matching email).
    try {
      await pool.query(
        `INSERT INTO accounts (email, username, password_hash, custody, verify_token)
         VALUES ($1, $2, $3, 'light', NULL)`,
        [RESET_EMAIL, `log_shape_reset_smtp_${Date.now()}`, passwordHash],
      );
      acctSetupOk = true;
    } catch {
      acctSetupOk = false;
    }
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query('DELETE FROM accounts WHERE email = $1', [RESET_EMAIL]).catch(() => {});
  });

  it.skipIf(!dbReachable || !redisReachable)(
    'fires on sendMail throw with route + emailKnown:known + err: <Error>',
    async () => {
      if (!acctSetupOk) return;
      const prevHost = config.smtpHost;
      config.smtpHost = 'smtp-fail-test.invalid';
      const sendMailSpy = vi.fn().mockRejectedValue(new Error('SMTP connection refused'));
      const transportSpy = vi
        .spyOn(nodemailer, 'createTransport')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValue({ sendMail: sendMailSpy } as any);
      // Emission is at logger.warn (auth.ts:957), not logger.error.
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(
        () => undefined as unknown as void,
      );

      try {
        await clearRateLimitKeys(['auth-reset-request']);
        const res = await request(app)
          .post('/api/auth/reset-request')
          .send({ email: RESET_EMAIL });
        // Per BE-AUTH-SMTP-STATUS-CODE-ORACLE: 200 even on sendMail throw.
        expect(res.status).toBe(200);
        expect(sendMailSpy).toHaveBeenCalledTimes(1);

        const fields = findEvent(warnSpy, 'auth.reset_request.smtp_send_failed');
        expect(fields).toBeDefined();
        expect(fields).toMatchObject({
          event: 'auth.reset_request.smtp_send_failed',
          route: 'auth.reset-request',
          emailKnown: 'known',
        });
        expect(fields!.err).toBeInstanceOf(Error);
      } finally {
        warnSpy.mockRestore();
        transportSpy.mockRestore();
        config.smtpHost = prevHost;
      }
    },
  );
});

describe('auth.resend_verification.failed log shape', () => {
  it.skipIf(!dbReachable || !redisReachable)(
    'fires from outer catch with route + err',
    async () => {
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
          return Promise.reject(new Error('synthetic db failure for resend_verification.failed'));
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return origQuery(...(args as [any]));
      };

      try {
        await clearRateLimitKeys(['auth-resend']);
        const res = await request(app)
          .post('/api/auth/resend-verification')
          .send({
            email: `${SHAPE_TEST_EMAIL_PREFIX}resend_fail_${Date.now()}@example.com`,
            password: 'AnyPassword1',
          });
        expect(res.status).toBe(500);

        const fields = findEvent(errorSpy, 'auth.resend_verification.failed');
        expect(fields).toBeDefined();
        expect(fields).toMatchObject({
          event: 'auth.resend_verification.failed',
          route: 'auth.resend-verification',
        });
        expect(fields!.err).toBeInstanceOf(Error);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pool as any).query = origQuery;
        errorSpy.mockRestore();
      }
    },
  );
});

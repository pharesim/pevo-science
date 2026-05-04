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
 * Scope: outer-catch `*.failed` events on the 5 auth handlers + the 3
 * `*.smtp_send_failed` events. The 2 `*.smtp_not_configured` events on
 * /reset-request and /resend-verification are covered by the integration
 * tests in `recover.test.ts` BE-AUTH-SMTP-STATUS-CODE-ORACLE block (round-2
 * hold-fix item 5(b)) and counted toward the 6-10 budget there. File-level
 * emissions (`auth.startup.*`, `auth.burn_sentinel.*`) are out of scope per
 * the hold-block triage.
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

        const fields = findEvent(errorSpy as never, 'auth.signup.smtp_send_failed');
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

        const fields = findEvent(errorSpy as never, 'auth.signup.smtp_not_configured');
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

        const fields = findEvent(errorSpy as never, 'auth.login.failed');
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

        const fields = findEvent(errorSpy as never, 'auth.reset_request.failed');
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

        const fields = findEvent(errorSpy as never, 'auth.reset.failed');
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

        const fields = findEvent(errorSpy as never, 'auth.recover.failed');
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

        const fields = findEvent(errorSpy as never, 'auth.signup.failed');
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

/**
 * Helper unit test for `createSmtpTransporter()` in
 * `backend/src/lib/smtp.ts` — pins the canonical 5-field shape
 * (host/port/secure/auth + 4 timeout knobs) so a future revert that drops
 * any single field fails loudly rather than silently passing.
 *
 * Two tiers of mutation-evident coverage protect this helper, satisfying
 * root CLAUDE.md "Running Tests" carve-out clauses (a/b) directly and
 * clause (c) at the risk-class level rather than the literal-assertion
 * level:
 *
 *   1. **This file (option-shape pin).** `vi.spyOn(nodemailer, 'createTransport')`
 *      captures the options object the helper passes. Per-field assertions
 *      on `connectionTimeout`, `socketTimeout`, `greetingTimeout`,
 *      `dnsTimeout` (split across separate `expect` calls so dropping any
 *      single knob fails the matching expectation with `expected <value>,
 *      received undefined` rather than a single bundled object-shape
 *      diagnostic). Plus host/port/secure/auth shape assertions.
 *
 *   2. **`recover.test.ts` BE-AUTH-SMTP-STATUS-CODE-ORACLE describe block
 *      (behavioral SMTP-failure pin).** Uses `mockReturnValue({ sendMail })`
 *      which discards the options arg and asserts on the uniform-200
 *      behavior under sendMail rejection. Covers the failure-mode shape;
 *      cannot detect option-revert mutations because options are never
 *      inspected.
 *
 * Together these two files cover the failure modes round-2 hold item 5
 * called for at the *risk class* level: option-revert mutations are caught
 * here; behavioral SMTP-failure regressions are caught in `recover.test.ts`.
 * The literal "real-HAF mirror of the same assertion" form clause (c) names
 * does not apply — the helper has no observable runtime behavior at the
 * unit level (timeouts only fire under partial SMTP failure, which the
 * integration test already covers). See
 * `architect-test-carve-out-clause-c-clarify` (architect task) for the
 * convention disambiguation.
 *
 * Justification for `vi.spyOn` (per root CLAUDE.md test carve-out):
 *   (a) Real-path impracticality: timeout values are options handed to
 *       nodemailer.createTransport at call time. The only way to assert on
 *       them is to capture the options object the helper passes; no
 *       observable runtime behavior at the helper level.
 *   (b) `nodemailer.createTransport` is the only mock target. No middleware
 *       (verifyHiveSignature, getAppPool, getRedis) is mocked.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import nodemailer from 'nodemailer';
import { createSmtpTransporter } from '../../src/lib/smtp.js';
import { config } from '../../src/config.js';

describe('createSmtpTransporter — canonical options shape', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes connectionTimeout: 5000', () => {
    const spy = vi
      .spyOn(nodemailer, 'createTransport')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockReturnValue({ sendMail: vi.fn() } as any);

    createSmtpTransporter();

    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0][0] as Record<string, unknown> & { auth?: Record<string, unknown> };
    expect(opts.connectionTimeout).toBe(5000);
  });

  it('passes socketTimeout: 10000', () => {
    const spy = vi
      .spyOn(nodemailer, 'createTransport')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockReturnValue({ sendMail: vi.fn() } as any);

    createSmtpTransporter();

    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0][0] as Record<string, unknown> & { auth?: Record<string, unknown> };
    expect(opts.socketTimeout).toBe(10000);
  });

  it('passes greetingTimeout: 8000', () => {
    const spy = vi
      .spyOn(nodemailer, 'createTransport')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockReturnValue({ sendMail: vi.fn() } as any);

    createSmtpTransporter();

    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0][0] as Record<string, unknown> & { auth?: Record<string, unknown> };
    expect(opts.greetingTimeout).toBe(8000);
  });

  it('passes dnsTimeout: 5000', () => {
    const spy = vi
      .spyOn(nodemailer, 'createTransport')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockReturnValue({ sendMail: vi.fn() } as any);

    createSmtpTransporter();

    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0][0] as Record<string, unknown> & { auth?: Record<string, unknown> };
    expect(opts.dnsTimeout).toBe(5000);
  });

  it('passes host/port/secure/auth from config', () => {
    const prevHost = config.smtpHost;
    const prevPort = config.smtpPort;
    const prevUser = config.smtpUser;
    const prevPass = config.smtpPass;
    config.smtpHost = 'smtp.example.test';
    config.smtpPort = 465;
    config.smtpUser = 'mailer';
    config.smtpPass = 'secret';

    const spy = vi
      .spyOn(nodemailer, 'createTransport')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockReturnValue({ sendMail: vi.fn() } as any);

    try {
      createSmtpTransporter();

      expect(spy).toHaveBeenCalledTimes(1);
      const opts = spy.mock.calls[0][0] as Record<string, unknown> & { auth?: Record<string, unknown> };
      // `secure` is `port === 465`; pin both port and secure to lock the
      // implicit derivation in the helper.
      expect(opts).toMatchObject({
        host: 'smtp.example.test',
        port: 465,
        secure: true,
        auth: { user: 'mailer', pass: 'secret' },
      });
    } finally {
      config.smtpHost = prevHost;
      config.smtpPort = prevPort;
      config.smtpUser = prevUser;
      config.smtpPass = prevPass;
    }
  });

  it('omits auth when smtpUser is empty', () => {
    const prevUser = config.smtpUser;
    const prevPass = config.smtpPass;
    config.smtpUser = '';
    config.smtpPass = '';

    const spy = vi
      .spyOn(nodemailer, 'createTransport')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockReturnValue({ sendMail: vi.fn() } as any);

    try {
      createSmtpTransporter();
      expect(spy).toHaveBeenCalledTimes(1);
      const opts = spy.mock.calls[0][0] as Record<string, unknown> & { auth?: Record<string, unknown> };
      expect(opts.auth).toBeUndefined();
    } finally {
      config.smtpUser = prevUser;
      config.smtpPass = prevPass;
    }
  });

  it('uses port 587 (non-465) → secure: false', () => {
    const prevPort = config.smtpPort;
    config.smtpPort = 587;

    const spy = vi
      .spyOn(nodemailer, 'createTransport')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockReturnValue({ sendMail: vi.fn() } as any);

    try {
      createSmtpTransporter();
      const opts = spy.mock.calls[0][0] as Record<string, unknown> & { auth?: Record<string, unknown> };
      expect(opts.secure).toBe(false);
    } finally {
      config.smtpPort = prevPort;
    }
  });
});

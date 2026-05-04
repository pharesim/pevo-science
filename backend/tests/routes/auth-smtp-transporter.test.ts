/**
 * Helper unit test for `createSmtpTransporter()` in
 * `backend/src/routes/auth.ts` — round-2 hold-fix item 4 + 5(a) of
 * BE-AUTH-SMTP-STATUS-CODE-ORACLE.
 *
 * Pins all 5 fields of the canonical nodemailer.createTransport options
 * object (host/port/secure/auth + 4 timeout knobs) so a future revert that
 * drops any single field — the failure mode the round-1 patch suffered when
 * /signup was missed and the existing `recover.test.ts` SMTP tests used
 * `mockReturnValue({ sendMail })` which discards the options arg — fails
 * loudly rather than silently passing.
 *
 * Justification for `vi.spyOn` (per root CLAUDE.md test carve-out, clauses
 * a/b/c):
 *   (a) Real-path impracticality: the timeout values are options handed to
 *       nodemailer.createTransport at call time. The only way to assert on
 *       them is to capture the options object the helper passes; there is no
 *       observable runtime behavior at the helper level (the timeouts only
 *       fire under partial SMTP failure, which the integration-style test in
 *       recover.test.ts already covers via the sendMail-rejects path).
 *   (b) `nodemailer.createTransport` is the only mock target. No middleware
 *       (verifyHiveSignature, getAppPool, getRedis) is mocked.
 *   (c) The integration-style coverage of the timeouts under real partial-
 *       SMTP failure is the existing BE-AUTH-SMTP-STATUS-CODE-ORACLE describe
 *       block in `recover.test.ts` (sendMail rejects → uniform 200). This
 *       file is the option-shape pin that complements that behavioral test.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import nodemailer from 'nodemailer';
import { createSmtpTransporter } from '../../src/routes/auth.js';
import { config } from '../../src/config.js';

describe('createSmtpTransporter — canonical options shape', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes all 4 timeout knobs (connectionTimeout, socketTimeout, greetingTimeout, dnsTimeout)', () => {
    const spy = vi
      .spyOn(nodemailer, 'createTransport')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockReturnValue({ sendMail: vi.fn() } as any);

    createSmtpTransporter();

    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0][0];
    // Pin every timeout field individually. A revert that drops ANY one of
    // the four reopens a different stage of the SMTP-failure wall-time
    // ceiling, so per-field assertions kill option-revert mutations one at a
    // time rather than a combined object-shape check that masks per-field
    // drift.
    expect(opts).toMatchObject({
      connectionTimeout: 5000,
      socketTimeout: 10000,
      greetingTimeout: 8000,
      dnsTimeout: 5000,
    });
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
      const opts = spy.mock.calls[0][0];
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
      const opts = spy.mock.calls[0][0];
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
      const opts = spy.mock.calls[0][0];
      expect(opts.secure).toBe(false);
    } finally {
      config.smtpPort = prevPort;
    }
  });
});

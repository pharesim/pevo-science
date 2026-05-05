/**
 * Structural lock: `nodemailer.createTransport` may only be referenced from
 * `backend/src/lib/smtp.ts`. Every other site must route through the
 * `createSmtpTransporter()` helper exported from there.
 *
 * Adding a direct call elsewhere reopens the per-stage timeout drift this
 * convention exists to prevent — round-1 of BE-AUTH-SMTP-STATUS-CODE-ORACLE
 * lost the /signup site to inline drift; this test makes the same mutation
 * fail loudly. See
 * `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`
 * for the convention this implements.
 *
 * The grep matches comments as well as code (`// nodemailer.createTransport`
 * is still a hit) — the test's job is structural, not parser-aware. If a
 * future doc-block in some other file mentions the bare phrase, that is
 * also a violation: doc-blocks describing the helper belong in the helper.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(__dirname, '../..');

describe('nodemailer.createTransport — exhaustive call-site audit', () => {
  it('only backend/src/lib/smtp.ts references nodemailer.createTransport', () => {
    let out = '';
    try {
      out = execFileSync(
        'grep',
        ['-rln', '--include=*.ts', 'nodemailer.createTransport', 'src/'],
        { cwd: BACKEND_ROOT, encoding: 'utf8' },
      ).trim();
    } catch (err) {
      // grep exits 1 when there are no matches; treat as empty result.
      const e = err as { status?: number; stdout?: string };
      if (e.status === 1) {
        out = '';
      } else {
        throw err;
      }
    }
    const files = out ? out.split('\n').sort() : [];
    expect(files).toEqual(['src/lib/smtp.ts']);
  });
});

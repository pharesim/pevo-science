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
 * The grep matches nodemailer *import statements* — ES `from 'nodemailer'`
 * or CJS `require('nodemailer')` — anywhere under `src/`, regardless of how
 * `createTransport` is referenced afterward. A bare `// nodemailer.createTransport`
 * comment is NOT a hit: the lock fires on the import that any direct call
 * would require, not on the phrase. The test's job is structural, not
 * parser-aware; routing every send through the helper means only the helper
 * imports nodemailer.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(__dirname, '../..');

describe('nodemailer imports — exhaustive call-site audit', () => {
  it('only backend/src/lib/smtp.ts imports nodemailer', () => {
    let out = '';
    try {
      out = execFileSync(
        'grep',
        ['-rlnE', '--include=*.ts', "(from|require\\().*['\"]nodemailer['\"]", 'src/'],
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

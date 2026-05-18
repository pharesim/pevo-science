/**
 * Unit coverage for `hashUserAgentForAudit` in `backend/src/routes/custody.ts`.
 *
 * The helper hashes the request's User-Agent header before it reaches the
 * audit-log writer, satisfying GDPR Art. 5(1)(c) data minimization for
 * `custody_audit_log.user_agent` (see migration 006 COMMENT). The
 * route-level integration assertions live alongside the consent-op
 * broadcast happy paths in `custody-consent-ops.test.ts`; this file pins
 * the pure-function contract — including the non-string defensive guard
 * that wire-level supertest cannot drive (Node's HTTP parser always
 * coerces a User-Agent header to a string, so the array-or-other-type
 * branch is reachable only via direct invocation).
 */

import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { hashUserAgentForAudit } from '../../src/routes/custody.js';

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

describe('hashUserAgentForAudit', () => {
  it('returns full 64-char lowercase hex SHA-256 of a non-empty string', () => {
    const out = hashUserAgentForAudit('Mozilla/5.0 (X11; Linux x86_64)');
    expect(out).toMatch(/^[0-9a-f]{64}$/);
    expect(out).toBe(sha256Hex('Mozilla/5.0 (X11; Linux x86_64)'));
  });

  it('is deterministic — same UA yields same hash (correlation-across-ops invariant)', () => {
    const a = hashUserAgentForAudit('PEvO-Test/1.0');
    const b = hashUserAgentForAudit('PEvO-Test/1.0');
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it('produces different hashes for different UAs (no collisions at test scale)', () => {
    const inputs = [
      'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15',
      'PEvO-Test/1.0',
      'PEvO-Test/2.0',
      'curl/8.5.0',
      'okhttp/4.12.0',
    ];
    const outputs = inputs.map((ua) => hashUserAgentForAudit(ua)!);
    expect(new Set(outputs).size).toBe(inputs.length);
  });

  it('returns undefined for absent header (undefined input)', () => {
    expect(hashUserAgentForAudit(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(hashUserAgentForAudit('')).toBeUndefined();
  });

  it('returns undefined for non-string inputs (defensive narrowing against req.headers typing)', () => {
    // `req.headers['user-agent']` is typed `string | string[] | undefined`;
    // Node's parser narrows to `string` in practice, but the helper guards
    // against the array form (and any other non-string Express-middleware
    // mutation) so the audit-log writer never receives a non-hash value.
    expect(hashUserAgentForAudit(['Mozilla/5.0', 'CrawlerBot/1.0'])).toBeUndefined();
    expect(hashUserAgentForAudit(null)).toBeUndefined();
    expect(hashUserAgentForAudit(42)).toBeUndefined();
    expect(hashUserAgentForAudit({ value: 'PEvO/1.0' })).toBeUndefined();
    expect(hashUserAgentForAudit(true)).toBeUndefined();
  });

  it('pinned hash value (mutation-kill for the digest algorithm choice)', () => {
    // SHA-256('PEvO-Test/1.0') pre-computed — a regression that swaps to
    // SHA-1, MD5, HMAC-with-default-key, or a truncating slice surfaces as
    // an inequality on this exact hex string. Generated via:
    //   node -e "console.log(require('crypto').createHash('sha256').update('PEvO-Test/1.0').digest('hex'))"
    expect(hashUserAgentForAudit('PEvO-Test/1.0')).toBe(
      'f166f6db304c5060d51733360c7e123f645db0c5f53e5740e246f2d0946675e2',
    );
  });
});

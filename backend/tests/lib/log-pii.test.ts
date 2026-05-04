import { describe, it, expect } from 'vitest';
import { hashEmailForLogs, hashTokenForLogs } from '../../src/lib/log-pii.js';

describe('hashEmailForLogs', () => {
  it('is deterministic — same input yields same output', () => {
    const a = hashEmailForLogs('alice@example.com');
    const b = hashEmailForLogs('alice@example.com');
    expect(a).toBe(b);
  });

  it('produces different outputs for different inputs (no collisions at test scale)', () => {
    const inputs = [
      'alice@example.com',
      'bob@example.com',
      'carol@example.com',
      'dave@university.edu',
      'eve@uni-freiburg.de',
      'alice@example.org',
    ];
    const outputs = inputs.map((e) => hashEmailForLogs(e));
    expect(new Set(outputs).size).toBe(inputs.length);
  });

  it('returns exactly 12 lowercase hex characters', () => {
    const out = hashEmailForLogs('someone@example.com');
    expect(out).toMatch(/^[0-9a-f]{12}$/);
    expect(out.length).toBe(12);
  });

  it('is case-insensitive and trims whitespace (normalization)', () => {
    const canonical = hashEmailForLogs('alice@example.com');
    expect(hashEmailForLogs('Alice@Example.COM')).toBe(canonical);
    expect(hashEmailForLogs('  alice@example.com  ')).toBe(canonical);
    expect(hashEmailForLogs('ALICE@EXAMPLE.COM')).toBe(canonical);
  });

  it('is not reversible — output does not contain any substring of the input email', () => {
    const email = 'alice@example.com';
    const out = hashEmailForLogs(email);
    // Spot-check: no contiguous 3-char substring of the email appears in the
    // hex output. Substrings of length 3 catch things like 'ali', 'ice', 'com'.
    const lower = email.toLowerCase();
    for (let i = 0; i <= lower.length - 3; i++) {
      const sub = lower.slice(i, i + 3);
      // Only flag if the substring is made entirely of hex chars (otherwise
      // it can't appear in a hex output by construction).
      if (/^[0-9a-f]{3}$/.test(sub)) {
        expect(out.includes(sub)).toBe(false);
      }
    }
  });

  it('does not leak the local-part or domain of a typical email', () => {
    const out = hashEmailForLogs('alice@example.com');
    expect(out).not.toContain('alice');
    expect(out).not.toContain('example');
    expect(out).not.toContain('com');
  });
});

// Round-4 hold #10: hashTokenForLogs parity coverage. The accreditation /verify
// route emits `token_hash` in operator-log paths (decrement-failure warn,
// cleanup-failure error, cap-exceeded warn) using this helper. Without these
// specs, a regression that changes the truncation length, swaps the algorithm,
// or drops normalization would silently shift the on-disk hash shape and break
// operator dashboards that grep for `token_hash` against a stable prefix.
describe('hashTokenForLogs', () => {
  it('is deterministic — same input yields same output', () => {
    const tok = 'a'.repeat(64);
    const a = hashTokenForLogs(tok);
    const b = hashTokenForLogs(tok);
    expect(a).toBe(b);
  });

  it('produces different outputs for different inputs (no collisions at test scale)', () => {
    const inputs = [
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      '0123456789abcdef'.repeat(4),
      'fedcba9876543210'.repeat(4),
      // Realistic token shape from the route: crypto.randomBytes(32).toString('hex')
      'a3f2c8e1b7d4569012345678abcdef0fedcba98765432100123456789abcdef0',
    ];
    const outputs = inputs.map((t) => hashTokenForLogs(t));
    expect(new Set(outputs).size).toBe(inputs.length);
  });

  it('returns exactly 12 lowercase hex characters', () => {
    const out = hashTokenForLogs('0123456789abcdef'.repeat(4));
    expect(out).toMatch(/^[0-9a-f]{12}$/);
    expect(out.length).toBe(12);
  });

  it('does NOT normalize input — case-different tokens yield different hashes', () => {
    // hashEmailForLogs lowercases its input because email addresses are
    // case-insensitive at the application layer. Tokens are uniformly hex-
    // encoded by `crypto.randomBytes(32).toString('hex')` (always lowercase),
    // so normalization is unnecessary and would mask a regression where
    // an upstream typed-the-token path passed an uppercase variant. Pin
    // the no-normalization invariant explicitly.
    const lower = 'abcdef'.repeat(10) + 'abcd';
    const upper = lower.toUpperCase();
    expect(lower.length).toBe(64);
    expect(upper.length).toBe(64);
    expect(hashTokenForLogs(lower)).not.toBe(hashTokenForLogs(upper));
  });

  it('is not reversible — output does not contain any 3-char hex substring of the input token', () => {
    const tok = 'a3f2c8e1b7d4569012345678abcdef0fedcba98765432100123456789abcdef0';
    const out = hashTokenForLogs(tok);
    for (let i = 0; i <= tok.length - 3; i++) {
      const sub = tok.slice(i, i + 3);
      // All token substrings ARE hex, so every window is a candidate.
      expect(out.includes(sub)).toBe(false);
    }
  });

  it('does not leak any 12-or-more-char prefix of the input token', () => {
    const tok = 'a3f2c8e1b7d4569012345678abcdef0fedcba98765432100123456789abcdef0';
    const out = hashTokenForLogs(tok);
    // The output IS 12 hex chars; assert it does not equal any 12-char
    // prefix of the input (would imply truncation-of-input rather than
    // hashing).
    for (let i = 0; i <= tok.length - 12; i++) {
      const window = tok.slice(i, i + 12);
      expect(out).not.toBe(window);
    }
  });
});

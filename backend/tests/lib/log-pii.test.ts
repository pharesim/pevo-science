import { describe, it, expect } from 'vitest';
import { hashEmailForLogs, hashTokenForLogs, maskEmail } from '../../src/lib/log-pii.js';

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

  // Value-pinned hash assertion. Replaces an earlier pair of substring-based
  // "is not reversible" / "does not leak" tests that were vacuous: the
  // alice@example.com input contains no 3-char hex windows, and 'alice' /
  // 'example' / 'com' each contain non-hex characters, so the inner expects
  // either never fired or could not structurally fail. This single assertion
  // simultaneously kills algorithm-swap (sha256 → md5/sha1), truncation-length
  // (12 → 16/8), and normalization-removal (drop trim/lowercase) mutations,
  // because any of them changes the pinned hex output.
  it('returns the pinned 12-hex sha256 prefix for a canonical input', () => {
    expect(hashEmailForLogs('alice@example.com')).toBe('ff8d9819fc0e');
  });
});

// `hashTokenForLogs` parity coverage. The accreditation /verify route emits
// `token_hash` in operator-log paths (decrement-failure warn, cleanup-failure
// error, cap-exceeded warn) using this helper. Without these specs, a
// regression that changes the truncation length, swaps the algorithm, or
// drops normalization would silently shift the on-disk hash shape and break
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

// `maskEmail` partial-redaction coverage. Distinct from `hashEmailForLogs`:
// this helper produces user-facing confirmation strings (e.g. "Verification
// email sent to j***h@***.edu") where the user needs to recognize their own
// address but the response must not echo the full plaintext. Pinned shapes
// kill mutations that change the local-mask split (long vs. short), the
// tld-extraction rule (last dot vs. first dot vs. full domain), or the
// fallback shape. The pre-extract accreditation copy had a dead
// `length <= 2 ? '${local[0]}***' : '${local[0]}***'` conditional (both
// branches identical) and the settings copy returned the full domain
// unmasked — these tests fail-loud if either regression re-appears.
describe('maskEmail', () => {
  it('short local (1 char) → first-char + *** + @***.tld', () => {
    expect(maskEmail('j@x.io')).toBe('j***@***.io');
  });

  it('short local (2 chars) → first-char + *** + @***.tld', () => {
    expect(maskEmail('jo@x.io')).toBe('j***@***.io');
  });

  it('long local (≥3 chars) → first + *** + last + @***.tld', () => {
    expect(maskEmail('joseph@mit.edu')).toBe('j***h@***.edu');
  });

  it('multi-dot domain uses ONLY the final tld (not the full suffix)', () => {
    expect(maskEmail('j@mail.example.co.uk')).toBe('j***@***.uk');
  });

  it('long local with multi-dot domain composes both rules', () => {
    expect(maskEmail('joseph@mail.example.co.uk')).toBe('j***h@***.uk');
  });

  it('missing @ returns the ***@*** fallback', () => {
    expect(maskEmail('not-an-email')).toBe('***@***');
  });

  it('empty string returns the ***@*** fallback', () => {
    expect(maskEmail('')).toBe('***@***');
  });

  it('multiple @ returns the ***@*** fallback (split count check)', () => {
    expect(maskEmail('a@b@c.io')).toBe('***@***');
  });

  it('leading @ (empty local) returns the ***@*** fallback', () => {
    expect(maskEmail('@example.com')).toBe('***@***');
  });

  it('trailing @ (empty domain) returns the ***@*** fallback', () => {
    expect(maskEmail('alice@')).toBe('***@***');
  });

  it('domain without a dot produces empty tld (no leak of full domain)', () => {
    // Regression guard: the original `settings.ts` copy returned
    // `parts[0][0] + '***@' + parts[1]` which echoed the full domain when
    // present. The canonical helper must never echo the full domain.
    expect(maskEmail('joseph@localhost')).toBe('j***h@***');
  });

  it('dead-conditional regression guard: long local does NOT collapse to first-char + ***', () => {
    // The pre-extract accreditation copy had `local.length <= 2 ?
    // '${local[0]}***' : '${local[0]}***'` (both branches identical), which
    // silently produced the short-local shape for ALL inputs. Assert the
    // long-local output is structurally different from the short-local one.
    expect(maskEmail('joseph@mit.edu')).not.toBe(maskEmail('jo@mit.edu'));
  });
});

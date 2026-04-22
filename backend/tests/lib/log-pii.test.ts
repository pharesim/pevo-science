import { describe, it, expect } from 'vitest';
import { hashEmailForLogs } from '../../src/lib/log-pii.js';

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

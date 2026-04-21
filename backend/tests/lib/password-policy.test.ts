import { describe, it, expect } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_POLICY_MESSAGE,
  isPasswordValid,
} from '../../src/lib/password-policy.js';

describe('password-policy', () => {
  it('exports MIN_PASSWORD_LENGTH = 10', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
  });

  it('accepts a password meeting every criterion', () => {
    expect(isPasswordValid('SecurePass123')).toBe(true);
  });

  it('rejects passwords shorter than the minimum length', () => {
    // 9 chars, has all three character classes — fails purely on length
    expect(isPasswordValid('Short9aBc')).toBe(false);
  });

  it('rejects passwords missing a lowercase letter', () => {
    expect(isPasswordValid('SECUREPASS123')).toBe(false);
  });

  it('rejects passwords missing an uppercase letter', () => {
    expect(isPasswordValid('securepass123')).toBe(false);
  });

  it('rejects passwords missing a digit', () => {
    expect(isPasswordValid('SecurePassword')).toBe(false);
  });

  it('accepts a password at exactly the minimum length when all classes present', () => {
    const pw = 'Abcdefgh12';
    expect(pw.length).toBe(MIN_PASSWORD_LENGTH);
    expect(isPasswordValid(pw)).toBe(true);
  });

  it('rejects non-string inputs without throwing', () => {
    expect(isPasswordValid(undefined)).toBe(false);
    expect(isPasswordValid(null)).toBe(false);
    expect(isPasswordValid(0)).toBe(false);
    expect(isPasswordValid(123456789012345)).toBe(false);
    expect(isPasswordValid({})).toBe(false);
    expect(isPasswordValid([])).toBe(false);
    expect(isPasswordValid(true)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isPasswordValid('')).toBe(false);
  });

  it('error message names every criterion users must satisfy', () => {
    expect(PASSWORD_POLICY_MESSAGE).toMatch(/10/);
    expect(PASSWORD_POLICY_MESSAGE).toMatch(/lowercase/i);
    expect(PASSWORD_POLICY_MESSAGE).toMatch(/uppercase/i);
    expect(PASSWORD_POLICY_MESSAGE).toMatch(/numbers?|digits?/i);
  });
});

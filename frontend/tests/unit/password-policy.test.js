import { describe, it, expect } from 'vitest';
import { isPasswordValid, MIN_PASSWORD_LENGTH } from '../../src/password-policy.js';

describe('password-policy', () => {
  it('exports MIN_PASSWORD_LENGTH = 10', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
  });

  it('accepts a valid password (>=10 chars, lower, upper, digit)', () => {
    expect(isPasswordValid('Abcdefghi1')).toBe(true);
    expect(isPasswordValid('LongerPassword123!')).toBe(true);
  });

  it('rejects a password shorter than 10 characters', () => {
    // 9 chars: A, 7 lowers, 1 digit.
    expect(isPasswordValid('Abcdefgh1')).toBe(false);
    expect(isPasswordValid('')).toBe(false);
  });

  it('rejects a password missing a lowercase letter', () => {
    expect(isPasswordValid('ABCDEFGHI1')).toBe(false);
  });

  it('rejects a password missing an uppercase letter', () => {
    expect(isPasswordValid('abcdefghi1')).toBe(false);
  });

  it('rejects a password missing a digit', () => {
    expect(isPasswordValid('Abcdefghij')).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(isPasswordValid(null)).toBe(false);
    expect(isPasswordValid(undefined)).toBe(false);
    expect(isPasswordValid(1234567890)).toBe(false);
    expect(isPasswordValid({})).toBe(false);
    expect(isPasswordValid([])).toBe(false);
    // eslint-disable-next-line no-new-wrappers
    expect(isPasswordValid(new String('Abcdefghi1'))).toBe(false);
  });

  it('accepts exactly 10 chars when all criteria present (boundary)', () => {
    // Exactly MIN_PASSWORD_LENGTH with lower+upper+digit.
    expect(isPasswordValid('Abcdefghi1')).toBe(true);
    expect('Abcdefghi1'.length).toBe(MIN_PASSWORD_LENGTH);
  });
});

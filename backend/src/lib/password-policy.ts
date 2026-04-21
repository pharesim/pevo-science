// Mirrors frontend/src/password-policy.js — both helpers must keep the
// same rule shape so FE-side checks and BE-side checks agree.

export const MIN_PASSWORD_LENGTH = 10;

export const PASSWORD_POLICY_MESSAGE =
  'Password must be at least 10 characters and contain lowercase letters, uppercase letters, and numbers';

export function isPasswordValid(pw: unknown): boolean {
  if (typeof pw !== 'string') return false;
  return (
    pw.length >= MIN_PASSWORD_LENGTH
    && /[a-z]/.test(pw)
    && /[A-Z]/.test(pw)
    && /[0-9]/.test(pw)
  );
}

// Keep in sync with backend/src/lib/password-policy.ts — the backend CI drift-check compares these two files.
//
// Shared password-policy helper for the frontend. Single source of truth
// for the light-account password rule, used by signup, recover,
// reset-password, and settings (set-password section).
//
// Policy: minimum length 10, at least one lowercase letter, at least one
// uppercase letter, at least one digit. Non-string inputs are rejected.

export const MIN_PASSWORD_LENGTH = 10;

export function isPasswordValid(pw) {
  if (typeof pw !== 'string') return false;
  return (
    pw.length >= MIN_PASSWORD_LENGTH
    && /[a-z]/.test(pw)
    && /[A-Z]/.test(pw)
    && /[0-9]/.test(pw)
  );
}

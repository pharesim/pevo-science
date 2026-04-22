// Mirrors frontend/src/password-policy.js — both helpers must keep the
// same rule shape so FE-side checks and BE-side checks agree.

export const MIN_PASSWORD_LENGTH = 10;

export const PASSWORD_POLICY_MESSAGE =
  'Password must be at least 10 characters and contain lowercase letters, uppercase letters, and numbers';

// Type-predicate guard so callers flow-narrow `pw` to `string` after the
// truthy check, avoiding downstream `as string` casts. The rule shape
// mirrors frontend/src/password-policy.js.
export function isPasswordValid(pw: unknown): pw is string {
  if (typeof pw !== 'string') return false;
  return (
    pw.length >= MIN_PASSWORD_LENGTH
    && /[a-z]/.test(pw)
    && /[A-Z]/.test(pw)
    && /[0-9]/.test(pw)
  );
}

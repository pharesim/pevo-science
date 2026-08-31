// Shared test fixture mirroring the `loginFromResponse` helper from
// frontend/src/auth.js. Used by every page-level test that mocks the
// auth store and asserts post-call state on mockAuthStore. Keeping the
// mirror in one file lets a single edit track helper semantics drift
// (atomic {token, expires_at} pair, preserve-on-undefined for the rest)
// across the 4+ test files that exercise login-style call sites.
//
// Usage:
//   import { mockLoginFromResponse } from './fixtures/mock-auth.js';
//   // ...
//   const mockAuthStore = {
//     // ... store fields ...
//     loginFromResponse: vi.fn(mockLoginFromResponse),
//   };
//
// The function is designed to be invoked as a method on a `this`-bound
// store object: `vi.fn(mockLoginFromResponse)` preserves the `this` ref
// when the consuming code calls `Alpine.store('auth').loginFromResponse(...)`.

export function mockLoginFromResponse(data) {
  // Mirror of the helper's subject-adoption step: a response subject that
  // differs from the tab's marked subject (or the store's current username
  // when the marker is unreadable) scrubs the subject-bound sessionStorage
  // keys, the way the real store routes every subject change through its
  // scrub. Module-held state (the password-factor memo, in-flight
  // acquisitions, the in-memory window mirror) cannot be mirrored here; the
  // real-store suite covers those against the real scrub.
  const subject = data.username !== undefined ? data.username : this.username;
  if (subject) {
    let marker = null;
    try {
      marker = sessionStorage.getItem('pevo_tab_subject');
    } catch { /* unavailable */ }
    const previous = marker ?? this.username;
    if (previous && previous !== subject) {
      for (const key of [
        'pevo_fresh_auth_session_proof',
        'pevo_fresh_auth_consent_op_proof',
        'pevo_fresh_auth_return_to',
        'pevo_orcid_mode',
        'pevo_orcid_return_to',
        'pevo_tab_subject',
      ]) {
        try {
          sessionStorage.removeItem(key);
        } catch { /* noop */ }
      }
    }
    try {
      sessionStorage.setItem('pevo_tab_subject', subject);
    } catch { /* noop */ }
  }
  if (data.token && data.expires_at) {
    this.token = data.token;
    this.expiresAt = data.expires_at;
  }
  if (data.username !== undefined) this.username = data.username;
  if (data.is_accredited !== undefined) this.isAccredited = data.is_accredited;
  if (data.accreditation !== undefined) this.accreditation = data.accreditation;
  if (data.custody !== undefined) this.custody = data.custody;
  this.isConnected = true;
  this._saveSession();
  this._startAccreditationPolling();
}

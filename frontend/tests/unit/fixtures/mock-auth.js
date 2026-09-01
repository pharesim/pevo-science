// Shared test fixture mirroring the `loginFromResponse` helper from
// frontend/src/auth.js. Used by every page-level test that mocks the
// auth store and asserts post-call state on mockAuthStore. Keeping the
// mirror in one file lets a single edit track helper semantics drift
// (atomic {token, expires_at} pair, preserve-on-undefined for the rest)
// across the 4+ test files that exercise login-style call sites.
//
// The subject-scrub key set is imported from the same module the real
// store's scrub loops (subject-bound-keys.js — dependency-free, so pulling
// it in here cannot disturb the consuming suites' partial module mocks),
// never hand-copied: a key added there is scrubbed by this mirror
// automatically. The parity test in auth.test.js additionally pins this
// mirror's sessionStorage effect against the real `loginFromResponse`.
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

import {
  SUBJECT_BOUND_STORAGE_KEYS,
  TAB_SUBJECT_KEY,
} from '../../../src/lib/subject-bound-keys.js';

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
      marker = sessionStorage.getItem(TAB_SUBJECT_KEY);
    } catch { /* unavailable */ }
    const previous = marker ?? this.username;
    if (previous && previous !== subject) {
      for (const key of SUBJECT_BOUND_STORAGE_KEYS) {
        try {
          sessionStorage.removeItem(key);
        } catch { /* noop */ }
      }
    }
    try {
      sessionStorage.setItem(TAB_SUBJECT_KEY, subject);
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

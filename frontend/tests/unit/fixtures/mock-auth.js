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

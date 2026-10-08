// The sessionStorage keys bound to the JWT subject — the state a logout or a
// cross-user re-login must scrub so the next subject on a shared browser
// cannot inherit the previous subject's proofs or in-flight ORCID context.
//
// This module is the single source of truth for that key set, and it is
// dependency-free ON PURPOSE: the auth store's subject scrub
// (`_scrubSubjectBoundState` in auth.js), the fresh-auth caches that own the
// proof keys (lib/fresh-auth.js), and the test fixture that mirrors the scrub
// for suites that mock the auth store (tests/unit/fixtures/mock-auth.js) all
// import from here. The fixture especially depends on the emptiness of this
// module's import graph — it is consumed by test files that partially mock
// `api.js` and `alpinejs`, so any dependency added here would drag those
// mocks' missing exports into every consumer.
//
// Adding a subject-bound sessionStorage key? Define it here and add it to
// SUBJECT_BOUND_STORAGE_KEYS below. The scrub and the fixture both loop the
// list, so membership here IS what makes a key scrubbed on subject change;
// the parity test in tests/unit/auth.test.js pins the real store and the
// fixture mirror against each other on top of it.
//
// The semantics of what each key holds stay documented next to the code that
// reads and writes it.

// The session-kind fresh_auth_proof window cache (lib/fresh-auth.js).
export const SESSION_PROOF_KEY = 'pevo_fresh_auth_session_proof';

// The consent_op-kind fresh_auth_proof cache (lib/fresh-auth.js).
export const CONSENT_OP_PROOF_KEY = 'pevo_fresh_auth_consent_op_proof';

// The pre-redirect return path for the ORCID fresh-auth round-trips
// (lib/fresh-auth.js).
export const RETURN_PATH_KEY = 'pevo_fresh_auth_return_to';

// The per-tab ORCID OAuth mode marker that routes /orcid/callback to the
// matching handler. The page-level flow starters (login, signup, recover,
// settings link, accreditation) write their mode values inline; fresh-auth's
// redirect helper writes the session_auth / fresh_auth modes.
export const ORCID_MODE_KEY = 'pevo_orcid_mode';

// The ORCID-flow return-path pointer some page flows stash alongside the mode
// marker (written by the recover flow, consumed by /orcid/callback).
export const ORCID_RETURN_TO_KEY = 'pevo_orcid_return_to';

// The per-tab marker naming the subject the rest of this state belongs to
// (written and read by the auth store's `_adoptSubject`).
export const TAB_SUBJECT_KEY = 'pevo_tab_subject';

// The composed work carried across the session-auth ORCID round-trip
// (lib/navigation-stash.js).
export const NAVIGATION_STASH_KEY = 'pevo_navigation_stash';

export const SUBJECT_BOUND_STORAGE_KEYS = Object.freeze([
  SESSION_PROOF_KEY,
  CONSENT_OP_PROOF_KEY,
  RETURN_PATH_KEY,
  ORCID_MODE_KEY,
  ORCID_RETURN_TO_KEY,
  TAB_SUBJECT_KEY,
  NAVIGATION_STASH_KEY,
]);

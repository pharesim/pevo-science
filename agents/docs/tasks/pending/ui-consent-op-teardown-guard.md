# Guard the consent-op orchestrators and retry legs against a subject teardown

**Owner:** ui
**Created:** 2026-09-01

Routed out of the architect review of the cross-user teardown work
(`1b9f2137` + `9ecff448` + `4c3e7c7a`). The teardown machinery landed correctly on
the session-window acquisition path but does not reach three adjacent surfaces that
consume the same primitives. Filed separately because the fix spans files outside
that task's scope.

## Why

`abandonInFlightAcquisitions` and the `_acquireGeneration` checks guard only
`acquireSessionProof` in `lib/fresh-auth.js`. Two consent-op orchestrators,
`withSettingsFreshAuth` (`lib/settings-fresh-auth.js`) and `withAuthorshipFreshAuth`
(`lib/authorship-consent.js`), call the same shared `resolvePasswordFactor` and
`mintViaPasswordFactor` with no generation or subject re-check, and their promise
chains live in a page component's click handler, not in module state the scrub can
reach. Separately, neither `_scrubSubjectBoundState` (`auth.js`) nor
`abandonInFlightAcquisitions` closes the shared reauth modal, so a prompt opened
before a teardown stays open and interactive after it.

The validated failure, confirmed end-to-end including the backend: a user opens a
settings critical-action prompt (delete_account, change_email) or an authorship
consent prompt and steps away; a second user signs in on the same tab (the storage
event runs the scrub); the prompt is still open; the second user types their
password; `mintViaPasswordFactor` mints under the CURRENT JWT (the api layer reads
the token at call time), and the backend binds the proof to that JWT subject at
mint time, so the first user's captured action runs against the second user's
account. The action class here is the most destructive in the app.

The same "teardown does not reach this path" shape recurs on two retry legs, folded
in here rather than filed separately:

- `broadcastWithFreshAuth`'s 401-retry rethrows a raw `username_mismatch` via its
  shape-preserving branch instead of routing it through
  `handleSessionInconsistency()`, so a mismatch surfacing on the retry lands at a
  generic "publishing failed" with no teardown (the first-attempt branch handles it
  correctly; the retry leg does not).
- `uploadFile`'s re-mint and aged-token retries call `attemptOnce` outside the
  `username_mismatch` catch, so a mismatch on a retry attempt escapes raw with no
  teardown.

## Scope

1. Put the guard in the shared layer so every consumer is covered at once. Have the
   subject scrub close the open reauth modal (`Alpine.store('reauthModal')?.cancel()`,
   which resolves the open request and unwinds every `mintViaPasswordFactor` caller
   as a clean cancel), AND capture `_acquireGeneration` inside `mintViaPasswordFactor`
   (same module as the generation counter), returning the clean-cancel outcome after
   each prompt resolution and after the mintFn when the generation moved. That covers
   the settings and authorship orchestrators and any retry re-prompt without
   per-orchestrator edits.
2. Route a retry-leg `username_mismatch` through `handleSessionInconsistency()` on
   both `broadcastWithFreshAuth`'s 401-retry and `uploadFile`'s retry attempts, so a
   mismatch surfacing on a retry tears down like a first-attempt mismatch does.

## Acceptance criteria

1. A password typed into a consent-op prompt (settings or authorship) left open
   across a cross-tab subject change does not spend a mint; the orchestrator unwinds
   as a clean cancel with a distinguishable message, not silently.
2. The scrub closes any open reauth modal, so a session-path prompt left open across
   a teardown is dismissed rather than left interactive (this also closes the
   session-path silent-cancel gap the teardown review surfaced).
3. A `username_mismatch` surfacing on `broadcastWithFreshAuth`'s 401-retry or on
   either `uploadFile` retry leg tears down through `handleSessionInconsistency()`,
   with a test per leg.

## Notes

The backend proof-to-subject binding (§ 6.4.1) is the load-bearing enforcement that
prevents a cross-account WRITE; this task closes the client-side action-on-behalf-of
and the missing-teardown UX so the client never spends a credential or runs an action
for a subject the tab no longer represents. The reachability of the consent-op case
was validated by an independent verification pass, not assumed.

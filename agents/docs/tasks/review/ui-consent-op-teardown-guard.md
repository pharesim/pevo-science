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

---

## UI implementation notes (2026-09-01)

**Mechanism.** `subjectTeardownGuard()` (fresh-auth.js) is the new shared primitive:
it snapshots the generation the subject scrub bumps and answers "was this stretch of
work abandoned" plus "how does this flow report that". `mintViaPasswordFactor` takes a
`guard` option (defaulting to one opened at its own entry, which is correct only for
the session path, whose first await IS the prompt).

**Three deviations from the Scope prescription, all deliberate:**

1. *Scope 1 said the shared-layer guard covers both orchestrators "without
   per-orchestrator edits". It does not, and both orchestrators were edited.* A guard
   captured at `mintViaPasswordFactor`'s entry is blind to a teardown that landed
   during the factor read both orchestrators await BEFORE entering it — it compares the
   post-teardown generation against itself and never fires, so the prompt opens, the
   mint spends under the new subject, and `run(proof)` executes the previous subject's
   captured action. That is the same harm AC1 names, one await earlier. The guard is
   therefore opened at each orchestrator's entry and threaded down through
   `resolveProof`, `mintViaPasswordFactor`, and the retry gate, matching how
   `acquireSessionProof` already threads its own. Verified by an independent adversarial
   pass (3 of 3 refutation attempts confirmed it); tests per orchestrator.

2. *A fourth retry leg was fixed beyond the three AC3 names.*
   `consentOpFreshAuthRetryGate`'s own retry `catch` returned the retryable
   `{ freshAuthFailed: true }` on a `username_mismatch`, contradicting that function's
   docblock. Same defect class as the two named legs, in the same function family;
   fixing three and leaving the fourth would have reopened the sweep at review. One
   test per consent-op surface.

3. *The first-attempt mismatch gate in `broadcastWithFreshAuth` lost its
   `status === 403` condition.* Both legs now share `isUsernameMismatch(err)`
   (code + `details.reason`, no status). Behaviour-preserving — the backend maps that
   reason to 403 only — and required on the retry leg, where the normalizing wrapper
   replaces `details` with a `cause` string, so a status-gated check could never see the
   reason. One predicate is also what stops the two legs drifting.

**One in-class parity fix inside a touched leg:** `retryOnce` in ipfs-upload.js branches
on a null proof the way the first attempt always has. Reachable exactly in this task's
scenario: a teardown between attempts leaves the store without light custody, so the
re-acquisition answers ready-with-no-proof and the old code passed that null through as
a proof.

**Not fixed, surfaced for triage** (per root CLAUDE.md "Code Review Findings"):

- A teardown cancel raised inside `uploadFile`'s own window acquisition reports twice:
  the teardown message, then the page's `common.uploadCancelled`. Suppressing the
  second needs a distinguishable outcome, i.e. a new member of the window-outcome
  vocabulary plus its `UPLOAD_*` code and `describeUploadError` arm. Both messages are
  true; the cost of the vocabulary widening looked worse than the noise.
- `broadcastConfirm` is the same "singleton prompt outlives the subject" shape as the
  reauth modal and the scrub does not dismiss it either. An adversarial pass refuted the
  cross-account-broadcast harm (the scrub drops the window, so a post-teardown Confirm
  lands on a full re-acquisition rather than a silent broadcast), so this is a UX
  residual, not a security one.

**Verification.** 1778/1778 frontend unit tests pass; production build clean. Every new
test was confirmed to fail against the unfixed code before the fix landed. No browser or
Playwright run: the change has no DOM surface of its own, and its one visible effect is
a toast in a two-tab, two-account race that the unit suite stages deterministically and
a manual session cannot.

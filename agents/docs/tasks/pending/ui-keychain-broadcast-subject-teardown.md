# A subject teardown during the Keychain broadcast prompt goes unnoticed

**Owner:** ui
**Created:** 2026-10-06
**Priority:** low

Routed out of the architect review of `ui-upload-batch-teardown-guard` (`4781efac`): the
implementer's out-of-scope follow-up 3.

## Why

`broadcastWithFreshAuth` in `frontend/src/lib/fresh-auth.js` returns
`broadcastOps(username, operations, broadcastOpts)` directly when `auth.custody !== 'light'`.
That branch opens no `subjectTeardownGuard`, unlike the light-account branch of the same function.
`broadcastOps` hands the operations to Keychain through `requestBroadcast`, which waits for
the user to approve in the extension. A cross-tab login or logout landing while that prompt
is open is not seen by this branch: the call resolves as it would without a teardown, and
its caller goes on to handle the result for a tab that now represents another subject or none.

Keychain signs and broadcasts with the key of the account named in `username`, the one
captured when the submit started. The gap is the parent invariant: the client finishes a
captured action and reports on it for a subject the tab no longer represents. Once the user
approves, Keychain has broadcast, so the page cannot undo it. It can only decide what to
report.

## Scope

Find what each caller of `broadcastWithFreshAuth` does with the result on the non-light
branch. If the subject changed while Keychain's prompt was open, the call reports the
teardown once through the guard's `cancel()` and does not present the outcome as an
ordinary success or failure for the current subject. Open the guard before the first await,
per the `subjectTeardownGuard` docblock. Ask before implementing if a caller needs the
broadcast result anyway, for example to record what landed.

## Acceptance criteria

1. On a self-custody (Keychain) account, a subject change while the Keychain prompt is open,
   followed by approval, shows exactly one teardown message and no success state.
2. The same change followed by rejection in Keychain shows exactly one teardown message and
   no failure message.
3. Light-account behaviour and the existing fresh-auth and page suites are unchanged and
   green; each new case is observed red at base.

## Architect note (2026-10-08): the settings self-custody branch folded in

Folded in at the architect review of `ui-state-d-session-settings-critical-actions`. User
triage: "as recommended".

`withSettingsFreshAuth` in `frontend/src/lib/settings-fresh-auth.js` returns `run(undefined)`
for a non-light session on every action but `set_password`, before it opens
`subjectTeardownGuard`. A self-custody session's change-email, delete-account and accreditation
metadata requests now sign with Keychain (`settingsActionRequest` in `frontend/src/api.js`), so
that `run` waits on a Keychain prompt, as the `broadcastWithFreshAuth` branch does. The signed
request acts for the username read before the prompt; the page then handles the result for
whatever subject the tab holds when the prompt resolves. Two callers also write to the auth
store at that point:

- `handleMetadataSubmit` calls `applyAccreditationMetadata`, which merges the submitted name,
  institution and field into the store's current accreditation.
- `handleEmailDelete` calls `disconnect()`, stops notifications and shows the account-deleted
  toast. Its `removeAccountDrafts` call already uses the account read before the first await.

Scope addition: apply this task's rule and acceptance criteria to that branch and its callers in
`frontend/src/pages/settings.js`.

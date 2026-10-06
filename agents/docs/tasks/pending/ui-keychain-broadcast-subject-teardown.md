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

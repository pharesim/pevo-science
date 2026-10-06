# A confirm dialog answered after a subject teardown acts for the new account or unwinds silently

**Owner:** ui
**Created:** 2026-10-06
**Priority:** normal

Routed out of the architect review of `ui-upload-batch-teardown-guard` (`4781efac`): the
implementer's out-of-scope follow-up 1, plus one review residual on the publish
confirmation that two reviewers reached independently.

## Why

Two dialogs on the publish and edit pages ask through the `broadcastConfirm` store and wait
for a click: the navigation-cost offer (`_confirmNavigationCost`, passed as
`onReauthRequired` by each page's `_windowReady`), and on publish only the publish
confirmation in `handleSubmit`. The subject scrub (`_scrubSubjectBoundState` in
`frontend/src/auth.js`) closes an open re-auth prompt through `dismissOpenReauthPrompt()`,
but nothing in it touches a `broadcastConfirm` dialog. Either dialog therefore stays on
screen and answerable after a cross-tab login or logout.

1. **The offer answered yes after a teardown.** `freshAuthWindowReady` then calls itself
   with `allowRedirect: true` for whoever the tab now represents: a password account is
   prompted and its mint is spent, a passwordless one starts an ORCID navigation. This is
   reachable from each page's submit entry gate (the first `_windowReady()` in
   `handleSubmit`) and from the file-selection gates (publish `handlePdfChange` and
   `handleSupplementaryFiles`, edit `handleSupplementaryFiles`). In a submit, the batch
   guard stops every leg afterwards, but the prompt and the mint have already happened.
2. **A dialog answered no after a teardown.** The submit unwinds to idle with no teardown
   message: publish's `if (!confirmed) { this.step = 'idle'; return; }` and each page's
   entry-gate exit `if (!await this._windowReady()) { this.step = 'idle'; return; }` do not
   consult the batch guard. A review probe on publish observed no message on these paths. The same
   silent exit follows when the yes in item 1 opens a re-auth prompt for the new account
   and that prompt is dismissed.
3. **The publish confirmation answered yes after a teardown.** `sha256File` reads the PDF
   before the post-hash check stops the submit. No credential is spent on this path.

## Scope

Satisfy this condition on both pages: a dialog answer given after the tab stopped
representing the subject that opened the dialog spends no credential and starts no
navigation for the new subject, and the submit or file pick it was gating ends with exactly
one teardown message.

Where the check lives is yours to choose; ask before implementing if the choice is unclear.
The reviewers of the parent task proposed `freshAuthWindowReady` itself for item 1 (a guard
opened at its entry, consulted after `onReauthRequired()` resolves, refusing the recursion
and reporting through `cancel()`), and the page's batch guard for the exits in item 2.
A dismissal of the `broadcastConfirm` dialog inside the scrub would also reach
`comment-composer.js`, `vote-buttons.js` and `review.js`, which use the same store; check
those callers before choosing that layer.

On tests: a check right after the publish confirmation does not leave the post-hash check
without a case. A `sha256File` stub that awaits a macrotask and then changes the subject
pins the post-hash check on its own (a review probe showed this).

## Acceptance criteria

1. On each page, a subject change while the navigation-cost offer is open at the submit
   entry gate, followed by yes, produces no re-auth prompt, no mint, no ORCID navigation, no
   upload or broadcast, and exactly one teardown message.
2. The same holds for the file-selection gates (publish PDF pick, supplementary pick on both
   pages), and the pick is refused the way a false gate refuses it today.
3. A subject change while the offer or the publish confirmation is open, followed by no,
   unwinds to idle with exactly one teardown message.
4. A subject change while the publish confirmation is open, followed by yes, ends the
   submit with exactly one teardown message before `sha256File` runs.
5. The existing page, upload and batch-teardown suites stay green; each new case is observed
   red at base.

The wording of the teardown message itself is the subject of
`ui-teardown-message-and-mapper-mock-wording`; either task may land first.

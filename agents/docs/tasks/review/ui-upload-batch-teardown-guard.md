# Guard a whole publish or edit submit against a subject teardown between its legs

**Owner:** ui
**Created:** 2026-09-02
**Priority:** normal

Routed out of the architect round-2 review of `ui-consent-op-teardown-guard`
(`01347275` + `646c23bb`). Not held there: the round-1 hold marked a batch-level guard
optional, and the gap sits outside that commit's lines. Four reviewers converged on it
independently this round (security, correctness, adversarial, and the frontend-races
lens), which is why it is filed rather than left as a recorded residual.

## Why

`uploadFile` now opens its own teardown guard at entry and threads it through the
pre-flight and both retry legs, so a subject teardown landing anywhere inside ONE call
is caught. A submit is many calls: the publish page uploads the PDF, then each
supplementary file, then broadcasts; the edit page does the same around its
supplementary loop. Each call opens a fresh guard, and a guard opened after a teardown
snapshots the already-bumped generation, so it compares that value against itself and
never fires.

A cross-tab login landing between two legs is therefore invisible to every guard in the
batch. The next leg acquires a window for whoever the tab now represents: the new
subject is prompted with the generic re-auth message, their credential mints an upload
token, and the departed subject's remaining files pin under their account. The submit
then broadcasts with the username captured at submit entry, which the backend refuses
because it no longer matches the JWT subject, and that mismatch tears the new subject's
session down.

Fail-closed at the chain, so nothing is published for the wrong account. But the client
has spent a credential and run part of a captured action for a subject the tab no longer
represents, which is the invariant the consent-op teardown work exists to hold. The
per-leg guards are sound for the boundaries they span; the hole is between legs.

## Scope

1. Open one guard per submit, at each submit entry, after the existing pre-upload window
   gate. Thread it into `uploadFile` as an option defaulting to the guard that function
   opens for itself today, so every existing caller (the editor's inline image upload
   included) keeps working unchanged.
2. Check it before each upload leg and again immediately before the broadcast. On a
   teardown, report once through the guard's cancel and unwind to idle with the
   already-reported silent upload code, matching how a single leg unwinds now.
3. One teardown in a batch is one message. Do not report per remaining file.

Interaction to check before starting: `ui-light-account-reauth-window` item 6 proposes
moving the broadcast confirm ahead of the upload legs. If that lands first the
pre-broadcast check moves with it. The condition to satisfy is that no leg of a submit
runs for a subject the tab stopped representing, wherever the legs end up ordered.

## Acceptance criteria

1. A teardown between two supplementary uploads in one submit stops the batch: no
   further upload, no prompt, no mint, exactly one message.
2. A teardown between the last upload and the broadcast stops the submit before the
   broadcast is issued.
3. Single-leg behaviour is unchanged, pinned by the existing upload and page tests
   staying green with no edits.
4. One test per page (publish, edit) for AC1 and AC2, each observed red at base.

UI implementation signal (2026-10-06, commit 4781efac):

Landed in `4781efac` (`ui(upload): one teardown guard spans each publish and edit submit`),
verified an ancestor of `main`. Files: `frontend/src/pages/publish.js`,
`frontend/src/pages/edit.js`, and two new suites
`frontend/tests/unit/pages-publish-batch-teardown.test.js` and
`frontend/tests/unit/pages-edit-batch-teardown.test.js`. `lib/ipfs-upload.js` and
`lib/fresh-auth.js` are untouched; no existing test was edited.

What changed. Each `handleSubmit` opens one `subjectTeardownGuard()` ("the upload batch
guard", the name the `_remountWhenSettled` docblocks already defer to) before its first
await, and a local `unwindIfSubjectChanged()` checks it immediately ahead of each leg with
nothing awaited in between: publish checks after the entry gate (ahead of the publish
confirmation), after `sha256File` (ahead of the PDF upload), at the top of each
supplementary iteration, and ahead of the pre-broadcast `_windowReady` gate; edit checks at
the top of each supplementary iteration and once ahead of the `isContinuation` split (ahead
of both arms' pre-broadcast gates). On a teardown it calls the guard's `cancel()` (one
message per teardown, deduped by `reportTeardownOnce`) and unwinds to idle.

Departures from Scope, asked and approved by the user before implementation (option
"Page checks, guard at start"):
1. The guard opens at submit entry, not "after the existing pre-upload window gate". The
   entry gate's navigation-cost offer (`_confirmNavigationCost` inside
   `freshAuthWindowReady`) can answer ready for a new subject after a cross-tab login lands
   while it is open; a guard opened after the gate never fires, and every leg and the
   broadcast then ran for the new account (probed at base on both pages).
2. The guard is not threaded into `uploadFile`. Passing a second argument fails the existing
   `pages-edit.test.js` assertion `toHaveBeenCalledWith(file)`, which AC3 forbids editing.
   A page check placed immediately before the call is equivalent: `uploadFile`'s own guard is
   its first statement, so it snapshots the same generation the check just compared.
3. The pre-broadcast check sits ahead of the pre-broadcast gate rather than "immediately
   before the broadcast". Past a teardown that gate acquires for the new account and prompts
   it and spends its mint; a check after the gate would only cross microtask hops (see
   `await-is-not-a-teardown-boundary-unless-it-yields-to-a-macrotask-2026-09-03.md`).

The "Interaction to check" paragraph is stale: the publish confirmation already precedes the
upload legs, and the edit page has no confirmation; the pre-broadcast gate did not move, so
the pre-broadcast check stays at the end, ahead of that gate.

Acceptance criteria:
- AC1: "a subject change between two supplementary uploads stops the batch" on both pages
  asserts 1 transfer, 0 prompts, 0 mints, 0 broadcasts, exactly one teardown message, step
  idle, no error surface, no row error, no row left uploading.
- AC2: "a subject change between the last upload and the broadcast" on publish (PDF only)
  and on both edit arms asserts the same outcome with no broadcast issued.
- AC3: `pages-publish`, `pages-edit`, `lib-ipfs-upload`, `lib-ipfs-upload-real-window` and
  `editor` suites green and unedited (314 tests).
- AC4: the two new suites (11 cases: 3 controls, 8 teardown cases) run the real auth store and
  its storage-event scrub, the real fresh-auth window and the real `uploadFile`. All 8
  teardown cases fail against the HEAD pages; the 3 controls pass. Extra cases beyond the ACs
  pin the publish confirmation dwell and the entry-gate offer path.

Verification: full frontend unit suite 96 files / 2262 tests, exit 0; `npm run build` clean
(built in an isolated copy; standing dhive eval warning only); pre-commit anchor gate zero
hits on the added lines, control line fires. Eleven single-site mutants (each check removed,
the guard moved after the entry gate on each page, the publish pre-broadcast check moved
after its gate, the loop check moved after `sf.uploading = true` on each page) are each killed
by their own case. A `ce-simplify-code` pass (reuse, quality, efficiency) and a four-lens
adversarial review with two refuters per finding ran before commit; upheld findings were all
comment or test-header narrowings plus the `uploading` assertion, and are in the commit.

Considered and not built: a check between the publish confirmation and `sha256File`. A
teardown during the confirmation costs one local hash and spends no credential; the
post-hash check stops the PDF upload, and an extra check there would leave the post-hash
check unpinned by any case.

Out-of-scope findings for follow-up filing:
1. The navigation-cost offer in `freshAuthWindowReady` (normal priority suggested). The
   subject scrub dismisses the re-auth modal but not the `broadcastConfirm` offer dialog, and
   a yes runs `freshAuthWindowReady({ ...acquireOpts, allowRedirect: true })` for whoever the
   tab now represents: a password account is prompted and its mint spent, a passwordless one
   gets an ORCID start. This happens inside the gate, before any page check. In a submit the
   batch guard then stops every leg (pinned by the entry-gate offer cases), but the prompt
   and mint have already happened, and if the new account dismisses that prompt the submit
   unwinds with no teardown message. The same path reaches the file-selection gates, outside
   any submit: publish `handlePdfChange` and `handleSupplementaryFiles`, edit
   `handleSupplementaryFiles`. Reviewers converged on the fix layer being
   `freshAuthWindowReady` itself (a guard opened at its entry, consulted after
   `onReauthRequired()` resolves, refusing the recursion and reporting through `cancel()`),
   not the two submit pages.
2. The `describeUploadError` mocks in `pages-publish.test.js` and `pages-edit.test.js` say they
   mirror the real mapper but return `common.uploadFailed` for `UPLOAD_SUBJECT_CHANGED`, which
   the real one maps to null (low; mock and comment fix, left alone here under AC3).
3. `broadcastWithFreshAuth`'s non-light branch calls `broadcastOps` with no guard, so a
   teardown landing during the Keychain prompt itself is not detected there. That is an
   in-leg gap, not a between-leg one (low).
4. The teardown message reads "Your session changed, so the confirmation was cancelled." On
   the edit page, and on publish when a leg rather than a dialog was cancelled, no
   confirmation was on screen. This copy is shared with the existing single-leg upload
   cancels (low; copy follow-up candidate).

Learnings checkpoint: grepped `agents/docs/solutions/` for `subjectTeardownGuard`,
`uploadFile`, `onReauthRequired`, `_confirmNavigationCost` and "batch guard"; no entry is
contradicted by this work. Nothing new qualifies: the placement rule is the
`subjectTeardownGuard` docblock's own "open the guard before the first await of the
stretch", the check-adjacency argument is carried by the new opener comment, and the
offer-path hole is a defect for follow-up 1, not a learning.

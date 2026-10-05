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

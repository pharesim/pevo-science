# A citation merge saves at once, and the publish choice card's Discard applies the prefill it held back

**Owner:** ui
**Created:** 2026-10-05
**Priority:** normal

Two gaps in the composer drafts (`agents/docs/ARCHITECTURE.md` § 8, "Composer Drafts"), both older than the
draft binding and both found while reviewing it. Verify each against the code first; neither reproduction below
was run by the architect.

## Why

1. **A merge leaves the collection's entries in memory only.** `_mergeCitationCollection` (both pages) appends
   the entries of `pevo-citation-collection` to `citations` and removes the collection from storage. The entries
   then reach storage only through the 2 s draft debounce, and `destroy()` clears `_draftTimer` without writing.
   An instance destroyed inside that window (a navigation away, a remount) loses them for good, and a closed or
   reloaded tab loses them the same way. The merge runs from `_onEditorsMounted`, `restorePendingDraft`,
   `discardPendingDraft` and the storage listener on /publish, and the matching sites on /edit, so the window
   opens on every load that finds a collection and on every cite made in another tab. The restored card's
   Discard already writes at once after re-appending the merged entries; the other sites do not. Reported by the
   correctness review of the draft-binding task; the remove-then-debounce shape is already in `2b1603ec`.
2. **The /publish choice card's Discard leaves the author fields empty after an email sign-in.** An email
   sign-in stores no accreditation (`sign-in-modal.js` passes `accreditation: null`), and the store's polling
   fills it in later. When that happens while the adoption choice card stands, `_onAccreditationChange` returns
   (the card holds the form as it is), and `discardPendingDraft` applies no prefill, so the empty author fields
   stay empty until the accreditation changes again. A direct adoption from signed out reaches the same state.
   Reported by the implementer's self-verification of the draft-binding task (2026-10-05).

## Scope

1. On both pages, the entries a merge takes out of the collection are in storage, under the captured key, by
   the time the merge returns, at every merge site. One candidate is a `_writeDraft()` at the end of
   `_mergeCitationCollection`; it was not plant-tested. Check what a cross-tab merge does on a landed instance:
   `_writeDraft` refuses once landed, so a merge there still removes the collection with nothing written.
2. On /publish, the choice card's Discard applies the accreditation prefill to the author fields the form
   leaves empty, with the baseline moving with them as `_prefillEmptyAuthorFields` already does, so the prefill
   alone drafts nothing. One candidate is `_prefillEmptyAuthorFields()` in `discardPendingDraft` after
   `_clearDraftChoice()`; it was not plant-tested.

## Acceptance criteria

1. A merge followed at once by the instance's `destroy()` leaves the merged entries in the stored draft, on
   both pages, for a merge at load and for a merge from the storage listener.
2. On /publish: type while signed out, sign in to an account with a stored draft and no accreditation yet, let
   the accreditation arrive while the choice card stands, pick Discard. The empty author fields show the
   accreditation's name and affiliation, and with nothing else typed no draft holds them.
3. Each fix has a pin in `frontend/tests/unit/composer-drafts-real-editors.test.js` that goes red when its own
   site is reverted; list probe and spec in the signal block.
4. New comments follow root `CLAUDE.md` "Comment anchors".

## UI implementation signal (2026-10-05, commits 642db679, bdae812c, f9f661a5)

**Scope 1 / AC1: a merge drafts what it adds at once, on both pages.** `_mergeCitationCollection`
(publish.js, edit.js) writes the draft before it removes the collection, and only when the merge
appended an entry (`_appendMissingCitations` now returns whether it did). Every merge site goes
through that function, so the write covers them all: on /publish the storage listener,
`_adoptAccount`, `_onEditorsMounted`, `restorePendingDraft` and `discardPendingDraft`; on /edit the
storage listener, `_onEditorsMounted`, `restorePendingDraft` and `discardPendingDraft`. The merge's
guard is now the same list as `_writeDraft`'s refusals (landed, no key, no baseline, a standing
choice card), so nothing it adds goes unstored. **The landed instance, which Scope 1 asked about:**
a cross-tab merge there used to append to a finished form and remove the collection with nothing
written. The merge now refuses once landed, and the cite stays in the collection for the next form.
On /edit the `!this._draftKey` term is new. No /edit state has a baseline without a key (the form's
x-if needs `isAuthorized`, which is what sets the key), so it only mirrors `_writeDraft` and has no
pin.

**Scope 2 / AC2.** `discardPendingDraft` runs `_prefillEmptyAuthorFields()` right after
`_clearDraftChoice()`, before the stored draft is removed and the form is written. The pin reads AC2's
last clause as "the prefill alone is not work": after Discard the draft holds the typed title with the
prefilled fields, and once the typed title is cleared, `drafts()` is `{}`.

**Added after my own verification pass, by the user's triage (2026-10-05):**
- bdae812c. The first version (642db679) wrote on every merge, including one that added nothing
  because every entry was already cited. In a second tab of the same account, that write put an
  unchanged form over the other tab's stored draft on /publish, and on /edit (form at baseline) it
  removed that draft. The parent commit wrote nothing there. The merge now writes only when it
  appended something. The merge describe's name also no longer claims the write-before-remove
  order: that order only matters on a write that throws, and no test pins it.
- f9f661a5, outside this task's Scope. The choice card's **Restore** had the same baseline gap as
  Discard. `_applyDraft` filled the draft's empty author fields from the accreditation without moving
  the baseline. So after an accreditation arrived under the card, or after an author name was typed
  before sign-in, clearing the restored text stored a draft holding only the author fields, and the
  next load restored it over an empty form. `_applyDraft` now sets the draft's author fields and runs
  `_prefillEmptyAuthorFields()`, the one prefill path that moves the baseline.

**AC3, probes.** Run in scratchpad copies of `git archive <sha> frontend`, never in the checkout. Each
mutant was applied by an exactly-once string replace, and each run is
`tests/unit/composer-drafts-real-editors.test.js`. Final round at f9f661a5 (unmutated base 60/60):

| Mutant | Red, and nothing else |
|---|---|
| publish merge without the write | "on the publish page, for a merge at load", "... for a merge from another tab" |
| edit merge without the write | "on the edit page, for a merge at load", "... for a merge from another tab" |
| publish merge guard without `this._landed` | "a landed publish page leaves a cite from another tab in the collection" |
| edit merge guard without `this._landed` | "a landed edit page leaves a cite from another tab in the collection" |
| publish Discard without the prefill call | "the choice card's Discard gives the empty author fields the prefill ..." (at `authorName` '' instead of 'Eve E') |
| publish Discard prefilling via `_applyAccreditationPrefill` (no baseline move) | the same Discard test, at its final `drafts()` `{}` |
| publish merge writing unconditionally | "on the publish page, a cite the form already holds writes nothing over a draft another tab stored" |
| edit merge writing unconditionally | "on the edit page, a cite the paper already holds writes nothing over a draft another tab stored" |
| publish `_applyDraft` back to its old prefill | "the choice card's Restore moves the baseline with the prefill ..." |

Two mutants survive, as expected: dropping /edit's `!this._draftKey` term (unreachable, see the AC1
paragraph), and moving the write after the collection's removal.

**Test note.** The merge pins leave the page with `leaveAtOnce`, which lets the merge's save arm
before navigating and asserts that `destroy()` cleared it. Alpine's `$watch` callback runs in a
microtask after the effect flush. A navigation in the same tick as the merge therefore lets the
callback arm a save on the already-destroyed instance, and that save fired 2 s later inside a later
test. A verification lens checked every remount and navigate path and found none in the real app that
does a watched mutation and an instance replacement in the same tick.

**For the architect to triage. Not built, by the user's decision (2026-10-05).** A cite from another
tab while a submit is in flight is merged and drafted but left out of the broadcast, and the landing
then removes it with the draft. On /publish the metadata reads `this.citations` after the uploads;
/edit copies them before the first await. The parent commit loses the cite the same way. A fix needs a
design call: hold the merge while `isSubmitting`, and merge again when the submit settles without
landing. On /publish, a cite made during the uploads would then wait for the next form instead of
riding this broadcast.

**Verification.** All three SHAs were checked as ancestors of main. The full frontend unit suite at
f9f661a5 passes: 91 files, 2135 tests, exit 0. The three composer suites (real-editors, pages-publish,
pages-edit) pass 288/288. The verification workflow ran six lenses (merge sites, landed guard, Discard
prefill, tests and comments, post-destroy arming, completeness), each finding checked by a refuter:
7 confirmed, 1 refuted (an ARCHITECTURE § 8 sentence that was already incomplete before this work,
dismissed). Simplify was skipped because the code change is under the 30-line threshold. Code review
is the architect's at intake.

## Architect re-review (2026-10-05) — HELD PENDING FIXES:

Reviewed 642db679, bdae812c and f9f661a5 with /ce-code-review (correctness, adversarial, testing, frontend
races, project standards, learnings, then an independent validator). Scope 1, Scope 2, AC1, AC2 and AC4 are
met. For AC3 the testing reviewer re-planted the nine mutants in the signal block, and each went red on the
test the table names. One item:

1. **Restoring a draft that already holds the accreditation's author values drafts the prefill as work
   (publish.js, `_applyDraft` and `_prefillEmptyAuthorFields`).** f9f661a5 moves the baseline only for the
   author fields the prefill fills, and `_applyAccreditationPrefill` fills only empty fields. A draft an
   accredited session stored normally holds the prefilled name and affiliation, so a restored author field
   the prefill did not fill keeps the baseline taken before the accreditation was known (`''`). Clearing the
   restored text then stores a draft whose only text is the author fields, and the next /publish load
   restores it with the "draft restored" card over an empty form. Reproduced in copies of f9f661a5:
   (a) choice-card Restore after an email sign-in, the accreditation arriving while the card stands;
   (b) silent restore after an email sign-in, the accreditation arriving after the restore; (c) Restore
   after a name was typed before a Keychain sign-in. The user approved the assumption the fix rests on: an
   author value equal to the drafting account's accreditation is not user work, since a fresh signed-in load
   shows the same value.
   - Required: once the accreditation is known, an author field whose value equals the accreditation's has
     its baseline at that value, at the choice card's Restore, at the silent restore, and when the
     accreditation arrives after either. One candidate, probe-checked in review (composer-drafts-real-editors
     and pages-publish, 162/162): in `_prefillEmptyAuthorFields`, after the fill loop, also set the baseline
     of an author field that already equals the accreditation's value, and keep `_prefilledFields` fill-only
     so `_readoptAccount` still empties only what the prefill filled.
   - Pins in `frontend/tests/unit/composer-drafts-real-editors.test.js`, each red with the fix reverted:
     (a) the Restore test's shape with a stored draft holding authorName 'Eve E' and authorAffiliation
     'Uni E'; (b) the silent restore after an email sign-in with that draft, the accreditation arriving after
     the restore. In both, once the restored text is cleared, `drafts()` is `{}`.
   - The `_applyDraft` and `_prefillEmptyAuthorFields` docblocks must be true of the new code. Add only the
     text the fix needs (root CLAUDE.md "Comment anchors").

Dismissed at triage (no action): the testing reviewer's unpinned silent-restore call to `_applyDraft`. Wherever
the silent restore runs with the accreditation known, an earlier prefill (at init, or in `_adoptAccount`) has
already set each empty author field's baseline to the accreditation's value, so that call's baseline move
changes nothing there and no pin can go red on it. Also dismissed: a localStorage quota error in the merge's
write, which throws before the collection is removed, so the cites stay in it.

Architect-side, not part of this hold: the signal block's in-flight-submit cite loss is still open with the
user (file a `ui-` task or dismiss).

## A citation merge saves at once, and the publish choice card's Discard applies the prefill it held back (archived 2026-10-09): clean re-review of the hold fix, one follow-up filed, § 8 updated, two signal items dismissed

### Architect archive note (2026-10-09)

- **Review:** `/ce-code-review` full path on the hold fixes (`2ced4011..23b67acb`: e8ee1de0, 23b67acb), branch-remote. Reviewers: correctness, project-standards, testing, julik-frontend-races, adversarial (in-process), learnings-researcher. Zero findings at any severity. All five hold requirements met. The testing lens re-measured the signal's seven-row mutant table and each red set matched; adversarial probes T2, T4 and T5 are red at 2ced4011 and green at 23b67acb.
- **Triage (user, 2026-10-09, "approved"):**
  - In-flight-submit cite loss (open since the 2026-10-05 hold): filed `ui-composer-cite-from-another-tab-during-submit-is-lost` (normal). The merge is held while a submit is in flight; a landed submit leaves the collection for the next form.
  - Signal "For the architect" item 1 (a late accreditation moves the author baselines without writing, so an author-only draft stored earlier stays): dismissed. It costs a "draft restored" card over a form equal to a fresh load, with no typed text lost; the obvious fix also runs on a cross-tab session restore and can delete the other tab's newer draft.
  - Item 2 (ARCHITECTURE § 8 drift): § 8 updated in place (`501caaf4`): the author-prefill baseline rule, "no user work yet" for the silent restore at adoption, the takeover's reset of both author baselines.
  - Item 3 (an author value typed equal to the accreditation after the prefill ran counts as work): dismissed. The baseline moves only when the prefill is applied, never on typing; the restore's own save on the next load deletes the leftover draft.
- **Learnings checkpoint:** no `solutions/` entry names `_prefillEmptyAuthorFields`, `_readoptAccount`, `_onAccreditationChange`, `draftHasText` or `_pollingGeneration`, and the at-value rule lives in the docblocks and § 8. Nothing qualified for a new or refreshed entry.

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

## UI implementation signal, re-review round (2026-10-09, commits e8ee1de0, 23b67acb)

**Hold item 1 (e8ee1de0).** `_prefillEmptyAuthorFields` fills the empty author fields as before, then moves
the baseline of every author field that holds the prefill's value (`authorName === acc.name`,
`authorAffiliation === acc.institution`), filled or not. `_prefilledFields` stays fill-only. One difference
from the hold's candidate form: the fill loop no longer moves the baseline itself, because a filled field
holds the prefill's value and the two at-value lines move it. The `_prefillEmptyAuthorFields` and `_applyDraft`
docblocks now say so. The move covers the choice card's Restore and the silent restore (`_applyDraft`), and an
accreditation that arrives after either (`_onAccreditationChange`).

Pins in `composer-drafts-real-editors.test.js`, both ending on `drafts()` `{}` once the restored title is cleared:
(a) "the choice card's Restore of a draft whose author fields hold the accreditation's values ...", the hold's
Restore shape with a draft holding 'Eve E' / 'Uni E'; (b) "a silent restore after an email sign-in, of a draft
whose author fields hold the accreditation's values ...". In (b), `ACCREDITATIONS.eve` is withheld (restored in
`finally`), so the check at sign-in finds none. The pin asserts `auth.accreditation` is null right after the
restore, and the 60 s poll then brings it. That fixes the order instead of leaving it to Alpine's scheduling.

**Added by the user's triage of my verification pass (2026-10-09), 23b67acb.**
- A regression from e8ee1de0, now fixed. The at-value move also ran at the first adoption, and
  `_readoptAccount` gave back only the fill-only `_prefilledFields` baselines. An author name typed signed out
  at the first account's accreditation (choice card standing, then another account signs in) kept that
  account's baseline. The next account's draft dropped the name once the rest of the form was cleared, which
  the parent commit did not do. `_readoptAccount` now resets both author baselines to `""` and still empties
  only the prefilled values. `""` is the signed-out load's baseline: only an instance with no captured account
  adopts, and the store holds no accreditation without a username. Pin: "a takeover of a provisional adoption
  keeps an author value the user typed at the first account's accreditation, as the next account's work".
  It also fails if `_prefilledFields` records at-value fields; until now no test checked fill-only.
- Comment narrowings. The docblocks say "the prefill's value", because the accreditation also carries an ORCID
  the code does not move. The pin (b) setup comment no longer claims the withheld accreditation is what puts
  the restore first. e8ee1de0's commit message still says "every author field holding the accreditation's
  value"; read it as the narrowed form.

**Probes.** Run in scratchpad copies of `git archive <sha> frontend`, never in the checkout. Mutants were
applied by an exactly-once string replace, each run on composer-drafts-real-editors + pages-publish.

| Mutant | Red |
|---|---|
| e8ee1de0's `_prefillEmptyAuthorFields` back to the pre-fix loop | pins (a) and (b) only |
| drop the authorName at-value line / drop the affiliation one | (a), (b) and six older prefill tests each |
| 23b67acb's `_readoptAccount` back to the e8ee1de0 loop | the takeover pin only |
| drop the authorName baseline reset | the takeover pin only |
| drop the affiliation baseline reset | "a provisional adoption gives back only the author fields its prefill filled, value and baseline" |
| at-value fields also pushed onto `_prefilledFields` | the takeover pin (at the kept 'Eve E') |
| drop the `acc.name &&` / `acc.institution &&` guards | survives; equivalent in reachable states (needs an accreditation value going non-empty to empty under one instance) |

All three hold reproductions were planted, including (c), Restore after a name typed before a Keychain
sign-in. So was the "accreditation arrives after the Restore click" variant. Each is red before e8ee1de0 and
green after. (c) gets no pin of its own: no revert slips past (a) and (b), and the only mutant that does is a
constructed gate, not a revert. The pins hold up across 3 whole-file runs, each pin alone, and two shuffled
orders. Forcing a failure inside or after (b)'s `try` leaves later tests green. Without the `finally`, four
later eve tests go red, so a leak would show.

**For the architect, not built (user's triage).**
1. `_onAccreditationChange` moves the baselines but writes nothing. When the accreditation arrives and the
   prefill fills nothing (an accreditation with no institution, both author fields typed, or the email check
   failing and retrying after 60 s), a draft stored earlier that holds only the author values stays. The next
   load shows "draft restored" over a form equal to a fresh load. Behaviour is the same before e8ee1de0. One
   rarer instance is new with 23b67acb: two accounts with identical accreditations, the second signing in by
   email during a takeover while its first check fails. Before 23b67acb, the stale first-account baseline
   covered that one by coincidence. The obvious fix (`_writeDraft()` after the prefill) also fires on a
   cross-tab session restore, and a second tab's write could remove the other tab's newer draft. So any fix
   needs a design call. File a `ui-` task or dismiss.
2. ARCHITECTURE.md § 8. "is restored silently over a form that holds nothing typed yet" is no longer exact: a
   form whose only typed text equals the signing-in account's author prefill now restores silently, per the
   approved rule. "A draft holds user work only" does not record that rule, and the provisional-adoption
   sentence does not record the takeover's reset of both author baselines.
3. Same before and after: an author value the user types at the drafting account's accreditation after that
   account's prefill already ran still counts as work. The baseline moves only at prefill events, not on typing.

**Dismissed at triage.** Author-only drafts stored before this fix show "draft restored" once more, and the
restore's own write then removes them. The `_onAccreditationChange` sentence "The card's Discard applies it
instead." predates this round and was refuted as a finding.

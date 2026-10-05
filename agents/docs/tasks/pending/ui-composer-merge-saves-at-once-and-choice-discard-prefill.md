# A citation merge saves at once, and the publish choice card's Discard applies the prefill it held back

**Owner:** ui
**Created:** 2026-10-05

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

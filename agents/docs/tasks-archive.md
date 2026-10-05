## A composer draft is bound to its account and, on the edit page, to the head it was written against (archived 2026-10-05) — clean re-review of the four held items; two older composer gaps filed; two residuals dismissed; e2e locator task left open

### Architect archive note (2026-10-05)

Re-review of 4ca874dc, 03aceaf5, 18951b4a and e3bf84f4 with /ce-code-review (full:
correctness, project-standards, testing, maintainability, julik-frontend-races,
adversarial in-process, learnings). Scoped to the five files those commits touch,
through a synthetic head, because sibling commits in e4e7eed2..e3bf84f4 touch other
files. No primary finding: the two maintainability candidates asked for the shared
draft-machinery extraction declined on 2026-10-05. All four held items are fixed and
pinned. The markdown-mode source view serialises from the editor (turndown(getHTML()))
instead of the given text, a measured deviation from the hold's wording, accepted.
Full unit suite at e3bf84f4 in an isolated copy: 91 files, 2125 tests, exit 0; build
exit 0. 10 of the 29 claimed revert probes re-run in isolated copies, all RED (control
50/50 green); the testing lens reverted the landed check on both pages, RED.

Triage (user approved as recommended):
- Filed `ui-composer-merge-saves-at-once-and-choice-discard-prefill`: a merge removes
  the citation collection and its entries wait on the 2 s debounce, which destroy()
  clears without writing (already in 2b1603ec); and the /publish choice card's Discard
  applies no prefill when the accreditation arrived while the card stood (the
  implementer's item for architect triage).
- Dismissed: merged citations protected for one Discard only (after it they are draft
  content, and the hold scoped the fix to the entries this instance merged); a merged
  citation edited and then removed coming back on Discard (narrow path).
- Refuted residuals: stale accreditation on an email-sign-in re-adoption
  (sign-in-modal.js passes accreditation: null); _mergedCitations not reset on
  re-adoption (no merge can precede a standing choice card).
- Open, not filed: the e2e submit locators also match the re-auth modal's Confirm
  button, so 9 composer specs fail on it as committed (set aside in the first signal).

### Task file

**Owner:** ui
**Created:** 2026-10-01

Implements the draft-binding half of `agents/docs/ARCHITECTURE.md` § 8 ("Composer Drafts"):
the paragraphs "Shape", "A draft holds user work only", "Restore is bound to the account and, on
the edit page, to the head" and "The instance is bound to the account and the paper it loaded
for". Read them first; they are the contract this task is reviewed against. The retry state that
§ 8 also puts into the draft belongs to a later task, filed in `blocked/` behind this one; build
the draft shape so that state can be added without another key change.

## Why

All measured with the real page modules (whole app booted under jsdom, the real tiptap editor)
on 2026-10-01, against main after the landing barrier was archived.

- **Every edit-page load writes a draft about two seconds later with nothing typed**, also for
  signed-out visitors and accounts that cannot edit the paper. The stale-draft population is
  therefore every paper whose edit page this browser ever had open.
- **The edit page restores silently over whatever the paper is now.** `_restoreDraft` checks only
  `typeof draft.title === 'string'`, shows nothing, and offers no discard. Measured: an author who
  typed nothing returns after a co-author's change, Save broadcasts the old text (as a reverting
  patch on the native arm) and drops the head's citations (`if (draft.citations)` treats an empty
  array as present). The restoring instance then re-stamps `savedAt`, so the stale text looks
  fresh on the next visit.
- **Drafts are not bound to an account.** The keys are `pevo-draft-publish` and
  `pevo-draft-edit-<author>-<permlink>`. Both drafts carry `authorName`, `authorAffiliation` and
  `authorOrcid`, and restore them into the next account's form in the same browser (on the edit
  page, between co-authors). They survive `auth.disconnect()` and account deletion.
- **The instance is not bound to an account.** A mounted composer outlives a sign-out and a
  sign-in as another account, and nothing in it is recomputed. Measured: bob's Save on a form
  alice had loaded broadcast authors `[{"name":"Alice A","hive":"bob","orcid":<alice's>}]`,
  dropping alice from the author list.
- **The edit key is read live from the router params.** After a history jump between two edit
  entries the mounted instance writes one paper's form under the other paper's key (measured,
  also over a non-adjacent `history.go(-2)`). This is the residual the blocked surfaces task
  carries; this task closes the key half of it and the remount closes the rest.
- **Remounting is not possible today.** `page-mount.js` re-renders only when the router's route
  name changes, and an in-place `loadPaperData` leaves the form without editors
  (`_mountEditors` returns early on `_editorsInitialized`, which only `destroy()` releases).
  Measured: signing out and in again on a mounted edit page, or using the page's own sign-in
  call to action, re-renders the form with no editor at all and, for the call to action, blank
  author fields.

## Scope

Both pages unless stated.

1. **Keys.** `pevo-draft-publish:<account>` and
   `pevo-draft-edit:<account>:<canonical author>:<canonical permlink>`. Capture the account and
   (edit page) the loaded paper's canonical pair once the load completes, and use only the
   captured values in every reader, writer, the landing clear and the restore. No getter that
   reads the auth store or the router params may name a draft key.
2. **Baseline.** Writes are refused until the instance has a baseline. Take the editor fields'
   baseline after both editors have mounted and an explicit
   `editor.view.dispatch(editor.state.tr)` has run on each (the list re-serialisation comes from
   an append-transaction that runs on the first dispatched transaction; the dispatch that happens
   to run today is incidental), and the other fields once the prefill is done. `_writeDraft`
   writes only when the form differs from the baseline. A form back at its baseline drops the
   stored text fields; an entry with no other state is removed. An instance with no captured
   account writes nothing, and on the edit page neither do accounts that cannot edit the paper.
   A signed-in account that is not yet accredited keeps drafting on the publish page (it can
   reach the form, and its "Get accredited" link navigates away). Expose whether the editors
   still hold their baseline (the later retry task composes the native edit's body from the
   served text while they do).
3. **Head binding (edit page).** The draft records the head marker of the paper the form was
   loaded against: `<head_author>/<head_permlink>/<versions.length>/<block_num of the last
   versions[] entry>`, null when `versions` is the one-entry stub (`block_num: 0`) a failed or
   empty replay leaves. Use the payload's `head_marker` field instead once the backend ships it;
   it is defined as the same string, with the same null rule (§ 2 "Body, edits and versions").
   On load, restore silently only when the draft's marker equals the loaded paper's and neither
   is null. When they differ, restore nothing yet and show a card: the paper has a newer version
   than the draft (possibly from the user's own earlier save), with Restore and Discard. When
   either is null, the same card says the page could not check whether the paper changed. Restore
   replaces the form with the draft and re-binds the draft to the current marker; the card's copy
   says that it replaces the newer version. Until the user picks one, the form is read-only and
   `_writeDraft` refuses.
4. **The edit page's restore card.** A silent restore shows the publish page's "draft restored"
   card (reuse `publish.draftRestored`, `common.discard` and the `time.*` keys; move
   `relativeTime` out of `publish.js` into a shared module). After Restore on the newer-version
   card, the same "draft restored" card replaces it. Its Discard re-runs the prefill, empties
   `newCoAuthors` and `addressedReviews`, sets both editors' content, re-takes the baseline and
   removes the captured key. Gate Discard on `_landed` on both pages (the publish page's
   `discardDraft` has no such gate today) and hide the card on landing.
5. **Legacy entries.** Entries under the old keys (`pevo-draft-publish`, `pevo-draft-edit-*`)
   carry no account and cannot be told apart from load-time copies; they also hold author name,
   affiliation and ORCID. Do not restore them. The first composer load with a captured account
   deletes them.
6. **Account deletion** (`frontend/src/pages/settings.js`, after the deletion succeeds) removes
   that account's draft keys: `pevo-draft-publish:<account>` exactly, and edit keys by the prefix
   `pevo-draft-edit:<account>:` including the trailing colon, so deleting `bob` never touches
   `bobby`'s drafts. Explicit sign-out keeps them, as § 8 says.
7. **Account and paper changes under a mounted composer.** Add a generation counter to the
   router store that `page-mount.js` also keys on, so a page can be remounted without a
   route-name change. Remount when an account signs in that differs from the captured non-null
   account, and when the edit route's params name another paper; flush the pending debounce
   under the captured key first. On the publish page, a sign-in under an instance that captured
   no account adopts that instance instead of remounting: capture the new account, keep the form,
   write under that account's key from then on, apply the accreditation prefill only to empty
   author fields, and if the key already holds a draft show the "draft restored" card so the user
   picks. A change to no account (sign-out, the session teardowns that deliberately keep the
   composer mounted) does not remount, keeps attached files, and keeps drafting under the
   captured key, so work typed after a teardown survives the trip to the sign-in page. A custody
   upgrade keeps the username and is not a subject change. Bind the editors' lifecycle to the
   form's `x-if` rather than `_editorsInitialized`, so a re-render brings the editors back; that
   also fixes the editor loss described in Why. A remount during a submit waits for the submit to
   settle: a subject change between submit legs is `pending/ui-upload-batch-teardown-guard.md`'s
   batch guard's job. Coordinate with that task (same `handleSubmit` legs); whichever lands
   second says so in its signal block.

## Out of scope

- Retry state in the draft (minted permlink, attempt marker), the head check before a submit,
  the landing's wait for the index, the diff base. The later ui tasks.
- `sessionStorage` for drafts: decided against (2026-10-01); drafts stay in `localStorage`.
- The round-trip stash on the review, comment and vouch surfaces
  (`tasks/blocked/ui-composer-surfaces-navigate-over-undrafted-work.md`), which uses a
  `sessionStorage` slot in `SUBJECT_BOUND_STORAGE_KEYS`. The two mechanisms stay separate.

## Copy

New keys in all 16 locale files (English stubs plus `STUBS.md` lines, per the i18n convention),
owned by this task:

- the newer-version card message, stating that Restore replaces the newer version with the draft;
- the could-not-check variant of the same card, for a null marker;
- a Restore label (`en.json` has `common.discard` and no restore key).

The head-check refusal and its reload, the could-not-confirm message, and the already-published
message belong to the later retry tasks and are not added here. No emdashes.

## Acceptance criteria

1. A load with nothing typed writes no draft, including when an editor re-serialises the loaded
   content (stage a body with a list in the form the editor rewrites), for a signed-out visitor,
   and for a non-author on the edit page. A signed-in unaccredited account still drafts on
   `/publish`.
2. A draft written by one account is not restored for another, on either page, and a mounted
   composer remounts when a different account signs in. The case that broadcast alice's author
   entry under bob no longer reaches a broadcast.
3. On `/publish`, text typed while signed out survives an in-page sign-in and is then drafted
   under the new account; with a stored draft already under that key, the card offers the choice.
4. After a session teardown, text typed under the mounted composer is still drafted under the
   captured key.
5. After a history jump between two edit entries, no write lands under the other paper's key.
6. Edit page: equal markers restore silently and show the restored card; different markers show
   the newer-version card, and a null marker shows the could-not-check card; the form is
   read-only and writes are refused until a choice; Restore re-binds the marker; Discard returns
   the form to the loaded paper.
7. Old-key entries are never restored and are deleted on the first load with a captured account;
   account deletion removes exactly that account's drafts; sign-out keeps them; the ORCID
   round-trip of a passwordless account still restores its draft.
8. The landing barrier's behaviour is unchanged (its specs stay green), and Discard is refused
   once landed on both pages.
9. Every assertion is probed by reverting its own site; list probe and spec in the signal block.
   The unit harnesses mock `$watch` and set `_initialLoadDone` by hand, so the load-time write
   and the baseline need a spec that boots the real editors (the jsdom harness that measured
   this task's Why did it); say which spec does.
10. The 31 literal draft-key strings in the six test files move to the new key shape.
11. New comments follow root `CLAUDE.md` "Comment anchors".

## UI implementation signal (2026-10-01, commits 4882cd42, 5b4ee3cd, 943263dd, 78dff15c, 301be0a8, e4e7eed2)

All six commits are on main (`git merge-base --is-ancestor <sha> main` checked for each) and each carries the
Co-Authored-By trailer. 4882cd42 is the implementation; 5b4ee3cd, 943263dd, 78dff15c and 301be0a8 are fixes and
pins from a self-verification pass and the mutation probes; e4e7eed2 is the simplify pass (one docblock).

### What landed, by Scope item

1. **Keys.** `pevo-draft-publish:<account>` and `pevo-draft-edit:<account>:<canonical author>:<canonical permlink>`,
   built only from captured values: the publish page captures at init (or at adoption), the edit page when its
   first load lands (`_captureDraftTarget`). The edit page's `draftKey` getter is gone; `handleSubmit`, the landing
   clear, the restore and every writer use `_draftKey`. Shared storage helpers live in
   `frontend/src/lib/composer-drafts.js`; `relativeTime` moved to `frontend/src/lib/relative-time.js`.
2. **Baseline.** Plain fields once the prefill is done; editor fields after both editors mount and
   `PevoEditor.normalize()` (an explicit `editor.view.dispatch(editor.state.tr)`) has run on each. `_writeDraft`
   writes nothing without a captured key, before the baseline, while a choice card stands, or after landing; a
   form back at its baseline drops the stored text (`composeDraftEntry` keeps any other state and removes an
   entry left with none). `savedAt` moves only when the text changes. `editorsAtBaseline` is exposed on both
   pages. An unaccredited signed-in account drafts on /publish.
3. **Head binding.** `headMarkerOf(paper)` takes the payload's `head_marker` whenever the payload carries one,
   and otherwise computes `<head_author>/<head_permlink>/<versions.length>/<block_num of the last entry>`, null for
   the one-entry block-0 stub. A silent restore needs equal non-null markers. Otherwise the choice card shows:
   `edit.draftNewerVersion`, or `edit.draftVersionUnchecked` when either marker is null. The form is read-only
   (the fieldset is disabled and both editors `setEditable(false)`, also after a re-render) and `_writeDraft`
   refuses. Restore applies the draft and stores it bound to the loaded marker; Discard removes it.
4. **Edit page restored card**, reusing `publish.draftRestored`, `common.discard` and `time.*`. Its Discard
   re-runs the prefill, empties `newCoAuthors` and `addressedReviews`, reloads the editors, re-takes the baseline
   and removes the key. Discard is refused once landed on both pages, and the card hides on landing.
5. **Legacy entries** are never restored, and go on the first composer load with a captured account (both pages,
   adoption included).
6. **Account deletion** (`settings.js`, after the deletion succeeds) removes `pevo-draft-publish:<account>` and
   every `pevo-draft-edit:<account>:` key, trailing colon included. A sign-out keeps them.
7. **Remount.** The router store has `generation` and `remount()`, and pageMount re-renders on either the route or
   the generation. The page remounts when a different account signs in or the edit route names another paper. It
   flushes the pending save under the captured key first, and waits for a submit in flight to settle (a `step`
   watcher). Publish adoption keeps the form and attached files, captures the account, fills only empty author
   fields from the accreditation prefill (the baseline moves with them, so a sign-in with nothing typed drafts
   nothing), restores a stored draft silently over an untouched form, offers the choice card otherwise, merges the
   citation collection after that, and drafts under the new key. A change to no account does not remount and
   keeps drafting. The edit editors are bound to the form's x-if (`x-init` on the form root), so a re-render
   rebuilds them.

### Decisions and departures to check

- **Publish adoption with typed work and a stored draft** (user decision, 2026-10-01). The typed form is kept, the
  stored draft is not loaded, and a choice card ("You have a saved draft from {time}. Restore replaces what you
  typed here.") offers Restore and Discard, read-only until a pick. This adds `publish.draftSavedChoice`, one key
  beyond the Copy list. A form holding nothing typed gets the silent restore.
- **Edit page, a signed-out load followed by a sign-in, remounts.** § 8 makes adoption publish-only. That is what
  fixes the Why's call-to-action bullet (editors and author fields come back).
- **Both forms take no input until the baseline exists** (`formLocked`). The self-check found that the edit restore,
  which now waits for the editor import, silently replaced text typed during that wait. A dragged citation row,
  which the fieldset cannot disable, is refused while locked.
- **`editor.js` marks the tiptap Editor `__v_skip`.** Pre-existing defect: any `setContent()` or dispatch a page
  made through Alpine's reactive proxy threw "Applying a mismatched transaction". The publish page's existing
  Discard could not reset its editors. `tests/e2e/edit-paper.spec.js` documented this as a race, and that comment
  is corrected.

# A composer draft is bound to its account and, on the edit page, to the head it was written against

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
- **A restore is stored at once under the draft's own `savedAt`**, so what the restore fills in (ticks in checklist
  order, the prefill on empty author fields) does not date old text as new. The edit page restores author fields
  held as empty strings. The publish page fills empty draft author fields from the prefill, never from what was
  typed. After setContent the fields are read back from the editors (`_loadEditorsFromFields`), so Discard's
  re-taken baseline is the editors' text, not the served text.
- **`_prefillForm` empties the author fields for a broadcaster absent from `authors[]`** (the accepted-claim case),
  so a Discard does not keep the draft's entry.
- **The publish page applies the accreditation prefill when the accreditation arrives after the username** (the
  email sign-in passes none), and a signed-out publish form no longer merges, and so uses up, the citation
  collection.

### Coordination

`pending/ui-upload-batch-teardown-guard.md`: this task landed first. The remount waits for a submit to settle; a
subject change between that submit's legs stays the batch guard's job (same `handleSubmit` legs).

### Real-editor spec (AC9)

`frontend/tests/unit/composer-drafts-real-editors.test.js`. It boots index.html's body and `main.js` once under
jsdom, with the real Alpine, pageMount, router, auth store and tiptap editors. Fetch answers from fixtures,
Keychain is a stub that records broadcasts, and fake timers cover the debounce. 46 cases cover the load-time write
with a list body the editor rewrites, the baseline, signed-out and non-author visitors, account binding and
remounts (also after a submit settles), adoption, teardowns, the history jump, the three cards, legacy keys and
the canonical-pair key.

### Probes (AC9)

85 mutation probes, each applied alone to a scratch copy of 301be0a8 (anchor asserted to match once) and run
against its spec files (the real-app spec plus the page's unit file, or the lib/router/settings files). 82 went
red. The 3 greens:

- `ed-write-key`: on the edit page an instance without a key has no form, so it never gets a baseline. The no-key
  refusal there is a second guard behind the no-baseline refusal, which `ed-write-baseline` shows red.
- `ed-incidental-only` (removing the editor's own i18n-effect dispatch) is green by design: the explicit
  normalise covers it.
- `ed-normalize-only` (removing the explicit normalise) was red in 1 of 6 runs and green in 5. The incidental
  dispatch usually, not always, rewrites the list before the baseline under jsdom. That is the timing the task
  calls incidental. With both removed (`ed-normalize-and-incidental`) it is red every time.

| Probe | Mutation | Result | First failing test |
|---|---|---|---|
| `pub-write-key` | publish `_writeDraft`: drop the no-key refusal | RED | a signed-out visitor drafts nothing on either page |
| `pub-write-baseline` | publish `_writeDraft`: drop the no-baseline refusal | RED | a flush before the restore has run leaves a real draft untouched |
| `pub-write-choice` | publish `_writeDraft`: drop the choice-card refusal | RED | a sign-in under a signed-out form that holds work, for an account with a stored draft, asks before either replaces the other |
| `pub-write-atbaseline` | publish `_writeDraft`: never at baseline | RED | a sign-in under a signed-out form that holds nothing drafts nothing: the prefill it brings is not work |
| `pub-adopt-branch` | publish `_onAccountChange`: no adoption branch | RED | a sign-in before the editors have mounted leaves the restore to the mount |
| `pub-account-null` | publish `_onAccountChange`: a change to no account counts | RED | a change to no account, or back to the captured one, keeps the instance drafting under its key |
| `pub-remount-submitting` | publish `_remountWhenSettled`: ignore a submit in flight | RED | waits for a submit in flight to settle before replacing the instance |
| `pub-remount-flush` | publish `_remountWhenSettled`: no flush before remount | RED | another account replaces the instance, after flushing the pending save under the captured key |
| `pub-step-watcher` | publish: no `step` watcher | RED | a sign-in under a signed-out form that holds work, for an account with a stored draft, asks before either replaces the other |
| `pub-adopt-baseline-move` | publish `_prefillEmptyAuthorFields`: baseline does not move | RED | a sign-in under a signed-out form that holds nothing drafts nothing: the prefill it brings is not work |
| `pub-adopt-write` | publish `_adoptAccount`: no write under the new key | RED | text typed on the publish page while signed out survives an in-page sign-in and is drafted for that account |
| `pub-adopt-merge` | publish `_adoptAccount`: no collection merge | RED | a signed-out form leaves the citation collection alone, and the sign-in restores the draft and then merges it |
| `pub-merge-key` | publish `_mergeCitationCollection`: merge without an account | RED | a signed-out form leaves the citation collection alone, and the sign-in restores the draft and then merges it |
| `pub-restore-choice` | publish `_restoreDraft`: always silent | RED | a sign-in under a signed-out form that holds work, for an account with a stored draft, asks before either replaces the other |
| `pub-restore-sync` | publish `_restoreDraft`: editors not locked | RED | a sign-in under a signed-out form that holds work, for an account with a stored draft, asks before either replaces the other |
| `pub-fieldset` | publish template: fieldset never disabled | RED | the form is locked until the baseline exists and while a choice stands |
| `pub-formlocked-baseline` | publish `formLocked`: ignore the baseline | RED | refuses while the form is locked: before the baseline, and while the choice card stands |
| `pub-drag-lock` | publish `dragCitationDrop`: no lock check | RED | refuses while the form is locked: before the baseline, and while the choice card stands |
| `pub-discard-landed` | publish `discardDraft`: no landed refusal | RED | the restored card's Discard is refused once landed, and the card is gone |
| `pub-card-landed` | publish template: restored card shown after landing | RED | the restored card's Discard is refused once landed, and the card is gone |
| `pub-legacy` | publish `_captureAccount`: no legacy removal | RED | legacy entries are never restored and go on the first load with an account; a sign-out keeps the bound ones |
| `pub-apply-savedat` | publish `_applyDraft`: restore stored under now | RED | a restore whose empty author fields take the prefill does not date the draft as new |
| `pub-apply-authors` | publish `_applyDraft`: typed author fields kept | RED | the choice card's Restore replaces typed author fields with the draft's, or with the prefill where the draft holds none |
| `pub-accreditation-watch` | publish: no accreditation watcher | RED | an email sign-in, whose accreditation arrives after the username, still gets the prefill on empty author fields |
| `pub-choice-copy` | publish choice card: draftRestored copy | RED | a sign-in under a signed-out form that holds work, for an account with a stored draft, asks before either replaces the other |
| `pub-restore-label` | publish choice card: Discard label on Restore | RED | a sign-in under a signed-out form that holds work, for an account with a stored draft, asks before either replaces the other |
| `ed-capture-authorized` | edit `_captureDraftTarget`: key for a non-author | RED | an account that cannot edit the paper drafts nothing on the edit page |
| `ed-capture-legacy` | edit `_captureDraftTarget`: no legacy removal | RED | legacy entries are never restored and go on the first load with an account; a sign-out keeps the bound ones |
| `ed-capture-canonical` | edit `_captureDraftTarget`: key from the route params | RED | an edit page opened under a pair other than the canonical one drafts under the canonical key |
| `ed-restore-null-guard` | edit `_restoreDraft`: null markers compare equal | RED | a draft written with no head marker waits on the could-not-check card, whether or not the paper now has one |
| `ed-restore-always-silent` | edit `_restoreDraft`: always silent | RED | a draft written against another head waits on the newer-version card, read-only, and Restore binds it to this head |
| `ed-choice-kind` | edit `_restoreDraft`: draft-null marker labelled newer | RED | a draft written with no head marker waits on the could-not-check card, whether or not the paper now has one |
| `ed-restore-sync` | edit `_restoreDraft`: editors not locked | RED | a draft written against another head waits on the newer-version card, read-only, and Restore binds it to this head |
| `ed-mounted-sync` | edit `_onEditorsMounted`: no re-lock on re-render | RED | a re-rendered form keeps the lock the choice card holds |
| `ed-mounted-guard` | edit `_onEditorsMounted`: baseline re-taken every render | RED | the baseline outlives a re-render: work typed only in an editor is still work after the same account signs back in |
| `ed-normalize-only` | edit `_onEditorsMounted`: normalize removed | GREEN | (none) |
| `ed-normalize-and-incidental` | edit `_onEditorsMounted` normalize and editor.js i18n dispatch both removed | RED | an edit-page load whose editors rewrite the served body writes no draft until the user types |
| `ed-incidental-only` | editor.js: i18n-effect dispatch removed | GREEN | (none) |
| `ed-mount-refs` | edit `_mountEditors`: mount without elements | RED | a mount that finds the elements gone builds nothing and takes no baseline |
| `ed-mount-generation` | edit `_mountEditors`: no generation check | RED | a mount superseded while its import is in flight builds nothing |
| `ed-mount-mounted` | edit `_mountEditors`: no `_mounted` check | RED | is a no-op when the component was destroyed before the import resolved |
| `ed-mount-destroy` | edit `_mountEditors`: old pair not destroyed | RED | a later render destroys the pair left on the old elements and builds one on the new |
| `ed-xinit` | edit template: no x-init on the form root | RED | the form root inside the form's x-if calls _mountEditors |
| `ed-write-key` | edit `_writeDraft`: drop the no-key refusal | GREEN | (none) |
| `ed-write-baseline` | edit `_writeDraft`: drop the no-baseline refusal | RED | a write after the load and before the editors have mounted writes nothing |
| `ed-write-choice` | edit `_writeDraft`: drop the choice-card refusal | RED | a draft written against another head waits on the newer-version card, read-only, and Restore binds it to this head |
| `ed-write-marker` | edit `_writeDraft`: no head marker stored | RED | an edit-page load whose editors rewrite the served body writes no draft until the user types |
| `ed-params-route` | edit `_onRouteParamsChange`: no route check | RED | route params naming another paper replace the instance; the same paper or another route does not |
| `ed-params-compare` | edit `_onRouteParamsChange`: same params remount | RED | route params naming another paper replace the instance; the same paper or another route does not |
| `ed-account-captured` | edit `_onAccountChange`: acts before the load | RED | nothing is replaced before the load has captured anything |
| `ed-account-null` | edit `_onAccountChange`: a change to no account counts | RED | a change to no account, or back to the captured one, keeps the instance |
| `ed-remount-submitting` | edit `_remountWhenSettled`: ignore a submit in flight | RED | waits for a submit in flight to settle before replacing the instance |
| `ed-remount-flush` | edit `_remountWhenSettled`: no flush before remount | RED | another account replaces the instance, after flushing the pending save under the captured key |
| `ed-step-watcher` | edit: no `step` watcher | RED | init() registers every draft $watch handler + 1 storage listener exactly once; subsequent loadPaperData() does not re-register |
| `ed-apply-strings` | edit `_applyDraft`: empty author fields skipped | RED | Restore puts back author fields the draft had cleared, and stores them cleared |
| `ed-apply-savedat` | edit `_applyDraft`: restore stored under now | RED | a restore that reorders the ticks does not date the draft as new |
| `ed-apply-write` | edit `_applyDraft`: restore not stored | RED | a draft written against another head waits on the newer-version card, read-only, and Restore binds it to this head |
| `ed-discard-landed` | edit `discardDraft`: no landed refusal | RED | the restored card's Discard is refused once landed, and the card is gone |
| `ed-discard-empties` | edit `discardDraft`: rows and ticks kept | RED | the restored card's Discard empties the rows and ticks only the draft added |
| `ed-discard-editors` | edit `discardDraft`: editors not reloaded | RED | a draft written against the head the page loaded is restored silently, with the restored card |
| `ed-loadfields-readback` | edit `_loadEditorsFromFields`: body not read back | RED | a draft written against the head the page loaded is restored silently, with the restored card |
| `ed-discard-remove` | edit `discardDraft`: no removal | RED | a draft written against the head the page loaded is restored silently, with the restored card |
| `pub-discard-remove` | publish `discardDraft`: no removal | RED | the publish page's restored card Discard removes the draft at once and empties the form |
| `ed-restore-order` | edit `_onEditorsMounted`: restore before the baseline | RED | a draft that changed only the body is restored and kept: the baseline is the loaded form, not the restored one |
| `pub-sync-abstract` | publish `_syncEditorsEditable`: abstract editor not locked | RED | a sign-in under a signed-out form that holds work, for an account with a stored draft, asks before either replaces the other |
| `ed-params-author` | edit `_onRouteParamsChange`: author ignored | RED | route params naming another author, with the same permlink, replace the instance |
| `pub-adopt-early` | publish `_adoptAccount`: restore before the editor baseline | RED | a sign-in before the editors have mounted leaves the restore to the mount |
| `ed-pending-discard-remove` | edit `discardPendingDraft`: no removal | RED | the newer-version card's Discard keeps the loaded version and drops the draft |
| `ed-prefill-claimer` | edit `_prefillForm`: claimer author fields not emptied | RED | the restored card's Discard empties the author fields of an accepted claimer the paper does not list |
| `ed-drag-lock` | edit `dragCitationDrop`: no lock check | RED | a citation drag is refused while the form is locked |
| `ed-fieldset` | edit template: fieldset never disabled | RED | the form is locked until the baseline exists and while a choice stands |
| `ed-formlocked-baseline` | edit `formLocked`: ignore the baseline | RED | the form is locked until the baseline exists and while a choice stands |
| `ed-card-landed` | edit template: restored card shown after landing | RED | the restored card's Discard is refused once landed, and the card is gone |
| `ed-restore-label` | edit choice card: Discard label on Restore | RED | a draft written against another head waits on the newer-version card, read-only, and Restore binds it to this head |
| `lib-stub-null` | `headMarkerOf`: stub not null | RED | is null for the one-entry stub a failed or empty replay leaves |
| `lib-payload-marker` | `headMarkerOf`: payload marker ignored | RED | takes the payload's own marker whenever the payload carries one, null included |
| `lib-savedat` | `composeDraftEntry`: savedAt always now | RED | keeps the time when the text is unchanged, and moves only the marker |
| `lib-otherstate` | `composeDraftEntry`: other state dropped at baseline | RED | drops the text and its bookkeeping at the baseline, keeping any other state |
| `lib-separator` | `removeAccountDrafts`: prefix without the separator | RED | removes one account's drafts and leaves an account whose name extends it alone |
| `lib-legacy-edit` | `removeLegacyDrafts`: edit shape kept | RED | removes the keys used before drafts were bound to an account, and only those |
| `lib-read-remove` | `readDraftEntry`: corrupt entry kept | RED | reads a stored entry, and removes one that does not parse to an object |
| `rt-remount` | router `remount`: generation not moved | RED | moves the generation and leaves the route, params and history alone |
| `pm-generation` | pageMount: generation ignored | RED | one account's edit draft is not restored for another, and a mounted form is replaced when the other signs in |
| `st-remove` | settings `handleEmailDelete`: no draft removal | RED | removes exactly the deleted account's composer drafts |
| `ed-vskip` | editor.js: no `__v_skip` marker | RED | an edit-page load whose editors rewrite the served body writes no draft until the user types |

### Tests

- Unit: `npx vitest run` gives 90 files, 2092 tests, exit 0 at e4e7eed2 (was 88 / 2016 at the start). The new
  files are `composer-drafts-real-editors.test.js` and `lib-composer-drafts.test.js`. Changed: `pages-publish`,
  `pages-edit`, `pages-settings`, `router`.
- AC10: the 31 literal draft-key strings in the six test files moved to the new shape (4 e2e specs, `pages-edit`,
  `pages-publish`). The remaining old-shape literals are deliberate legacy fixtures in the new tests.
- Build: `npm run build` is clean (only the standing dhive eval warning).
- E2E (`./deploy.sh restart`, `test-db-up`, `test-up`, then `up` afterwards), the four composer specs:
  - **As committed: 6 passed, 9 failed.** All 9 are the pre-existing strict-mode clash: `form button[type="submit"]`
    also matches the always-present re-auth modal's Confirm button. Neither index.html nor those locators is
    touched here.
  - **Re-run from a scratch copy with the locator scoped to the page's form (not committed): 9 passed, 2 failed.**
    All 7 edit-paper specs pass. The 2 failures (`publish.spec.js`, and coauthor-accredited-prefill's publish
    broadcast) stop at the Keychain-signed IPFS upload pre-flight. That answers 401, and the browser console shows
    `[publish pdf upload] ApiRequestError: Signature verification failed`. Upload and signing code is untouched.
    The light-account publish-with-PDF path (`non-consent-fresh-auth.spec.js`) passes end to end.

### Considered and not built

- **Discard clicked while a submit is in flight.** `handleSubmit` reads `title` and `addressedReviews` after its
  awaits, so a mid-submit Discard mixes the paper's title with the draft's body. This is the pre-existing
  live-read class (the form was never disabled during a submit). The task gates Discard on `_landed` only. It
  could be a separate task.
- **An account deleted in one tab, with a composer still mounted in another.** That composer keeps drafting
  under the deleted account's key after the storage-event sign-out. This is spec-conformant (a change to no
  account keeps drafting); a § 8 Limits line is the architect's call.
- Tightening the e2e submit locators for the modal clash: pre-existing and out of scope.

Code review: owned by the architect at review intake (`agents/ui/CLAUDE.md`: the UI agent does not run
`/ce-code-review`). Before this signal, the work went through a self-verification workflow: five lenses over
4882cd42, one skeptic per lens, 10 agents. It confirmed 22 findings. Each one is fixed or pinned in
5b4ee3cd..301be0a8, apart from 3 the skeptics refuted (two are listed under Considered and not built; the
third, a missing signal block at the reviewed commit, is answered by this block). A simplify pass followed:
1 change applied, 5 skipped (`editorsAtBaseline` is required by Scope 2; the serialisation savings are bounded
by the debounce).

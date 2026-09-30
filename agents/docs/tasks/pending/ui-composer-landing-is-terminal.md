# A landed broadcast ends the composer instance: one draft clear, a write barrier, no second submit

**Owner:** ui
**Created:** 2026-09-30

Implements the draft lifecycle decision in `agents/docs/ARCHITECTURE.md` § 8 ("Composer
Drafts"). Read that section first. It is short, and it is the contract this task is
reviewed against. Filed out of `architect-edit-draft-lifecycle-decision` (archived
2026-09-30), which collected the questions the edit-draft ticks task kept out of its
implementer's scope for six rounds. § 8 and this file went through `/ce-doc-review`
before filing.

## Why

On main, `handleSubmit` in `frontend/src/pages/edit.js` keeps a spent draft out of storage
with a clear at each exit past the broadcast: one after each arm's broadcast, one after
each arm's `invalidatePaperCache` await, and one in the terminal catch behind the `landed`
local. Each clear answers for one moment, and the form stays interactive after every one
of them. What that leaves open, all verified against main on 2026-09-30:

- **A resting state has no exit to hang a clear on.** After a rejecting invalidation the
  page rests at `step = 'error'` with the form live. A keystroke arms the debounce and a
  file selection flushes through `_windowReady`. Either writes the spent draft back, and
  nothing runs afterwards to remove it.
- **The success window.** For the 1.5 s before `navigate()` fires, a file selection
  flushes the draft back. `destroy()` cancels a pending timer, not a write that already
  happened.
- **The clears after the invalidation await run by captured key after the component is
  gone.** A later visit to the same paper shares that key, so a draft it wrote while the
  earlier instance's invalidation was still pending is deleted.
- **A landed edit is reported as a failure.** A rejecting invalidation sends a post that is
  on chain to `common.editFailed`. The route is authenticated and rate limited, so a 401
  or a 429 gets there as readily as a network error. The natural response to "edit failed"
  is to submit again.
- **A second native edit from the same instance corrupts the body.** `isSubmitting`
  excludes `success` and `error`, so the submit button is live in both. The instance still
  holds the body it loaded as its diff base, so a second native edit sends a patch computed
  against the pre-edit body, and `applyHivePatch` in `backend/src/lib/chain-walkers.ts`
  applies it to the already-patched body without reading `patch_apply`'s per-hunk flags.
  Measured with the installed `diff-match-patch` (the `computeDiff` shape from `edit.js`,
  applied twice): a re-applied insertion is inserted twice, a re-applied append is
  appended twice, a re-applied deletion removes a second, similar passage. The edit page
  has no confirm dialog, so for a light account with an open window nothing stands between
  the second click and the second broadcast.
- **A second submit on the continuation arm or the publish page is a second post.** Both
  mint the permlink inside `handleSubmit` from `slugify(title)` plus `Date.now()`.
- **An unmount during the broadcast skips the invalidation.** The `_mounted` guard sits
  ahead of it, the paper-detail cache entry lasts 30 minutes, and the `/invalidate` route
  is what evicts it. So a user who leaves while the broadcast is in flight is served the
  pre-edit paper for up to half an hour.
- **`publish.js` has the same shapes and was never audited exit by exit.** Its `_mounted`
  guard sits ahead of its only clear, so leaving during the broadcast keeps the draft of a
  paper that is on chain, and the next visit to `/publish` offers it again. Its clear is a
  bare `localStorage.removeItem` that does not cancel the debounce, so a change made in the
  last two seconds of the broadcast writes the draft back inside the navigate delay. A file
  selection in the success window flushes it back, as on the edit page.

## Scope

Both pages, one rule: **from the moment the broadcast resolves with a result, the instance
is finished.** "Resolves with a result" means `broadcastWithFreshAuth` returned something
other than `FRESH_AUTH_REDIRECT_PENDING`. A rejection and the sentinel both mean "not
landed": they keep the draft, and the instance keeps drafting and stays submittable,
exactly as today.

1. **One clear, at landing.** Cancel the debounce and remove the entry as the first thing
   after the broadcast resolves with a result, ahead of any `_mounted` guard. On the edit
   page, by the key `handleSubmit` captures before its first await, as today. On the
   publish page this means the landing check moves ahead of the `_mounted` guard that
   currently precedes it. The publish page's redirect-pending branch relies on that guard
   today, so it gets a `_mounted` guard of its own ahead of its `step` write, as both edit
   arms have.
2. **A write barrier in `_writeDraft`.** Once landed, `_writeDraft` writes nothing, on
   both pages. It has to be in `_writeDraft` itself: the debounce and the flush both end
   there, and a refusal placed only in `_scheduleDraftSave` leaves the flush open. Leave
   `_scheduleDraftSave` as it is. A timer armed after the landing fires into the refusal.
3. **No second submit.** Once landed, `handleSubmit` returns before it changes `step` or
   reaches any gate, and the submit control is disabled. Add the landed flag as its own
   term in each page's `:disabled` binding (`isSubmitting || ...` on the edit page,
   `isSubmitting || txBlock || ...` on the publish page). Leave `isSubmitting` and the
   label expression alone: the button reads its idle label, disabled, for the 1.5 s. No
   new copy.
4. **The invalidation is best effort, and it runs whether or not the component is still
   mounted** (edit page). The sequence past the landing becomes: landing clear, then
   `invalidatePaperCache` awaited inside its own try/catch, then the `_mounted` guard,
   then `success` and the navigate timer. The `_mounted` guard that sits between the
   landing and the invalidation on main goes. A rejection is logged where it is caught
   with the `console.warn` sanitization pattern the terminal catch uses, mounted or not,
   and adds no toast and no copy. Keep the call awaited: the navigate must not outrun the
   eviction. After this change nothing past the landing reaches the terminal catch.
5. **Remove what the barrier makes unnecessary** (edit page): both clears after the
   invalidation await, the `landed` local, and the terminal catch's clear. This is a
   requirement and not tidying. A clear that runs after the landing clear is the thing
   that deletes a later visit's draft.
6. **Comments.** Two comments on main say more than the code knows, and both sit in lines
   this task rewrites. The terminal catch's comment says "nothing landed", and the header
   and title of the spec `a broadcast that fails before landing keeps the flushed draft`
   in `frontend/tests/unit/pages-edit.test.js` say the throw "has put nothing on chain". A
   broadcast can reject with the transaction on chain (§ 8, Limits). What the code knows
   is that the broadcast call did not resolve. Say that, and say that the draft is kept
   either way because losing typed work is the worse outcome.

Recommended shape, implement unless you see a reason to deviate, in which case say so in
the signal block: one instance flag and one method that sets it, cancels the debounce and
removes the entry, called once per landing site. The two arms of the edit page's
`handleSubmit` run the same sequence past the broadcast. Sharing one tail between them is
allowed and reduces the sites criterion 8 has to probe.

## Out of scope

- **A retry after a broadcast that rejected.** Whether that retry is safe when the first
  attempt did land is a separate decision
  (`tasks/pending/architect-composer-retry-safety-and-draft-binding.md`). This task must
  not change what a rejection does.
- **A stale diff base in a fresh instance.** When the invalidation fails, an edit page
  loaded before the cache entry expires diffs against the pre-edit body (§ 8, Limits).
  Same architect task. Do not add a retry, a toast or an error state for a failed
  invalidation here.
- **What a draft is bound to.** A draft records neither the account that wrote it nor the
  chain head it was written against, and the edit page restores one without saying so.
  Same architect task.
- **Making the form inert after the landing.** Only the submit control changes. The
  fields and the file pickers stay as they are.
- **The key a writer uses when the same instance outlives a router param change.** Carried
  by `tasks/blocked/ui-composer-surfaces-navigate-over-undrafted-work.md`. The debounce,
  the flush and the confirm's flush keep reading the `draftKey` getter.
- New i18n keys, in any locale.

## Acceptance criteria

Edit page, each for both arms (continuation and same-author) unless the arms share one
tail, in which case say so in the signal block and cover the tail once plus each arm's
entry into it:

1. An unmount during the broadcast still drops the draft the landed post spent, by the
   captured key, and still requests the invalidation. Stage the unmount inside the
   broadcast mock together with `mockStores.router.params` renamed to another paper that
   holds a draft of its own. Assert the spent draft is gone, the other paper's draft is
   untouched, and `invalidatePaperCache` was called for the landed paper.
2. After the landing, no writer puts the draft back:
   a. a debounced save armed during the invalidation await and fired before it settles;
   b. a file selection during the invalidation await, through
      `handleSupplementaryFiles` and `_windowReady`'s flush;
   c. a file selection at `step === 'success'`, before the navigate timer fires.
3. A rejecting `invalidatePaperCache` ends at `step === 'success'` with the navigate timer
   armed and no error message. No path shows `common.editFailed` once the broadcast call
   has resolved with a result.
4. A draft written under the same key after the landing clear is still in storage when
   `handleSubmit` returns, with the invalidation resolving and with it rejecting. (This is
   the later visit's draft. Stage it as a direct `localStorage.setItem` inside the mocked
   invalidation, after a `destroy()`.)
5. A second `handleSubmit` on an instance that has landed broadcasts nothing, leaves
   `step` alone and writes no draft. The `:disabled` binding on the submit control carries
   the landed term. State in the signal block how the binding was checked.
6. The not-landed outcomes are unchanged, and each leaves the instance drafting and
   submittable. This is the pin against a barrier raised too early, which would silently
   stop drafting for the rest of the visit.
   a. After a rejected broadcast: the flushed draft is in storage, a later change is saved
      by the debounce, and a later `handleSubmit` reaches the broadcast again.
   b. After `FRESH_AUTH_REDIRECT_PENDING`: the flushed draft is in storage, a later change
      is saved by the debounce, and a later `handleSubmit` is not refused (it reaches
      `_windowReady`; what the gate then does depends on the account the spec staged and
      is not part of this criterion).

   `$watch` is mocked in both harnesses, so "a later change" is staged through
   `_scheduleDraftSave()`, as the existing specs do.

Publish page:

7. The same behaviors where the page has them:
   a. an unmount during the broadcast drops the draft of the landed paper;
   b. with a save the debounce armed during the broadcast, `_draftTimer` is null once
      `handleSubmit` returns and storage is still empty after the debounce delay. The
      handle assertion is what makes the cancel visible: behind the barrier, storage
      stays empty whether or not the timer was cancelled;
   c. a file selection at `step === 'success'`, through `handlePdfChange` and through
      `handleSupplementaryFiles`, writes nothing;
   d. a second `handleSubmit` after the landing broadcasts nothing and opens no confirm
      dialog, and the `:disabled` binding carries the landed term;
   e. a redirect-pending result on an unmounted instance leaves `step` and the draft
      untouched;
   f. the not-landed outcomes of criterion 6 hold.

Both pages:

8. Every assertion above is probed by reverting its own site, and the probes are per site,
   not per fix. List each probe and the spec that caught it in the signal block. The
   sites:
   - each landing call (one per arm on the edit page, or each arm's entry into a shared
     tail plus the tail once; one on the publish page);
   - inside the landing method, its three effects separately: the flag, the debounce
     cancel, the removal. Reverting the whole call turns most specs red at once and
     attributes nothing;
   - the key the edit page's landing clear uses, probed by reading the `draftKey` getter
     in place of the captured key (criterion 1 has to catch it);
   - the barrier in each page's `_writeDraft`, including the probe that moves the refusal
     to `_scheduleDraftSave` (2b, 2c and 7c have to catch it);
   - the submit refusal in each page's `handleSubmit`, and the landed term in each
     `:disabled` binding by the method criterion 5 names;
   - the invalidation catch, and the invalidation's position ahead of the `_mounted`
     guard (criterion 1 has to catch a guard put back in front of it);
   - a clear reinstated after the invalidation await, which is the shape on main
     (criterion 4 has to catch it);
   - the barrier raised before the broadcast await (criterion 6 has to catch it).

   Both harnesses build a component with `_initialLoadDone` false unless the spec runs
   `loadPaperData` or sets it, and `_writeDraft` returns early on that flag. A "writes
   nothing" assertion is vacuous until the fixture turns it on, so run the barrier probe
   against every such spec, not against one of them.
9. The specs on main that pin the removed clears are rewritten to the new contract, not
   deleted: the three that stage a rejecting invalidation, the two that stage an unmount
   across a resolving invalidation, and the one that enters the terminal catch unmounted.
   Each either still describes a reachable path and pins it, or is replaced by the
   criterion above that covers its risk. Say which in the signal block.
10. New and reworded comments follow root `CLAUDE.md` "Comment anchors": no task slug,
    round or hold ordinal, line number, commit SHA, or bare positional reference. The
    docblock on `_clearDraft`, the comment on the `landed` local (it moves to whatever
    replaces that local) and the terminal catch's comment describe the exit-by-exit
    design, and so do the headers of the surviving draft specs in both unit files.
    Rewrite them to the design that is there when you are done.

## Notes

The unit suites are the evidence for this task: `frontend/tests/unit/pages-edit.test.js`
and `frontend/tests/unit/pages-publish.test.js`. `frontend/tests/e2e/edit-paper.spec.js`
and `frontend/tests/e2e/publish.spec.js` both drive a full submit. Run them if the e2e
stack is up, and say in the signal block whether you did.

If you find a writer of either draft key that does not go through `_writeDraft`, or a path
past the landing that can still reach the terminal catch, stop and flag it in the task
file before landing. Both would mean § 8 is wrong about the code, and the section gets
fixed first.

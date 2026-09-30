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

## UI implementation signal (2026-09-30, commits `49e8fcea`, `3c5ca950`)

Landed in `49e8fcea` (both pages and both unit files) and `3c5ca950` (removes one spec from
the edit unit file, see "Binding check"). Both verified as ancestors of `main`.

**Shape.** The recommended one: an instance flag `_landed` and one method `_markLanded`
(flag, debounce cancel, removal) on each page. The barrier is in `_writeDraft`, the submit
refusal is the first statement of `handleSubmit`, and each `:disabled` binding carries
`|| _landed` as its own term. `isSubmitting`, the label expressions and
`_scheduleDraftSave` are untouched. No i18n key was added.

**The two edit arms share one tail**, `_finishLanded(draftKey, canonicalAuthor,
canonicalPermlink)`: `_markLanded(draftKey)`, then the invalidation inside its own
try/catch (`console.warn('[edit invalidate]', err)`), then the `_mounted` guard, then
`success` and the navigate timer. Each arm's entry is one `await this._finishLanded(...)`.
`_clearDraft`, the `landed` local, both clears after the invalidation await and the
terminal catch's clear are removed.

**One deviation.** The canonical author and permlink are captured in `handleSubmit` next
to the other targets, ahead of the broadcast, and passed into the tail. On main each arm
read `this.paper` after the broadcast. The tail now runs on an unmounted instance too, and
a throw from a `this.paper` read there would have reached the terminal catch, which
scope item 4 rules out.

**Stop-and-flag checks, both negative.** The only `setItem` on either draft key is in the
page's `_writeDraft`. Nothing past the landing reaches the terminal catch: the tail's one
await is caught where it is called (probe E12).

**Publish page, beyond the letter of the scope.** The refusal in `_writeDraft` sits ahead
of the empty-form `removeItem` as well as the write, since every visit shares the one key.
Pinned by `a flush of an emptied form on a landed instance leaves the shared key alone`
(probed by moving the refusal below the removal: that spec alone goes red).
`discardDraft()` still removes the entry on a landed instance. It is a user action on a
mounted page and was left alone.

### Criterion 9: the six specs that pinned the removed clears

| Spec on main | Outcome |
|---|---|
| `the continuation post drops the draft when the cache invalidation rejects` | Rewritten, path still reachable: `a rejecting cache invalidation still ends in success, with the rejection logged and the navigate armed` (criterion 3, continuation arm) |
| `a keystroke during the rejecting invalidation cannot resurrect the spent draft` | Rewritten, path still reachable: `a save armed during a rejecting invalidation fires into the write barrier` (2a, same-author) |
| `the continuation post drops a draft re-armed during the rejecting invalidation` | Replaced: the per-arm catch clear is gone. Risk covered by `a file selection during the invalidation await writes nothing` (2b, continuation arm) |
| `an unmount across a resolving invalidation drops the draft a fired save wrote back` | Rewritten, path still reachable: `a save armed and fired inside the invalidation await writes nothing` (2a). The fired save writes nothing, so there is nothing to drop |
| `an unmount across a resolving invalidation drops the continuation draft a fired save wrote back` | Replaced by criterion 4: `a draft a later visit wrote during a resolving invalidation is still there when handleSubmit returns`. The new contract requires the opposite of the old spec |
| `a catch entered unmounted after the debounce fired drops the rewritten draft by its captured key` | Replaced: nothing past the landing reaches the terminal catch. Covered by criterion 4's rejecting variant, and its captured-key half moved into both criterion 1 unmount specs |

`a broadcast that fails before landing keeps the flushed draft` is now `a broadcast call
that does not resolve keeps the flushed draft and leaves the instance drafting and
submittable` (scope item 6 and criterion 6a), with a continuation twin.

### Criterion 8: probes, one mutant per site

Run by an agent that did not write the specs, one fresh scratchpad copy of `frontend/` per
mutant, after two repair rounds on the specs. Baseline green. Every mutant was killed.
"n" is the number of specs that went red; the named specs are the ones the criterion
requires, or the most specific ones.

Edit page (`pages-edit.test.js`):

| Site | Mutant | n | Caught by |
|---|---|---|---|
| continuation arm's entry | call deleted | 9 | `an unmount during the continuation broadcast still drops the draft the landed post spent` and others |
| same-author arm's entry | call deleted | 26 | `an unmount during the broadcast still drops the draft the landed edit spent` and others |
| landing call in the tail | `_markLanded(draftKey)` deleted | 18 | both later-visit specs, both file-selection specs and others |
| `_markLanded`: flag | line deleted | 8 | both file-selection specs, both save-armed specs, the second-submit specs |
| `_markLanded`: debounce cancel | line deleted | 2 | `the landing cancels a save the debounce still has armed` and its continuation twin |
| `_markLanded`: removal | line deleted | 18 | both unmount specs, both later-visit specs and others |
| landing key | `this.draftKey` in place of the captured key | 2 | both unmount specs (criterion 1) |
| barrier | refusal deleted from `_writeDraft` | 4 | 2a (both), 2b, 2c |
| barrier | refusal moved to `_scheduleDraftSave` | 4 | 2b, 2c, and both 2a specs |
| submit refusal | deleted | 4 | the four `a second submit on a landed instance ...` specs |
| `:disabled` term | `\|\| _landed` removed | 1 | `the submit button is disabled by the landed flag` |
| invalidation catch | bare await | 2 | criterion 3 spec, `a save armed during a rejecting invalidation fires into the write barrier` |
| invalidation ahead of the guard | `_mounted` guard put back in front | 2 | both unmount specs (criterion 1) |
| clear after the invalidation await | second `_markLanded(draftKey)` | 5 | the later-visit specs, resolving and rejecting (criterion 4) |
| clear after the invalidation await | bare `removeItem(draftKey)` | 4 | the later-visit specs, resolving and rejecting, each arm |
| barrier before the broadcast, continuation | `_landed = true` ahead of the await | 2 | continuation 6a and 6b specs |
| barrier before the broadcast, same-author | `_landed = true` ahead of the await | 2 | same-author 6a and 6b specs |
| redirect-pending branch, each arm | block deleted | 3 each | that arm's three redirect-pending specs |

Publish page (`pages-publish.test.js`, describe `a landed broadcast ends the composer instance`):

| Site | Mutant | n | Caught by |
|---|---|---|---|
| landing call | deleted | 7 | 7a, 7b, both 7c, 7d and others |
| `_markLanded`: flag | line deleted | 5 | both 7c specs, the armed-after-landing spec, 7d |
| `_markLanded`: debounce cancel | line deleted | 1 | 7b, on the `_draftTimer` handle |
| `_markLanded`: removal | line deleted | 6 | 7a, 7b, both 7c and others |
| barrier | refusal deleted from `_writeDraft` | 3 | both 7c specs, the armed-after-landing spec |
| barrier | refusal moved to `_scheduleDraftSave` | 3 | `handlePdfChange` and `handleSupplementaryFiles` specs, each separately |
| submit refusal | deleted | 1 | 7d |
| `:disabled` term | `\|\| _landed` removed | 1 | `the submit button is disabled by the landed flag as its own term` |
| barrier before the broadcast | `_landed = true` ahead of the await | 2 | both 7f specs |
| landing ahead of the guard | `_markLanded()` moved behind the `_mounted` guard | 1 | 7a |
| redirect-pending's own guard | deleted | 1 | 7e |
| redirect-pending branch | block deleted | 3 | 7e, 7f and the remintable-401 spec |

Vacuity (`_initialLoadDone`): every spec that asserts nothing is written after the landing
runs on a fixture with the flag set and goes red under the barrier probe, with three
stated exceptions where another refusal stands in front. On both pages the second-submit
specs' storage clause is held by the submit refusal first. On the publish page 7b's
trailing storage clause cannot be reached once the timer is cancelled. Those specs bite on
the broadcast count, the `_writeDraft` spy and the `_draftTimer` handle.

Two probe results a reviewer should know:

- A removal reinstated after the invalidation await but **behind** the `_mounted` guard
  turns no spec red. Criterion 4 stages the later write after `destroy()`, so it covers the
  ahead-of-guard position, which is the shape on main. A mounted-only second removal can
  only reach another tab's draft, which § 8 Limits already accepts.
- All four edit barrier specs for 2a and 2c run on the same-author fixture, and 2b runs on
  the continuation one. The barrier is the one shared `_writeDraft`.

### Binding check (criteria 5 and 7d)

Two layers. In the repo, a template assertion per page pins the exact `:disabled` string.
In scratchpad copies, a throwaway spec sliced the submit button out of each shipped
template and mounted it under real Alpine in jsdom (no browser): the button is live with
`_landed` false, disabled once it is set, and keeps its idle label. Both passed. A repair
agent had also added that real-Alpine spec to the edit unit file. `3c5ca950` removes it, so
the unit file carries no second Alpine-mounting harness. Say so if you would rather have
it in the suite.

### Verification

- `npx vitest run` in `frontend/` at `49e8fcea`: 88 files, 2017 tests, exit 0, no Errors line.
  After `3c5ca950` the two page files re-run at 207 tests, exit 0.
- `npm run build`: clean.
- E2E not run. `edit-paper.spec.js` and `publish.spec.js` need the stack swapped into test
  mode, which I did not do in the shared checkout.
- A separate review agent per page checked the diff against the criteria and the comment
  rules. It reported no blocker. Its should-fix and nit items on comment wording are
  applied in `49e8fcea`.

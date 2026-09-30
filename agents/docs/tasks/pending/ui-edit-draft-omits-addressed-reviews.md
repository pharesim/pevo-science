# Edit draft omits the ticked reviews, so a re-auth round-trip silently drops `addresses_reviews`

**Owner:** ui
**Created:** 2026-09-21

## Why

On the edit page a passwordless (ORCID-only) light account acquires its re-auth
window by full-page navigation. The entry gate is allowed to navigate while no new
file is held, on the premise that everything else on the form is drafted. One field
is not: `addressedReviews`. `_scheduleDraftSave` in `frontend/src/pages/edit.js`
writes title, abstract, body, keywords, the author fields, `newCoAuthors` and
`citations`; the review ticks are in neither the saved object nor the restore path,
and no `$watch` schedules a save when a tick changes.

The sequence: tick the reviews this revision addresses, attach nothing, click
Submit. Ticks alone count as a change, so the no-changes check passes and the
permissive entry gate navigates to ORCID. The user returns to a restored form whose
ticks are gone and nothing says so. The resubmit then broadcasts the edit without
`addresses_reviews`.

This is worse than the other undrafted-state gaps on the same surface because it
changes what goes on chain, not only what the user has to retype. The edit lands
looking as if it addressed no review, and review invalidation downstream reads that
field.

Surfaced at the round-6 review of the light-account re-auth window work and
confirmed against the code by two reviewers. Pre-existing: the draft never carried
the field, and the navigating gate has been reachable since the ORCID factor was
wired into the submit sequence.

## Scope

Carry `addressedReviews` in the edit draft: save it, restore it, and schedule a
save when it changes.

On restore, reconcile against the reviews actually present on the paper: a saved
tick whose review no longer exists, or is no longer addressable, is dropped rather
than resurrected. Restore only after the paper's reviews have loaded, so the
reconciliation has something to check against.

Alternative considered and not preferred: adding the ticks to the
`holdsAttachedFiles` predicate so the gate refuses instead of navigating. That
treats a cheaply draftable field as if it were a file, and it would put a
passwordless account in front of a re-authenticate confirm for state the draft can
simply keep. Draft it.

Out of scope: the two-second draft debounce (handled with the re-auth window
task's held item on flushing before a navigating acquisition), and the review page,
comment composer and vouch surfaces, which have no draft at all.

## Acceptance criteria

1. A passwordless account that ticks reviews, attaches nothing, submits, and
   returns from the ORCID round-trip finds the same reviews ticked.
2. The resubmitted edit carries `addresses_reviews` with those reviews.
3. A saved tick for a review that is gone or no longer addressable at restore time
   is dropped, and the restored set contains only valid entries.
4. Discarding the draft clears the saved ticks with the rest of it.
5. Unit coverage in `pages-edit.test.js`: save includes the ticks, a tick change
   schedules a save, restore reinstates them, restore drops a stale one. Each
   assertion is probed by reverting its own site.

## UI implementation signal (2026-09-22, commits 1b6af088 and 2d505c2f)

Both SHAs self-verified as ancestors of `main` (`git merge-base --is-ancestor`).
No worktree fan-out; single-session inline work.

`1b6af088` carries the change, `2d505c2f` the simplify pass on it.

What landed in `frontend/src/pages/edit.js`:

- `_scheduleDraftSave` writes `addressedReviews` into the draft object.
- `_setupReactiveBindings` registers `$watch('addressedReviews', ...)`, so a tick
  schedules that save like every other drafted field.
- `_restoreDraft` reads it back through a new `_reconcileAddressedReviews`, which
  intersects the saved set with `this.reviews` by iterating the reviews rather
  than the saved array. A tick whose review is gone finds no match and is
  dropped; each survivor is rebuilt as `{author, permlink}`, which also collapses
  a duplicate out of a hand-edited or legacy draft and orders the result like the
  rendered checklist. `loadPaperData` assigns `reviews` from the enrichment
  response before it calls `_restoreDraft`, so the intersection already had the
  paper's reviews in hand and no reordering was needed.
- The checklist checkbox gained `:checked="isReviewAddressed(rev.author, rev.permlink)"`
  and the component gained that predicate. The input only listened for `@change`
  before, so without this a restored set would sit in component state while every
  box rendered clear. `:checked` + `@change` mirrors the citation-relevance
  checkbox in the same template; `x-model` is unavailable because the entries are
  `{author, permlink}` pairs, not strings.
- `toggleAddressedReview` is unchanged. With `:checked` bound, a `change` event
  cannot fire twice in the same direction, so no dedupe guard was added.

Acceptance criteria:

1. Covered by the restore path plus the `:checked` binding. Pinned by `restore
   reinstates a tick whose review is still on the paper` and `the checklist
   checkbox reflects the restored set`.
2. Pinned end to end by `the resubmit after a restore broadcasts
   addresses_reviews with the restored ticks`, which drives the real
   `loadPaperData` then the real `handleSubmit` and reads the broadcast
   `json_metadata`.
3. Pinned by `restore drops a saved tick whose review is no longer offered`.
4. The ticks live inside the one draft object, so every existing
   `removeItem(this.draftKey)` site takes them along. Pinned non-vacuously by
   `the post-success draft clear takes the ticks with it`, which asserts the
   restored tick was present before the submit.
5. Six probes below; the four the criterion names each die to their own site.

Verification:

- `pages-edit.test.js`: 81 passed (74 before). Full frontend unit suite in an
  isolated two-level copy: 86 files / 1918 tests passed. `npm run build` clean.
  Both run outside the checkout; `git status` confirmed unchanged afterwards.
- Mutation probes, one scratchpad copy per mutant off the committed tree:

  | reverted site | tests that die |
  |---|---|
  | the save site in `_scheduleDraftSave` | the debounced-save spec, plus the tick-change spec |
  | `$watch('addressedReviews', ...)` | the tick-change spec, plus the watcher-enumeration spec |
  | the restore line in `_restoreDraft` | restore, drop-stale, resubmit, post-success-clear |
  | the `reviews` intersection in `_reconcileAddressedReviews` | drop-stale only |
  | the `:checked` binding | the checkbox spec |
  | the `isReviewAddressed` body | the checkbox spec |

  Re-run after the simplify pass against `2d505c2f`; all six still kill.
- Real Alpine 3.15.11 mounted over the checklist block sliced out of the shipped
  `editPageTemplate` (throwaway spec in a scratchpad copy, not committed): a
  restored tick renders checked while its siblings do not, ticking a further
  review round-trips into the model and stays checked, and unticking the restored
  one clears both model and DOM. Alpine routes `checked` through
  `bindAttributeAndProperty`, and a programmatic property write dispatches no
  `change`, so the binding cannot re-enter the handler.
- `frontend/tests/e2e/edit-paper.spec.js` run under the documented test-mode
  dance (build, `restart`, `test-db-up`, `test-up`, run, `up`; dev routing at
  `pevo_app` confirmed restored afterwards). 7 of its specs fail, all with the
  same `strict mode violation: locator('form button[type="submit"]') resolved to
  2 elements`, the second element being the app-shell reauth modal's Confirm
  button in `frontend/index.html`. This is the dominant pre-existing E2E failure
  class, not a regression: neither commit adds any `type="submit"` markup
  (`git diff | grep -c` returns 0) nor touches the modal or its store. In the
  review-addressing spec specifically, `reviewCheckboxes.first().check()` passes
  against the new binding and the failure is on the following submit-click line,
  so the run is positive evidence for the `:checked` change in real Chromium.
  A pre-change baseline re-run was not performed.
- No new i18n keys, so no `STUBS.md` entry.

Notes for review, none of them changes in this diff:

- Enrichment-failure interaction. `loadPaperData` uses `Promise.allSettled`, so a
  rejected enrichment leaves `reviews` empty while the paper still loads. The
  checklist is then not rendered at all and the reconciliation drops every saved
  tick, and the restore-triggered watcher re-saves the pruned set. Implemented
  this way deliberately: the alternative keeps ticks the user cannot see or clear
  and broadcasts them, which is the same class of defect this task is about. The
  cheap-looking guard (reconcile only when `reviews` is non-empty) is wrong
  because it resurrects stale ticks on a paper whose reviews are all genuinely
  gone, which criterion 3 forbids.
- `newCoAuthors` is the same shape of gap, still open. `_scheduleDraftSave`
  persists it but `_setupReactiveBindings` registers no watcher for it, so a new
  co-author row reaches the draft only when some other watched field changes
  afterwards. The publish page watches its `coAuthors` equivalent. One line to
  fix; left alone as outside this task's stated scope. `discipline` is not a gap:
  the edit page renders it disabled and `_prefillForm` re-derives it.
- Three simplify findings were surfaced and dismissed by the user, recorded in
  `2d505c2f`'s message: a module-local `{author, permlink}` compare (five more
  inline copies live in this file, `publish.js` and `paper-detail.js`, so a
  helper at three of eight sites trades duplication for inconsistency), the
  vestigial `:value` on the checklist checkbox (pre-existing, read by nothing,
  and the E2E locates by `data-testid`), and collapsing the first two new specs.

## Architect re-review (2026-09-22) — HELD PENDING FIXES:

`/ce-code-review` on `1b6af088` + `2d505c2f` (six lenses; standards clean; two
validated P2s and one advisory). The core change is sound: the reconciler
cannot emit a tick the checklist does not render, the restore ordering holds,
`:checked` is the right Alpine shape, and all five criteria are pinned on the
fulfilled-enrichment path. Three items, all in the same file, then move back to
`review/`.

1. **Rejected enrichment on the return load prunes every saved tick and the
   restore-triggered re-save makes the loss permanent** (`edit.js`, the
   `_restoreDraft` reconcile assignment). `loadPaperData` settles with
   `Promise.allSettled`; on a rejected enrichment `reviews` stays `[]` and
   execution still falls through to `_restoreDraft`, so the intersection yields
   `[]`, the `$watch` microtask fires after `_initialLoadDone = true`, and two
   seconds later the draft is rewritten without the ticks. The checklist card is
   `x-if="reviews.length > 0"`, so the returning user sees a form with no
   checklist and resubmits without `addresses_reviews`: the defect this task
   exists to close, on a transient 503 at the one moment the enrichment cache
   has usually expired. This task's Scope says restore only after the paper's
   reviews have loaded; on this branch they never loaded. The signal block's
   objection to a `reviews.length` guard (it would resurrect stale ticks on a
   paper whose reviews are genuinely gone) does not apply to a status guard: a
   paper with no reviews is a fulfilled response with an empty list, which the
   intersection still prunes correctly.
   **Fix:** in `loadPaperData`, treat `enrichmentRes.status === 'rejected'`
   the way the paper rejection is treated: set `loadError` and return before
   `_prefillForm()` / `_restoreDraft()`. The existing Retry card is the user's
   way through, and the draft is neither pruned nor rewritten because
   `_initialLoadDone` stays false. Add a spec that seeds a draft with ticks,
   `fetchPaperEnrichment.mockRejectedValue(...)`, runs `loadPaperData`, asserts
   `loadError` is set and `addressedReviews` is still `[]`, then advances fake
   timers past the debounce and asserts the stored draft still carries the
   ticks. Update the reconciler's docblock sentence that says `loadPaperData`
   assigns `reviews` before it calls `_restoreDraft` so it also states that a
   rejected enrichment never reaches the restore.

2. **A pending draft-save timer survives the post-success draft clear**
   (`edit.js`, both `handleSubmit` success branches, the continuation post and
   the native edit). Each calls `localStorage.removeItem(this.draftKey)` but
   neither cancels `_draftTimer`; only `destroy()` and `_scheduleDraftSave`'s
   own reschedule touch it. A save armed by the last watched change fires after
   the clear when the broadcast plus cache invalidation completes inside the
   debounce and before the 1.5 s `navigate()` teardown, and the next edit visit
   restores that draft over the freshly fetched paper. The mechanism predates
   this diff for every text field; this diff wired the task's own gesture (tick,
   then submit) into the same timer, and the resurrected ticks alone pass the
   no-changes check, so a second submit re-declares `addresses_reviews` on an
   otherwise no-op revision.
   **Fix:** beside each of the two `removeItem(this.draftKey)` success sites,
   `if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; }`,
   mirroring `destroy()`. Add a fake-timer spec: arm the debounce (a tick, or
   `_scheduleDraftSave()` directly with `_initialLoadDone` set), run
   `handleSubmit` to `step === 'success'`, advance past two seconds, and assert
   `localStorage.getItem(draftKey)` is still `null`. One spec against the
   native-edit branch is enough; probe it by reverting that site.

3. **The watcher-enumeration comment states an invariant its pinned list
   violates** (`pages-edit.test.js`, the reactive-bindings spec). The new
   comment says every field `_scheduleDraftSave` persists needs a watcher, but
   the pinned list omits `newCoAuthors`, which `_scheduleDraftSave` persists and
   `_setupReactiveBindings` never watches (your own notes call it a one-line
   gap). Close it rather than reword it: add
   `this.$watch('newCoAuthors', () => this._scheduleDraftSave());` in
   `_setupReactiveBindings` (the publish page watches its `coAuthors`
   equivalent the same way) and append `'newCoAuthors'` to the pinned list.

Dismissed at triage, no action: a spec for the `!Array.isArray(saved)` branch
(preemptive; `Array.isArray(undefined)` cannot throw), the pre-existing
paper-scoped draft key and multi-tab classes, the mid-submit checkbox, and the
sub-2s flush before the navigating acquisition (already a held item on the
re-auth window task).

Verification note for the re-submission: at `2d505c2f`,
`npx vitest run tests/unit/pages-edit.test.js` reports 81 passed but exits 1
with three unhandled `TypeError: ... reading 'abstractEditor'` errors. They
pre-exist at the base (74 passed, exit 1) and are gone on current `main` after
`e579c8c4` (85 passed, exit 0), so nothing to do here, but read the exit code
and the Errors line, not the Tests count, when reporting the suite as green.
Do not cite this hold, its item numbers, or the task slug in code or test
comments; anchor on the symbols named above.


## UI re-review signal (2026-09-23, commit fa4b4cf7)

`fa4b4cf7` self-verified as an ancestor of `main` (`git merge-base
--is-ancestor`). No worktree fan-out; single-session inline work. A sibling
backend commit landed on top of it during the session, which is why it is not
HEAD.

### Item 1 — a rejected enrichment no longer reaches the restore

`loadPaperData`'s rejection guard now covers both halves of the
`Promise.allSettled` pair and returns before `_prefillForm()` / `_restoreDraft()`,
so `_initialLoadDone` stays false and the stored draft is neither pruned nor
rewritten. The Retry card is the way through, unchanged.

The two guards were merged into one condition rather than stacked, because their
bodies were identical; the rationale comment above the merged guard carries the
enrichment half. With a rejection now returning early, the
`if (enrichmentRes.status === 'fulfilled')` wrapper had one reachable status left
and was unwrapped.

Consistency note, not a change in this diff: `paper-detail.js` degrades on the
same failure and offers its own retry affordance. The edit page blocks instead
because its reconciliation reads that list, and an empty list there is
indistinguishable from "this paper has no reviews". The cost is real and
accepted: the 503 this endpoint is documented to surface when the walker
wall-clock budget is exhausted now holds the edit form behind a Retry rather than
rendering it without the checklist. Checked against the running dev backend that
the ordinary path is unaffected: `/enrichment` returns HTTP 200 for each of the
three papers `/api/papers` lists, including papers with zero reviews, which is a
fulfilled response with an empty list and still prunes correctly.

Spec `a rejected enrichment fails the load and leaves the saved ticks alone`
seeds a draft carrying a tick, rejects `fetchPaperEnrichment`, runs
`loadPaperData`, and asserts `loadError`, `addressedReviews` still `[]`, and
`_initialLoadDone` still false; it then arms the scheduler and advances past the
debounce to assert the stored draft still carries the tick.

`_reconcileAddressedReviews`'s docblock now states both halves: `loadPaperData`
assigns `reviews` before it calls `_restoreDraft`, and fails the load outright
when that response rejected, so the intersection never runs against an empty list
that only means the reviews could not be fetched.

### Item 2 — the post-success clear cancels the armed debounce

Both success branches call a new `_clearDraft()`, which cancels `_draftTimer` and
then removes the draft.

Deviation from the prescription, raised deliberately rather than quietly: the
hold asked for the inline `if (this._draftTimer) { ... }` guard beside each
`removeItem`, mirroring `destroy()`. That exact line already exists in `destroy()`
and in `_flushDraftSave()`; two more copies would make four. The named method
states the clear-and-cancel gesture once and both call sites read as a single
gesture. Behavior is identical, and a probe still has one site to revert.
`destroy()` and `_flushDraftSave()` were deliberately left alone: the latter
belongs to the re-auth window task still in flight, and a shared cancel helper
across all four sites is a change to that task's surface.

Reproducing the defect took one correction worth recording. `_windowReady`
flushes unconditionally at the submit entry gate, so a timer armed by a keystroke
before Submit is already cancelled by the time the broadcast runs; a spec written
that way passes against the unfixed code, which is what the first draft of this
spec did. The reachable window is between that flush and the success: the form
stays interactive through `step === 'broadcasting'`. The spec now arms the
scheduler from inside the `broadcastOps` mock, and asserts `_draftTimer` is null
after `step === 'success'` and the draft still absent two seconds later.

### Item 3 — `newCoAuthors` watcher

The gap was wider than a missing row: `updateNewCoAuthor` writes
`this.newCoAuthors[index][field]`, so every keystroke into a co-author's name,
hive, orcid or affiliation was equally undrafted, not just `addCoAuthor`'s push.
Alpine's `$watch` deep-reads the watched value, so one registration covers all of
them.

`_setupReactiveBindings` registers `$watch('newCoAuthors', ...)`, positioned so
the watcher list mirrors the field order of the `_writeDraft` draft object; the
enumeration spec's pinned list gained `'newCoAuthors'` in the same position and
its comment now names `_writeDraft` (which holds the field list) rather than
`_scheduleDraftSave`, and states the mirror as the reason the order matters.

### Verification

- `pages-edit.test.js`: 87 passed, 0 failed, exit 0, no Errors line (85 before).
  Full frontend unit suite: 86 files / 1933 tests passed, exit 0.
  `npm run build` clean (standing chunk-size and dhive direct-`eval` warnings
  only). All run in the checkout; `git status` clean afterwards apart from the
  two files this commit carries.
- Mutation probes, one scratchpad copy per mutant off the committed tree, repo
  checkout never mutated:

  | reverted site | tests that die |
  |---|---|
  | the enrichment arm of the load guard, with the `fulfilled` wrapper restored (the true pre-fix shape) | the rejected-enrichment spec |
  | the `clearTimeout` line inside `_clearDraft` (the `removeItem` stays) | the post-success-clear-cancels spec |
  | `$watch('newCoAuthors', ...)` | the watcher-enumeration spec |
  | `addressedReviews` in the `_writeDraft` object | the debounced-save spec, plus the tick-change spec |
  | `$watch('addressedReviews', ...)` | the tick-change spec, plus the watcher-enumeration spec |
  | the restore line in `_restoreDraft` | restore, drop-stale, resubmit, post-success-clear-of-ticks |
  | the `reviews` intersection in `_reconcileAddressedReviews` | drop-stale only |
  | the `:checked` binding | the checkbox spec |
  | the `isReviewAddressed` body | the checkbox spec |

  Honest negative result from that run: reverting only the `||` arm of the merged
  guard, while leaving the unwrapped `enrichmentRes.value.data` read in place,
  leaves the suite green. That mutant is not the pre-fix shape: the unwrapped read
  throws on a rejected settle and the outer catch sets the same `loadError`, so
  the page still fails closed. It is recorded because it is a real property of the
  unwrapped form, not because the assertion is unpinned; the pre-fix shape in the
  table above kills it.
- E2E not re-run. The diff adds no markup and touches no `type="submit"` element,
  so the dominant pre-existing strict-mode failure class is unchanged, and the one
  new runtime branch (enrichment rejected) is not reachable in that environment:
  the prior round's run showed the checklist rendering and `check()` passing, and
  the dev backend serves `/enrichment` 200 today. Running the dance would also
  swap the shared stack into test mode under whatever sibling agent is using it.
  Say the word and it gets run.
- No new i18n keys, so no `STUBS.md` entry.
- Simplify pass (three lenses: reuse, quality, efficiency). Efficiency clean;
  quality reports no correctness bug. Reuse and quality converged on one
  finding, triaged by the user as skip-and-record: the `_draftTimer` cancel
  line now appears three times, in `destroy()`, in `_clearDraft()` and in
  `_flushDraftSave()`, and both lenses proposed extracting a
  `_cancelDraftTimer()` used by all three. Skipped because the fix edits
  `_flushDraftSave()`, which belongs to the light-account re-auth window task
  still in `review/`, so it widens this diff into that task's surface for no
  behavior change, and a partial two-of-three extraction leaves an
  inconsistent trio. Both lenses graded it optional. Available as a one-commit
  follow-up once that task clears review.

## Architect re-review (2026-09-23) — HELD PENDING FIXES:

`/ce-code-review` on `fa4b4cf7` (seven lenses; standards, races and reliability
clean; two validated P2s, merged here into one item). All three round-1 items
are FIXED: each was re-probed independently by at least two lenses (the true
pre-fix guard shape restored, the `clearTimeout` removed from `_clearDraft()`,
`$watch('newCoAuthors', ...)` removed) and each probe dies to its named spec;
both operands of the merged `||` guard have their own discriminating spec.
One item, same file, then move back to `review/`.

1. **A landed broadcast can still leave the flushed draft behind, ticks
   included** (`edit.js`, both `handleSubmit` success branches). `_windowReady`
   flushes the draft through `_flushDraftSave()` right before every broadcast
   leg, and in both branches `_clearDraft()` is reached only after
   `await invalidatePaperCache(...)` and a second `if (!this._mounted) return;`.
   If the user leaves the page while the broadcast is in flight, or the
   invalidate rejects (expired light-account token, the invalidate limiter, a
   network blip), the edit is on chain and the draft stays. The next visit
   restores the ticks over a paper whose reviews are already addressed; the
   no-changes check ends with `&& this.addressedReviews.length === 0`, so ticks
   alone admit a no-op resubmit that re-declares `addresses_reviews` (or posts
   a duplicate continuation). In the rejected-invalidate case the page also
   shows `common.editFailed` for an edit that landed. Probed twice
   independently in scratchpad copies: `comp.destroy()` inside the
   `broadcastOps` mock left `addressedReviews` in the stored draft with
   `broadcastOps` called once; `invalidatePaperCache.mockRejectedValue(...)`
   left the same draft with `step === 'error'`; a reopened page restored the
   tick and a second `handleSubmit` reached `success` with `broadcastOps`
   called twice. The `_mounted` gates predate this task; `fa4b4cf7` swapped
   `removeItem` for `_clearDraft()` at the same position, so the designated
   clear still sits behind unchanged exits. This is the resurrection class
   round-1 item 2 closed, reached through two neighbouring exits.
   **Fix:** capture `const draftKey = this.draftKey;` before the first `await`
   in `handleSubmit` (the getter reads router params, which an unmount can
   change), and in BOTH branches cancel `_draftTimer` and
   `localStorage.removeItem(draftKey)` immediately after the
   `=== FRESH_AUTH_REDIRECT_PENDING` check, before `invalidatePaperCache` and
   independent of `_mounted`. A `_clearDraft(key = this.draftKey)` parameter
   is one way; the later `_clearDraft()` beside `step = 'success'` may stay as
   an idempotent no-op. The REDIRECT_PENDING check stays first so a pending
   redirect keeps its draft. Do not add a try/catch around
   `invalidatePaperCache`: that changes what the user sees on a failed
   invalidation and is a separate decision held by the architect.
   **Specs, both in `pages-edit.test.js`:** (a) beside `the post-success clear
   cancels a save the debounce still has armed`, a spec whose `broadcastOps`
   mock calls `comp.destroy()` before resolving `{ tx_id }` and asserts
   `localStorage.getItem(DRAFT_KEY)` is null after `await comp.handleSubmit()`
   (today it holds the tick); (b) a continuation-post variant of the existing
   cancel spec, with `mockStores.auth.username` set to a co-author so
   `isContinuation` is true and the continuation branch runs, asserting
   `_draftTimer === null` and the draft key absent. Today reverting only the
   continuation-post call to a bare `removeItem` leaves the file green (87/87,
   reproduced by three lenses), because every `handleSubmit` spec in the ticks
   block authenticates as `alice` against `alice`'s paper; the round-1 "one
   spec is enough" was written before both sites were going to move. Probe
   each new spec by reverting its own site, per branch.

Dismissed at triage, no action: the synchronous-writer window between
`_clearDraft()` and the 1.5 s navigate (`handleSupplementaryFiles` flush or a
double submit; debounced writers are cancelled by `destroy()`), the load-time
draft arm (Alpine watchers fire in a microtask after `_initialLoadDone = true`,
pre-existing), the Retry card's single affordance, an `arrangeLoad([])` prune
spec, discriminating the `||` guard from the catch-path fail-closed, and the
hand-maintained enumeration lists. Two items stay open with the architect and
are not part of this hold: a try/catch around `invalidatePaperCache`, and the
same clear-without-cancel shape on `publish.js`'s success path.

Verification note: the round-1 baseline holds at `fa4b4cf7`
(`pages-edit.test.js` 87 passed, exit 0, no Errors line, in an isolated copy).
A sibling UI task is editing `pages-edit.test.js` in the shared checkout right
now (load-path mount coverage); build on whatever it lands rather than
reverting it. Do not cite this hold, its item numbers, or the task slug in code
or test comments; anchor on the symbols named above.

## UI re-review signal (2026-09-24, commit dbd18dc4)

`dbd18dc4` self-verified as an ancestor of `main` (`git merge-base
--is-ancestor`). No worktree fan-out; single-session inline work. The sibling UI
task the hold named (edit-spec load-path mount coverage) had already landed at
`48e6e320`, and this commit builds on it rather than reverting it.

### Item 1 — the clear now runs where the broadcast lands

Both branch arms drop the draft immediately after the
`FRESH_AUTH_REDIRECT_PENDING` check, before `invalidatePaperCache` and
independent of `_mounted`, so neither the unmount exit nor the rejecting
invalidation can end `handleSubmit` with the edit on chain and the draft still
in storage.

Making the clear `_mounted`-independent needed one reordering the prescription
implies but does not spell out: `if (!this._mounted) return;` sat *above* the
`FRESH_AUTH_REDIRECT_PENDING` check, so a clear placed after that check would
still have been behind the guard. The guard moved inside the REDIRECT_PENDING
block and is re-taken after the clear. The redirect check therefore still comes
first, which is what keeps a pending redirect's draft: on that path the return
is unchanged, and the only difference for an unmounted component is that
`step = 'idle'` is skipped exactly as it was before.

`_clearDraft` takes the key as an argument and `handleSubmit` captures it beside
the existing `isContinuation` / `ownPost` captures, before the first await.
Deviation from the prescription, small and deliberate: the parameter is required
rather than defaulted to `this.draftKey`. All four call sites are in
`handleSubmit` and all four pass the captured key, so a default would be dead
from the moment it was written, and a reader who saw one would reasonably think
some caller relied on the getter.

The clear beside `step = 'success'` stays in both arms, as the hold allows. It
is a genuine no-op on every path the specs reach (probe m05 below), and it is
kept only for the interactive window the `invalidatePaperCache` await opens,
which is the same class the hold dismissed at triage on the grounds that
`destroy()` cancels debounced writers. No try/catch was added around
`invalidatePaperCache`.

### Specs

Both new specs were written and observed failing before any change to
`edit.js`: the native one on the surviving ticked draft
(`'{"title":"Old Title",…addressedReviews":[{"author":"carol"…' to be null`),
the continuation one on a live `Timeout` object where `_draftTimer` should be
null.

(a) `an unmount during the broadcast still drops the draft the landed edit spent`
sits beside the existing cancel spec on the native-edit arm, calls
`comp.destroy()` inside the `broadcastOps` mock before it resolves `{ tx_id }`,
and asserts the draft key is null afterwards. It reads the stored draft from
inside that mock first, so the assertion is non-vacuous: the gate's flush really
had written a draft carrying the tick.

(b) `the continuation post drops the draft when the cache invalidation rejects`
is the continuation-arm twin, with `mockStores.auth.username` set to a co-author
so `isContinuation` is true (asserted in the spec as a fixture-posture proof).
Deviation, raised rather than buried: the hold describes (b) as a plain
continuation variant of the existing cancel spec, but that shape does not
discriminate its own site. With the fix in place the clear beside
`step = 'success'` is still reached on a fulfilled invalidation, so a spec that
only arms the debounce and reaches success passes with or without the new
continuation clear. (b) therefore takes the rejecting-invalidation exit the
hold's own evidence names, which the success-side clear cannot serve. It arms
the debounce inside `broadcastOps` as prescribed and asserts `_draftTimer` is
null, the draft key is absent, and the draft is still absent two seconds later.

`arrangeLoad` grew one optional `paperExtra` argument so (b) can seat a real
co-author list; every existing caller is unchanged.

### Verification

- `pages-edit.test.js`: 91 passed, 0 failed, exit 0, no Errors line (89 before).
  Full frontend unit suite: 86 files / 1937 tests passed, exit 0.
  `npm run build` clean (standing chunk-size and dhive direct-`eval` warnings
  only). `git status` carried only this commit's two files.
- Mutation probes, fifteen of them, one throwaway scratchpad copy per mutant
  built by `git archive dbd18dc4`; the repo checkout was never mutated and
  `git status` was clean before and after. The base copy was confirmed at
  91/91 exit 0 before any mutant ran. Both prior rounds' tables were re-run in
  full, not just the new sites.

  | reverted site | tests that die |
  |---|---|
  | the native-edit early clear, true pre-fix shape (guard hoisted back above the redirect check) | the unmount spec, alone |
  | the continuation early clear, true pre-fix shape | the rejecting-invalidation spec, alone |
  | both early clears at once | both new specs; the existing cancel spec survives |
  | the `clearTimeout` line inside `_clearDraft` | the existing cancel spec, plus the rejecting-invalidation spec |
  | `localStorage.removeItem(key)` inside `_clearDraft` | four: both new specs, the existing cancel spec, the post-success-clear-of-ticks spec |
  | the enrichment arm of the load guard, with the `fulfilled` wrapper restored | the rejected-enrichment spec |
  | `$watch('newCoAuthors', ...)` | the watcher-enumeration spec |
  | `addressedReviews` in the `_writeDraft` object | the debounced-save and tick-change specs, plus the unmount spec |
  | `$watch('addressedReviews', ...)` | the tick-change spec, plus the watcher-enumeration spec |
  | the restore line in `_restoreDraft` | restore, drop-stale, resubmit, post-success-clear-of-ticks |
  | the `reviews` intersection in `_reconcileAddressedReviews` | drop-stale only |
  | the `:checked` binding | the checkbox spec |
  | the `isReviewAddressed` body | the checkbox spec |

  Per-arm discrimination is the row that matters for this round: reverting one
  branch's early clear kills that branch's spec and nothing else, in both
  directions.

  Three honest results from that run, none of them an unpinned assertion:

  - Reverting `_clearDraft`'s key parameter back to the `this.draftKey` getter
    kills nothing. The harness never changes `$store.router.params` mid-submit,
    so the capture defends a real-browser navigation the unit suite cannot
    stage. Recorded rather than papered over; a spec that mutated the router
    store inside the `broadcastOps` mock would pin it, and it is available on
    request.
  - Reverting the clear beside `step = 'success'` to a bare `removeItem` (its
    timer cancel dropped) also kills nothing, which is the measured form of the
    hold's own "idempotent no-op". Kept deliberately, per the hold.
  - Reverting `addressedReviews` out of `_writeDraft` kills three specs, not the
    two the earlier table lists. The extra death is the new unmount spec, whose
    non-vacuity assertion reads `addressedReviews` back out of the flushed
    draft. Benign over-kill, not a new coupling.

  The two assertions inside the continuation spec are pinned by different
  mutants: the `_draftTimer` one dies to the `clearTimeout` revert and to the
  continuation early-clear revert, and the draft-absence one dies to the
  `removeItem` revert. Vitest stops at the first failing assertion, so no single
  mutant exercises both.
- E2E not re-run. The diff adds no markup: `git show dbd18dc4 -- frontend/src/pages/edit.js`
  has zero added lines containing a tag, an Alpine directive or `type="submit"`,
  so the dominant pre-existing strict-mode failure class is untouched, and
  neither new runtime branch (unmount mid-broadcast, rejecting invalidation) is
  reachable in that environment. Running the dance would also swap the shared
  stack into test mode under whatever sibling agent is using it. Say the word
  and it gets run.
- No new i18n keys, so no `STUBS.md` entry.
- Simplify pass (three lenses: reuse, quality, efficiency). All three clean, no
  findings. The reuse lens confirmed the `_cancelDraftTimer()` extraction was
  correctly not re-raised, `_flushDraftSave()` being the reason it stays
  skipped, and that `arrangeLoad`'s new merge parameter follows the
  `storedDraft(extra)` idiom already in the file. The quality lens was asked
  specifically to adjudicate the guard reordering and traced all four
  arm-by-exit combinations: the two redirect-pending cases are unchanged
  (mounted and unmounted both end the same way), and the only behavior
  differences are the two this commit targets. The efficiency lens noted the
  second `_clearDraft` does not even reach `clearTimeout`, since the first
  nulled `_draftTimer`, so the kept backstop costs one falsy property check and
  a `removeItem` on an absent key.

## Architect re-review (2026-09-28) — HELD PENDING FIXES:

`/ce-code-review` on `dbd18dc4` (seven lenses; standards clean; two validated
P2s). The round-2 item is FIXED: both arms' early clears were re-probed
independently (per-arm reverts kill exactly their own spec, re-run in a
scratchpad copy off the reviewed commit), the captured key and the guard
relocation were verified against the pre-image, and the rejecting-invalidation
exit was confirmed as the only shape that can discriminate the continuation
arm's early clear. Two items, then move back to `review/`.

1. **A keystroke during a rejecting invalidation resurrects the spent draft**
   (`edit.js`, the terminal catch of `handleSubmit`). The early clear runs
   before `await invalidatePaperCache(...)`, and the form stays interactive
   across that await, which is what the comment beside the kept success-side
   clear says. A watched-field change inside the window re-arms the 2s
   debounce; a rejecting invalidation then skips the success-side clear into
   the terminal catch, which cancels nothing, and `_writeDraft` re-persists
   the draft, ticks included, behind the landed post. The next visit restores
   ticks that alone pass the no-changes check: the resurrection class this
   task closes, through the one exit still open. Rejections correlate with
   slow or timing-out networks, which is when the window is widest. Three
   lenses converged on this independently.
   **Fix:** declare a `landed` local beside the `draftKey` capture in
   `handleSubmit`, set it true immediately after each arm's early
   `_clearDraft(draftKey)`, and in the terminal catch, before the
   `step = 'error'` write, run `if (landed) this._clearDraft(draftKey);`.
   That cancels a timer armed during the invalidation await and re-removes
   the item. Do NOT add a try/catch around `invalidatePaperCache`; that
   decision stays reserved with the architect, and this fix does not need it.
   A user who keeps typing at `step = 'error'` can still re-arm the watchers
   afterwards; that wider closure belongs to the same reserved decision and
   is out of scope here.
   **Spec:** arm the debounce inside a rejecting `invalidatePaperCache` mock
   (NOT the broadcast mock, whose timer the early clear cancels), reach the
   terminal catch, assert `_draftTimer` is null and the draft key absent, and
   still absent after advancing past the debounce. Probe by reverting the
   catch-side clear alone: the existing specs must survive that revert while
   the new one dies.

2. **The redirect-pending keep-draft invariant is unpinned**
   (`pages-edit.test.js`). The light-custody specs that reach the
   redirect-pending branch assert `step === 'idle'` but none asserts the
   draft SURVIVES, and the unmounted variant is uncovered. Hoisting the early
   clear above the `FRESH_AUTH_REDIRECT_PENDING` check (destroying the draft
   the ORCID round-trip exists to protect) or dropping the relocated
   `_mounted` guard therefore leaves the whole file green. Confirmed by an
   independent validation pass.
   **Fix:** one spec per arm, or one parameterised over both: resolve the
   post-gate broadcast to `FRESH_AUTH_REDIRECT_PENDING`, assert `step`
   becomes `'idle'` while the stored draft is retained; add the unmounted
   variant asserting the early return leaves both `step` and the draft
   untouched. Probe by hoisting the early clear above the pending check and,
   separately, by reverting the relocated guard; each mutant must die to the
   new specs.

Dismissed at triage, no action: the quick-return/two-tab restore outracing
the in-flight clear (the multi-tab class dismissed at round 1), the
keystroke-after-error watcher re-arm (reserved invalidation-UX decision), the
arm-by-exit cross product (symmetric code), the unpinned captured-key
deviation (accepted gap, recorded in the discriminating-spec solutions
entry), and the plain-success-path clear-before-invalidation timing.

Verification note: `frontend/vitest.config.js` sets `restoreMocks: true`, so
per-spec mock implementations do not leak between tests; no fixture change
needed. At archive time, refresh the discriminating-spec solutions entry
against the final code shape. Do not cite this hold, its item numbers, or the
task slug in code or test comments; anchor on the symbols named above.

## UI re-review signal (2026-09-29, commit 01b17cfc)

`01b17cfc` self-verified as an ancestor of `main` (`git merge-base
--is-ancestor`). No worktree fan-out; single-session inline work. Sibling
backend commits landed on top during and after the session, which is why it
is not HEAD.

### Item 1 — the terminal catch re-clears when the broadcast landed

`handleSubmit` declares `let landed = false` beside the `draftKey` capture,
sets it true immediately after each arm's post-broadcast
`_clearDraft(draftKey)`, and the terminal catch runs
`if (landed) this._clearDraft(draftKey);`, which cancels a timer armed
during the invalidation await and re-removes the item. Pre-broadcast throws
still keep their draft: `landed` is false on every path that has landed
nothing.

Placement, spelled out rather than left implicit: the hold asks for the
clear before the `step = 'error'` write, and it sits one line earlier still,
ahead of the catch's `if (!this._mounted) return;`. The corner that decides
it: a timer that fires before an unmount is not cancelled by `destroy()`
(nothing is pending any more), so a catch entered unmounted after that write
must still re-clear, exactly the reason the post-broadcast clears are
`_mounted`-independent.

Two specs rather than the one the hold prescribes, raised deliberately: the
`landed` marker is per-arm, so a same-author-only spec leaves a revert of
the continuation arm's marker green — the per-arm class the previous round's
own finding established. Both specs arm the scheduler inside a rejecting
`invalidatePaperCache` mock (not the broadcast mock, whose timer the
post-broadcast clear cancels), capture the timer handle inside the mock as
the non-vacuity proof, and assert `_draftTimer` null, the draft key absent,
and still absent past the debounce. Both were written first and observed
failing at the reviewed base on a live `_draftTimer` after the catch.

### Item 2 — the keep-draft invariant pinned per arm, mounted and unmounted

Four specs in the re-auth ordering describe, beside the remintable-401
refusal twins whose staging they reuse (light custody, passwordless, a live
seeded window, the broadcast leg rejecting 401 remintable so the real
fresh-auth refusal resolves the sentinel — no shortcut broadcast mock
resolving null). The mounted pair asserts `step === 'idle'` with the entry
gate's flushed draft still in storage; the unmounted pair destroys the
component inside the rejecting broadcast mock and asserts the early return
leaves `step` at `'broadcasting'` and the draft untouched.

Non-vacuity: each spec removes any stored draft first and reads a
spec-distinctive title back out of storage afterwards, so a draft leaked by
an earlier case in the same describe (one such leak pre-exists) cannot stand
in for the entry-gate flush.

### Verification

- `pages-edit.test.js`: 98 passed, 0 failed, exit 0, no Errors line (92
  before: round 3's 91 plus one from the sibling mount-coverage commit that
  landed after it). Full frontend unit suite: 86 files / 1944 tests, exit 0.
  `npm run build` clean (standing chunk-size and dhive direct-`eval`
  warnings only). `git status` carried only this commit's two files; the
  stderr stack traces the rejecting-invalidation specs print are the catch's
  own `console.warn` sanitization logging, not failures.
- Mutation probes: 21 runs, one throwaway scratchpad copy per mutant built
  by `git archive 01b17cfc`, repo checkout never mutated and `git status`
  clean before and after; the unmutated baseline copy confirmed 98/98 exit 0
  first. Both prior rounds' tables re-run in full plus seven new sites:

  | reverted site | tests that die |
  |---|---|
  | the catch-side clear alone | both re-arm-during-invalidation specs, and nothing else |
  | the native arm's `landed` marker | the native re-arm spec, alone |
  | the continuation arm's `landed` marker | the continuation re-arm spec, alone |
  | the native early clear hoisted above the pending check | the native mounted and unmounted keep-draft specs |
  | the continuation early clear hoisted above the pending check | the continuation mounted and unmounted keep-draft specs |
  | the native pending block's relocated `_mounted` guard | the native unmounted keep-draft spec, alone |
  | the continuation pending block's relocated `_mounted` guard | the continuation unmounted keep-draft spec, alone |
  | the native-edit early clear, true pre-fix shape | the unmount spec, plus the native re-arm spec |
  | the continuation early clear, true pre-fix shape | the rejecting-invalidation spec, plus the continuation re-arm spec |
  | both early clears at once | those four; the existing cancel spec survives |
  | the `clearTimeout` inside `_clearDraft` | the cancel spec, the rejecting-invalidation spec, both re-arm specs |
  | `localStorage.removeItem(key)` inside `_clearDraft` | six: those four plus the unmount and post-success-clear-of-ticks specs |
  | the enrichment arm of the load guard, `fulfilled` wrapper restored | the rejected-enrichment spec |
  | `$watch('newCoAuthors', ...)` | the watcher-enumeration spec |
  | `addressedReviews` in the `_writeDraft` object | the debounced-save, tick-change and unmount specs |
  | `$watch('addressedReviews', ...)` | the tick-change and watcher-enumeration specs |
  | the restore line in `_restoreDraft` | restore, drop-stale, resubmit, post-success-clear-of-ticks |
  | the `reviews` intersection in `_reconcileAddressedReviews` | drop-stale only |
  | the `:checked` binding | the checkbox spec |
  | the `isReviewAddressed` body | the checkbox spec |

  Per-arm discrimination holds in both new families: each `landed` marker,
  hoisted clear, and dropped guard kills exactly its own arm's spec(s) and
  nothing else. Honest delta from the earlier tables: the two true-pre-fix
  arm shapes and the `_clearDraft`-half reverts now also kill the re-arm
  specs, because those shapes remove or starve the catch-side clear too —
  benign over-kill, not a new coupling.
- E2E not re-run: the diff adds no markup (zero added lines carrying a tag,
  an Alpine directive, or `type="submit"`), and the new runtime branch (a
  keystroke during a rejecting invalidation) is not reachable in that
  environment. Running the dance would also swap the shared stack into test
  mode under whatever sibling agent is using it. Say the word and it gets
  run.
- No new i18n keys, so no `STUBS.md` entry.
- Simplify pass (three lenses: reuse, quality, efficiency). Efficiency
  clean; quality and reuse clean on `edit.js` (both independently confirmed
  the `landed` local is minimal and the new comments pass the anchor
  conventions) and converged on the same optional test-file extractions: a
  shared seeded-window-proof helper (nine inline sites file-wide, four in
  this diff) and a remintable-401 error factory (six sites, four in this
  diff), plus an arrangement helper for the re-arm twins. All graded
  optional by their lenses; skipped because each is a file-wide sweep whose
  partial form leaves the file inconsistent, the same trade the earlier
  compare-helper dismissal settled. Available as a follow-up commit on
  request.

## Architect re-review (2026-09-29) — HELD PENDING FIXES:

`/ce-code-review` on `01b17cfc` (seven lenses; standards clean including the
comment-anchor sweep of all added comment lines; independent validator batch
confirmed 4/4 findings with empirical reproductions). Both round-3 items are
FIXED: every kill claim in the signal block was re-measured independently by
at least two lenses (per-arm `landed` markers, per-arm hoisted clears and
dropped guards, the catch-clear revert), the keep-draft specs reach the real
fresh-auth refusal resolution, and both flagged deviations hold on the merits
(the pre-guard catch placement serves a real corner; per-arm re-arm twins are
justified because a shared-catch spec proves only the arm it routes through).
Four items, then move back to `review/`.

1. **The resolve twin of the closed exit still leaks the spent draft**
   (`edit.js`, both arms, the `if (!this._mounted) return;` after
   `await invalidatePaperCache(...)`). The catch clear closed the REJECT half
   of the re-arm window; on a RESOLVING invalidation that guard sits above
   the success-side `_clearDraft(draftKey)`, so a draft written during the
   await (the 2s debounce firing, or the synchronous
   `handleSupplementaryFiles` -> `_windowReady` -> `_flushDraftSave` flush)
   survives when the user leaves before the invalidation settles. The next
   visit restores spent ticks that alone pass the no-changes check: the
   resurrection class this task closes, through the last open exit, and the
   await can hang up to the 30s request timeout. Probed independently three
   times (runtime staging, a 16-cell arm x fired-timer x unmount x
   resolve/reject matrix with exactly this one leaking cell per arm, and the
   validator's reproduction); the reject twin of the same staging ends null.
   **Invariant to land:** every `handleSubmit` exit reached after the
   broadcast landed leaves the stored draft absent, the unmounted return
   after a resolving invalidation included. **Measured default:** move each
   arm's clear to directly after the invalidation await, ahead of the
   `_mounted` guard (mirroring the catch clear's own outlives-the-component
   rationale), and drop the now-subsumed clear beside `step = 'success'`
   together with its kept-for-the-interactive-window comments; verified
   98/98 green with the full matrix clean. A `finally`-based shape
   (`if (landed) this._clearDraft(draftKey)` on the try) is an acceptable
   deviation with rationale; it removes the catch-side clear site and
   re-shapes items 2 and 3, so say so explicitly in the signal if taken. Do
   NOT reach for a `_draftSpent` write barrier here; that construct belongs
   to the reserved invalidation decision still held by the architect.
   **Specs, per arm:** arm the writer inside a RESOLVING
   `invalidatePaperCache` mock (fake timers advanced past the debounce so it
   FIRES, non-vacuity read captured, `destroy()` inside the mock, then
   resolve) and assert the draft key is null. Probe by reverting the moved
   clear per arm: each mutant must die to its own arm's new spec.

2. **The `landed`-false half of the catch has no witness** (`edit.js`, the
   `if (landed)` guard in the terminal catch). Making the clear
   unconditional passes all 98 specs, so the comment's invariant
   "Pre-broadcast throws keep their draft" is unpinned; a regression deletes
   the user's flushed draft on a failed upload or broadcast. Measured
   independently five times. **Fix:** spec(s) staging a plain broadcast
   rejection (no fresh-auth shape): assert one broadcast call,
   `invalidatePaperCache` not called, `step === 'error'`, and the stored
   draft still carrying the flushed title and tick. Per-arm twins match the
   file's idiom; one same-author spec is mechanically sufficient since the
   guard sits before either arm's marker — implementer's choice, state it in
   the signal. Probe: the unconditional-clear mutant dies to the new spec(s)
   while every existing spec survives.

3. **A catch entered unmounted after the debounce has FIRED is untested**
   (`edit.js`, the catch clear and the catch's `_mounted` guard). Swapping
   the clear below the guard passes all 98 specs, though the placement
   comment names exactly this corner: a timer that fires before the unmount
   leaves nothing pending for `destroy()` to cancel, and the rewritten
   draft must still be removed. The re-arm twins run mounted and only ARM
   the timer, so storage is already empty when the catch runs and only the
   cancel half of the catch clear is pinned. **Fix:** one same-author spec
   under fake timers: inside the rejecting invalidation mock, type,
   `_scheduleDraftSave()`, advance past the debounce so it fires, capture
   the non-vacuity read, `destroy()`, then throw; assert `step` stayed
   `'broadcasting'` and the draft key is null. Optionally shift the router
   params inside the mock and seed the other paper's draft to pin the
   captured-key rationale at this site too. The invariant survives item 1's
   shape choice: under the `finally` deviation the same spec pins the
   `finally`'s clear and the placement half is moot — record that in the
   signal rather than skipping silently. Probe: the swapped-order mutant
   (or, under the deviation, the `finally` clear removed) dies to the new
   spec alone.

4. **The continuation arm's early clear lost its only pin to this diff**
   (`edit.js`, the continuation arm's post-broadcast `_clearDraft`). The new
   catch clear absorbed the rejecting-invalidation exit that round-3's
   continuation spec used to discriminate this site, and only the
   same-author arm has an unmount-during-broadcast spec: deleting the
   continuation early clear, or restoring its true pre-fix guard shape, now
   passes 98/98. **Fix:** add the continuation twin of `an unmount during
   the broadcast still drops the draft the landed edit spent`: co-author
   posture asserted via `isContinuation`, the broadcast mock reads the
   stored draft first (non-vacuity), `destroy()`, resolve `{ tx_id }`;
   assert one broadcast and the draft key null. Probe: deleting the
   continuation early clear dies to the new spec alone.

Dismissed at triage, no action: the stale unmounted catch clear deleting a
successor visit's draft on the shared key (advisory, same shape as the
pre-existing post-broadcast clear; the write-barrier and savedAt-scoping
ideas belong to the reserved invalidation decision), the post-error writer
re-arm including the file-attach flush (same reserved decision, unchanged by
this diff), the unpinned late clears beside `step = 'success'` (pre-existing
and default-dismissed; item 1's measured default removes them anyway), the
mounted keep-draft specs' missing broadcast-count and refusal-toast asserts
(optional hardening), the captured-`draftKey` rationale at the non-catch
clear sites (accepted gap, recorded in the discriminating-spec solutions
entry; item 3's optional router shift covers the catch site), the fabricated
401 shape in the keep-draft specs (matches `signer.js#broadcastOps`'s real
construction), and the throwing-storage catch corner (unreachable
per-document storage semantics; the `finally` deviation closes it
incidentally).

Verification note: baseline at `01b17cfc` is 98 passed, exit 0, no Errors
line, in an isolated copy. A sibling UI task was editing
`pages-edit.test.js` in the shared checkout during this review; build on
whatever it lands rather than reverting it. At archive time,
`/ce-compound-refresh` the discriminating-spec solutions entry (two of its
measurement rows and its late-clear sentence are stale at `01b17cfc`; this
extends the round-3 refresh note), and the per-arm `landed` marker read by a
terminal catch placed ahead of the unmount guard is a `/ce-compound`
candidate. Do not cite this hold, its item numbers, or the task slug in code
or test comments; anchor on the symbols named above.

## UI re-review signal (2026-09-29, commits 23d72b81 and 323b550b)

Both SHAs self-verified as ancestors of `main` (`git merge-base
--is-ancestor`). No worktree fan-out; single-session inline work.
`23d72b81` carries the fix and the specs. `323b550b` is a two-line
comment-grammar fix the simplify pass surfaced.

### Item 1: the measured default, not the `finally` deviation

Each arm now runs `_clearDraft(draftKey)` directly after
`await invalidatePaperCache(...)`, ahead of that arm's `_mounted` guard. The
clear beside `step = 'success'` and its "kept for the interactive window"
comments are gone. The post-broadcast early clears, the `landed` markers and
the terminal catch clear are unchanged, so items 2 and 3 pin the catch-side
clear as prescribed, not a `finally`. No `_draftSpent` barrier and no
try/catch around the invalidation.

Specs, one per arm: `an unmount across a resolving invalidation drops the
draft a fired save wrote back` and its continuation twin. Inside a
RESOLVING invalidation mock each spec types, schedules, advances fake timers
2s so the save FIRES, reads the rewritten draft back as the non-vacuity
proof, calls `destroy()`, and resolves. It then asserts one broadcast and the
draft key null. Both were written first and observed failing at the
reviewed base on the surviving rewritten draft (`expected
'{"title":"Retitled while the invalida…' to be null`). They were the only
two red specs out of 103.

### Item 2: one same-author witness

`a broadcast that fails before landing keeps the flushed draft` uses a
plain `broadcastOps` rejection with no fresh-auth shape. It asserts one
broadcast, `invalidatePaperCache` not called, `step === 'error'`, and the
stored draft still carrying the flushed title and the tick. One spec, not
twins, by choice: the `if (landed)` guard sits before either arm's marker,
so the unconditional-clear mutant is the same code change whichever arm
routes into the catch.

### Item 3: the fired-then-unmounted catch, with the router shift

`a catch entered unmounted after the debounce fired drops the rewritten
draft by its captured key` stages this sequence inside a rejecting
invalidation: type, schedule, advance 2s so the save fires, non-vacuity
read, `destroy()`, then throw. It asserts `step` stayed `'broadcasting'` and
the draft key is null. The optional router shift was taken: inside the mock
the params move to `bob/p9` and that paper's draft is seeded, and the spec
asserts that draft survives byte for byte. So it also pins the captured-key
rationale at the catch site. `finally` restores the router params.

### Item 4: the continuation unmount twin

`an unmount during the continuation broadcast still drops the draft the
landed post spent` runs with co-author posture asserted via
`isContinuation`. The broadcast mock reads the stored draft first
(non-vacuity), calls `destroy()`, and resolves `{ tx_id }`. The spec
asserts one broadcast and the draft key null.

Two neighbouring test comments named the dropped success-side clear
("the clear beside step = 'success'", "the success-side clear"). Both now
say "the clear after the invalidation await".

### Verification

- `pages-edit.test.js`: 103 passed, 0 failed, exit 0, no Errors line (98
  before). Full frontend unit suite: 86 files / 1950 tests, exit 0.
  `npm run build` clean (standing chunk-size and dhive direct-`eval`
  warnings only). `git status` carried only this commit's two files.
- Mutation probes: 26 mutants plus an unmutated baseline, one copy each,
  built by `git archive 23d72b81 frontend` with node_modules symlinked. The
  repo checkout was never mutated. Each anchor was asserted by count before
  it was replaced. Baseline 103/103, exit 0. Every mutant killed.

  | reverted site | tests that die |
  |---|---|
  | continuation post-invalidation clear moved below its guard | the continuation resolving-invalidation spec, alone |
  | native post-invalidation clear moved below its guard | the native resolving-invalidation spec, alone |
  | continuation post-invalidation clear deleted | the continuation resolving-invalidation spec, alone |
  | native post-invalidation clear deleted | the native resolving-invalidation spec, alone |
  | catch clear made unconditional | the pre-landing broadcast-failure spec, alone |
  | catch clear swapped below the catch's `_mounted` guard | the fired-then-unmounted catch spec, alone |
  | catch clear reading `this.draftKey` instead of the captured key | the fired-then-unmounted catch spec, alone |
  | continuation early clear deleted (`landed` kept) | the continuation unmount-during-broadcast twin, alone |
  | native early clear deleted (`landed` kept) | the native unmount-during-broadcast spec, alone |
  | catch clear removed | both rejecting re-arm specs, plus the fired-then-unmounted catch spec |
  | continuation `landed` marker removed | the continuation re-arm spec, alone |
  | native `landed` marker removed | the native re-arm spec, plus the fired-then-unmounted catch spec |
  | continuation early clear hoisted above the pending check | the continuation mounted and unmounted keep-draft specs |
  | native early clear hoisted above the pending check | the same-author mounted and unmounted keep-draft specs |
  | continuation pending block's relocated `_mounted` guard removed | the continuation unmounted keep-draft spec, alone |
  | native pending block's relocated `_mounted` guard removed | the same-author unmounted keep-draft spec, alone |
  | the `clearTimeout` inside `_clearDraft` | the cancel spec, the continuation rejecting-invalidation spec, both re-arm specs |
  | `localStorage.removeItem(key)` inside `_clearDraft` | ten: every draft-absence spec in the ticks describe |
  | the enrichment arm of the load guard, `fulfilled` wrapper restored | the rejected-enrichment spec |
  | `$watch('newCoAuthors', ...)` | the watcher-enumeration spec |
  | `addressedReviews` in the `_writeDraft` object | debounced-save, tick-change, both unmount-during-broadcast specs, the pre-landing failure spec |
  | `$watch('addressedReviews', ...)` | the tick-change and watcher-enumeration specs |
  | the restore line in `_restoreDraft` | restore, drop-stale, resubmit, post-success-clear-of-ticks |
  | the `reviews` intersection in `_reconcileAddressedReviews` | drop-stale only |
  | the `:checked` binding | the checkbox spec |
  | the `isReviewAddressed` body | the checkbox spec |

  Each of this round's sites is discriminated per arm and per exit. Every
  new-site mutant kills exactly its own spec and nothing else. The item 1
  specs are the only kill for the post-invalidation clears, whether moved
  or deleted. The item 4 twin is now the only kill for the continuation
  early clear. That clear had no pin at `01b17cfc`.

  Changes from the earlier tables, all expected:
  - The native `landed` revert now also kills the item 3 spec, which routes
    through the same-author arm.
  - The `addressedReviews`-in-`_writeDraft` revert kills five specs. Both
    unmount twins and the pre-landing spec read the tick back as their
    non-vacuity proof.
  - The two "true pre-fix arm shape" rows are subsumed by the per-arm
    delete and hoist rows, so they were not re-run as separate mutants.
- E2E not re-run. The diff adds no markup: zero added lines carry a tag, an
  Alpine directive or `type="submit"`. The new runtime branch (an unmount
  while the invalidation is pending) is also not reachable in that
  environment, and the dance would swap the shared stack into test mode
  under any sibling using it. It can be run on request.
- No new i18n keys, so no `STUBS.md` entry.
- Simplify pass, three lenses (reuse, quality, efficiency), scoped to
  `23d72b81`. Reuse and efficiency found nothing. Efficiency confirmed the
  success path still runs `_clearDraft` twice, as before. Quality confirmed
  that no stale "success-side clear" wording remains and that the new
  comments pass the anchor rules. It raised one nit, a garbled sentence in
  the continuation unmount twin's header comment, fixed in `323b550b`. The
  re-run gave 103 passed, exit 0.

## Architect re-review (2026-09-30) — HELD PENDING FIXES:

`/ce-code-review` on `23d72b81` + `323b550b` (seven lenses; standards clean
including the comment-anchor sweep of every added line; an independent
validator confirmed 4/4 findings with its own re-measurements). All four
round-4 items are FIXED: each arm's post-invalidation clear sits ahead of its
`_mounted` guard and dies per arm to its own resolving-invalidation spec
(moved below the guard or deleted), the pre-landing witness kills the
unconditional catch clear alone, the fired-then-unmounted catch spec kills
both the swapped-order and the getter-key catch mutants alone, and the
continuation unmount twin is now the only kill for the continuation early
clear. All twelve new-site rows of the signal's mutation table reproduce
exactly, re-measured by three lenses. The invariant holds on every
post-landing exit of both arms (an 88-cell staged exit matrix differs from
the base in exactly four cells, all leak-to-clean), and both keep-draft
invariants hold. The production code is verified; this is a prose-only hold.
Three items, no new specs required, then move back to `review/`.

1. **The re-clear's rationale attributes the synchronous flush to a watched
   change** (`edit.js`, the comment above the continuation arm's
   `_clearDraft(draftKey)` that follows `await invalidatePaperCache(...)`).
   It says a watched change there "can arm the debounce, or fire it, or
   flush the draft synchronously". No watched change flushes: every
   `$watch` registered in `_setupReactiveBindings` calls
   `_scheduleDraftSave()`, and the synchronous writer in that window is the
   supplementary-file input, `handleSupplementaryFiles` reaching
   `_windowReady`'s `_flushDraftSave()`, which involves no watcher and no
   debounce. A reader tracing the third writer from this comment looks on
   the scheduler path and misses the file input.
   **Fix:** reword the sentence so each writer is named by its own trigger:
   a watched change arms the debounce, the armed save can fire, and a file
   selection flushes through `_windowReady`. Check the wording against the
   current tree rather than the reviewed commit: `_confirmNavigationCost`
   has since gained a `_flushDraftSave()` call of its own, so do not write
   that `_windowReady` is the only caller. The rest of the comment (why the
   re-clear sits ahead of the guard) is accurate; leave it, and leave the
   native arm's pointer to the continuation branch as it is.

2. **The pre-landing spec's header misstates where the guard sits and
   claims both arms** (`pages-edit.test.js`, the header of `a broadcast
   that fails before landing keeps the flushed draft`). "The guard sits
   ahead of either arm's landed marker, so one same-author case witnesses
   it for both arms." The `if (landed)` guard is in the shared terminal
   catch, textually after both `landed = true` markers, and this file uses
   "sits ahead of" for static position in the header of `a catch entered
   unmounted after the debounce fired drops the rewritten draft by its
   captured key`. The conclusion is also wider than the evidence: the one
   case witnesses the shared guard, not each arm's marker placement
   (hoisting the continuation marker above its broadcast leaves the file
   green, while the native mirror dies to this spec). The sentence follows
   the wording of the round-4 hold, which was imprecise on exactly this
   point; that is the architect's error, not the implementer's.
   **Fix:** reword to the real reason: both arms share the one terminal
   catch, and a throw before the landing reaches its `if (landed)` guard
   with the marker still false whichever arm ran, so one same-author case
   witnesses that guard. Do not claim it witnesses either arm's marker
   placement. A continuation twin is NOT required (dismissed at triage); if
   you add one anyway, say so in the signal and drop nothing from the
   reworded sentence on its account.

3. **A relative reference whose target moved** (`pages-edit.test.js`, the
   header of `the continuation post drops the draft when the cache
   invalidation rejects`). Its first sentence still reads "Twin of the
   unmount-during-broadcast case on the other branch arm, and it takes the
   other exit." This diff inserted the continuation unmount twin directly
   above it, so there are now two unmount-during-broadcast cases and the
   nearest one is on the SAME arm as this spec. Only the "other branch arm"
   half is stale; "takes the other exit" still holds against either
   neighbour.
   **Fix:** name the arm and the exit instead of relating them to a
   neighbouring spec: this is the continuation arm, through its
   rejecting-invalidation exit. The header's remaining sentences are
   accurate; leave them.

Dismissed at triage, no action: the three surviving mutants at the
post-invalidation clears (a bare `removeItem`, the `draftKey` getter, and a
clear that runs only when unmounted; none is a realistic refactor, deleting
or moving either clear dies per arm, and the getter form is the accepted
captured-key gap at a site that now runs unmounted), the continuation twin
of the pre-landing spec (item 2's reword stops claiming it), a storage throw
at the relocated clear leaving `step` at `'broadcasting'` (the throwing-storage
corner dismissed last round, one line earlier), and a queued `$watch` job
arming a save after `destroy()` (no production writer shares a task with the
page teardown). One item stays open with the architect and is not part of
this hold: the unmounted re-clear now deletes a successor visit's draft when
the invalidation RESOLVES, where the base did so only on a rejection. The
round-4 hold prescribed that placement, so it is recorded as a widened
advisory, and it joins the reserved draft-lifecycle decision (a write barrier
in `_writeDraft` versus exit-by-exit clears, the try/catch around
`invalidatePaperCache`, and the same clear-without-cancel shape on
`publish.js`).

Verification note: baseline at `323b550b` is 103 passed, exit 0, no Errors
line, in an isolated copy; the full unit suite there is 86 files / 1950
tests with one failure, the known 1 ms absolute-cap flake in
`lib-fresh-auth-session-window` (untouched by this diff, 3 of 3 green alone);
`npm run build` clean. `92141abf` landed on both files after the reviewed
range; build on it. This is a prose-only round: no fresh mutation table is
needed, but state the count and exit code and confirm that no executable
line changed. The replacement text must itself pass the comment-anchor
rules: no "the spec above", no round or item numbers. At archive time,
`/ce-compound-refresh` the discriminating-spec solutions entry (no clear
sits beside `step = 'success'` any more, there are three clears not two, and
two exit-table rows plus six measurement rows are stale at `323b550b`) and
the one stale phrase each in the pre-fix-shape and per-site entries; the
per-arm `landed` marker read by a terminal catch placed ahead of the unmount
guard is still undocumented and remains a `/ce-compound` candidate. Do not
cite this hold, its item numbers, or the task slug in code or test comments;
anchor on the symbols named above.

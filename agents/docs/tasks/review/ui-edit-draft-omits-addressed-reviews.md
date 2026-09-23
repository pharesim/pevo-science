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

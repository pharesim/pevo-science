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

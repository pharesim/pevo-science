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

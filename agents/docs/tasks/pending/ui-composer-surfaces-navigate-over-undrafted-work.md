# Review, comment and vouch surfaces navigate a passwordless account away from work they do not keep

**Owner:** ui
**Created:** 2026-09-21

## Why

A passwordless (ORCID-only, ARCHITECTURE § 6.1 state C) light account acquires its
re-auth window by full-page navigation. The publish and edit pages were taught to
handle that: acquisition happens before anything costly, the text fields are
drafted, and no gate navigates over a held file. Four other call sites were left as
they were. Each calls `broadcastWithFreshAuth` with the permissive default, at
submit time, on a surface that keeps no draft:

- `frontend/src/pages/review.js`, the review submit: `reviewBody`, the four
  `ratings`, and `isAnonymous`.
- `frontend/src/components/comment-composer.js`: the comment `body`, bound to a
  parent.
- `frontend/src/components/vouch-section.js`, `handleVouch` and `handleRetract`:
  whatever each composes, the retraction reason at minimum.

So the first write of a window on any of them sends a passwordless account to ORCID
and returns it to the same page (the redirect records `window.location.pathname` and
the callback navigates back to it) with the composed work gone. The review page is
the worst case on the platform: a full structured review, which is the thing PEvO
exists to collect, is lost to a click on Submit. Every later action in the same
window is free, which is why this reads as intermittent.

Known since the first review round of the light-account re-auth window work, carried
as a residual through six rounds, and unchanged by any of them. Filed now because
with the re-auth window task's confirm affordance landing, publish and edit become
the only surfaces that handle this, and the gap stops being defensible as "not yet".

The two `vote-buttons.js` call sites are the same shape and are NOT in scope: a vote
holds no composed work, so the round-trip costs a click.

## Scope

Keep the composed work across the round-trip. Recommended default, implement unless
you see a reason to deviate, in which case flag before landing:

**Stash immediately before a navigating acquisition, restore on return.** The
helper is the only thing that knows a navigation is about to happen, so it owns the
moment: a `broadcastWithFreshAuth` option (threaded to the acquisition the way
`allowRedirect` is) that the helper invokes right before it assigns the ORCID
navigation. The call site supplies what to stash; it does not decide when. This is
the same seam the re-auth window task's held item on flushing the draft before a
navigating acquisition needs, so build it once: whichever task lands second reuses
the first one's seam. Writing only at that moment is also what keeps stale stashes
from accumulating, since a dismissed password modal or an ordinary failure never
writes one.

Constraints:

- **One fixed storage key, one slot.** Only one navigation can be in flight per
  tab. A fixed `sessionStorage` key holding `{ surface, target, subject, payload,
  savedAt }` fits the existing scrub, which loops a fixed key list. Register the key
  in `SUBJECT_BOUND_STORAGE_KEYS` so `auth.disconnect()` and a subject change drop
  it with everything else subject-bound. A review body, possibly one the user
  marked anonymous, must never be restored into a tab that now represents someone
  else.
- **Restore is bound three ways.** Same surface, same target (paper author and
  permlink; for a comment also the parent), same subject. Any mismatch discards the
  stash silently instead of restoring it. Consume on read: a restore removes the
  slot.
- **Clear on success.** A broadcast that succeeds leaves nothing behind.
- **`sessionStorage`, not `localStorage`.** This is a bridge across one round-trip
  in one tab, not a draft feature. Do not grow it into general draft persistence
  for these surfaces; that is a separate product decision.
- **A failed stash write must not navigate silently.** Storage can be blocked or
  full. If the write fails, the navigation would lose the work, so do not fire it
  unasked. The work stays on screen, and the next constraint governs what the user
  is offered.
- **Every refusal needs a way through.** If any path here ends in a refusal for a
  passwordless account, the same change must give that account an in-page next
  step, because nothing else in the tab can open a window for it. Reuse the
  cost-stating confirm from the re-auth window task rather than inventing a second
  one: the user is told the work will not survive, and on confirm the navigation
  proceeds. This constraint exists because a refusal prescribed without one, on
  that task, produced a dead end. If that task's confirm has not landed at pickup,
  sequence this task after it rather than building a parallel affordance.
- **The password factor is untouched.** It prompts inline; nothing navigates, so
  nothing is stashed.
- **No per-surface re-auth logic.** Call sites pass what to stash and handle
  `FRESH_AUTH_REDIRECT_PENDING` as the clean-abort sentinel, as they do today.
- Check the review page's anonymous-submit path for the same class. If it reaches a
  navigating acquisition by another route, it is in scope; if it does not, say so
  in the signal.

Alternative considered and not preferred: acquiring when the user starts composing.
A full-page navigation fired by focusing a text area is more surprising than the
loss it prevents, and it spends a round-trip on every abandoned comment.

## Acceptance criteria

1. A passwordless account that writes a review (body, ratings, anonymous flag),
   submits with no window open, and returns from ORCID finds all of it restored and
   submits successfully inside the new window.
2. The same for a comment, restored into the composer for the same parent and no
   other.
3. The same for the vouch and retract handlers, for whatever each composes.
4. A stash is never restored on a different paper, a different parent, or under a
   different subject, and `auth.disconnect()` removes it.
5. A successful broadcast, and a consumed restore, leave the slot empty.
6. A failed stash write does not navigate and does not strand the user: the work
   stays on screen and the account has an in-page way to proceed.
7. A password-factor account sees no behavior change on any of the four call sites.
8. Unit coverage per call site, each assertion probed by reverting its own site
   (four sites, and the two vouch handlers do not mask each other). Cover: stash
   written only on the navigating path, restore on return, the three binding
   mismatches, clear on success, the failed-write path.
9. New comments cite no task slug, round number, or line number (root `CLAUDE.md`
   "Comment anchors").

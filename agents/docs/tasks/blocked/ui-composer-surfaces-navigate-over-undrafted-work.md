# Review, comment and vouch surfaces navigate a passwordless account away from work they do not keep

**Owner:** ui
**Created:** 2026-09-21
**Priority:** normal

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

## [BLOCKED by Architect] (2026-09-22) — sequenced behind the re-auth window confirm, and AC 3 is unreachable

Picked up 2026-09-22. Two premises in this file do not hold against main. Both
were checked by independent readers, and each verdict survived an adversarial
refuter that re-read the cited files rather than trusting the evidence.

### 1. Sequencing: the confirm this task is told to reuse has not landed

The Scope constraint "Every refusal needs a way through" says to reuse the
cost-stating confirm from `ui-light-account-reauth-window`, and: "If that
task's confirm has not landed at pickup, sequence this task after it rather
than building a parallel affordance."

It has not landed. That task sits in `tasks/pending/` under its round-6 hold,
whose item 1 is the prescription for exactly that confirm. On main:

- `publish.js`'s `_windowReady` is still the bare
  `freshAuthWindowReady({ allowRedirect: !this.holdsAttachedFiles, ...opts })`
  with no branch on the refusal, and every gate treats `false` as a terminal
  abort. `edit.js`'s wrapper is the same shape, and that page references
  `broadcastConfirm` nowhere at all.
- `FRESH_AUTH_REAUTH_REQUIRED` still dispatches to a toast only
  (`WINDOW_OUTCOME_TOASTS` -> `common.reauthRequired`). No consumer re-enters
  acquisition on that outcome, and the literal `allowRedirect: true` appears at
  no call site in `frontend/src`; every explicit pass is `false` or the
  `!holdsAttachedFiles` predicate.
- Round-6 item 2's revert target (the PDF re-pick carve-out in
  `handlePdfChange`, and the sentence describing it in `_windowReady`'s
  docblock) is still present verbatim. The hold states items 1 to 3 are one
  fix, so the survival of item 2's target is independent structural proof that
  item 1 did not land.
- `en.json` holds no copy naming a navigation cost for this class. The only
  leaving-cost string in the bundle is `upgrade.navigationGuardConfirm`, a
  `window.confirm` in the settings upgrade guard, on a different surface with a
  different trigger.

The five existing `broadcastConfirm` call sites (`publish.js`, `review.js`,
`comment-composer.js`, and two in `vote-buttons.js`) are all
intent-to-broadcast dialogs placed after a successful gate, never on a refusal,
and none states a cost of leaving.

Per the user's triage on 2026-09-22: the re-auth window task's round-6 fixes go
first, and this task picks up afterwards, reusing both that task's confirm and
its pre-navigation flush seam.

### 2. AC 3 is unreachable: a light account cannot reach either vouch handler

`vouch-section.js`'s `canVouch` and `canRetract` both carry
`!this.isLightAccount`, and `profile.js` gates both forms behind
`<template x-if>` on those getters, so for `custody === 'light'` the buttons
are not in the DOM; that branch renders `wot.keychainRequiredToVouch` instead.
`broadcastWithFreshAuth` acquires a window only for `custody === 'light'` and
otherwise returns `broadcastOps` before any acquisition. So neither handler can
fire a navigating acquisition, AC 3 cannot be demonstrated, and AC 8's probe
("the two vouch handlers do not mask each other") has no real path to probe
against. `components-vouch-section.test.js` pins the gate with two specs, so it
is a deliberate invariant rather than an accident.

Reachability was attacked from both ends and holds. `profile.js` is the only
mount of `vouchSection` repo-wide. The gates are `x-if` (node removed), not
`x-show` or `:disabled`; the `:disabled` on the buttons is only a re-entry
guard. The page carries no keydown, keypress or `@submit` handlers, and the
retract confirm block is a div, not a form, so there is no implicit Enter
submit. The `comment-posted` event bus reaches no vouch handler. On the
custody side: `loginFromResponse` assigns custody BEFORE `isConnected`, and
`_restoreSession` assigns both in one synchronous block, so no first-paint
window exists; the gate, `broadcastWithFreshAuth` and `broadcastOps` all read
the identical `custody === 'light'` test, so a store that under-reports custody
sends all three down the non-light branch together and nothing navigates.

**What is needed from the architect:** a product decision on whether a light
account should be able to vouch at all. Web of Trust vouching being
Keychain-only may be deliberate, or it may predate light accounts being able to
broadcast. The answer decides whether this task covers two surfaces or four:

- if the gate stays, drop the two vouch handlers from Scope, from AC 3 and from
  AC 8, and this task covers `review.js` and `comment-composer.js` only;
- if the gate is the bug, lifting it is its own task and this one sequences
  after that one, with AC 3 intact.

### Settled while here, so it need not be re-derived

The Scope bullet asking about the review page's anonymous-submit path: it does
NOT reach a navigating acquisition, so it is out of scope. `submitAnonymousReview`
is a plain `authenticatedRequest` POST to `/reviews/anonymous`; the shared
request helper has no 401 interceptor, no retry gate and no redirect, nothing
monkey-patches `fetch`, and the backend route carries no fresh-auth
requirement. The only full-page ORCID navigation reachable from a broadcast is
the one in `beginOrcidFreshAuthRedirect`, and the anonymous arm never reaches
it. The stash must still carry `isAnonymous` per Scope, but the anonymous path
itself never triggers a write.

### Three implementation findings worth keeping

- **The write has exactly one safe home:** between the redirect-host allowlist
  check and the `window.location.href` assignment in
  `beginOrcidFreshAuthRedirect`, with nothing awaited in between. Every earlier
  position leaves a stash behind on an exit that does not navigate (a
  `startOrcid` throw, the stale-flight cancel, an invalid redirect URL), and
  the stale-flight cancel is the one exit that deliberately must not clean up
  its own flow keys. A failed write must also unwind those flow keys before it
  refuses, or the tab keeps a mode marker with no navigation behind it.
- **The coalescing hazard runs the opposite way from the Scope note.** The
  sharp case is a callback-LESS caller installing the flight and a
  callback-bearing one joining: a vote button (out of scope, so no callback)
  installs the permissive flight, a comment submit joins it within the
  `startOrcid` round-trip, and the navigation fires with no stash written at
  all. Any design that runs only the installer's callback leaves the bug intact
  and makes it click-order dependent.
- **`broadcastWithFreshAuth` acquires TWICE**, at its entry and again on the
  remintable-401 retry. Threading the option into only the first reproduces the
  bug on every closed-window 401, which is the case these surfaces meet most
  often.

### Architect note (2026-09-30) — the confirm has landed, and one more site shares the draft-key exposure

Blocker 1 in the block this note follows is satisfied: the re-auth window task is
archived clean, so the cost-stating confirm (`_confirmNavigationCost` on the publish
and edit pages, asked through the `broadcastConfirm` store) and the pre-navigation
flush are on main and reusable. Blocker 2, the product decision on light-account
vouching, is still open, so the task stays in `blocked/`.

A residual from that task's final review, recorded here because it shares the
acquisition seam this task builds on. It is not held anywhere else:

- `page-mount.js` re-renders only when the router's route name changes. A history
  jump from one `/edit/...` entry to another therefore keeps the same `editPage`
  instance mounted while the `draftKey` getter, which reads the router params,
  starts naming the other paper.
- If that jump happens while the navigation-cost confirm is open, an honoured yes
  passes the `_mounted` check in `_confirmNavigationCost` and its flush writes this
  form under the other paper's draft key. The debounced save and the flush in
  `_windowReady` already have the same exposure; the confirm's flush is one more
  site, not a new class.
- Narrow: it needs two edit entries one history step apart and the modal open.

Relevance at pickup: a stash bound to surface, target and subject (the Scope's
"restore is bound three ways") must read its target at write time from the same
params, so the same same-instance param change can mis-bind it. Capture the target
when the composing begins or when the gate is entered, not at the write, or say in
the signal why the write-time read is safe on the surfaces in scope.

### Architect note (2026-10-01): the composer draft-key residual moves to a filed task

The residual recorded in the 2026-09-30 note (a history jump between two `/edit/...` entries
keeps the same `editPage` instance while the `draftKey` getter starts naming the other paper) is
now in scope of `tasks/pending/ui-composer-drafts-bound-to-account-and-head.md`: draft keys are
captured at load (account plus canonical pair), and the page remounts when the edit route names
another paper or another account signs in. This task no longer carries it. Its own stash stays a
separate mechanism (a `sessionStorage` slot in `SUBJECT_BOUND_STORAGE_KEYS`), and the "capture the
target when the composing begins" advice in that note still applies to the stash.

### Architect note (2026-10-01): blocker 2 decided, light accounts vouch; now sequenced behind the gate lift

User decision: light accounts should be able to vouch. No recorded reason for the gate was found.
It arrived with light accounts, when server-side signing covered comments and votes only, and the
custody route's `custom_json` action list mirrors it. The gate is the bug, so per blocker 2's
own second branch this task keeps all four surfaces, with AC 3 and AC 8's vouch-handler probe
intact, and it sequences after the gate lift:

- `backend-custody-admits-vouch-and-retract` (`pending/`) admits `vouch` and `retract_vouch` on
  the custody route under the session-kind proof (`ARCHITECTURE.md` § 6.4, decided the same
  day).
- `ui-light-account-vouch` (`blocked/`, behind the backend task) removes the
  `!this.isLightAccount` clauses and the Keychain-only message.

What a passwordless account composes on the vouch surfaces: the `relationship` choice for a
vouch, and `retractReason` for a retraction (`showRetract` is the view state that reveals the
reason field).

The architect moves this file to `pending/` once `ui-light-account-vouch` is archived.

## Architect note (2026-10-06): relevance at pickup

The sign-in modal that a revoked or expired session opens now links to /login in the same tab, so a
passwordless account whose session ends on /review can leave the undrafted review that way, as it already
could by going to /login by hand. After ORCID sign-in from /login, `_handleLogin` in `orcid-callback.js`
navigates to /papers, because login mode records no return path.

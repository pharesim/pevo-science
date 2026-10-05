# Recovery and password reset leave this browser's revoked session in place

**Owner:** ui
**Created:** 2026-09-30
**Priority:** high

## Why

`pages/recover.js` and `pages/reset-password.js` complete their flow without
touching the auth store. Both recovery arms await the API call and move to the
done phase, discarding the reissued token in the response. The reset route
returns no token at all. Each of these revokes every earlier session for the
account on the server.

A user who is signed in on the same browser and runs either flow keeps the
revoked token in the store and in the stored session. Nothing happens until
the next bearer request, which can be the notification poll up to five minutes
later. At that point `handleRevokedSession` tears every tab down, shows the
signed-out message and opens the sign-in modal, possibly over the done screen
or over `/login`. The outcome is coherent, since the done screens already send
the user to sign in, but it is delayed and unprompted, and it reads as if
someone else changed the account.

## Scope

1. On a successful recovery or reset, end a live session in this browser for
   the same account at that moment, through the auth store's existing
   disconnect path, so the sign-out is part of the user's own action.
2. Decide whether recovery should instead adopt the reissued token its
   response carries. That changes what the done screen says and what state the
   account is in, so check it against `ARCHITECTURE.md` § 6.1 and § 6.3 before
   choosing, and ask if the answer is not clear from there.
3. A session for a different account must be left alone.

## Acceptance criteria

1. After a successful recovery or reset in a browser signed in as that
   account, no revoked session remains stored, and no teardown message or
   sign-in modal appears later on its own.
2. A session for another account survives.
3. Unit tests pin both pages.

## UI implementation signal (2026-10-06, commits f4eb9c85, 2319a5b9)

Recovery half done. The reset half is blocked on the backend (note at the end).

Decisions taken with the user on 2026-10-05 and 2026-10-06, for scope item 2
and for two gaps the task text did not anticipate:

- **Seed-phrase recovery is two-phase.** Phase 1 (`POST /api/auth/recover`
  with `memo_key`) changes nothing and revokes nothing, so the seed arm leaves
  the session alone. The revocation happens at `POST /api/auth/recover/verify`,
  whose mailed link has no SPA page (nor does the dispute link). Filed as
  `ui-seed-recovery-confirm-and-dispute-pages` (high); it reuses the helper
  below.
- **ORCID recovery adopts the reissued session** (the § 6.7 survivor token,
  as the custody upgrade does) when the browser is signed out or signed in to
  the recovered account. A different account stays signed in (criterion 2).
  The done screen offers a button that switches to the recovered account at
  the user's request.
- **Reset needs the account name.** The reset response does not name the
  account, so the page cannot tell whether the browser's session belongs to
  it. The user chose a backend change over a client-side probe. Filed as
  `backend-reset-response-names-the-account` (high).

What landed:

- `auth.js` `adoptRecoveredSession(data, { replaceAnotherAccount })`. For the
  same account it scrubs this tab's subject-bound state and saves the reissued
  session over the stored one. This does not go through `disconnect()` as
  scope item 1 suggests: removing the stored session and then saving in one
  task lets another tab's storage-event sign-out remove the reissued session.
  Verification found that, and it reproduced in Chromium with two tabs sharing
  a renderer process. The user chose this helper-local fix over changing the
  shared storage handler, which would let a late accreditation-poll save in
  another tab undo a header sign-out.
- `recover.js`: the ORCID arm hands its response to the helper, and the done
  screen follows the outcome (`doneCopy`, `doneAction`). New keys
  `recover.orcidDoneSignedIn`, `orcidDoneOtherAccount`, `goToSettings` and
  `switchAccount` are stubbed in 15 locales (`STUBS.md` entries dated
  2026-10-05 and 2026-10-06).
- Tests: `tests/unit/pages-recover-session.test.js` drives the real page,
  store and `api.js` with `fetch` stubbed. It covers the same account, signed
  out, another account kept, the switch, a second tab replaying the storage
  events, the seed arm signed in and signed out, and a later bearer request.
  The real-backend recovery test in `e2e/orcid-no-password.spec.js` asserts
  the stored reissued session, its acceptance by the real middleware
  (`GET /api/settings/email` 200), the signed-in copy and Go to Settings.
- Verification: the full unit suite is green (92 files, 2159 tests), and
  `orcid-no-password.spec.js` passes 7/7 against the rebuilt test stack. A
  three-lens adversarial verification of f4eb9c85 (21 agents) left seven
  findings; the user triaged them and 2319a5b9 fixes them.

Acceptance criteria:

1. Met for the ORCID arm. Seed phase 1 has nothing to revoke, and phase 2
   belongs to the seed task. Reset: open (blocked).
2. Met: another account stays signed in unless the user switches.
3. The recover page is pinned. The reset page is still to do.

Left for the reset half: `reset-password.js` hands `data.username` to the
store, a same-account session ends there without anything to adopt, and unit
tests pin the reset page.

[BLOCKED by Backend] (2026-10-06): needs `POST /api/auth/reset` to return the
reset account's `username` in its success `data`
(`backend-reset-response-names-the-account`). Move this file back to
`pending/` once that lands.

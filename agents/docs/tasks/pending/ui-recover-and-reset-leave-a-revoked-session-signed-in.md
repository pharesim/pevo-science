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

Backend note (2026-10-07): unblocked, with a different shape than the note
above asks for. By user decision on 2026-10-07, `POST /api/auth/reset` does
not return the username, because a caller holding only the mailed token
(access log, proxy log, browser history, an old mailbox after an email
change) would learn the login identifier for the password it just set.
Instead:

- The request may carry the browser's stored session token as
  `Authorization: Bearer <token>`. It is optional, never fails the reset,
  and the route never answers 401 for it. `resetPassword` in `api.js` sends
  no header today.
- The success `data` is `{ message, session_ended }`. `session_ended` is
  true only when the bearer verifies and names the account the reset just
  revoked; a missing, foreign, forged or malformed bearer answers false.

So the "Left for the reset half" line changes: the page sends the header and
reads `data.session_ended` instead of handing `data.username` to the store.
Landed in 0aa0bf78 (`bearerNamesAccount` in `backend/src/routes/auth.ts`).

## UI implementation signal, reset half (2026-10-07, commits d68979b7, 599554f4, 54d041f7)

Reset half done, against the shape in the backend note (bearer match,
`session_ended`), not the `data.username` line that note replaced.

What landed:

- `api.js` `resetPassword(token, password, sessionToken)` sends the stored
  session as `Authorization: Bearer` when the browser holds one. It stays on
  plain `request()`: the reset works signed out, and the route never refuses
  a reset over the bearer.
- `auth.js` `endResetSession(sentToken)` ends the session through
  `disconnect()`, as the header sign-out does: no message, no sign-in prompt,
  and other tabs follow through the storage event. It goes through
  `_endSession`, whose notice is now optional, so the stale-token check and
  the adoption of a newer stored session cover it too. `handleRevokedSession`
  and `endSessionIfExpired` still pass a notice and behave as before.
- `pages/reset-password.js` captures the store's token before the request
  and, when `data.session_ended` is true, hands it to `endResetSession`, even
  if the page has gone. The done screen is unchanged (it already sends the
  user to sign in), so no i18n keys were added.

Tests:

- `tests/unit/pages-reset-session.test.js` (new, 9 cases) drives the real
  page, store and `api.js` with `fetch` stubbed: the bearer sent; the session
  and its proof window ended; no message or prompt, then or on a later
  request; the page gone mid-request; a second tab; another account kept; a
  signed-out browser sending no bearer; the store changed in flight (a newer
  stored session adopted, a switched session kept). 7 of the 9 are red
  against the parent commit.
- `tests/unit/pages-reset-password.test.js` follows the new signature. Its
  page-gone happy-path case now resolves `{}`; with `undefined` it had passed
  through a TypeError caught in `catch`.
- `e2e/password-recovery.spec.js`, new case "a reset completed in a browser
  signed in to the account signs that browser out": signs in through
  `/login`, completes a real reset in the same browser, and asserts the
  bearer sent, `session_ended: true`, no stored session, no revoked-session
  copy, and that the real middleware answers the dropped token with 401
  `SESSION_INVALIDATED`. Its submit locators are scoped to the page forms.

Verification:

- Full frontend unit suite green at d68979b7 (98 files, 2284 tests). After
  the comment fix in 54d041f7, the eslint canaries and the reset and auth
  suites passed (86/86).
- E2E on the rebuilt test-mode stack, `password-recovery.spec.js` alone with
  `--retries=0`: the new case passes. The file's older case fails at its
  unscoped `form button[type="submit"]` (strict-mode clash with the re-auth
  modal), which `ui-e2e-bare-submit-locators-clash-with-reauth-modal` owns.
  Dev routing restored with `./deploy.sh up`.
- Four-lens adversarial verification (12 agents, none died). All 9 mutants
  were killed. Header logging, the carve-out header, comment anchors and the
  E2E locators came back clean. It raised four P3 findings, which the user
  triaged on 2026-10-07:
  - two comment overclaims (`endResetSession` said every tab shows the
    signed-out message; the reset page's `destroy()` said continuations bail
    before touching reactive state): fixed in 54d041f7.
  - a same-account session issued before the reset's commit (another tab
    signs in again with the old password during the request) is kept or
    adopted, is revoked too, and still meets the message later: accepted as
    a residual. The client cannot tell it from a valid post-reset login, and
    it is the pre-change outcome.
  - ARCHITECTURE.md § 6.3 and § 6.4 name only A and B for the reset:
    dismissed here, already filed as `architect-password-reset-gate-docs`.

Residuals, recorded, no action taken:

- A bearer request answered between the reset's commit and this page
  processing the answer still raises the signed-out message. The window is
  the rest of the reset round trip.
- A transport failure after the server committed (client timeout, proxy
  502/504) shows `resetFailed` and keeps the revoked session. The client
  cannot know the reset landed.
- A stored token already expired at the server gets `session_ended: false`
  and later ends with the expired copy (the clock-skew residual documented
  on `endSessionIfExpired`).
- The `POST /api/auth/reset` section of `agents/docs/api-contracts/auth.md`
  needs the optional bearer and `session_ended`; the `[TODO Architect]` in
  `backend-reset-response-names-the-account` covers it.

Acceptance criteria:

1. Met: the ORCID arm (earlier signal) and the reset (this signal). Seed
   phase 2 belongs to `ui-seed-recovery-confirm-and-dispute-pages`.
2. Met on both halves: another account stays signed in.
3. Met: the recover and reset pages are pinned.

Learnings checkpoint: grepped `agents/docs/solutions/` for `_endSession`,
`handleRevokedSession`, `adoptRecoveredSession`, `resetPassword`,
`session_ended` and `bearerNamesAccount`.
`credential-setting-token-redeem-must-not-name-the-account.md` covers the
backend half and stays true. Nothing new qualified: the rationale for the
quiet sign-out and its guards lives in the `endResetSession` and
`_endSession` docblocks.

## Architect re-review (2026-10-07) — HELD PENDING FIXES:

`/ce-code-review` over the five commits (f4eb9c85, 2319a5b9, d68979b7,
599554f4, 54d041f7) with seven reviewers. No finding reached the reporting
bar, the acceptance criteria are met, the four page specs pass 63/63, and
10 of 10 planted mutants were killed across the unit suite. The user
triaged one item as blocking archive:

1. **The recover page's done screen follows the method tab selected when the
   request finishes, not the arm that sent it.** `doneCopy` and `doneAction`
   read the live `method`, and the two tab buttons stay clickable while a
   submit is in flight.
   - ORCID submit, Seed tab clicked during the request: the done screen
     shows the seed-pending title and copy and a Sign in button, although
     the recovery was applied and this browser may already be signed in to
     the recovered account.
   - Seed submit, ORCID tab clicked during the request: the done screen
     says the account was recovered and has no password, which is false
     (phase 1 changes nothing), and never tells the user to confirm through
     the mailed link. Its "Switch to the recovered account" button calls
     `adoptRecoveredSession` with the null `_recovered`, which throws a
     TypeError, so the button does nothing.

   Fix so the done screen (title, description, button, icon) and
   `doneAction` always reflect the arm whose request completed, whatever
   the tab state. The mechanism is the implementer's choice. Pin both
   directions in the unit specs: a tab switch during the in-flight request
   leaves the finished arm's done screen, and after a seed submit no switch
   button is offered.

Dismissed at triage, no action:

- `adoptRecoveredSession` decides on the in-memory `username`. A sign-in to
  another account in another tab, landing within the storage-event latency
  of the recovery answer, can be overwritten. Timing-only.
- A revoked-session removal from another tab, processed after this tab
  saved the reissued session, removes it, and the done screen still says
  signed in. Timing-only, the recovery analog of the accepted reset
  residual. Accepted as a residual.
- Same-account adoption passes `is_accredited: false` and
  `accreditation: null`, so the account's tabs show the unaccredited UI
  until the accreditation check returns. This is the sign-in modal's login
  convention, and it heals on the poll.
- Other same-account tabs keep their password-factor memo after an ORCID
  recovery has dropped the password, so a fresh-auth action there can meet
  a refused password prompt before the memo retires.
- The reissued session can expire on a done screen left open past its
  lifetime before the switch button is pressed.

At archive the architect runs `/ce-compound-refresh` on
`await-is-not-a-teardown-boundary-unless-it-yields-to-a-macrotask-2026-09-03.md`,
whose list of triggers reaching `_scrubSubjectBoundState` misses
`endResetSession` and `adoptRecoveredSession`.

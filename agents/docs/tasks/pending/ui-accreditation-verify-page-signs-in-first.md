# The accreditation verify page posts the token without a session

**Owner:** ui
**Created:** 2026-10-05
**Priority:** high

Filed from the accreditation and Web of Trust audit (finding 4).

## Why

`POST /api/accreditation/verify` takes the emailed token as its only credential. Whoever opens
the link accredits the account that requested it, under the name the requester typed. A requester
can name someone else's institutional address, and `accreditationVerifyPage.init()`
(`frontend/src/pages/accreditation-verify.js`) posts the token as soon as the page loads.

**Decision (user, 2026-10-05):** `/verify` will require the session of the account the link was
requested for. The backend half is `backend-accreditation-verify-requires-the-account-session`,
which waits in `blocked/` until this task is archived: if the backend landed first, this page's
unauthenticated POST would answer 401 and the page would show its generic failure state.

This task is compatible with the backend as it stands. The route has no auth middleware today, so
it ignores an `Authorization` header.

## Scope

1. `verifyAccreditation` (`frontend/src/api.js`) sends the session. It uses the plain `request`
   helper today; `requestAccreditation`, next to it, uses `authenticatedRequest`.
2. The page does not post while no session exists. It shows a state that says the link has to be
   opened while signed in as the account that requested the accreditation, and offers the app's
   existing sign-in entry point (`frontend/src/components/sign-in-modal.js`). After a sign-in on
   that page it goes on with the token it captured in `init()`. The session is kept in
   `localStorage`, so a link opened in a new tab of a browser that is already signed in has it.
3. Two answers the backend task will add, both leaving the token usable:
   - 401 (`UNAUTHORIZED`, or the session-ended codes `authenticatedRequest` already handles):
     show the sign-in state, not "Request New".
   - 403 `ACCREDITATION_ACCOUNT_MISMATCH`: say that the link belongs to a different account and
     that the user should sign in as that account and open the link again. No "Request New"
     button on this state.
4. New copy goes through the i18n flow the other pages use.

## Out of scope

- How the page maps the other error codes. `architect-audit-frontend-security-surface` covers
  this file.
- A confirm click before posting. The session requirement was chosen instead.

## Acceptance criteria

1. With no session the page sends no request and shows the sign-in state. After sign-in it posts
   once, with the token from the URL.
2. With a session the POST carries the `Authorization` header.
3. A 403 `ACCREDITATION_ACCOUNT_MISMATCH` answer shows the different-account copy and no
   "Request New" button. A 401 answer shows the sign-in state.
4. Comments follow root `CLAUDE.md` "Comment anchors".

## [TODO Architect] at archive

- Move `backend-accreditation-verify-requires-the-account-session` from `blocked/` to `pending/`.

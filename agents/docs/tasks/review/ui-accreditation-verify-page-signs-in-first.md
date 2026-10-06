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

## UI implementation signal (2026-10-06, commits 9e853eea, 39439ca1, 8f9a082a)

Landed on main in three commits, each verified with
`git merge-base --is-ancestor <sha> main`:

- `9e853eea`: the two `form button[type="submit"]` locators in
  `accreditation.spec.js` scoped to `[x-data="accreditationPage"]` (decision 1).
- `39439ca1`: the change itself: `verifyAccreditation`, the page, the four
  `verify.*` keys in all sixteen locales, the STUBS.md sweep, and the unit and
  E2E specs.
- `8f9a082a`: three comments in the new specs narrowed to what the page does
  (verification findings, below).

**Decisions taken with the user before submitting:**

1. **Locator fold-in.** The request-and-verify E2E spec failed at its first
   click on the known strict-mode clash with the always-rendered re-auth modal
   form, so the Authorization assertion added to it never ran. Fixed in its own
   commit, the same fix `edit-paper.spec.js` received.
2. **Adopted session posts again.** On a `SESSION_EXPIRED` or
   `SESSION_INVALIDATED` answer the auth store can adopt a newer session another
   tab saved instead of signing out (`_endSession` ->
   `_adoptStoredSessionOtherThan`). The page would then show "Sign in" under a
   live session. `_verify` remembers the session token the request carried; in
   the sign-in branch, a different store token means the page posts again with
   it, and no token left means the sign-in state. A server `UNAUTHORIZED` with an
   unchanged token shows the sign-in state, so there is no loop. A newer session
   of another account lands on the mismatch state once the backend task is in.

**Scope 1 / AC2.** `verifyAccreditation` (`frontend/src/api.js`) goes through
`authenticatedRequest`. `api.test.js` asserts `Authorization: Bearer <token>` on
`POST /api/accreditation/verify`; both E2E flows assert the bearer header.

**Scope 2 / AC1.** `init()` captures the URL token, registers
`$watch('$store.auth.token')`, and calls `_verifyIfSignedIn()`. With no session
it shows the `signin` state (title, the "has to be opened while signed in as the
requesting account" copy, and a Sign in button calling `auth.connect()`) and
sends nothing. Any later session token while in that state (the page's button,
the header, another tab's storage event) posts the captured token once.
E2E "verify link opened without a session asks for sign-in, then posts with the
session" drives this through the real modal (Keychain path, `/api/auth/session`
stubbed with a minted JWT): zero requests before sign-in, exactly one after,
with the token from the URL and the new bearer.

**Scope 3 / AC3.** `SIGN_IN_CODES` (`UNAUTHORIZED`, `SESSION_EXPIRED`,
`SESSION_INVALIDATED`) map to the `signin` state, never to "Request New".
`ACCREDITATION_ACCOUNT_MISMATCH` maps to a `mismatch` state with its own title
and the different-account copy, and no button. E2E "verify link opened as a
different account shows the different-account state" asserts the copy and zero
"Request New Accreditation" links (the stubbed 403 carries a different message,
so the assertion would catch raw server text).

**Scope 4.** Keys `verify.signInTitle`, `verify.signInMessage`,
`verify.mismatchTitle`, `verify.mismatchMessage` in all sixteen locales, English
stubs in the fifteen others, listed under
`### Added 2026-10-06 (ui-accreditation-verify-page-signs-in-first)`. No emdash.

**AC4.** The pre-commit anchor gate passed on all three commits.

**Verification.**
- Unit: full frontend suite, `npx vitest run` exit 0, 92 files, 2179 tests.
- E2E (test-mode stack, bundle rebuilt from 39439ca1): `accreditation.spec.js`
  3/3 passed, including the formerly failing request-and-verify spec. `8f9a082a`
  is comment-only. Stack restored with `./deploy.sh up`.
- `/ce-simplify-code`: applied the watcher's redundant token check, the
  `vi.fn()` `$watch` idiom of `pages-edit.test.js`, and a distinct mismatch stub
  message. Skipped exporting `SESSION_ENDED_CODES` (would pull `fresh-auth.js`
  into the page and its api mock) and an E2E session-stub helper (two copies).
- Adversarial verification workflow (3 lenses, skeptic per finding) on
  39439ca1: 10 planned mutants plus 4 extra, all killed by a unit spec or, by
  reading, an E2E spec; a real-Alpine probe of 11 sign-in scenarios found no
  double post or loop. Two low findings confirmed and fixed in `8f9a082a`
  (comments stating the backend's session check as current, and that the
  mismatch state names the account).
- `/ce-code-review` not run: architect-owned per `agents/ui/CLAUDE.md`.

**Out of scope, for follow-up if wanted.**
- The sign-in modal's ORCID line navigates to `/login` in the same tab
  (decision on `ui-sign-in-modal-has-no-orcid-path`), so an ORCID sign-in from
  this page loses the captured token; the user opens the link again, which the
  sign-in copy already asks for. A skeptic refuted it as a defect of this task.
- `403 ACCREDITATION_SANCTIONED` from `/verify` still shows the generic failure
  with "Request New" (other-code mapping is out of scope here).

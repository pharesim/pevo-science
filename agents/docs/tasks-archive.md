## The signup verify page asks for the signup password (archived 2026-10-06) — one round; clean; three left-open behaviors accepted; NULL-hash note added to the backend half

### Architect archive note (2026-10-06, round 1)

- **Review:** `/ce-code-review` on `e2334dd4~1..e2334dd4` (correctness, security, adversarial in-process, testing, frontend races, project-standards, learnings; empty validator batch). No P0/P1/P2. The full frontend unit suite on a git-archive copy of `e2334dd4`: 94 files, 2227 tests, exit 0, matching the signal. Testing planted 8 mutants: 6 killed; the two survivors (the `isVerifying` re-entry guard, which the disabled submit button masks, and the `_mounted` guard in `finally`) dismissed. The races lens was re-tasked after a shallow first pass and then checked double submit, re-navigation mid-request, stale error copy across 401 then 400, and a lost-response retry: no defect.
- **#1 to #3 (P3, reverse check, accepted):** 429 keeps the form with a wait message; any other failure keeps the form with the retry message; the wrong-password copy points to a new signup with the same address, which holds for state E, the only state `/verify` can answer 401 for.
- **RR1 (accepted, note appended to `backend-signup-verify-requires-the-signup-password`):** a pending row with `password_hash` NULL (an `orcid_token` that no longer resolved, no password sent) gets the wrong-password 401, not the 500 an `argon2.verify(null, ...)` TypeError would give. The same commit narrowed that task's deploy note, which still said the SPA sends no password.
- **TG1 (dismissed):** a wrong-password E2E run against the real backend. The backend task's AC1 asserts 401 `UNAUTHORIZED` on the real route, and the unit specs pin the page's routing on that code.
- **RR2 (noted, no action):** the account takeover stays open until the backend half deploys; the current `/verify` ignores `password`.
- **Dismissed:** `verifyPassword` stays in component state after verify (lives only as long as the page, like `resumePassword`).
- **Sibling drift:** `64bca0fb` and `141840d7` landed on `signup-verify.js` and its spec after the reviewed head; `handleVerify` is identical at HEAD. The three E2E locators `ui-e2e-bare-submit-locators-clash-with-reauth-modal` lists are scoped in this commit; its pickup re-grep will find them gone.
- **Learnings checkpoint:** solutions/ grepped for the page, the error-code routing, the stub sweep and the locator symbols; no entry contradicted or overclaiming. No new entry: the NULL-hash dependency lives in the backend task note.

**Owner:** ui
**Created:** 2026-10-05
**Priority:** high

The UI half of `backend-signup-verify-requires-the-signup-password`, filed at the user's request
on 2026-10-05. Read that task's Why first: it explains the account takeover this closes.

## Why

`POST /api/auth/verify` will require the password chosen at signup beside the mailed token, and
will answer 400 `VALIDATION_ERROR` without it. Today `pages/signup-verify.js` calls
`verifyToken(emailToken)` from `init()` as soon as the page loads with `?token=`, and
`verifyEmail(token)` in `api.js` sends `{ token }` only. Once the backend change lands, that call
fails and the email signup flow stops at the verify page.

## Scope

1. **`api.js`:** `verifyEmail(token, password)` sends `{ token, password }`.
2. **`pages/signup-verify.js`:** landing with `?token=` shows a password field. It does not verify
   on load. Submitting sends the token and the password.
   - 401 `UNAUTHORIZED` means a wrong password. Show that, keep the form, and keep the token: the
     link stays usable.
   - The 400 `BAD_REQUEST` answers (an unknown, already used or expired token) keep today's
     handling.
   - A 503 from argon saturation shows a retry message.
   - The resume path (`query.resume === RESUME_MARKER`) is unchanged.
3. **Copy:** the prompt says this is the password chosen when signing up for PEvO, and that someone
   who did not sign up should close the page. New strings go through the project's i18n flow.
4. **Specs:** `tests/unit/pages-signup-verify.test.js`, plus whichever of
   `tests/e2e/email-signup.spec.js` and `tests/e2e/seed-phrase.spec.js` drive the verify link,
   enter the signup password. Add a unit spec: a 401 keeps the form and the token, and a retry
   with the right password reaches the `choose` phase.

## Notes

- This can ship before the backend task or with it, never after. The current `/verify` ignores
  the extra `password` field, but the backend change alone breaks the flow.
- The E2E specs need the backend change on the test stack.

## UI implementation signal (2026-10-06, commit e2334dd4)

Landed on main in one commit, verified with
`git merge-base --is-ancestor e2334dd4 main`.

**Scope, item by item:**

1. `api.js`: `verifyEmail(token, password)` posts `{ token, password }`.
   `tests/unit/api.test.js` pins the body.
2. `pages/signup-verify.js`: landing with `?token=` stores the token and
   shows a password form (new phase `password`, which replaces the
   verify-on-load `verifying` spinner). Nothing is sent on load. Submit
   (`handleVerify`) sends the token and the password.
   - 401 `UNAUTHORIZED`: the form and the token stay, with a wrong-password
     message; a retry with the right password reaches `choose`.
   - 400 `BAD_REQUEST`: today's resume form, no message.
   - 503: the form stays, with a retry message.
   - The `?resume=1` path is unchanged.
3. Copy: six new `seedPhrase` keys (`passwordTitle`, `passwordDescription`,
   `passwordButton`, `passwordWrong`, `verifyRetry`, `verifyRateLimited`),
   English stubs in the 15 other locales, one STUBS.md Added sweep (90
   lines). The prompt says the password is the one chosen when signing up
   for PEvO and that someone who did not sign up should close the page.
4. Specs: `pages-signup-verify.test.js` covers landing without a request,
   token plus password sent, the 401-then-retry spec the task asks for,
   400, 503, 429, an unexpected flow and teardown. `email-signup.spec.js`
   and `seed-phrase.spec.js` enter the signup password;
   `email-signup.spec.js` also asserts the `/verify` request body.

**Decisions the task left open:**

1. **429 `RATE_LIMITED` keeps the form with a wait message.** Wrong-password
   retries now count against `verifyLimiter` (10 per hour per IP). The
   resume form cannot help a row the link has not confirmed yet, so
   dropping to it would be a dead end.
2. **Any other failure (500, network, timeout) keeps the form with the
   retry message**, for the same reason. If the confirm landed and only the
   answer was lost, the retry gets 400 and moves to the resume form, which
   then works.
3. **The wrong-password copy names the way out:** "If you forgot it, start
   a new signup with the same email address." The `/signup` upsert's
   `DO UPDATE` rewrites a pending row E's password and token and mails a new
   link. The form also carries the existing "Start a new signup instead"
   link.
4. **The busy state is the button label** (`seedPhrase.verifying`), as the
   resume form on the same page does, rather than a spinner phase that would
   hide the form between attempts.

**Verification:**

- Frontend unit suite: 94 files, 2227 tests, exit 0.
- E2E on the test-mode stack (`./deploy.sh restart`, `test-db-up`,
  `test-up`; dev routing restored with `./deploy.sh up` afterwards):
  `email-signup.spec.js` and `seed-phrase.spec.js` 2/2 passed, `--retries=0`.
  The stack ran the current backend, which ignores `password`, so this run
  proves the new form and request shape, not the 401 branch.
- The 401, 503 and 429 branches were driven in a real browser against the
  rebuilt bundle with `/api/auth/verify` answered by `page.route` (401, then
  503, then 429, then 200 `choose`) at 1280px and 390px wide. Each kept the
  form with its message, every request carried the token and the typed
  password, the last reached `choose`, and nothing overflowed horizontally.

**Also in this commit:** the three bare `form button[type="submit"]`
locators in these two specs (`email-signup` 1, `seed-phrase` 2) are scoped
to `[x-data="signupPage"]` and `[x-data="recoverPage"]`. Before this the
specs failed at those clicks. `ui-e2e-bare-submit-locators-clash-with-reauth-modal`
lists them, and its pickup re-grep will find them gone.

**For deploy:** the backend sibling
(`backend-signup-verify-requires-the-signup-password`) is still in
`pending/`. This commit can ship first: the current `/verify` ignores the
extra field.

## The accreditation verify page posts the token without a session (archived 2026-10-06) — one round; clean after one in-place comment fix; ORCID copy gap and cross-tab post dismissed; backend half unblocked

### Architect archive note (2026-10-06, round 1)

- **Review:** `/ce-code-review` on `9e853eea~1..8f9a082a` (correctness, security, adversarial in-process, testing, frontend races, project-standards, learnings; validator on the two merged findings). No P0/P1. The full frontend unit suite on a git-archive copy of `8f9a082a`: 92 files, 2179 tests, exit 0, matching the signal. Testing planted 11 mutants: 9 killed; the two survivors (the `SIGN_IN_CODES` branch moved below `_isRetriable`; the `_mounted` guard in `handleConnect` dropped) dismissed as low-risk. Two lenses traced the page's states (8 real-Alpine scenarios, 5 named race scenarios): no double post, loop, stuck `loading`, lost token, or POST without a session.
- **#1 (P2, dismissed):** the sign-in modal's ORCID line navigates to `/login` in the same tab and ORCID login lands on `/papers`, so the captured token is lost, and `verify.signInMessage` does not say to open the link again. The signal's "which the sign-in copy already asks for" is false: only `verify.mismatchMessage` says it. Dismissed on reachability: an account that requests email accreditation signs in inside the modal (light signups are accredited by the `/confirm` and `/link` accreditation cascade in `signup-verify.ts`; pure self-custody accounts have no ORCID login), so only an off-path click on the ORCID line reaches it.
- **#2 (P3, fixed in place by the architect, `faffe9f9`):** deleted "Each comes before the token is read, so" from the `SIGN_IN_CODES` docblock. `/verify` has no auth middleware yet, so the server-side ordering described the backend task.
- **#3 (advisory, dismissed):** a sign-in in another tab also posts the captured token; the watcher comment names that case. Until the backend task lands this is narrower than the old post-on-load; after it, a sign-in as the wrong account gets the mismatch state.
- **Noted, no action:** two tabs in the sign-in state both post on one sign-in, and `/verify` has no per-token lock, so near-simultaneous posts may both broadcast (backend concern). Testing gap on the code strings is covered by the backend task's AC1/AC2 plus the unblock note appended to it.
- **Sibling drift:** `64bca0fb` and `141840d7` (other ui tasks: mailbox-bound and sanctioned states, timeout naming, copy) landed on the verify page and its spec after the reviewed head; not part of this review.
- **[TODO Architect] done:** `backend-accreditation-verify-requires-the-account-session` moved `blocked/` → `pending/` with an unblock note naming the codes the page matches.
- **Learnings checkpoint:** existing entries grepped for the verify page and route symbols; the `skip-failed-requests-jwt-required-credential-verify-carve-out` grid row for `accreditationVerifyLimiter` (JWT-required ❌) still holds until the backend task lands, and no entry claims the page posts on load. No new entry: the adopted-session re-post rationale is carried by the comment in `_verify` and by `_endSession` in `auth.js`.

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

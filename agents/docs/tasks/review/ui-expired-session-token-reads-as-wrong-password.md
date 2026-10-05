# An expired session token reads as a wrong password, and the user is never told to sign in

**Owner:** ui
**Created:** 2026-10-01

Routed out of the architect archive of the fresh-auth count-tally task (archived
2026-10-01), where the implementer reported it as a behaviour outside that comment-only
task. An architect-side check confirmed it. The user chose a client-side fix over a new
backend error code.

## Why

The session JWT lives 24 hours (`SESSION_EXPIRY` in the backend auth routes). The auth
store checks `expiresAt` only in `_restoreSession`, so a tab left open past expiry keeps
sending the expired token. The backend's `verifyHiveSignature` cannot verify it, falls
through to the signature branch, and answers 401 `UNAUTHORIZED` ("X-Hive-Username and
X-Hive-Signature headers are required"). `authenticatedRequest` in `api.js` special-cases
only `SESSION_INVALIDATED`, so the `UNAUTHORIZED` reaches the caller unchanged.

On a light account the next critical action goes wrong in one of two ways:

- **Password-factor memo warm:** the mint answers `UNAUTHORIZED`, which
  `mintViaPasswordFactor` reads as a wrong password and re-prompts. The retry mint
  answers the same, retires the memo, and the user sees "Re-authentication failed".
- **Memo cold:** the status read also answers `UNAUTHORIZED`, so the factor is assumed.
  The mint's `UNAUTHORIZED` becomes the ORCID fallback, whose start request fails the
  same way and surfaces as a generic failure.

Neither path tells the user that their session has ended. Every other authenticated call
made with the expired token also fails with an unhelpful `UNAUTHORIZED`.

## Scope

1. Before `authenticatedRequest` sends a request, check the stored session's `expiresAt`
   against the client clock, the same comparison `_restoreSession` makes. If it has
   passed, do not send the request. End the session and tell the user it expired and
   that they need to sign in again, the way `handleRevokedSession` ends a revoked one
   (one teardown, one message, the reason still visible in the sign-in prompt if the
   store opens one). New copy goes through the project's i18n convention for added keys.
2. The error the caller then receives must not be mistaken for a wrong password, a
   retryable failure, or an ORCID fallback by any caller. In-flight fresh-auth flows
   (the session acquisition, both consent-op orchestrators, the upload surface) must
   unwind as a session teardown: no re-prompt, no "Re-authentication failed", and no
   ORCID round-trip.
3. Clock skew is accepted, not corrected. `expires_at` is the server's timestamp and
   the check reads the client clock. A fast clock ends the session early, which is
   harmless. A slow clock leaves a gap as long as the skew, in which the server rejects
   first and today's misreport still happens. State this in the comment next to the
   check. Anchoring the expiry to the client clock at login is out of scope unless it
   turns out to be trivial.
4. A proactive timer that signs the user out at the moment of expiry is out of scope.
   The check runs at request time.

## Acceptance criteria

1. With an expired `expiresAt`, an authenticated call sends no request, ends the
   session once, and shows the expiry message.
2. A password-mint flow started on an expired session resolves as a teardown: the user
   sees no second prompt and no re-authentication failure, and the password-factor memo
   is not retired because of the expiry.
3. A session that has not expired behaves exactly as before, including the existing
   `SESSION_INVALIDATED` handling.
4. Each of these is pinned by unit tests that fail if the check is removed, using the
   real auth store and fresh-auth modules where the existing suites already do.
5. Full frontend unit suite green; `npm run build` clean.

## Notes

The backend alternative (a distinct 401 code for an expired JWT, handled like
`SESSION_INVALIDATED`) was considered and not chosen. It would also cover a token the
server rejects for reasons other than expiry, and the skew gap, at the cost of a backend
change and an API-contract update.

## Implementation notes

**UI implementation signal (2026-10-05, commit `b9de6dcc`; verified ancestor of `main`):**

- The auth store gained `endSessionIfExpired(sentToken)`. Past `expiresAt`
  (client clock, through `isUnexpired`, the same comparison `_restoreSession`
  now uses) it ends the session and returns true, and the caller does not
  send. The api.js bearer helper throws a client-side `SESSION_EXPIRED`
  `ApiRequestError`. The signer.js custody broadcast makes the same check
  before its own fetch, because a session window can outlive the session.
- The ending goes through `_endSession`, now shared with
  `handleRevokedSession`: stale-token check, adoption of a newer live
  session another tab stored, teardown, and the sign-in prompt with the
  reason in it. The teardown is the new `handleSessionExpired` in
  `lib/fresh-auth.js`, through the same `tearDownSessionWithMessage` body
  (one toast, teardown claimed). New key `auth.sessionExpired`, stubbed in
  fifteen locales, with a STUBS.md sweep.
- The teardown runs synchronously before the rejection propagates, so every
  in-flight fresh-auth flow unwinds through its teardown guard. A warm
  password memo shows the one prompt (no request precedes it), then ends
  silently at the mint, which is never sent. A cold one ends at the status
  read with no prompt. No second prompt, no "Re-authentication failed", no
  ORCID round-trip.
- The clock-skew trade-off is stated at `endSessionIfExpired`, and the
  api.js check points there.

Decisions:

- **Memo clause in AC 2 (decided with the user).** Read as "the mint's
  second-consecutive-rejection eraser must not fire on an expiry". It
  cannot: no mint is sent. The disconnect scrub still clears the memo, as on
  every sign-out.
- **Custody broadcast (decided with the user).** Covered by the same check.
- **Adoption.** When storage holds a newer live session from another tab,
  it is adopted instead of torn down, and the expired request is still not
  sent. The request was built for the expired token, and the adopted
  session may belong to another account. The caller gets `SESSION_EXPIRED`
  for that one action. This needs a storage event still in flight, so it is
  rare.
- **Anchoring the expiry to the client clock at login.** Not done, because
  it is not trivial. It changes the persisted session shape, the restore,
  and what the cross-tab sync carries.

Not covered, by decision (same shape as the revoked-session precedent):

- Where the expired request is itself the guarded call (an open session
  window, a cached consent-op proof, a self-custody or plain authenticated
  call), the call site still gets the rejection and some sites show their
  own generic error next to the expiry message. `set_password` is one of
  these on the cold path too: its factor needs no status read, so the ORCID
  start is the expired request, and that helper passes a stale start's
  rejection back to its caller. Its inline error sits inside the
  `isConnected` template, which the teardown has already removed.
- The notification poll is an authenticated request, so a signed-in tab
  left idle ends its session at the first poll after expiry and opens the
  sign-in prompt. That follows from the request-time check. No timer was
  added.
- The custody-upgrade POST sends its own pinned token and is not covered. A
  verification pass found that an expired session can reach it after the
  irreversible `account_update`. That is recorded on
  `ui-upgrade-401-proof-budget-auth-failure-split`, with the client-side way
  to separate the expiry arm.

For the architect: no API shape changed, and `SESSION_EXPIRED` never goes
on the wire. If § 6.7 is reworded for the revoked-session handling, it could
also say that the SPA ends an expired session before sending rather than on
the server's 401.

Verification:

- New suite `tests/unit/session-expired.test.js`, 16 cases on the real auth
  store, api.js, signer.js and fresh-auth flows (session acquisition, both
  consent-op orchestrators, the upload surface, the custody broadcast). The
  fetch stub answers an expired bearer token the way `verifyHiveSignature`
  does (401 `UNAUTHORIZED`). Before the fix, 14 of 16 failed: requests went
  out, and the flows re-prompted or hung on a prompt.
- Nine mutants were each killed in a scratchpad copy: the api.js check, the
  signer.js check, adoption removed, sending after adoption, the `>` vs `>=`
  boundary in the check and in the restore, the revoked copy in the toast
  and in the notice, and the error code.
- Full frontend unit suite: 91 files, 2110 tests, exit 0. `npm run build`
  clean (run in an isolated copy).
- A verification workflow (two caller audits, spec conformance, teardown
  ordering, two skeptics per finding) left 0 findings standing, 4 refuted.
- No e2e run and no browser check: a real expired session needs a JWT past
  its 24-hour lifetime.

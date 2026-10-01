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

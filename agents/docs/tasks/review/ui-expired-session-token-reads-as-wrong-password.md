# An expired session token reads as a wrong password, and the user is never told to sign in

**Owner:** ui
**Created:** 2026-10-01
**Priority:** high

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

## Architect re-review (2026-10-05) — HELD PENDING FIXES:

Reviewed `b9de6dcc` with `/ce-code-review` (correctness, security, adversarial,
testing, project-standards, frontend races, learnings; one validator over the
merged set, both findings confirmed). Verified independently in an isolated
copy of `b9de6dcc`: full frontend unit suite 91 files / 2110 tests, exit 0;
`npm run build` exit 0. Scope 1, 3 and 4 and AC 1, 3, 4 and 5 are met.
Security, testing and project-standards returned no findings.

Triage decision (user, 2026-10-05): the "Not covered, by decision" carve-out
for call sites whose guarded call is itself the expired request is rejected on
the surfaces Scope 2 names: the upload surface, the custody broadcast wrapper,
and both consent-op orchestrators. Scope 2 says no caller may misread the
error, and it names the upload surface. On those surfaces, a `SESSION_EXPIRED`
whose teardown has already run must add nothing to the expiry message, the way
the paths that end at the status read or the mint already behave.

1. **Upload under an open window** (`lib/ipfs-upload.js`). When a session
   window is still cached as the JWT passes `expiresAt`, the pre-flight is
   refused client-side, `uploadFile`'s catch matches none of its branches and
   rethrows `SESSION_EXPIRED`, and `describeUploadError` maps it to
   `common.uploadFailed`. Publish then shows "Upload failed" and "Publishing
   failed" after the expiry toast; the editor shows its image-upload failure
   and does not abandon the queued images. Required: a `SESSION_EXPIRED` that
   arrives once this flight's guard reads torn down resolves to the
   already-reported code (`describeUploadError` returns `null`), in
   `uploadFile`'s catch and in `retryOnce`'s catch. Keep the `guard.tornDown()`
   condition. In the adoption branch `endSessionIfExpired` returns true with no
   teardown and no message, so that rejection must keep reporting. Adding
   `SESSION_EXPIRED` to `describeUploadError`'s `null` cases would silence it,
   so the fix does not go there.
   Measured by the architect in a copy of `b9de6dcc`: asserting
   `describeUploadError(err)` is `null` in the case "refuses an upload under an
   open window without retrying it" fails at `b9de6dcc` with "expected
   'common.uploadFailed' to be null", and passes with
   `if (err?.code === 'SESSION_EXPIRED' && guard.tornDown()) throw uploadError(UPLOAD_SESSION_TORN_DOWN);`
   placed just before `uploadFile`'s final `throw err;`. The `retryOnce` arm
   was not planted.

2. **Custody broadcast under an open window** (`lib/fresh-auth.js`,
   `broadcastWithFreshAuth`). Same state: `broadcastOps` tears the session
   down and throws `SESSION_EXPIRED`, the wrapper's catch has no branch for
   it, and the rejection reaches the caller, so `components/vote-buttons.js`
   toasts `vote.voteFailed` and publish sets "Publishing failed" next to the
   expiry message. On the retry leg the status-less error is wrapped as
   `FRESH_AUTH_RETRY_FAILED`. Required: once the guard reads torn down, a
   `SESSION_EXPIRED` on either leg returns `FRESH_AUTH_REDIRECT_PENDING`, the
   sentinel the wrapper already returns when a teardown abandons its
   acquisition. Same `guard.tornDown()` condition, for the same reason as
   item 1.
   Measured the same way: making the case "sends nothing under a window that
   outlived the session, and ends the session once" expect a `null` resolve
   fails at `b9de6dcc` and passes with
   `if (err?.code === 'SESSION_EXPIRED' && guard.tornDown()) return FRESH_AUTH_REDIRECT_PENDING;`
   placed first in the outer catch, ahead of its `FRESH_AUTH_REQUIRED` branch.
   With items 1 and 2 planted, `session-expired.test.js` and
   `session-revoked.test.js` pass (31 tests). The retry-leg arm was not
   planted.

3. **Consent-op guarded call** (`consentOpFreshAuthRetryGate` in
   `lib/fresh-auth.js`, serving `withSettingsFreshAuth` and
   `withAuthorshipFreshAuth`). When the proof in hand is spent after the
   session expired (a cached ORCID-factor proof, or one minted just before the
   instant), `run(proof)` meets the pre-send check and the session is torn
   down. The gate rethrows every error other than `FRESH_AUTH_REQUIRED`, on
   the first call and on its retry call, so the page's own failure lands next
   to the expiry message. Required: once the guard reads torn down, a
   `SESSION_EXPIRED` from `run` resolves to `{ cancelled: true }`, the outcome
   both orchestrators document for an action a teardown abandoned. Not
   planted; the shape is yours.

4. **Tests.** Pin the page-level outcome in the two open-window cases (the
   assertions measured under items 1 and 2), and add one case for item 3 on
   either orchestrator. Retry-leg cases are not required.

Scope limits:

- `SESSION_INVALIDATED` produces the same double message on the same surfaces.
  Whether it gets the same treatment is decided at the review of
  `ui-session-invalidated-global-handling`, which carries the same carve-out.
  Do not extend these items to it unless that review says so.
- The rest of the carve-out stands: plain authenticated calls and the
  self-custody `run(undefined)` path outside the named surfaces, the
  `set_password` cold ORCID start, and the idle-tab notification poll.

Dismissed:

- Refusing the expired request after adopting another tab's newer session,
  with no message (P3): kept as implemented. It needs a storage event still in
  flight, the docblock records the choice, and refusing is the conservative
  failure. The mint retry leg in that branch can still show "Re-authentication
  failed"; accepted for the same reason.
- A client clock fast by 24 hours or more signs every new session out at its
  first request: Scope 3 accepts skew.
- The test header's clause (c) names the revoked-session e2e spec, which is
  filed but not yet written. That satisfies clause (c). A note on
  `ui-revoked-session-e2e-real-path` asks it to update this suite's header too.

## Architect amendment (2026-10-05): hold items widened to SESSION_INVALIDATED

The review of `ui-session-invalidated-global-handling` (b3d52627, 7247ff5b)
settled the open scope limit above. The user rejected the carve-out for
`SESSION_INVALIDATED` on the same three surfaces, and its fix lands here,
together with the `SESSION_EXPIRED` one: same sites, same condition. Five
reviewers measured the revoked case at 7247ff5b, and the call sites are
unchanged at HEAD. When the guarded request itself meets the revoked token (an
open session window or a cached consent-op proof):

- Upload: `uploadFile` has no branch for the code, so `describeUploadError`
  maps it to `common.uploadFailed`. Publish adds an "Upload failed" toast and a
  "Publishing failed" card, which is the only lasting text once the revoked
  toast times out. Supplementary rows add their inline error. The editor adds
  its image-upload failure and does not abandon the queued images.
- Custody broadcast: `broadcastWithFreshAuth` rethrows the code untouched, so
  vote-buttons toasts `vote.voteFailed` or `vote.cancelFailed`, the comment
  composer shows `comments.postFailed`, and publish shows "Publishing failed".
- Consent-op gate: `consentOpFreshAuthRetryGate` rethrows it. Authorship ops on
  paper-detail toast `claims.claimFailed` and similar. On settings the inline
  error sits inside the `isConnected` template, so it is hidden while signed
  out; a reading not probed is that it reappears when the user signs back in
  through the in-place prompt.

No surface retries, re-mints or re-prompts on this code. That part is correct
and stays.

Amended items:

1-3. Each item's `SESSION_EXPIRED` condition becomes `SESSION_EXPIRED` or
   `SESSION_INVALIDATED`, with the same `guard.tornDown()` condition and the
   same outcome (`UPLOAD_SESSION_TORN_DOWN`, `FRESH_AUTH_REDIRECT_PENDING`,
   `{ cancelled: true }`). The `guard.tornDown()` condition matters for the
   revoked code too: when another tab has already saved a newer session, the
   auth store takes it up instead of tearing down, so the rejection arrives
   with no teardown and no message and must keep reporting. The fix therefore
   does not go into `describeUploadError`'s `null` cases for this code either.
4. Tests: add one `SESSION_INVALIDATED` case per surface (upload, custody
   broadcast, one consent-op orchestrator). Drive each with a 401
   `SESSION_INVALIDATED` fetch response the way `session-revoked.test.js` does,
   and assert that the page-level outcome adds nothing to the revoked-session
   message. Retry-leg cases are still not required.

The scope limits' remaining carve-outs stand for both codes: plain
authenticated calls outside the named surfaces, the self-custody
`run(undefined)` path, the `set_password` cold ORCID start, and the idle-tab
notification poll.

**UI re-review signal (2026-10-05, commit `5dc0772b`; verified ancestor of `main`):**

Items 1-4, as amended to both codes, landed in one commit. One shared helper,
`unwindIfSessionEnded(err, guard)` in `lib/fresh-auth.js` (next to
`isUsernameMismatch`), matches `SESSION_EXPIRED` or `SESSION_INVALIDATED`
only when the guard reads torn down. Each surface calls it on both legs:

- Upload: `uploadFile`'s catch (right after the mismatch branch) and
  `retryOnce`'s catch throw `UPLOAD_SESSION_TORN_DOWN`.
  `describeUploadError` is unchanged.
- Custody broadcast: `broadcastWithFreshAuth`'s outer catch, ahead of the
  `FRESH_AUTH_REQUIRED` branch, and the retry leg's catch, ahead of the
  mismatch check and the wrap, return `FRESH_AUTH_REDIRECT_PENDING`.
- Consent-op gate: `consentOpFreshAuthRetryGate` returns `{ cancelled: true }`
  on entry, ahead of its non-FRESH_AUTH_REQUIRED rethrow, and in the retry
  `run`'s catch.

One addition to the literal hold form, for the architect to accept or
reject: the helper calls `guard.cancel()` before returning true. Where the
ending spoke (expiry or revoked teardown), the teardown claim makes that call
silent. It speaks when the guard reads torn down without a message, which
happens when the auth store adopts ANOTHER account's stored session at
`_endSession` (the subject scrub runs, nothing is said). Under the literal
form the null code would then be silent with no message at all. A same-account
adoption runs no scrub, so the guard condition keeps reporting the rejection
there, as the hold requires.

Comments narrowed where the change made them false: the gate docblock's
"rethrow untouched" sentence, the cached-proof drop comment in
`getCachedConsentOpProof`'s docblock, the two orchestrators' catch comments,
`UPLOAD_SESSION_TORN_DOWN`'s "re-login toast" parenthetical, and
`retryOnce`'s "Only a mismatch is reclassified".

Tests:

- `session-expired.test.js`: the two open-window cases now assert the
  page-level outcome (`describeUploadError(err)` null, broadcast resolves
  `null`). New: a settings action whose cached ORCID proof outlived the
  session resolves `{ cancelled: true }`. New: same-account adoption under
  the upload still describes `common.uploadFailed` with no toast. New:
  another-account adoption under the upload is null-coded with the one
  session-changed toast.
- `session-revoked.test.js`: the broadcast case now expects a `null`
  resolve. New: an upload under an open window is null-coded with only the
  revoked toast. New: a settings action with a cached proof resolves
  `{ cancelled: true }` with only the revoked toast. Each drives a 401
  `SESSION_INVALIDATED` fetch response. The existing "keeps a session whose
  token was replaced while the broadcast was in flight" case still expects
  the rejection, which pins the guard condition on the broadcast.
- `lib-ipfs-upload.test.js`: the mocked `fresh-auth.js` factory pulls the
  real `unwindIfSessionEnded`.
- Retry legs are implemented but not pinned (not required).

Verification:

- Red before the fix: 7 of the new or changed cases failed. The rejection
  reached the caller, and `describeUploadError` gave `common.uploadFailed`.
- Seven mutants, each killed in a scratchpad copy: the guard condition
  dropped, `guard.cancel()` dropped, each code dropped from the list, and
  the gate's, the broadcast's and the upload's call sites removed.
- Full frontend unit suite: 91 files, 2140 tests, exit 0. One earlier run hit
  the known absolute-cap flake in `lib-fresh-auth-session-window`, which
  passed 3 of 3 runs alone and on the full rerun. `npm run build` was clean,
  run in an isolated copy. `frontend/` has no lint config.
- A `ce-simplify-code` pass (reuse, quality, efficiency) applied 5 findings:
  the orchestrator comment overclaim, two test tidy-ups, and two ordering
  moves. It skipped 3: exporting the code constants from `api.js` (outside
  the diff's files), a shared `pickedFile` fixture, and folding the two upload
  checks into one.
- No `/ce-code-review`, per the UI agent rule. No e2e run.

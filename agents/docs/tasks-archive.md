## Handle a server-revoked session (401 SESSION_INVALIDATED) in the SPA (archived 2026-10-05) — revoked-surface fixes moved to the expired-session hold; § 6.7 and contracts corrected; four items dismissed

### Architect archive note (2026-10-05)

Review of b3d52627 and 7247ff5b with /ce-code-review (full: correctness, security,
adversarial in-process, testing, project-standards, julik-frontend-races, learnings).
Reviewers read git-show snapshots at 7247ff5b, because b9de6dcc and 8594733d later
reshaped api.js, auth.js, lib/fresh-auth.js and signer.js (handleRevokedSession now
ends the session through _endSession). No P0 or P1. Scope 1-5 and AC 1, 2, 4, 5, 6
met. AC 4 holds on the upload surface, the custody broadcast and the consent-op gate:
every gate keys on the error code, so nothing re-mints, retries or re-prompts. Full
unit suite at 7247ff5b in an isolated copy: 88 files, 1995 tests, exit 0; npm run
build exit 0.

Triage (user approved as recommended):
- Carve-out rejected: the generic error SESSION_INVALIDATED adds next to the revoked
  message on the upload surface, broadcastWithFreshAuth's callers and the consent-op
  gate gets the SESSION_EXPIRED treatment. Landed as an amendment widening hold items
  1-4 of `ui-expired-session-token-reads-as-wrong-password` to both codes (same
  guard.tornDown() condition), not as a hold here.
- AC 6 doc side landed: ARCHITECTURE.md § 6.7 and the common.md SESSION_INVALIDATED
  row now say the SPA signs the user out in place and opens the sign-in prompt;
  custody.md says other devices are signed out and same-browser tabs take up the
  reissued token.
- Narrowed implementer claim: "a cold light-account acquisition ends silently instead
  of asking for a password" holds only while the tab's password-factor memo is empty.
  With it set, the re-auth password prompt opens before any request, the mint meets
  the revoked token, then one teardown and a null result, no retry. Not a credential
  exposure. No change.
- Dismissed: no test on the real sign-in modal's notice set/reset (P2, validator
  confirmed a surviving mutant; works today); on the adoption branch the call site's
  generic error is the only message (P3, same as the expired-session dismissal);
  stale "You were signed out" notice in a tab after signing in from another tab;
  adoption-path polling-restart mutant (no consequence); warm-memo test case.
- Deferred again: /ce-compound-refresh of
  solutions/conventions/guard-report-dedupes-per-event-not-per-holder-2026-09-02.md
  (deferred at the session-inconsistency archive until this review). Run it once the
  expired-session hold lands, since that hold adds the call-site quieting for both
  codes.

### Task file

**Owner:** ui
**Created:** 2026-09-02

## Why

The backend revokes every previously issued bearer JWT whenever an account's
credentials rotate. Four routes do it today: `POST /api/auth/reset`, both
recovery phases in `routes/recover.ts`, and `POST /api/custody/upgrade`. Each
stamps `accounts.sessions_invalidated_at`, and `verifyHiveSignature` then
refuses any bearer token minted at or before that instant with
`401 SESSION_INVALIDATED`.

Nothing in the SPA handles that code. A search of `frontend/src` and
`frontend/tests` returns zero references to `SESSION_INVALIDATED`. The core
`request` helper in `api.js` throws an `ApiRequestError` carrying the server's
error code and leaves interpretation to each call site, and no call site
recognizes this one. There is no central place that clears a session the server
has already destroyed.

Same-browser tabs are NOT the gap. The auth store's storage-event handler keys
on the session localStorage entry, so a rotation performed in one tab
propagates its reissued token to the other tabs of that browser, and a cleared
entry disconnects them. What has no path is a session on **another browser or
another device**: it holds a token the server has revoked, learns nothing until
its next authenticated request, and then receives an error code no handler
recognizes. The user sees whatever that particular call site does with an
unexpected code, while the stored session stays on disk and continues to look
valid to `_restoreSession` until its own `expiresAt` passes.

This is pre-existing and general to all four writers rather than fallout of any
one of them. A password reset already strands other devices this way today. It
is filed now because the custody upgrade made it materially more reachable: the
upgrade is a deliberate in-app action a user takes while plausibly signed in
elsewhere, and it revokes on success rather than on a forgotten-password detour.

`ARCHITECTURE.md` § 6.7 currently asserts the behavior as if it existed: "the
SPA treats it as session expiry and redirects to login". That sentence is not
implemented. Resolving this task means either making it true or correcting it.
`ARCHITECTURE.md` is architect-owned, so do not edit it. Say which way it went
and the architect will land the doc side.

## Scope

1. Recognize `SESSION_INVALIDATED` centrally rather than per call site. The
   natural seam is the shared `request` helper in `api.js` or a thin wrapper
   around it, so every authenticated route inherits the behavior instead of each
   caller opting in.
2. On that code, clear the stored session through the auth store's existing
   disconnect path rather than a bespoke scrub. That path already exists for
   explicit sign-out and already scrubs subject-bound state; reusing it keeps
   the revoked-session teardown from drifting away from the sign-out teardown.
   Confirm it also clears the session localStorage entry, so the storage event
   propagates the sign-out to sibling tabs for free.
3. Decide and implement what the user sees. A silent redirect to an anonymous
   view is not obviously right: the user did not sign out, and telling them
   nothing invites a bug report. Prefer surfacing that the session ended because
   the account's credentials changed elsewhere, then routing to sign-in.
4. Do not treat this as retriable. It is terminal for the held token, unlike the
   `503` retry path the SPA already distinguishes. Make sure the handling cannot
   be reached by the fresh-auth retry gate, which re-mints proofs on some 401s.
   A revoked bearer token is not remintable and must not be retried into a loop.
5. Check the interaction with the pending session-teardown work in flight on the
   ui track. If a shared teardown helper is emerging there, route this through
   it rather than adding a second teardown surface.

## Acceptance criteria

1. An authenticated request answered with `401 SESSION_INVALIDATED` clears the
   stored session and routes the user to sign-in, from any page, without the
   call site needing its own handler.
2. The stored session entry is gone afterward, so a reload does not restore a
   session the server has already revoked.
3. The user is told the session ended because the account's credentials changed,
   not shown a bare error or a silent anonymous page.
4. The fresh-auth retry gate does not re-mint or retry against this code. A test
   pins that a revoked bearer token produces one teardown and no retry loop.
5. A test drives the real code path rather than asserting on a hand-built error
   object, so a future change to how `request` surfaces error codes fails it.
6. State in the task whether § 6.7's "redirects to login" sentence is now true or
   still needs correcting, for the architect to land.

## Notes

Do not chase the same-browser multi-tab case as if it were broken; verify the
storage-event path still covers it and leave it alone.

The four writers are named here as context for why the code exists, not as a
list to enumerate in code. Anchor any comment on the behavior (a revoked bearer
token tears the session down) rather than on the roster of routes that can cause
it, which will grow.

## Implementation notes

**UI implementation signal (2026-09-30, commits `b3d52627`, `7247ff5b`; both verified ancestors of `main`):**

- `b3d52627` lands the central handling: the api.js bearer helper and the
  custody broadcast in signer.js report `401 SESSION_INVALIDATED` to the auth
  store's `handleRevokedSession`, which reuses `disconnect()` and the shared
  fresh-auth teardown (`handleSessionRevoked`, a sibling of
  `handleSessionInconsistency` over one shared body). New key
  `auth.sessionRevoked`, stubbed in fifteen locales.
- `7247ff5b` lands three items from the user's triage of a pre-handoff review:
  the sign-in modal shows the reason while it is open, the copy no longer
  names a cause, and a different unexpired session found in storage is adopted
  instead of torn down.

Decisions the task left open:

- **Where the user lands (scope 3, criterion 1).** Decided with the user: the
  SPA does not navigate. It signs out, shows the message, and opens the
  existing sign-in modal on the current page. `/login` has no extension path
  and no return path, and a route change destroys review and comment text,
  attached files, and the key-upgrade retry state.
- **§ 6.7 (criterion 6).** "Redirects to login" is still not literally true
  and needs correcting, in `ARCHITECTURE.md` § 6.7 and in the
  `SESSION_INVALIDATED` row of `api-contracts/common.md`: the SPA signs the
  user out, says the account's sign-in details changed, and opens the sign-in
  prompt in place. `api-contracts/custody.md` says other tabs are signed out
  after an upgrade; same-browser tabs adopt the reissued token instead.
- **Stale token.** The store acts only when the rejected token is still its
  own, so a late rejection of an old token cannot sign out a reissued session.
- **Retry gate (scope 4, criterion 4).** No gate matched this code before and
  none does now. With the teardown running before the rejection propagates, a
  cold light-account acquisition ends silently instead of asking for a
  password on a dead session. Pinned in `session-revoked.test.js`.
- **Shared teardown (scope 5).** Routed through the helper the
  session-inconsistency task reshaped. If that task is held and the helper
  moves, `handleSessionRevoked` moves with it.
- **Same-browser tabs.** Left alone; `disconnect()` removes the stored entry,
  so the storage event signs sibling tabs out.

Not covered, by decision:

- The upgrade POST in `pages/settings.js` is not hooked. It sends a pinned
  token and belongs to `ui-upgrade-401-proof-budget-auth-failure-split`, which
  now carries a note on the remaining race.
- Call sites still receive the rejection, so some show their own generic error
  next to the central message.

Follow-ups filed from the triage: `ui-sign-in-modal-has-no-orcid-path`,
`ui-recover-and-reset-leave-a-revoked-session-signed-in`,
`ui-revoked-session-e2e-real-path`.

Verification: full frontend unit suite green at `7247ff5b` (88 files, 1995
tests, exit 0). Not checked in a browser and no e2e run.

**Architect note (2026-10-05), for this task's review:** the review of
`ui-expired-session-token-reads-as-wrong-password` rejected the "call sites
still show their own generic error next to the central message" carve-out for
`SESSION_EXPIRED` on the upload surface, the custody broadcast wrapper and the
consent-op retry gate, and held that task for it. This task carries the same
carve-out for `SESSION_INVALIDATED` on the same surfaces. Decide at review
whether the revoked rejection gets the same treatment.

## Decide whether a second concurrent session-inconsistency detection should speak (archived 2026-10-05) — clean review at 790eee0e; silent-sign-out message accepted; implementer's successor-teardown item already filed

### Architect archive note (2026-10-05)

Review of 790eee0e with /ce-code-review (full: correctness, project-standards,
testing, adversarial in-process, julik-frontend-races, learnings). Reviewers read
git-show snapshots at 790eee0e, because five later sibling commits (590d211a,
b3d52627, 7247ff5b, 8594733d, b9de6dcc) had reshaped fresh-auth.js, moving the handler
body into tearDownSessionWithMessage. No finding at the reporting threshold. All four
ACs met. Full unit suite at 790eee0e re-run in an isolated copy: 87 files, 1980 tests,
exit 0. Mutation probes in isolated copies: dropping the isConnected gate fails 3 pins;
a bare return in the disconnected branch fails the silent-sign-out pin; claiming
before disconnect fails 4 tests. The project-standards pass was shallow (it did not
open the cited convention docs).

Triage (user approved as recommended):
- Accepted, no change: a mismatch after a silent sign-out shows the session-changed
  message instead of the re-login message (unrequested behavior rule; reasoned in the
  docblock and pinned).
- Folded into `ui-fresh-auth-and-upload-comments-that-overclaim` (item 4, new bullet):
  the `UPLOAD_SESSION_TORN_DOWN` comment in lib/ipfs-upload.js names only the re-login
  toast (correctness + adversarial, still present at HEAD). The matching
  broadcastWithFreshAuth "runs the same scrub again" sentence was already gone at HEAD.
- Implementer's "For architect triage" item (mismatch arms do not consult their
  teardown guard, so a session established mid-flight is torn down): already filed as
  `ui-upload-mismatch-teardown-after-subject-change`, which covers the upload leg and
  asks for a check of the broadcast and consent-op arms. Not worsened by this diff
  (adversarial S3 probe).
- Dismissed: no upload-plus-broadcast cross-surface pin (same handler, probe correct
  today); AC3 fixture flips unobserved in the settings and authorship suites; the gate's
  dependency on disconnect() being the sole isConnected=false writer (holds at HEAD).
- Deferred: /ce-compound-refresh of
  solutions/conventions/guard-report-dedupes-per-event-not-per-holder-2026-09-02.md,
  whose code sample predates the liveness gate and reportTeardownOnce. Run it after
  `ui-session-invalidated-global-handling` is reviewed, since that task reshaped the
  same handler.

### Task file

**Owner:** ui
**Created:** 2026-09-02

Routed out of the architect round-3 review of `ui-consent-op-teardown-guard`
(`69686a16`). Not held there: three reviewers raised it independently and the adversarial
pass reproduced it, but the validator established the behaviour as pre-existing and
unaffected by that commit, and the obvious fix carries a behaviour decision the round-3
hold should not absorb.

## Why

`handleSessionInconsistency()` in `lib/fresh-auth.js` disconnects the auth store, claims
the teardown report, and toasts. The disconnect and the claim now sit inside an
`if (auth)` branch, so the claim is only stamped when there was a real teardown to claim,
but nothing gates the sequence against a SECOND caller detecting the same fault. It is

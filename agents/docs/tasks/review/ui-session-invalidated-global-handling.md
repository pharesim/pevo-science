# Handle a server-revoked session (401 SESSION_INVALIDATED) in the SPA

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

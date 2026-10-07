# The ORCID callback caches a departed account's proof, and the new account's next action signs it out

**Owner:** ui
**Created:** 2026-10-07
**Priority:** normal

The UI agent filed this at the user's request. It came out of the verification sweep on the upload
mismatch-after-subject-change task, which was in review when this was filed. A verifier probe
reproduced it on the broadcast, upload and consent-op surfaces.

## Why

`_verify` in `pages/orcid-callback.js` awaits `completeOrcid(code, state, mode)`. In the
`session_auth` and `fresh_auth` modes, `completeOrcid` sends an authenticated request.
`authenticatedRequest` reads the JWT synchronously when it is called, so the request carries the
account that started the round-trip, X. The backend's `/orcid/callback` refuses any caller other
than the username stored at `/start`. It then mints the proof for that stored username: a session
window in `handleSessionAuth`, or a target-bound consent-op proof in `handleFreshAuth`.

That round-trip is a real network wait, so a sign-in as another account, Y, in another tab can
land during it. The storage event runs the subject scrub. The scrub clears both proof slots, bumps
the teardown generation and removes the return path, then the store adopts Y and sets the
tab-subject marker to Y. Nothing navigates, so the callback page stays mounted.

`_verify` then resumes. It checks only `this._mounted`, which a subject change does not touch.
`_handleSessionAuth` and `_handleFreshAuth` then call `cacheSessionProof` and `cacheConsentOpProof`
with X's proof, filling the slots the scrub just emptied. Neither slot records a username. Nothing
scrubs them again, because the tab marker already reads Y.

Y's next broadcast or upload in that tab gets X's window from the cache. The backend answers 403
`username_mismatch`. The action's teardown guard opened after the scrub, so it reads not-torn-down,
and the mismatch arm calls `handleSessionInconsistency()`: `broadcastWithFreshAuth` for a broadcast,
`mismatchError` in `lib/ipfs-upload.js` for an upload. Y is signed out in every tab with "Session
inconsistency detected". The consent-op leg (`consentOpFreshAuthRetryGate`) does the same for Y's
next op on the target X's proof is bound to.

The fix does not belong in the mismatch arms. Each one reads a guard that correctly reports that
nothing changed during its own action. The fix is to keep the departed account's proof out of the
successor's slot.

## Scope

1. `_verify` opens a `subjectTeardownGuard()` before `await completeOrcid(...)`. When the guard
   reads torn-down after the await, the `session_auth` and `fresh_auth` modes write no proof to
   either cache and show no re-auth success toast. The teardown is reported once, through
   `guard.cancel()`.
2. Check the other modes against the same sequence before changing them. Do not change them on
   symmetry alone. `signup` and `login` are unauthenticated. `accredit` re-reads accreditation for
   whoever the store now holds. `link` sets `pevo_orcid_link_complete` and navigates to settings,
   which may then show a link success to Y. Record what you find, and change only what the sequence
   actually breaks.
3. Keep the 503-refresh-retry behaviour around `pevo_orcid_mode` intact.
4. Make the comments that describe these handlers match the new behaviour. No line numbers, task
   slugs or round ordinals.

## Acceptance criteria

1. A cross-tab sign-in as another account that lands while `completeOrcid` is pending leaves both
   proof caches empty. The new account's next broadcast, upload and consent op each acquire their
   own proof instead of meeting `username_mismatch`.
2. The user sees one message for the subject change and no re-auth success toast.
3. Without a subject change, the `session_auth` and `fresh_auth` flows behave exactly as before:
   cache write, success toast, navigation to the return path.
4. Unit tests pin this and fail if the guard check is removed. Drive the subject change through the
   real auth store's storage-event handler, as `pages-publish-batch-teardown.test.js` does.
5. The full frontend unit suite is green and `npm run build` is clean.

## Notes

- After a torn-down callback, the implementer chooses the page state: an error with a retry link,
  or a navigation home. Either way it must not say the re-auth succeeded.
- `handleSessionInconsistency`'s docblock calls a mismatch a corrupted session "which no re-auth can
  fix". Until this task lands, this sequence is a counterexample: the session is not corrupted, and
  dropping the stale window would fix it. Re-check that docblock once the fix is in.

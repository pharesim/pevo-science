# Stop an auth-layer 401 from spending the custody-upgrade proof budget

**Owner:** ui
**Created:** 2026-09-06
**Priority:** normal

Routed out of the architect review of the custody-upgrade subject-pin work. Pre-existing;
surfaced there because that task added a third entry point into the same retry.

## Why

`_handlePostBroadcastError` in `pages/settings.js` classifies the post-broadcast failure ladder by
HTTP status alone:

```
if (broadcastLanded && status === 401) {
  this._proofRetryAttempts += 1;
```

Every 401 is read as a rejected upgrade proof. The second one exhausts
`UPGRADE_PROOF_RETRY_BUDGET`, runs `_clearSensitiveUpgradeState()`, and routes to terminal
`partialApplyFailed`.

But `POST /api/custody/upgrade` returns 401 for two unrelated classes. The proof arms are the
ones the budget exists for: an expired or invalid `signed_at`, a signature that does not recover,
a `derived_pubkey` absent from the on-chain key set. The auth arms are not: `verifyHiveSignature`
returns `SESSION_INVALIDATED` for a revoked session, and the route itself returns
`UNAUTHORIZED` for a missing bearer and again for an account row it can no longer read
("Session is no longer valid").

So a user whose session dies while the error screen idles, then presses Try Again twice, loses the
mnemonic. That mnemonic is the only key to an account whose on-chain owner, active, posting and
memo authorities have already rotated and whose backend row still holds keys derived from the old
seed, because the cleanup POST never ran. The proof was never the problem, and the budget that
protects against a genuinely broken proof spent itself on a dead session instead.

The window is real: the error screen has no timeout, `retryUpgradeBackend` is reachable from
three sub-cases now, and the newly retryable before-cleanup sub-case explicitly asks the user to
sign back in and press Try Again, which is exactly the sequence that runs a stale bearer into
this branch.

## Scope

1. In `_handlePostBroadcastError`, split the 401 branch. When the error is an auth failure rather
   than a proof rejection, do not increment `_proofRetryAttempts` and do not wipe. Route it to
   `_endUpgradeAsSessionChanged({ cleanupLanded: false, upgradeSubject })`, which is the truthful
   description of that state and is now retryable, so the user re-authenticates and the next Try
   Again runs the cleanup.

2. `err.code` is already captured on the thrown error, so `SESSION_INVALIDATED` is separable with
   no backend change. Land that half now.

3. The remaining auth arms are not separable today: the route's own missing-bearer and
   stale-row 401s share the bare `UNAUTHORIZED` code with all five proof arms. Completing the
   split needs the backend to give the proof arms their own error code. That is a backend change
   and is NOT in this task's scope. File it as a backend task, or note here that it is wanted, and
   treat this task as landing the separable half plus the seam the backend half plugs into.

## Acceptance criteria

1. A post-broadcast 401 carrying `SESSION_INVALIDATED` leaves `_proofRetryAttempts` unchanged,
   leaves `newSeedPhrase` and `_upgradeSubject` intact, and lands in the before-cleanup
   session-changed sub-case with Try Again available.
2. Two consecutive `SESSION_INVALIDATED` 401s still leave the seed intact. This is the case that
   destroys it today.
3. A genuine proof rejection still increments the budget and still wipes on the second one, so
   the protection the budget exists for is unchanged.
4. Whatever the backend cannot yet distinguish is named in a comment at the branch, anchored on
   the error codes rather than on line numbers, so the seam is obvious when the backend half lands.

## Notes

Do not widen `_upgradeSubjectDiverged` for this. Its two landing call sites should keep accepting a
server-refreshed session; the change belongs in the error ladder, not the divergence predicate.

The reviewer that found this proposed a liveness check on the store's session before the retry
signs, as an independent second fix. That is defensible but it is a different change with its own
staleness question, so it is not part of this task's scope.

## Note from the revoked-session teardown work (2026-09-30)

The auth store now has `handleRevokedSession(sentToken)`, called by the api.js
bearer helper and the custody broadcast on `401 SESSION_INVALIDATED`. It tears
the session down when the rejected token is still the store's token, after
first adopting a different unexpired session found in storage. The upgrade
POST (`_postUpgradeBackend`) was deliberately left unhooked for this task to
decide.

One interaction to cover here. The upgrade route revokes the old token a
moment before it answers. A bearer request answered in that gap (the
notification or authorship poll in the upgrading tab, or any request in a
sibling tab before the upgrading tab has saved the reissued session) now tears
the session down, where before it was inert. When the upgrade response then
lands, `_upgradeSubjectDiverged` is true, the reissued token is dropped and the
flow ends as session-changed-after-cleanup. The window is tens of milliseconds
and the user recovers by signing in again, but it lands at the irreversible
step. A "rotation in flight" marker set around the upgrade POST in both legs,
which `handleRevokedSession` defers to, would close the same-tab case. The
sibling-tab case would need that marker visible across tabs.

## Note from the expired-session work (2026-10-05)

The auth store now has `endSessionIfExpired(sentToken)`. The api.js bearer
helper and the custody broadcast call it before sending: past the session's
`expiresAt` (client clock) it ends the session through the same path as
`handleRevokedSession` (stale-token check, adoption of a newer stored session,
teardown, sign-in offer) and the request is not sent. The upgrade flow does
not go through either sender, so it is not covered.

A verification pass traced that gap. Nothing on the upgrade path makes an
authenticated request through api.js: the old-phrase check and the proof
signing are local, `account_update` goes to the Hive node through dhive, and
`_postUpgradeBackend` / `retryUpgradeBackend` send a raw fetch with the pinned
token. A session that expired after the page mounted is caught only by the
notification poll or by some other authenticated action. Inside that window
the irreversible `account_update` lands, and the POST's 401 for the expired JWT
is the bare `UNAUTHORIZED` this task cannot yet separate from the proof arms,
so two Try Agains spend the budget and wipe the seed.

The expiry arm is separable on the client now, with no backend change. Calling
`Alpine.store('auth').endSessionIfExpired(upgradeToken)` before the
upgrade POST in both legs can route an expired session to the before-cleanup
session-changed sub-case without spending the budget. The same check before the
`account_update` broadcast would stop the irreversible step from starting on a
session that cannot complete it. Both are for this task to decide; the
staleness question the reviewer note raises applies to the second one.

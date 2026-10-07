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

## UI implementation signal (2026-10-07, commits 2b8e15ea, fb337fec, 1d4b9440, 07a4dff6)

Landed in `2b8e15ea` (`ui(settings): a dead session no longer spends the key-upgrade proof
budget`) and `fb337fec` (`ui(settings): narrow the upgrade comments the expiry check made
false`), both verified ancestors of `main`. Files: `frontend/src/pages/settings.js`,
`frontend/src/auth.js` (the `handleRevokedSession` and `endSessionIfExpired` docblocks), the 16
locale files and `frontend/public/messages/STUBS.md` (translator notes only), comment fixes in
`pages-settings.test.js`, `pages-settings-custody-upgrade-round2.test.js` and
`pages-settings-custody-upgrade-subject-pin.test.js`, and the new suite
`frontend/tests/unit/pages-settings-custody-upgrade-auth-failure.test.js` (13 tests, real auth
store via `initAuth`). `1d4b9440` files a follow-up; `07a4dff6` is the learnings refresh.

What landed against Scope and the ACs:
1. Scope 1-2, AC1-3. `_handlePostBroadcastError` routes a post-broadcast `SESSION_INVALIDATED`
   (and `SESSION_EXPIRED`, below) to `_endUpgradeAsSessionChanged({ cleanupLanded: false,
   upgradeSubject })` ahead of the 401 branch: `_proofRetryAttempts` unchanged, seed and
   `_upgradeSubject` kept, Try Again available. Two in a row keep the seed. A genuine proof
   rejection still counts and still wipes on the second, including with a revoked session
   between the two.
2. AC4. The seam comment at the 401 branch names, by error code, what still answers
   `UNAUTHORIZED` and spends the budget: a bearer the server cannot verify (an expired one
   included) and an account row the route can no longer read. It says the branch should
   match the proof rejections' own code once there is one.
3. Scope 3, the backend half, noted here and not filed (user decision 2026-10-06): wanted is a
   distinct error code for the five proof-rejection arms of `POST /api/custody/upgrade`, so
   the ladder can count only those. Until then the missing-bearer, unverifiable-JWT
   (including expiry the client misses through clock skew) and stale-row `UNAUTHORIZED`
   answers still spend the budget.

Decisions on the two appended notes, asked and approved by the user before implementation
(2026-10-06):
- Expiry (2026-10-05 note): checked before the cleanup POST in both legs, not before
  `account_update`. `_postUpgradeBackend` calls `endSessionIfExpired(upgradeToken)` only while
  `auth.token === upgradeToken`, and when that reports expiry it throws `SESSION_EXPIRED`
  without sending. The gate exists because the store compares its own `expiresAt`: a
  signed-out store has none and reads as expired, which in the ungated first draft stopped
  the POST on an ordinary sign-out. Verification caught it before commit.
- Teardown (2026-09-30 note): the upgrade POST reports `401 SESSION_INVALIDATED` to
  `handleRevokedSession(upgradeToken)`, so the store ends the session and opens the sign-in
  prompt in place, like the api.js helper and the custody broadcast.
- Rotation-in-flight marker (2026-09-30 note): not built; the user chose to leave it out.
  Candidate follow-up: the window is tens of milliseconds, and the outcome is a completed
  upgrade that costs a sign-in plus a manual Keychain import, not a lost seed.

Additions from verification triage, each approved by the user:
- While any `retryable-backend-only` retry waits (`upgradeRetryAwaitsSignIn`), the signed-out
  settings body renders `upgradeError`. Its Sign In then calls `signInFromSignedOutBody()`,
  which opens the in-place sign-in prompt (`auth.connect()`, failure toast
  `common.connectionFailed`) instead of `navigate('/login')`, which would unmount the page and
  let `destroy()` clear the seed and the pin. With no retry waiting, it still goes to /login.
- `upgrade.sessionChangedBeforeCleanup` is reworded to hold on every route into it. It was
  never translated, so it is reworded in place in all 16 locale files with no new STUBS.md
  entry, and the key's translator notes are narrowed to match.

Verification: three adversarial workflow rounds (four lenses, then three, then two, each
finding challenged by a refuter, probes run in scratchpad copies only). The user triaged each
round. Dismissed with reasons: a keyboard-activated second sign-in prompt over the
auto-offered one (the header Sign in does the same; cosmetic), and the copy-contract test not
telling the old copy from the new (preemptive hardening).

Accepted residuals, no action:
- A client clock running behind the server, or a same-account session that replaced the
  pinned one while the pinned token expired, still lets an expired bearer reach the bare 401.
- ORCID-only light accounts cannot sign back in on the page; the copy's support fallback
  covers them.
- A Keychain re-login mints custody `self`, which hides the upgrade section.
- The sign-in prompt's own links ("Go to the sign-in page", Forgot password, Sign up) still
  navigate away.
- In the rare route where this tab is already signed in again as the pinned account, the copy
  names the header Sign in, which is not rendered; Try Again works directly.

For the architect: `agents/docs/api-contracts/custody.md` lists `NOT_FOUND` (account not
found) for `POST /api/custody/upgrade`. The route answers a missing account row with `401
UNAUTHORIZED` ("Session is no longer valid"; its own comment says "401, not 404"), which is
one of the auth arms the seam comment names. This is outside the ui zone.

Follow-up filed: `ui-upgrade-done-screen-hidden-by-custody-flip.md` (`1d4b9440`). It is
pre-existing: both success landings set custody to 'self' before the Keychain import loop, so
the `x-if="isLight"` section with the done panel and the import warnings never renders.

Tests: the frontend unit suite passes, 97 files and 2275 tests, exit 0. The 8 suites the
round-3 comment edits touch pass (252 tests), as does `tests/unit/eslint`. Mutation probes:
each new behavior is killed by its own test (the pinned-token gate, reporting the pinned
token, the widened getter, the failure toast, the template wiring). The pre-change source
fails 7 of the original 8. A real-Alpine binding probe, kept in a scratchpad and not
committed, confirmed: the signed-out body shows the message, its Sign In opens the prompt
with no navigation, and a re-login then Try Again posts with the new token and reaches
'done'. No browser or E2E run: reaching the path needs a real on-chain `account_update`.

Learnings checkpoint: ran `/ce-compound-refresh` scoped to
`subject-divergence-guard-earns-its-place-only-where-the-flow-acts-unpinned-2026-09-03.md`
and `alpine-review-scope-global-chrome-and-x-if-teardown-boundary-2026-09-08.md` (both
Update, `07a4dff6`). The first now carries the gated expiry check as a new instance of its
rule. No new entry: an absent stub method masking the new store calls in sibling suites is
the same genus as `optional-predicate-gate-needs-live-false-case-not-just-absent-2026-09-02.md`.

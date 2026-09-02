# Thread the persisted upgrade subject through the custody-upgrade helpers

**Owner:** ui
**Created:** 2026-09-02
**Sequence after:** ui-custody-upgrade-subject-pin (depends on the persisted upgrade
subject that task's hold introduces)

Routed out of the architect review of the custody-upgrade subject pin. Pre-existing
code, surfaced by four reviewers; kept out of that task's hold because the pin's own
scope is the final `loginFromResponse` landing.

## Why

The subject pin protects only the landing. Every other step of the upgrade flow reads
the live auth store across its own awaits: `_performUpgradeKeyRotation` derives both
key sets and builds the `account_update` op from the store username;
`_signUpgradeProof` derives the new active key and builds the challenge from it;
`_postUpgradeBackend` sends the live store token as the bearer; and
`_performKeychainImport` reads the store username across its multi-minute import
loop. A cross-tab login as a different user that lands during the chain broadcast or
the proof signing, before the POST is sent, produces a proof for the wrong account
signed with the upgrader's new seed. The backend rejects it, and after the proof
retry budget the flow goes terminal with the upgrader's chain keys rotated and no
backend cleanup. The Keychain-loop variant requests an import for the other username.

## Scope

1. Pass the persisted upgrade subject, and a session token captured beside it before
   the first await, into `_performUpgradeKeyRotation`, `_signUpgradeProof`,
   `_postUpgradeBackend`, and `_performKeychainImport` as explicit parameters
   instead of reading the store live inside them.
2. In `executeUpgrade`, after each await before the POST, when the live username is
   not the persisted subject, stop before the next irreversible or credentialed step
   and route to the "session changed during upgrade" terminal sub-case the
   subject-pin task introduces, preserving the seed wherever recovery still needs it.

## Acceptance criteria

1. A test that flips the subject during the key-rotation await asserts the proof is
   never signed and no POST is sent.
2. A test that flips the subject between proof signing and the POST asserts the POST
   is not sent (or carries the upgrade-start subject's proof and token, whichever
   the scope item 2 guard chooses at that point).
3. The Keychain import loop derives and imports keys for the upgrade-start subject
   regardless of store drift during the loop, pinned by a test that flips the
   subject mid-loop.
4. Existing custody-upgrade suites stay green.

## Notes

The backend's custody-state check and on-chain key_auths verification remain the
load-bearing defense against wrong-subject upgrade requests. This task removes the
frontend's loud-failure path and the wrong-account Keychain import; it does not add a
security boundary. No comment anchors on task slugs, round numbers, or line numbers in
code or tests; anchor on the helper names above.

## UI implementation signal (2026-09-02, commits 47c3be96, 08bb7fc3, 6bf1c7f9, fdc67b55):

Sequenced after `ui-custody-upgrade-subject-pin`, whose hold was landed first in the
same series; both files move to review together. Coverage is a new suite,
`frontend/tests/unit/pages-settings-custody-upgrade-helper-subject.test.js`.

Scope 1 is done as written: `_performUpgradeKeyRotation`, `_signUpgradeProof` and
`_performKeychainImport` take the account as their first parameter,
`_postUpgradeBackend` takes the bearer as its second, and `_completeUpgradeAfterBackend`
threads the account to the Keychain loop. Each leg reads the persisted pin ONCE,
synchronously, into a frame-local: `destroy()` wipes the field before it flips the
mount flag, so a field read after an await derived keys and built a challenge for
`null`. No live-store read remains anywhere in the flow after its first await.

**Scope 2 and acceptance criterion 1 were deliberately NOT implemented, by user
decision on 2026-09-02.** The checkpoints were built first (they are in 47c3be96) and
then removed in fdc67b55. The argument, verified against `backend/src/routes/custody.ts`:
that route takes the account from `req.hiveUsername` off the bearer and rebuilds the
challenge itself with `buildCustodyUpgradeChallenge`, so once the subject and the token
are both pinned before the first await, nothing in the request body and nothing in this
tab's store can redirect the cleanup to another account. A mid-flight stop therefore
prevents no wrong-account action. What it does instead is abort inside the
rotation-to-cleanup pair that `executeUpgrade`'s own ORDERING block calls the flow's one
irreversible gap, leaving the account rotated on-chain while the backend still holds
keys that no longer sign for it, and (because the sub-case is terminal) with no in-app
recovery. Criterion 2's wording already allowed the other branch at the later of the two
points; this applies the same reasoning at the earlier one. A diverged tab still loses
the right to adopt the response, which is refused at both landings.

The retry leg's start guard is kept and is not a mid-flight checkpoint: it is the one
place the flow genuinely cannot act for the pinned account, because the only credential
available to it there belongs to whoever the store now names.

Acceptance criteria as they now stand:
- 1: not met, superseded as above.
- 2: met by the other branch the criterion offers. Two tests assert the POST is sent
  carrying the upgrade-start account's proof and bearer after a drift during the
  broadcast and during the proof signing, and that the landing is dropped.
- 3: met. A test flips the store on the first Keychain popup and asserts all three
  imports still name the upgrade-start account, as does the loop's own derivation.
- 4: met. Full frontend unit suite green (1823 tests, 82 files). Three direct positional
  helper calls in the existing suites were updated; left alone they would have passed
  silently against a mnemonic bound as the account name.

Not verified in a browser: the states this task touches need a cross-tab login raced
against a chain broadcast, and the Playwright run needs the shared Docker stack swapped
into test mode while a sibling agent has uncommitted work in the tree. The production
build is clean.

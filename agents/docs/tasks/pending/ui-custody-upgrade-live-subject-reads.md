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

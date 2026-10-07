---
title: "A subject-divergence guard earns its place only where the flow would otherwise act with something belonging to the wrong subject — once the identity AND the credential are pinned, all it can still do is abandon"
date: 2026-09-03
category: conventions
module: frontend/src/pages
problem_type: convention
component: frontend_stimulus
severity: high
root_cause: missing_workflow_step
resolution_type: code_fix
related_components:
  - authentication
  - development_workflow
applies_when:
  - "Adding or reviewing a mid-flight 'has the subject changed?' / staleness / divergence checkpoint in a flow that already captured its identity-bearing values before the first await"
  - "The flow's outbound request carries a pinned bearer and the server re-derives the acting account from that credential rather than from a client-supplied name"
  - "A checkpoint sits between two irreversible steps (an on-chain broadcast and the backend cleanup that follows it), where aborting is itself the damaging outcome"
  - "A guard and the pinning that retires its premise were specified in the same task series, or a sibling scope item landed pinning before the guard was implemented"
  - "Triaging a review finding that proposes more subject/staleness checks on a flow whose steps run only on captured values"
symptoms:
  - "A checkpoint aborts the flow between the on-chain rotation and the backend cleanup POST, leaving the account rotated on chain while the server still holds keys that no longer sign for it"
  - "The abandonment lands in a sub-case whose own classification decides whether the user can finish the pair, so a guard that abandons inherits whatever recoverability that sub-case happens to carry"
  - "The guard site reads as an unarguable safety check and says nothing about the irreversible pair it interrupts, so its cost is invisible where the reviewer's eye lands"
  - "No test objects: the guard's true arm is unreachable in any scenario the flow can actually produce once the subject and credential are pinned"
  - "The rationale that justified the checkpoint cites an unpinned subject or a re-read credential that the current code no longer has"
tags: [subject-guard, identity-pin, custody-upgrade, premise-invalidation, irreversible-pair, non-load-bearing-defense, guard-removal, sibling-task-coupling]
---

# A subject-divergence guard earns its place only where the flow acts unpinned

## Context

The light-to-self custody upgrade in `frontend/src/pages/settings.js` is one of the few flows in this app with a genuinely irreversible pair. `executeUpgrade`'s own ORDERING comment enumerates the steps: `_performUpgradeKeyRotation` broadcasts `account_update` on chain, then `_postUpgradeBackend` calls `POST /api/custody/upgrade`, where the server drops the encrypted posting and memo keys it can no longer sign with and flips the row to self-custody. The comment states the stake in one sentence: "The (b)→(c) pair is the only remaining irreversible-pair gap."

The component's `username` is a getter over the singleton Alpine `auth` store, and the flow suspends at several macrotask-scale gaps that a cross-tab login or a same-tab sign-out can land in: the dynamic dhive import, the chain round trip, the up-to-20s cleanup POST, and each of the three Keychain popups. Two changes were specified as one series against that hazard. One pinned the subject so every step acts for the account the upgrade started for. The other stopped the flow whenever the live store moved off that subject.

The pinning item landed as `this._upgradeSubject = this.username`, a frame-local `const upgradeSubject`, and a `const upgradeToken = Alpine.store('auth').token`, all taken before the first await and threaded explicitly into `_performUpgradeKeyRotation`, `_signUpgradeProof`, `_postUpgradeBackend` and `_performKeychainImport`. The guard item added `_upgradeSubjectDiverged` checkpoints in the gaps between those steps: one after the broadcast, one after the proof, and one in `retryUpgradeBackend` after its proof.

Two things made the resulting defect hard to see.

First, the premise expired quietly. When the checkpoints were specified, the steps between them still read the live store: the rotation named the `account_update`'s account from `this.username`, the proof built its challenge the same way, and the POST read the bearer at fetch time. A mid-flight check then really did stop a wrong-subject action. The sibling item in the same series removed exactly that premise, and it removed it in the same change that carried the checkpoints forward. Nothing about the checkpoint lines changed, so nothing signalled that they had become inert. The original specification was correct when it was written; the premise moved underneath it.

Second, the cost is invisible at the guard site. A line of the form `if (this._upgradeSubjectDiverged(upgradeSubject)) { ...; return; }` reads as a safety check and says nothing about what the `return` abandons. The reader has to hold the ORDERING block in mind to notice that the `return` lands inside the one irreversible gap the same function documents.

The corpus had most of the pieces and none of the rule. A validated security finding on the
fresh-auth flight had already drawn the distinction in a single case, observing that a consent-op
password mint binds its credential at mint time, *after* the divergence, which is exactly why a guard
there is load-bearing; but it was recorded as a finding about one call path, never as a test (session
history). The sharpest keep-or-remove argument in the store belongs to a different mechanism
entirely: a spent-proof ledger's per-entry deadline was deleted on the reasoning that a deadline can
only retire an entry earlier than a confirmation would, so a mechanism that can only fire in the
direction that weakens the invariant has no job left (session history). What follows is that argument
run against a guard, in the negative direction.

It took two independent review passes to surface. The first argued a recoverability regression: `destroy()` wiped the pinned field before flipping `_mounted`, so an ordinary navigate-away made the predicate compare a null subject against any signed-in store, and the flow returned without ever POSTing. That pass fixed the symptom by gating the checkpoints on `_mounted` and by taking a frame-local copy of the pin (the teardown-ordering half of it is written up separately). The second pass asked a different question: given the pinning, what wrong-subject action does the checkpoint actually prevent? The answer was none, and all three mid-flight checkpoints were removed.

## Guidance

The discriminator, stated so a reviewer can apply it at a guard: **a subject guard earns its place exactly where the flow would otherwise act with something belonging to the wrong subject. Where the flow acts only on values it captured before suspending, the guard is checking a fact that no longer bears on the outcome, and its only remaining effect is to abandon whatever it interrupts.**

Two things have to be pinned for the premise to expire, and identity alone is not one of them. Pinning the account name while still reading the bearer at fetch time leaves the request going out under whoever the store now names, and a check before it is load-bearing. `executeUpgrade` pins both, and says so where the first checkpoint used to sit:

```js
// NO subject check between here and the POST, deliberately. A
// cross-tab login or a sign-out can land in any of the suspensions
// below, but every step from here on is bound to values captured
// before the first await: the proof is derived and signed for
// `upgradeSubject`, and the POST carries `upgradeToken`. The backend
// takes the account from that bearer and rebuilds the challenge from
// it, so neither the request body nor anything in this tab's store can
// redirect the cleanup to whoever the tab now names.
```

The load-bearing fact behind that claim lives on the server, and a reviewer should verify it rather than assume it. In `backend/src/routes/custody.ts`, the handler is `router.post('/upgrade', verifyHiveSignature, validateUpgradeBodyShape, upgradeLimiter, ...)`. It takes `const username = req.hiveUsername`, which `verifyHiveSignature` sets on its Bearer branch from the verified JWT's `sub` claim (with a runtime type guard, so an absent or non-string `sub` never authenticates). It gates on `req.hiveCustody !== 'light'`. And it rebuilds the signed challenge from that same username via `buildCustodyUpgradeChallenge({ appTag, username, signedAt })` rather than from any body field, then requires the recovered pubkey to equal the declared `derived_pubkey` and to appear in the account's on-chain key set. A request pinned to one bearer is therefore unredirectable: the account it acts on is a function of the credential, not of the caller's claim, and a proof signed for a different name simply fails to verify.

The positive example is the one guard that survived at the head of `retryUpgradeBackend`:

```js
const upgradeSubject = this._upgradeSubject;
if (this._upgradeSubjectDiverged(upgradeSubject)) {
  this._endUpgradeAsSessionChanged({ cleanupLanded: false, upgradeSubject });
  return;
}
// Pin the credential for this attempt, beside the subject the guard
// above just confirmed.
const upgradeToken = Alpine.store('auth').token;
```

Read the ordering: the guard runs *before* the leg captures anything. The retry starts from an error screen that has no timeout, on a click that can arrive minutes later, and the only credential available to it is whatever the store holds at that moment. Without the guard, the retry would take a stranger's bearer, sign a proof for the pinned subject, and spend the proof-retry budget on a request that cannot succeed. This is the shape the discriminator selects for: the step after the guard reads identity material from the live store.

The two `loginFromResponse` landings are the same shape for the same reason. They do not act *for* the pinned subject at all; they mutate the singleton store, which belongs to whoever the tab currently represents. `_upgradeSubjectDiverged`'s docblock now names all three sites and why:

```js
// Three call sites, and all three are about a STORE MUTATION rather than
// about the upgrade's own steps: the two `loginFromResponse` landings, and
// the retry's start guard, which is the one place the flow genuinely
// cannot act for the pinned account, because the only credential available
// to it there belongs to whoever the store now names.
```

The negative example is what was removed. The checkpoint after the broadcast sat between two steps that both consumed only `upgradeSubject` and `upgradeToken`, values fixed before the flow's first await. It could prevent no wrong-account action, because there was no path by which a wrong account could be reached.

## Why This Matters

The abandonment was not free, and the state it left behind is the point.

On the abort path the chain rotation has already landed: the account's owner, active, posting and memo authorities are the new seed's. The backend row is untouched, so `custody` is still `light`, `upgraded_at` is still null, and `posting_key_enc` / `memo_key_enc` still hold the keys derived from the *old* seed. Those keys no longer sign for the account. The server-side signing the light-custody model exists to provide (comment and vote) is broken for that account from that moment, and only the second half of the pair, the POST the guard just abandoned, clears it.

A recoverability question compounds it, and it is decided somewhere else. `_endUpgradeAsSessionChanged({ cleanupLanded: false })` assigns `UPGRADE_ERROR_KEYS.sessionChangedBeforeCleanup`. Whether the user can still finish the pair from there is not a property of the guard at all: it is whatever the module-level `RETRYABILITY` map says about that key. `canRetryUpgrade` is `RETRYABILITY[this.upgradeErrorKey] !== 'terminal'`, and the error screen renders Try Again under `x-show="canRetryUpgrade"`, so the map entry alone decides whether the abandoned half is reachable again.

When this learning was captured that entry was `terminal`, the button was hidden, and the copy routed the user to support. It has since been corrected to `retryable-backend-only`, with copy that asks the user to sign back in as the pinned subject and press Try Again, on the reasoning that the arm's surviving caller at the time was a *start* guard which declines before signing a proof, before the POST, and before any attempt against the proof-retry budget. It now has a second caller, the error ladder on a cleanup POST whose session had ended, which spends no proof attempt either. That correction is the point, not a footnote: the guard's cost was never visible at the guard, so it was carried by an entry in the module-level `RETRYABILITY` map that nobody revisited when the guard was added.

Compare either state with what the same window produces without a guard. If the POST comes back `401 UNAUTHORIZED` the catch routes to `proofRejected`, whose `RETRYABILITY` entry is `retryable-backend-only`; `handleRetry` dispatches to `retryUpgradeBackend`, which keeps the mnemonic, re-signs a fresh proof, and completes the pair. The flow recovers by running the second half, not by explaining why it stopped. A mid-flight guard cannot do that, because abandoning is the only move it has. On the navigate-away path found by the first review pass it fired with no subject change at all, which meant a user closing the tab got the abandoned state for nothing.

There is a further cost that no amount of copy fixes: the message is rendered by the settings page, which is itself bound to the live store. After a login as a self-custody user, the surrounding sections stop rendering and the message is never seen. Worse, when the recovery the copy names is a control on that same page, losing the render loses the recovery too. A sign-out hid it the same way until the signed-out body began rendering a waiting backend-only retry's message, with a Sign In that opens the sign-in prompt on the page instead of leaving it. A guard that stops a flow to *tell* the user something has to survive the very store change that triggered it, and this one does not.

## When to Apply

Three conditions together make this relevant. The flow has at least one await between two steps that must both happen, whether that is an irreversible pair or any sequence with no compensating action for the first half. The flow reads identity from a mutable ambient source, such as a singleton store, a global session object, or a context re-read after suspension. And someone has added a mid-flight guard that returns or throws when that ambient identity changes.

At the guard, ask one question: **name the wrong-subject action this prevents.** Point at the specific value the following step would take from the ambient source. If every value the following step consumes was captured before the suspension, and the receiver derives the subject from one of those captured values rather than from a claim in the payload, the guard prevents nothing. Then ask the second question: **what does the abandonment leave behind, and is that state recoverable without an operator?** A guard that prevents nothing and abandons a reversible step is dead weight; one that prevents nothing and abandons an irreversible half is a defect.

Apply it in the other direction too, which is where the failure originated. Pinning a value retires the guards downstream of it. When a change introduces a pin, sweep the same flow for subject checks that the pin has just made inert, in the same pass. That sweep is cheap while the change is in hand and nearly invisible afterwards, because the guard lines themselves do not change.

A removal is a change like any other and can itself be a regression: this repo has held a round for
restoring a loud default that a previous round's cleanup deleted (session history). Removing a guard
means arguing that its true arm is unreachable, not that it is unlikely, and the argument belongs in
the commit message where the next reader will find it.

Finally, verify the server half instead of assuming it. The claim "the request cannot be redirected" is only true when the receiver derives the acting identity from the credential, the way `POST /api/custody/upgrade` derives `username` from the bearer and rebuilds the challenge from it. A route that read the account from a body field would make the same client-side pin worthless and the mid-flight guard load-bearing again.

## Examples

Before, the checkpoint after the broadcast:

```js
await this._performUpgradeKeyRotation(upgradeSubject, oldWords, newSeedPhrase);
broadcastLanded = true;

if (this._mounted && this._upgradeSubjectDiverged(upgradeSubject)) {
  this._endUpgradeAsSessionChanged({ cleanupLanded: false, upgradeSubject });
  return;
}

const proof = await this._signUpgradeProof(upgradeSubject, newSeedPhrase);
```

There was a second one of the same shape between `_signUpgradeProof` and `_postUpgradeBackend`, and a third in the retry leg after its proof. All three read as safety checks. All three sat between steps whose every input was already pinned.

After, the same position carries a comment instead of a branch, and the flow runs `_signUpgradeProof(upgradeSubject, newSeedPhrase)` and `_postUpgradeBackend(proof, upgradeToken)` through to the landing without a subject check, where `_upgradeSubjectDiverged` still refuses the store mutation:

```js
if (this._upgradeSubjectDiverged(upgradeSubject)) {
  this._endUpgradeAsSessionChanged({ cleanupLanded: true, upgradeSubject });
  return;
}
Alpine.store('auth').loginFromResponse({ /* ... */ username: upgradeSubject, custody: 'self' });
```

One live-store read does sit inside `_postUpgradeBackend` now, and its shape restates the rule. Before sending, it asks the auth store whether the session has expired, because the server answers an expired bearer with the same bare `401 UNAUTHORIZED` the proof rejections use, and the error ladder would spend the proof-retry budget on it. The store's `endSessionIfExpired` compares the store's own `expiresAt`, not the pinned token's, and a signed-out store has none, so it reads as expired. Asked unconditionally, the check stopped the cleanup POST on an ordinary sign-out while the pinned bearer was still valid on the server: an abandonment between the two halves of the pair, this entry's failure in a new form. It asks only while the store still holds the pinned token, so it speaks about the pinned credential or not at all:

```js
if (auth.token === upgradeToken && auth.endSessionIfExpired?.(upgradeToken)) {
```

The completing behaviour is pinned by tests in `frontend/tests/unit/pages-settings-custody-upgrade-helper-subject.test.js`. "finishes the cleanup for the upgrade-start account when the store moves during the broadcast" drifts the store to another user from inside the stubbed `sendOperations`, and "finishes the cleanup for the upgrade-start account when the store moves while the proof is signed" drifts it from inside the stubbed signer. Both then assert that `fetch` was called exactly once, that its `Authorization` header carries the bearer captured at upgrade start rather than the drifted user's, that `loginFromResponse` was never called while the store still names the other user, and that the phase ends in `error` with `upgrade.sessionChangedAfterCleanup`. Only the first also asserts that the signed challenge names the upgrade's account, and deliberately: its drift is triggered from inside the stubbed broadcast, before the proof is built, so a live read would be caught. The second triggers its drift from inside the stubbed signer, after the challenge string exists, where the same assertion would hold under any implementation and prove nothing. A sibling test that drifts during the proof's own key derivation carries that assertion instead. Together they are the rule in executable form: the cleanup lands for the pinned subject, the session adoption does not.

Telling the two kinds of guard apart in review comes down to three checks, in order. Does the step immediately after the guard read identity or credential material from the ambient store, or does it consume only values captured before the suspension? Does the receiver of that step derive the acting subject from a captured credential, or from something the payload asserts? And is the guard on the far side of a step that cannot be undone? A guard passes on the first two checks alone; the third only decides how expensive it is when it fails them. The retry's start guard passes because the credential it protects has not been captured yet. The landings pass because they write the live store, which is not the upgrade's to write. The three that were removed failed both, and the third check is why they were worth removing rather than leaving in place as harmless.

## Related

- `agents/docs/solutions/conventions/alpine-destroy-wipes-pinned-field-before-flipping-mounted-2026-09-02.md` is the same file, the same flow and the same guard, with the opposite sign. It installs the pin this entry then reasons from, and it documents a different failure of the same checkpoints: they also fired on an ordinary navigate-away, because the teardown wiped the pinned field before flipping the mount flag. One entry's solution is the other entry's cause.
- `agents/docs/solutions/conventions/hold-prescriptions-expire-with-their-premise-2026-09-01.md` is the review-cycle rule this entry instantiates: a prescription's justifying premise can be retired by the very change that carries it forward, so re-review must attack the prescribed shape rather than verify compliance with it. That entry says premises expire and how to catch it at review. This one supplies the test for one class of prescription, and reaches it from an implementation rather than from a hold.
- `agents/docs/solutions/conventions/hold-prescriptions-prescribe-invariants-not-constructs-2026-06-12.md` is the authoring-side counterfactual. Had the hold prescribed the invariant, that no leg may act with a credential belonging to a subject other than the one the flow started for, rather than the construct, that divergence is re-checked after each await, the pin would already have satisfied it and no checkpoint would have been written.
- `agents/docs/solutions/conventions/fresh-auth-guard-coverage-must-sweep-the-callee-graph-2026-09-01.md` is the maximalist direction of the same mechanism, and this entry bounds it. Its instruction to thread the guard into every callee that awaits before an irreversible effect is right where the callee still reads identity from the ambient store, and re-adds inert checkpoints where the callee reads only what the caller pinned. Sweep the callee graph for what each callee READS, not merely for whether it awaits.
- `agents/docs/solutions/conventions/chain-primitive-proxy-prefer-deletion-2026-04-28.md` is the general form of this discriminator, one domain over: name the failure mode a construct defends against, compare it against what already prevents that state, and delete the construct when the answer is that the state is already prevented.
- `agents/docs/solutions/conventions/recovery-defenses-vs-seed-phrase-holder-non-load-bearing-2026-05-25.md` is the same genus on a different axis. It dismisses a defense because the threat model already grants the attacker what the defense withholds; this one removes a guard because the flow no longer reaches the state the guard tests for.
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` supplies the vocabulary for the cost half: an irreversible remote write plus an ambiguous interruption is its own outcome class, and collapsing it into a plain failure is the anti-pattern. Aborting between the two halves of the pair manufactures exactly that class.
- `agents/docs/solutions/conventions/cross-task-hold-block-staleness-2026-04-22.md` is the closest existing statement of the first aggravating factor, a premise going stale between rounds because parallel work landed on the cited surface. Here the staling change was the sibling scope item of the same series, and it arrived in the same diff that carried the guard.
- `agents/docs/solutions/conventions/behavior-change-coverage-gap-not-preemptive-hardening-2026-06-10.md` is the triage-side analogue, asking whether a proposed defense's failure mode is reachable at all before holding on it.
- `CONCEPTS.md`, the Subject Teardown entry, carries the premise at the domain level: a stretch already inside an irreversible pair finishes on what it captured rather than unwinding. It does not draw the consequence this entry draws, that a mid-flight subject check downstream of both captures has nothing left to prevent.

---
title: "`destroy()` wipes pinned state before it flips `_mounted`: snapshot the pinned field into a frame-local before the first await"
date: 2026-09-02
category: conventions
module: frontend/src/pages
problem_type: convention
component: frontend_stimulus
severity: high
root_cause: async_timing
resolution_type: code_fix
related_components:
  - authentication
  - testing_framework
applies_when:
  - "Writing or reviewing an Alpine page component whose `destroy()` both wipes instance fields and flips a `_mounted`-style liveness flag, with the wipe ordered before the flip"
  - "An in-flight async flow pins an identity-bearing value on `this` (the account being upgraded, the paper being edited) and reads that field back after an await"
  - "Adding a divergence, staleness, or subject-change predicate that reads a pinned `this.*` field instead of taking the pinned value as a parameter"
  - "Threading a pinned field into a helper as an argument, where a null would be interpolated into a signing challenge, a key derivation, or a request path"
  - "Writing a navigate-away or unmount test for an in-flight flow by hand-assigning the liveness flag rather than calling the real `destroy()`"
symptoms:
  - "A subject-divergence predicate reports the subject changed for every signed-in store after any navigate-away, because the pinned field is null while the store username is not"
  - "An abort fires between an irreversible on-chain broadcast and its backend cleanup POST, leaving the account rotated on-chain while the server still holds encrypted keys that no longer sign for it"
  - "A signing challenge is built for the literal account name null (`pevo-custody-upgrade|v1|null|<timestamp>`) and the backend cannot verify it"
  - "Hive keys are derived for the account name null inside a helper that received the pinned field as an argument rather than snapshotting it"
  - "The entire suite stays green: every navigate-away test hand-assigns `_mounted = false`, which skips the wipe and so never produces the null field"
tags:
  - alpine
  - lifecycle
  - teardown
  - destroy
  - frame-local
  - identity-pin
  - custody-upgrade
  - test-fidelity
---

# `destroy()` wipes pinned state before it flips `_mounted`

## Context

The custody-upgrade wizard in `frontend/src/pages/settings.js` pins the account it is
acting for. `executeUpgrade()` sets `this._upgradeSubject = this.username` before its
first await, because `username` is a getter over the singleton auth store and a cross-tab
login can change it while the flow is suspended. The field is a field rather than a local
because a later leg, `retryUpgradeBackend()`, runs from a click on the error screen and has
to read the same pin minutes later.

That pin lives in Alpine reactive state, and Alpine reactive state is exactly what the
component's teardown wipes. `destroy()` calls `_clearSensitiveUpgradeState()` as its very
first statement, then removes the beforeunload listener, then unregisters the router
navigation guard, then `_teardownOrcidRedirectGuard()`, and only last calls
`_teardownTimers()`. `_clearSensitiveUpgradeState()` zeroes `oldSeedPhrase`,
`newSeedPhrase`, `newSeedWords`, `confirmInputs`, `upgradePassword`, and `_upgradeSubject`.
`_teardownTimers()`, supplied by `createTimerGuard()` in `frontend/src/lib/timer-guard.js`,
is what sets `_mounted = false`.

So the mount flag is the last thing teardown touches and the identity pin is the first.
A continuation that resumes after an await, in a component the user has navigated away
from, finds `_upgradeSubject` already `null`. If that continuation reads the field instead
of a value it captured before suspending, it acts on `null`.

This ordering is not itself the bug, and the repo has already decided as much once. The
subject scrub in the auth store evicts the fresh-auth window *before* it bumps the
generation counter, precisely so that a guard reading `tornDown()` can rely on
"torn down implies already evicted" (session history). The lesson from that round carries
here: when a wipe precedes the flag, ask whether the ordering is wrong or whether the
reader is missing a check. Both times the answer has been the reader.

## Guidance

Treat every field that teardown wipes as unreadable after an await. Snapshot it into a
frame-local `const` before the first suspension point and pass that local down through the
helper chain. The field remains the durable pin for a later leg; the local is what the
current leg uses.

Before, where a helper read the live field across a suspension:

```js
this._upgradeSubject = this.username;
// ...
await this._performUpgradeKeyRotation(this._upgradeSubject, oldWords, newSeedPhrase);
const proof = await this._signUpgradeProof(this._upgradeSubject, newSeedPhrase);
```

After, with the pin captured once and threaded explicitly:

```js
this._upgradeSubject = this.username;
const upgradeSubject = this._upgradeSubject;
// ...
await this._performUpgradeKeyRotation(upgradeSubject, oldWords, newSeedPhrase);
const proof = await this._signUpgradeProof(upgradeSubject, newSeedPhrase);
```

Both `executeUpgrade()` and `retryUpgradeBackend()` now take that local at the top and pass it
down: to `_signUpgradeProof`, to `_completeUpgradeAfterBackend` and through it to
`_performKeychainImport`, into the `loginFromResponse` payload, and to
`_upgradeSubjectDiverged(upgradeSubject)`. Only the executor also passes it to
`_performUpgradeKeyRotation`, because the retry leg never rotates: that landed on the first
attempt and re-broadcasting with the old seed's keys would be rejected by the chain. This is not a new pattern in the file: both
functions already snapshotted `newSeedPhrase` the same way, with a comment saying why. The
fix is the existing house pattern applied to one more field that had been left reading live.

The reflex to resist is reaching for `if (!this._mounted) return;` as the answer. That guard
protects state writes after unmount, and it is correct where it appears, but it is not a
validity check on a wiped field, for two reasons. It is set last in `destroy()`, so it is
not synonymous with "the wipe has happened"; and in this flow the code deliberately does not
stop when it is false. The stretch between the on-chain broadcast and the backend cleanup
POST must run to completion whether the component is mounted or not, so a guard that
returns early is the wrong instrument. The only thing that keeps a must-finish continuation
correct is that its inputs were captured before it suspended.

## Why This Matters

`executeUpgrade`'s own ORDERING comment block names the pair this touches: the on-chain
`account_update` broadcast followed by the `/api/custody/upgrade` cleanup POST is "the only
remaining irreversible-pair gap" in the flow. The broadcast rotates all four key
authorities and cannot be undone. The POST is what tells the backend to delete the now-dead
encrypted posting and memo keys and flip `custody` to `'self'`.

With a null subject, `_signUpgradeProof` builds the challenge
`` `${getAppTag()}-custody-upgrade|v1|${upgradeSubject}|${signedAt}` ``, which reads
`...|v1|null|...`, and derives the signing key via `deriveHiveKeys(newSeedPhrase, null)`.
The backend rebuilds the challenge from the JWT subject, so a proof signed for `null` is a
proof for an account that does not exist. The cleanup never lands. The account is rotated
on chain while the server still believes it is a light account and still holds encrypted
keys that can no longer sign anything, so every later server-signed broadcast for that user
fails. The user's only remaining route back is their seed phrase plus operator
intervention.

The trap is not specific to this flow. Any Alpine component whose `destroy()` clears
reactive state has the same shape: the wipe is the point of teardown, and the wiped fields
are precisely the ones an in-flight operation still needs.

## When to Apply

This applies whenever all three conditions hold. The component has a `destroy()` that
clears reactive fields rather than only detaching listeners and timers. Some async flow
reads one of those fields after an await. And the flow either must finish past unmount, or
reads the field for identity or correlation rather than for display.

The strongest signal is a field that answers "who or what is this operation for": an
account name, a paper permlink, a request correlator, an editing target. Those get baked
into signed payloads and outbound requests, where a null value does not throw but produces
a wrong, sometimes irreversible, action. Fields read only to render are far less dangerous:
a wiped one paints an empty box on a component nobody is looking at.

It also applies at review time to teardown ordering itself. When reading a `destroy()`,
note which statement clears state and which flips the mount flag, and do not assume the
flag is a proxy for the wipe.

## Examples

The production shape is above. The test shape is the other half of the learning, and it is
the reason the bug survived as long as it did.

Every navigate-away test that covered the stretch between the broadcast and the cleanup POST
simulated the unmount by hand-assigning the flag inside a fetch stub, in both
`frontend/tests/unit/pages-settings.test.js` and
`frontend/tests/unit/pages-settings-custody-upgrade-round2.test.js`:

```js
vi.stubGlobal('fetch', vi.fn(async () => {
  comp._mounted = false;              // simulates the flag, not the teardown
  return { ok: true, json: async () => ({ /* ... */ }) };
}));
```

That exercises the post-await `_mounted` guard, which is what those tests were written for,
and it is a fine stub for that purpose. But it flips one boolean and runs none of
`destroy()`. `_clearSensitiveUpgradeState()` never fires, so `_upgradeSubject` stays
populated and the null-subject state is structurally unreachable from those cases.

One test in `pages-settings.test.js` does call the real `destroy()`, and its own comment
says why: calling it rather than flipping the flag "exercises the integrated production
unmount path". It is the mid-Keychain-loop case, and the loop runs after the proof has
already been signed with a live subject, so its teardown lands past every step the wipe
could have corrupted. The suite therefore held both halves of what this bug needed, the
real teardown and the vulnerable stretch, and never put them in the same test. That is the
sharper version of the lesson: it is not enough to call the real `destroy()` somewhere; it
has to fire inside the await that the wiped field is read across.

The regression tests in
`frontend/tests/unit/pages-settings-custody-upgrade-helper-subject.test.js` call the real
teardown instead, and schedule it inside a specific await by driving it from the stubs
(`mockSendOperations` for the broadcast gap, `mockSign` for the proof gap):

```js
mockSendOperations.mockImplementation(async () => {
  comp.destroy();                     // real teardown: wipe first, then flag
  return { id: 'stub-tx' };
});

await comp.executeUpgrade();
```

The assertion that actually catches a null subject is not on the mount flag or on the error
key. It is on the signed challenge:

```js
expect(String(mockSign.mock.calls[0][0])).toContain('|alice|');
```

The dhive stub in that file makes `cryptoUtils.sha256` the identity function, so the
challenge string reaches the signer verbatim and the test can read the account name out of
it. Against the buggy code that string is `...|v1|null|...` and the assertion fails; a
`_mounted`-only assertion passes in both worlds.

The generalizable rule: a test that simulates unmount by setting the mount flag is testing
the guard, not the teardown. If the component's `destroy()` does anything besides flip that
flag, only calling `destroy()` exercises what a real navigate-away does, and only calling it
during the suspension in question exercises it where the wipe can still do damage.

## Related

- `agents/docs/solutions/conventions/subject-divergence-guard-earns-its-place-only-where-the-flow-acts-unpinned-2026-09-03.md` is this entry read forward, and the two belong together before anyone touches this flow. Three mid-flight divergence checkpoints used to sit in the stretch between the chain rotation and the cleanup POST, and that entry removes them: not because of the frame-local prescribed here on its own, but because the account name and the bearer are BOTH fixed before the first await and the server derives the acting account from that bearer, which together leave a check there nothing to prevent. The rule stated here survives the removal, since the `_upgradeSubjectDiverged` call sites that remain still take the frame-local rather than reading the field back. It is not a licence to re-add a properly-pinned check where those checkpoints were: the surviving sites all guard a store mutation, which is a different job.
- `agents/docs/solutions/conventions/alpine-persistent-instance-unconditional-ui-flag-reset-2026-05-20.md` covers the opposite lifecycle dimension and already prescribes half of this fix: capture identity at entry and pass the captured local, never `this.*`, to everything after an await. Its scope is the Alpine instance that is never destroyed, and its "When to Apply" excludes pages the router does destroy and recreate, which reads as though the destroy path were the safe one. It is not; this entry is that path's own trap.
- `agents/docs/solutions/conventions/synchronous-flag-before-await-idempotency-guard-2026-05-16.md` is the closest sibling on the "do it synchronously, before the first await" axis. It establishes the two stacked guards this entry sits between, and its rule to reset the flag in `destroy()` treats teardown as a single atomic event. This entry sharpens that: `destroy()` is a sequence, and its internal order is a correctness surface for any continuation still running.
- `agents/docs/solutions/conventions/fresh-auth-guard-coverage-must-sweep-the-callee-graph-2026-09-01.md` states the same threading rule for a guard ("pass the guard down as a value; do not let each layer capture its own"). This entry is the identity-value form of it, with a different failure mode: there the captured predicate goes stale, here the re-read field goes null.
- `agents/docs/solutions/conventions/alpine-init-handler-deregister-before-reassign-2026-05-17.md` documents the same file's `init()` and `destroy()` pair, but only for listener deregistration. Read together, the two entries say that both halves of that teardown body have ordering constraints on them.
- `agents/docs/solutions/conventions/ts-closure-denarrowing-nullable-property-hoist-2026-05-04.md` prescribes mechanically the same shape, hoisting a property into a local before a closure captures it, but for the opposite reason: there the type checker forces the hoist, here nothing does, which is why the trap survives review.
- `agents/docs/solutions/conventions/test-fabricated-error-shape-masks-dead-branch-2026-06-09.md` is the mirror image of the corollary half. There a hand-built fixture carried a field the real constructor never produces; here a hand-assigned flag omits everything the real teardown does. Both leave a whole class of production behaviour unreachable from a green suite.
- `agents/docs/solutions/conventions/optional-predicate-gate-needs-live-false-case-not-just-absent-2026-09-02.md` generalizes the corollary: coverage counted by outcomes hides gaps that only appear when it is counted by input shapes. Hand-assigning the mount flag is one such missing shape.
- `agents/docs/solutions/conventions/vacuous-state-unchanged-assertion-sentinel-pattern-2026-05-20.md` covers the other way a teardown-guard test stops discriminating, where the assertion is vacuous because the function's own prologue already wrote the asserted value.
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` supplies the vocabulary for why the symptom here was severe rather than cosmetic: the abort landed inside an irreversible pair, which is the frontend twin of that entry's ambiguous chain write.
- `CONCEPTS.md`, the Subject Teardown entry, states this same invariant at the domain level and for a different mechanism, the auth store's own teardown rather than a component's: a stretch captures the subject it acts for when it starts, because reading it back afterwards finds it gone, and a stretch already inside an irreversible pair finishes on what it captured rather than unwinding. The concept therefore has two independent statements in this repo; an editor of either should know about the other.

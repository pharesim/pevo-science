# UI-UPGRADE-FLOW-MOUNTED-GUARDS — add `_mounted` guard around `_completeUpgradeAfterBackend`'s Keychain import loop

**Owner:** UI Agent
**Created:** 2026-05-16 (architect, from `/ce-code-review` triage of `ui-seed-phrase-keychain-compat`)
**Priority:** P2 (pre-existing UX gap; widened by the recent async-derive refactor)

## Problem

`frontend/src/pages/settings.js` runs the custody-upgrade flow through `executeUpgrade()` and `retryUpgradeBackend()`. Both gate `loginFromResponse(...)` with `if (!this._mounted) return;` (lines 786 and 941 respectively). But the immediately-following `await this._completeUpgradeAfterBackend(...)` call (lines 904, 989) has **no `_mounted` check**, and that helper:

1. Calls `_signUpgradeProof` (now an async path that awaits `deriveHiveKeys`),
2. Enters `_performKeychainImport`'s 45s-timeout-per-key Keychain loop (4 keys × 45s worst-case = up to ~180s),
3. In its `finally` block, writes `this.upgradePhase = 'done'` and calls `_clearSensitiveUpgradeState()` on whatever `this` resolves to by then.

If the user navigates away mid-loop, `_completeUpgradeAfterBackend` keeps running. Keychain popups still fire (against a stale component). The `finally` block still tries to write `upgradePhase` and clear sensitive state on the unmounted component's `this`. The visible failure modes:

- Stale Keychain popups appear after the user navigated away — disorienting; no parent UI is visible to interpret them.
- Sensitive in-memory state (mnemonic, WIFs in closure-bound variables) lives longer than intended because the `_clearSensitiveUpgradeState()` call still fires on an orphaned reference graph rather than the active component.
- If the user re-enters the settings page mid-loop, two parallel upgrade flows can race against each other (one orphaned, one fresh).

The `seed-phrase-keychain-compat` refactor widened the navigate-away race window by adding new `await deriveHiveKeys(...)` suspension points before the Keychain loop. The underlying gap pre-dates that refactor but is now more reachable.

## Goal

Add `_mounted` gating to the post-`loginFromResponse` path so the Keychain loop short-circuits on unmount, sensitive state is cleared promptly, and stale popups don't fire on detached components.

## Acceptance criteria

1. **`executeUpgrade` and `retryUpgradeBackend` re-check `_mounted` before invoking `_completeUpgradeAfterBackend`.** If the component has been unmounted between the `loginFromResponse` guard and the next async boundary, return early. State writes after the early return (e.g., `upgradePhase = 'done'`) must be guarded too.

2. **`_completeUpgradeAfterBackend` itself checks `_mounted` between its async boundaries.** The Keychain import loop iterates per role; each iteration should bail if the component is unmounted. At minimum, check before `_signUpgradeProof`, before the loop body, and inside the loop between Keychain calls.

3. **`_clearSensitiveUpgradeState()` and `upgradePhase = 'done'` in the `finally` block guard against running on an unmounted component**, OR are restructured so unmount triggers a deliberate cleanup that wipes in-memory state. The current shape silently mutates an orphaned object; either skip the writes or surface the unmount as an explicit cleanup signal.

4. **Tests cover the navigate-away race.** Add at least one test in `frontend/tests/unit/pages-settings.test.js` that mounts the settings component, starts an upgrade, flips `_mounted = false` during a controlled await boundary in `_completeUpgradeAfterBackend`, and asserts (a) the Keychain loop short-circuits, (b) sensitive state is cleared exactly once, (c) no `upgradePhase = 'done'` write fires on the unmounted component.

5. **Consider whether in-flight Keychain calls themselves should be aborted on unmount.** If the user navigates away while a `requestImportKey` call is pending, the Keychain extension popup still fires. There's no clean cancel API in `window.hive_keychain`. Document the residual in the implementation block if abort isn't feasible — the goal is "no further work after unmount," not "rewind in-flight work."

## Out of scope

- The 4 pre-existing `pages-settings.test.js` failures unrelated to this issue (`upgradePassword` wipe, 409 `ALREADY_UPGRADED` error-key routing, sibling closure-wipe). Track separately if/when the user wants them addressed; do NOT bundle.
- Any change to the upgrade flow's broadcast logic, signature handling, or backend handshake. Scope is strictly the mount-lifecycle gating around the existing flow.
- Refactoring `_completeUpgradeAfterBackend` into smaller helpers unless required by the guard placement. Prefer minimal-diff surgical inserts over restructuring.
- Hive Keychain extension changes. The popup-after-navigate is a Keychain UX limitation; PEvO can only choose not to make additional Keychain calls.

## Cross-references

- `agents/docs/tasks/pending/ui-seed-phrase-keychain-compat.md` — the refactor that widened the race window (currently in hold cycle round 1). This task is intentionally NOT part of that hold — the gap pre-dates the refactor and the fix shape (where to gate, how to surface unmount) deserves its own scope.
- `frontend/src/pages/settings.js:786, 904, 941, 989` — the four `_mounted` reference points; lines 786 and 941 are the guarded `loginFromResponse` callsites, 904 and 989 are the unguarded follow-ons.
- `frontend/src/pages/settings.js:_completeUpgradeAfterBackend` (line ~960+ at HEAD) — the helper that needs internal gating.
- `/ce-code-review` of UI commit `6660694` (architect re-review 2026-05-16) — finding #4 in the triage, cross-reviewer corroboration between UI-adversarial (window-widening framing) and UI-julik-frontend-races (pre-existing-gap framing).

## Architect re-review (2026-05-17, round-1) — HELD PENDING FIXES:

`/ce-code-review` of commit `89c1dab` ran with 9 personas (correctness Opus; testing/maintainability/project-standards/julik-frontend-races/reliability/learnings-researcher Sonnet; security Opus; adversarial Opus; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). Core implementation verified correct: destroy() wipe-then-teardown ordering is sound (`_clearSensitiveUpgradeState` then `_teardownTimers` flips `_mounted`); per-iteration `_mounted` guard correctly exits the Keychain loop on unmount; finally-block gating correctly skips orphan state writes; reliability confirmed new-instance-mounting-after-navigate-away derives `isLight=false` from auth store so no UX wedge.

### Item to address

**1. (P2 — test fidelity, cross-reviewer 3-way corroboration: correctness + testing + adversarial)** The navigate-away test at `frontend/tests/unit/pages-settings.test.js:2005-2056` simulates unmount by directly setting `compRef._mounted = false` inside the `requestImportKey` stub. Production reaches `_mounted=false` ONLY via `_teardownTimers()`, called ONLY by `destroy()` — and the same `destroy()` synchronously runs `_clearSensitiveUpgradeState()` first. The test bypasses the wipe half of that chain entirely; the wipe-once-on-unmount invariant the production comments cite as the security guarantee has no end-to-end test against the integrated production path. The companion `destroy() wipes sensitive upgrade state` test exercises wipe on an idle component, never one mid-Keychain-loop. A regression reordering the two destroy() calls (or removing the wipe entirely) would pass both existing tests.

   **Fix:** change the navigate-away test's stub from `compRef._mounted = false` to `compRef.destroy()`. The post-`executeUpgrade()` assertions can then verify all three task-AC-#4 invariants in one test: (a) loop short-circuited (importKeyCalls.length === 1), (b) sensitive state wiped exactly once (`comp.oldSeedPhrase === ''`, `comp.newSeedPhrase === ''`, `comp.newSeedWords === []`, `comp.confirmInputs === {}`, `comp.upgradePassword === ''`), and (c) no `upgradePhase = 'done'` write fired on the unmounted component (`comp.upgradePhase !== 'done'`). The companion standalone `destroy()` test stays as it is — it pins the destroy() wipe on the idle path, complementing but no longer substituting for the integrated assertion.

### Items dismissed at architect triage

- (P3, adversarial-4) `comp.upgradePassword = 'light-password'` claimed to write a phantom field. **OBSOLETED**: adversarial reviewed against task 4's standalone diff (89c1dab) where `upgradePassword` was not yet a real reactive field; the intervening commit `f94144b` ("ui(tests): clean up 11 pre-existing unit-test failures") added `upgradePassword` to `_clearSensitiveUpgradeState`'s wipe set (settings.js:1303-1309 at current HEAD). The test write is valid at HEAD.
- (P3, julik-frontend-races JFR-1) Catch arms in `executeUpgrade`/`retryUpgradeBackend` write `upgradePhase='error'`/`upgradeError`/`upgradeErrorKey` without `_mounted` guard, asymmetric with the diff's other gates. Dismissed: orphan mutations have no Alpine observer (component is destroying), the existing _mounted-gate philosophy targets visible-state writes and Keychain-popup side-effects, not invisible orphan writes. Adding catch-arm guards would be defensive parity for no observable behavior change.
- (P3, maintainability MAINT-R1) `destroy()` comment and `_completeUpgradeAfterBackend.finally` comment carry near-identical prose without cross-reference. Dismissed: minor doc-hygiene; the two comments document the same contract from two angles (cleanup signal vs. defensive backstop) — both readable in isolation, drift risk low.

Two pre-existing items surfaced but explicitly NOT part of this hold (filed-separately if user prioritizes later):
- adversarial-1 (P2 latent): the existing `_mounted` guard at `settings.js:797` runs BEFORE `loginFromResponse` and can strand the auth singleton with a stale `custody='light'` JWT on navigate-away mid-_postUpgradeBackend. The guard's comment explicitly trades this risk for disconnect-protection. Pre-existing; not introduced by this diff.
- adversarial-3 (P3, pre-existing): the 45s Promise.race timeout in `_performKeychainImport` uses raw `setTimeout` not registered with `_pendingTimers`, so destroy() can't clear it; orphan timer extends WIF closure-capture lifetime past unmount by up to 45s. Pre-existing.

### Architect signal

Move this file from `review/` back to `pending/` per rule #8. Implementer addresses item 1 (single test refactor — swap `_mounted = false` for `destroy()` and add the wipe + done assertions) in a single commit, then `git mv`s the file back to `review/` for round-2 architect re-review.

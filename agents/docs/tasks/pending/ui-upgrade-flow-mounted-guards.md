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

# FE-KEYCHAIN-WARNING-COPY-OR-RETRY-ACTION

**Owner:** UI Agent (post-brainstorm)
**Priority:** P3
**Created:** 2026-05-15
**Status:** [BLOCKED by Architect] — needs `/ce-brainstorm` pass to decide direction

## Problem

The custody-upgrade flow surfaces warning strings on the success screen telling the user to "retry from settings later" when one or more Keychain imports do not complete:

- `upgrade.keychainImportFailed` — "Keychain import did not complete. You can retry from settings later."
- `upgrade.keychainImportWarning.{posting,active,memo}` — "Keychain import incomplete: your `<role>` key was not imported. You can retry from settings later."

But there is no standalone "re-import Keychain keys" affordance anywhere on the settings page. The copy directs the user to do something they cannot do.

Reachable via any partial-Keychain-import path: user denies a popup, extension installed-then-uninstalled mid-flow, network flake on the dynamic dhive import, hung Keychain callback timeout (once the round-4 FE-KEYCHAIN-API-MISUSE hold item #1 lands). After the upgrade completes (chain rotated, backend cleaned, mnemonic wiped from reactive state) the user's Keychain is missing one or more keys with no in-app recovery path.

Surfaced by `/ce-code-review` round-4 on `ui-keychain-api-misuse` (commit `0a6b176`), reliability persona, anchor 75. Filed as a separate task because the resolution is a UX decision rather than a defect fix and should not bundle into the keychain-api-misuse wrap-fix scope.

## Direction options to brainstorm

**A. Copy-only fix.** Rewrite the warning strings to describe what the user *can* do, given the seed phrase they wrote down at upgrade time. Example: "Keychain import incomplete: your `<role>` key was not imported. Use the seed phrase you wrote down to add the key manually in the Keychain extension." Cheap, no UI work. Assumes the user retained the seed phrase post-upgrade. Risk: users who did not write down the seed phrase have no recovery; they will still be confused.

**B. Add a re-import affordance.** A "Re-import Keychain keys" button on `/settings` that prompts the user for their current seed phrase, re-derives the WIFs in a helper frame, and runs the existing `_performKeychainImport` again against the now-current on-chain keys. Meaningful feature; lets users recover after any partial-import scenario. New code path that re-derives keys outside the upgrade flow — must preserve the closure-wipe invariant established in FE-UPGRADE-CLOSURE-WIPE and FE-UPGRADE-CREDENTIAL-WIPE. Security review required at design time.

**C. Hybrid.** Land option A immediately; defer option B until usage data indicates the recovery path is being hit often enough to warrant the UI work. Trades long-term ergonomics for short-term ship velocity.

## Why blocked

Direction (A vs B vs C) is a UX decision the architect needs to make in collaboration with the user, not a unilateral implementer call. Blocks until a `/ce-brainstorm` pass narrows the scope and an architect updates this file with the chosen approach + acceptance criteria.

## What unblocks

Architect runs `/ce-brainstorm` with the user. Once a direction is chosen, the architect rewrites this task file to specify the approach + acceptance criteria, then `git mv`s to `tasks/pending/` for the UI agent to pick up.

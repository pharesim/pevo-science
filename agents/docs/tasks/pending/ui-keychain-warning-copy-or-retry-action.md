# UI-KEYCHAIN-WARNING-COPY — rewrite partial-Keychain-import warnings to name the seed phrase as recovery

**Owner:** UI Agent
**Created:** 2026-05-15 (original blocked stub) / 2026-05-16 (scope locked by architect `/ce-brainstorm`, direction A)
**Priority:** P3

## Problem

The custody-upgrade flow surfaces warnings on the success screen when one or more Hive Keychain key imports fail at the end of a light-account → self-custody upgrade. Today the copy directs the user to "retry from settings later," but no re-import affordance exists on the settings page. Users are told to do something the app does not support.

Strings affected (current English in `frontend/public/messages/en.json`):

- `upgrade.keychainImportFailed` — "Keychain import did not complete. You can retry from settings later."
- `upgrade.keychainImportWarning.posting` — "Keychain import incomplete: your posting key was not imported. You can retry from settings later."
- `upgrade.keychainImportWarning.active` — "Keychain import incomplete: your active key was not imported. You can retry from settings later."
- `upgrade.keychainImportWarning.memo` — "Keychain import incomplete: your memo key was not imported. You can retry from settings later."

Reachable on any partial-Keychain-import path: user denies a popup, extension installed-then-uninstalled mid-flow, network flake on the dynamic dhive import, hung Keychain callback timeout.

In self-custody PEvO, the seed phrase is the recovery mechanism by design. The Hive Keychain extension already supports importing an account from a master password / WIF derived off the seed. The warning's correct instruction is "use the seed phrase you wrote down in the Keychain extension's import flow" — not "retry from settings."

Source: `/ce-code-review` round-4 on `ui-keychain-api-misuse` (commit `0a6b176`), reliability persona, anchor 75. Architect `/ce-brainstorm` 2026-05-16 selected the copy-only direction (option A) over a re-import affordance (option B) and the hybrid (option C).

## Acceptance criteria

1. Rewrite the four strings in all 16 locale files under `frontend/public/messages/*.json` (`ar`, `cs`, `da`, `de`, `en`, `es`, `fa`, `fr`, `he`, `it`, `nl`, `pl`, `pt`, `sv`, `tr`, `zh`). The English copy goes verbatim into every locale — this matches the project's current state where non-English locales already carry untranslated English strings for these keys.

2. New copy guidance — implementer's judgment on exact wording, but each string must:
   - Name the seed phrase as the recovery mechanism. The user already saw a seed-phrase confirmation step earlier in the upgrade flow; treat that as known context, do not re-explain what a seed phrase is.
   - Point at the Hive Keychain extension's existing import flow as the place to act. Do not invent PEvO-side terminology or imply a PEvO settings step.
   - Mention contacting support / the operator as a fallback for users who can't navigate Keychain.
   - Stay under ~2 sentences. The success screen is not the place for a tutorial.

3. Do NOT add a settings affordance. No new button, no new code path in `frontend/src/pages/settings.js`, no new seed-phrase prompt outside the upgrade flow. The change is locale-files-only plus any test assertions that reference the old copy verbatim.

4. Sweep test assertions: search the frontend test tree for any assertion on the old "retry from settings later" string or on the affected message keys' old values, and update to the new copy. Run the frontend test suite to confirm no stale references.

## Out of scope

- A `/settings` "Re-import Keychain keys" affordance. If real-user frequency surfaces post-launch, file a new UI task with its own scope (security review, closure-wipe invariant preservation per `FE-UPGRADE-CLOSURE-WIPE` / `FE-UPGRADE-CREDENTIAL-WIPE` archived conventions, seed-phrase-prompt UX).
- Changes to upgrade-flow logic — when warnings fire, what counts as a failed import, partial-state semantics. The bug is the misleading copy, not the upgrade mechanics.
- Changes to non-Keychain warnings on the upgrade success screen (other `upgradeWarnings.push` sites in `settings.js`).
- Actual translation of the new English copy into the other 15 locales. Matches the project's current pre-launch state; real localization is a separate pass for all strings, not just these four.

## Cross-references

- `frontend/src/pages/settings.js:1009, 1168, 1227` — warning `$t()` call sites (for context only; no code change required).
- `frontend/src/pages/settings.js:1156` — `_performKeychainImport` (for context; no code change).
- `frontend/public/messages/*.json` — the actual edit target (16 files).
- Architect `/ce-brainstorm` 2026-05-16 — direction-A selection over B (affordance) and C (hybrid). Rationale: pre-launch, frequency unknown, the seed phrase IS the recovery mechanism by design, and the Hive Keychain extension already supports the import workflow we'd otherwise duplicate.
- Original source: `/ce-code-review` round-4 on `ui-keychain-api-misuse`, reliability anchor 75 (commit `0a6b176`).

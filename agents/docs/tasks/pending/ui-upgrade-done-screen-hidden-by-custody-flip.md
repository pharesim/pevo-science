# Show the key-upgrade done screen and Keychain-import warnings

**Owner:** ui
**Created:** 2026-10-06
**Priority:** normal

Surfaced by the verification of the upgrade-401 proof-budget split (ended-session user-path
lens, confirmed by its refuter with a real-Alpine probe). Pre-existing, not introduced there.

## Why

The whole key-upgrade section of `pages/settings.js` sits inside `<template x-if="isLight">`,
and `isLight` reads `Alpine.store('auth').custody === 'light'`. That section holds the
`upgradePhase === 'done'` panel ("Upgrade Complete") and the `upgradeWarnings` list.

Both success landings (`executeUpgrade` and `retryUpgradeBackend`) call
`loginFromResponse({ ..., custody: 'self' })` before `_completeUpgradeAfterBackend`, and
`loginFromResponse` sets `custody` synchronously. So the upgrade section leaves the DOM
before the Keychain import loop starts, and the page shows the self-custody panel instead.
The 'done' panel never renders, and neither does a per-role import warning: a user who
denies one `requestImportKey` popup is never told that key is missing from Keychain, and
their next vote or comment fails at Keychain with no explanation. `upgradeWarnings` is
rendered nowhere else.

The unit suites mock Alpine and never render the template, and
`tests/e2e/custody-upgrade.spec.js` asserts the `requestImportKey` calls but not the done
screen, so nothing catches this.

## Scope

Keep the upgrade section, or at least its 'upgrading' and 'done' states and the warnings
list, rendered after the landing flips custody to 'self' (for example gate it on
`isLight || upgradePhase === 'upgrading' || upgradePhase === 'done'`, or move the done panel
and the warnings outside the `isLight` gate). Leave the self-custody panel's own behaviour
for an account that was already self-custody unchanged.

## Acceptance criteria

1. After a successful upgrade (either leg) the 'done' panel renders.
2. A denied or failed per-role Keychain import shows its warning on that panel.
3. A self-custody account that never upgraded in this page load sees the settings page as
   today.
4. A test that renders the real template (real Alpine) pins 1 and 2.

## Architect rider (2026-10-07, from the upgrade-401 proof-budget review)

While in `pages/settings.js`, delete the parenthetical
`(first in executeUpgrade, subsequent ones in retryUpgradeBackend)` from the
`_proofRetryAttempts` field comment. It is false when `executeUpgrade`'s cleanup POST ends in
a 503 or a session-ended error, because the first counted 401 then comes from
`retryUpgradeBackend`. Delete it; do not replace it with a longer sentence.

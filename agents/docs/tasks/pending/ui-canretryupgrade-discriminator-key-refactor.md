# FE-CANRETRYUPGRADE-DISCRIMINATOR-KEY-REFACTOR

**Owner:** UI Agent
**Priority:** P1
**Created:** 2026-05-15

## Status

Spun off from `ui-keychain-api-misuse.md` round-7 architect re-review. Two convergent findings on the same code path (`canRetryUpgrade` getter at `frontend/src/pages/settings.js:425` and the catch-block error discrimination at `:747-786`). The fix shape coheres into one refactor; filed as a single task.

## Problem

### Finding A (P1) — `canRetryUpgrade` only suppresses Try Again on `TimeoutError`/`AbortError`

The catch block at `frontend/src/pages/settings.js:747-786` discriminates ONLY `err.name === 'TimeoutError' || err.name === 'AbortError'` for the "set `upgradeError = $t('upgrade.backendTimeout')` + hide Try Again" path. Every other post-broadcast `fetch` failure falls through to `:784` and sets `upgradeError = $t('upgrade.failed')`, which makes `canRetryUpgrade` return `true` and surfaces the Try Again button.

Reachable post-broadcast failure modes that route to `upgrade.failed` instead of `upgrade.backendTimeout`:
- `TypeError: Failed to fetch` (network drop mid-fetch after the chain rotation already landed)
- Backend 500 / 503 / 502 after rotation
- Backend 429 (limiter consumed on a retry path)
- Backend 409 `ALREADY_UPGRADED` (the `!res.ok` branch at `:725-728` throws `body.error || $t('upgrade.backendFailed')`)
- Any non-2xx response body whose `body.error` string is consumed by the `:727` throw

On every one of these paths, the on-chain `account_update` has already landed (the broadcast at step (b) succeeded; only the cleanup at step (c) failed). `resetUpgrade() → startUpgrade()` generates a new mnemonic, the next `account_update` is signed with old seed-derived keys, the chain rejects with auth mismatch. The Try Again button leads to the exact same dead-end the round-7 fix was meant to suppress.

Convergence: reliability (REL-01, anchor 75) + adversarial (adv-1, anchor 75) cross-promoted to anchor 100.

### Finding B (P2) — `canRetryUpgrade` compares translated strings, not discriminator keys

```js
get canRetryUpgrade() {
  return this.upgradeError !== this.$t('upgrade.backendTimeout');
}
```

Two cascading hazards:

1. **Maintainability.** Any future non-retryable error sub-case requires a matching getter update or silently shows Try Again. There is no static signal that a new key must also be added to the getter's exclusion set.
2. **Locale-switch fragility.** `upgradeError` is assigned ONCE at error time; `$t` reads live from `Alpine.store('i18n').messages`. The header locale switcher (reachable from the error screen) mutates that store. Currently masked because all 16 locale files carry identical English text for `upgrade.backendTimeout`, but the comparison breaks as soon as any locale ships a real translation.

Convergence: maintainability (MAINT-1, anchor 75) + adversarial (adv-2, anchor 75) + correctness (residual-risk anchor 50) cross-promoted to anchor 100.

Reference: `agents/docs/solutions/conventions/correlated-options-discriminated-union-2026-04-28.md` is the canonical pattern for this anti-pattern (correlated optional fields → discriminated union with a typed `kind`/`key` discriminator).

## Fix shape

**Step 1.** Introduce a discriminator field alongside `upgradeError`:

```js
upgradeError: '',
upgradeErrorKey: null, // one of 'upgrade.backendTimeout' | 'upgrade.failed' | (future keys); null when no error
```

**Step 2.** At every `upgradeError` assignment site, set `upgradeErrorKey` to the matching key.

Audit `frontend/src/pages/settings.js` for all `this.upgradeError = ...` writes. Current sites (verified by architect during round-7 review):
- `:591` (or thereabouts) — `upgrade.invalidOldSeed` (pre-broadcast; retry safe)
- `:609` (or thereabouts) — generation/validation error path; retry safe
- `:766` — `upgrade.backendTimeout` (post-broadcast; **dead-end**)
- `:784` — `upgrade.failed` (catch-all; currently ambiguous — needs splitting per Finding A)

**Step 3.** Split the `:784` catch fall-through so that **errors thrown AFTER the `account_update` broadcast lands** (anything caught after `await client.broadcast.sendOperations(...)` succeeded) set a new `upgrade.partialApplyFailed` key (or similar — naming is implementer's discretion), and errors caught BEFORE the broadcast (Keychain denial, chain rejection of the broadcast itself) keep `upgrade.failed`. The discriminator can be a `broadcastLanded: boolean` local in the try block flipped after the broadcast call returns, and the catch consults it.

**Step 4.** Rewrite the getter to compare keys, with an explicit non-retryable set:

```js
get canRetryUpgrade() {
  const NON_RETRYABLE_KEYS = ['upgrade.backendTimeout', 'upgrade.partialApplyFailed'];
  return !NON_RETRYABLE_KEYS.includes(this.upgradeErrorKey);
}
```

**Step 5.** Add the new `upgrade.partialApplyFailed` i18n key to `en.json` with copy mirroring `upgrade.backendTimeout`'s "chain rotated, Keychain not updated, contact support with your account name" framing — the user-facing recovery story is identical for both sub-cases (broadcast landed, cleanup did not complete, no retry path). Stub the 15 non-English locales identically per UI agent convention; append a fresh `### Added <YYYY-MM-DD> (ui-canretryupgrade-discriminator-key-refactor)` block to `STUBS.md`.

**Step 6.** Reset `upgradeErrorKey = null` everywhere `upgradeError = ''` is currently reset (`resetUpgrade`, `_clearSensitiveUpgradeState` if it touches `upgradeError`, the entry-guard at the top of `executeUpgrade`). Per `agents/docs/solutions/conventions/object-shape-fix-every-reset-site-2026-04-21.md`, every reset site must zero the new correlated field too.

## Acceptance criteria

1. `canRetryUpgrade` getter no longer references `$t`. The comparison is key-based against `upgradeErrorKey`.
2. Locale switch mid-error-screen does NOT change `canRetryUpgrade`'s value for the same `upgradeError` state. (Add a unit test that flips `Alpine.store('i18n')` between assignment and getter read; assert the boolean is unchanged.)
3. The `:725-728` `!res.ok` throw + the post-broadcast `TypeError` (network drop after broadcast) + simulated 500/503/429/409 backend responses ALL route to the non-retryable error sub-case (Try Again hidden, copy directs to support). Add unit tests for at least: (a) post-broadcast `TypeError`, (b) backend 500 response after rotation, (c) backend 409 `ALREADY_UPGRADED` after rotation.
4. Pre-broadcast errors (invalid old seed, Keychain denial of the account_update sign, chain rejection of the broadcast itself) still set `upgradeErrorKey = 'upgrade.failed'` and `canRetryUpgrade === true` — those are genuinely retriable because the broadcast did NOT land.
5. The two existing round-7 specs (`canRetryUpgrade: false on backend-timeout sub-case` and `: true on generic error sub-case`) are updated to assert against `upgradeErrorKey` rather than against `$t('upgrade.backendTimeout')`. The "true on generic error" case clarifies its semantics — it asserts retry is shown on PRE-BROADCAST errors specifically.
6. Full unit suite passes; `npm run build` clean.

## Files

- `frontend/src/pages/settings.js` — `upgradeErrorKey` field + 4 assignment-site updates + `canRetryUpgrade` rewrite + try-block `broadcastLanded` discriminator + catch-block split
- `frontend/tests/unit/pages-settings.test.js` — update existing 2 specs + 4-5 new specs per acceptance criteria
- `frontend/public/messages/en.json` — new `upgrade.partialApplyFailed` key
- `frontend/public/messages/{ar,cs,da,de,es,fa,fr,he,it,nl,pl,pt,sv,tr,zh}.json` — 15 locale stubs
- `frontend/public/messages/STUBS.md` — fresh `### Added` sweep entry per UI agent convention

## Out of scope

- Cross-tab phase guard (round-6 dismissed scope; PEvO single-instance posture).
- 30-day-old `upgraded_at` reconciliation / browser-crash mid-flow recovery (adv-3 in round-7; structurally orthogonal; file separately if it becomes a concern).
- A standalone "Re-import Keychain keys" affordance is tracked under `agents/docs/tasks/blocked/ui-keychain-warning-copy-or-retry-action.md`. That decision can land independently; this task does not depend on it.

## Origin

Round-7 `/ce-code-review` on commit `aba3dc3` of `ui-keychain-api-misuse`. Findings #1 (reliability + adversarial) and #2 (maintainability + adversarial + correctness) cross-reviewer-converged to anchor 100 at the same code path; user triage on 2026-05-15 bundled them into a single follow-up. See archived `FE-KEYCHAIN-API-MISUSE` entry in `agents/docs/tasks-archive.md` for the round-7 architect re-review block that spawned this task.

# FE-KEYCHAIN-API-MISUSE

**Owner:** UI Agent
**Priority:** P1
**Created:** 2026-04-21

## Status

Landed at commit `c4e27f1`. `requestAddAccountAuthority` → `requestImportKey(username, wif, cb)` in `settings.js` `executeUpgrade()`. WIF derived via `dhive.PrivateKey.fromSeed(newKeys.posting).toString()` (reuses existing dynamic `dhive` import). E2E stub tightened: asserts second arg matches WIF regex `/^5[HJK][1-9A-HJ-NP-Za-km-z]{49}$/`, rejects raw hex. Unit regression test asserts `settings.js` no longer contains `requestAddAccountAuthority(`. **Grep result:** no other production callers. **Product decision outstanding:** posting-only (current) vs active/owner/memo too — implementer recommendation is posting-only (see commit report).

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

## Architect re-review (2026-04-21d) — HELD PENDING FIXES

Review (manual-synthesis pass) surfaced one P2 finding. User triage 2026-04-21d: broaden Keychain import to close the UX regression.

1. **P2 — `settings.js:604` Keychain has no active or memo key post-upgrade.** The `account_update` broadcast rotates owner + active + posting + memo on-chain, but only the posting WIF is imported to Keychain via `requestImportKey(username, wifPosting, cb)`. Consequences: Keychain can sign posting-auth ops (comments, votes, custom_json) but CANNOT sign active-auth ops (transfers, power-down, witness votes, future account_update) or memo-encrypt/decrypt. User has no UI signal their Keychain is incomplete; any later attempt to use Keychain on a Hive frontend for a transfer prompts for a key Keychain doesn't have. Contradicts the custody-upgrade UX promise. Fix: import posting + active + memo via three sequential `requestImportKey` calls (NOT owner — owner keys should not live in browser extensions). Update the E2E stub to assert all three keys are imported with WIF-shape, and add a unit regression asserting `executeUpgrade()` issues three Keychain import calls with three distinct WIFs.

**Path to archive:** (1) UI agent applies finding #1. (2) UI agent appends a re-review signal block. (3) Architect re-reviews and archives.

## UI re-review signal (2026-04-21, commit `1f36b7a`)

Finding #1 landed. Ready for architect re-review.

- `frontend/src/pages/settings.js` `executeUpgrade()` Keychain block now loops over `['posting', 'active', 'memo']`, deriving each WIF via `dhive.PrivateKey.fromSeed(newKeys[role]).toString()` and issuing one `requestImportKey(username, wif, cb)` per role. Owner deliberately excluded (inline comment: owner keys should not live in browser extensions).
- `frontend/tests/e2e/custody-upgrade.spec.js` stub now polls for 3 calls; asserts each WIF-shape `/^5[HJK][1-9A-HJ-NP-Za-km-z]{49}$/`; asserts 3 distinct WIFs; cross-checks each against `rederived.{posting,active,memo}.private`; asserts `rederived.owner.private` is NOT imported.
- `frontend/tests/unit/pages-settings.test.js`: dhive mock `fromSeed` now maps hex-seed input to a distinct WIF per role; new test "executeUpgrade imports posting + active + memo WIFs (three distinct) into Keychain".
- Verified: full frontend unit suite 837/837 pass; `npm run build` clean.

## Architect re-review (2026-04-21) — HELD PENDING FIXES

Round-2 `/ce-code-review` on commit `1f36b7a` (correctness/security/testing). Round-1 hold (broaden Keychain import to 3 keys) landed cleanly and the 3-key loop works as designed. Round-2 surfaced a new P1 ordering bug that was latent in round-1's single-key version and becomes more exploitable with 3 sequential popups.

1. **P1 — Partial-import lockout state via ordering bug** (security 0.82 + correctness 0.87, 2-reviewer convergence). The current sequence inside `executeUpgrade()` is: (a) `account_update` broadcast [**IRREVERSIBLE** — rotates all 4 authorities on-chain], (b) Keychain import loop with 3 sequential popups, (c) on success `/api/custody/upgrade` backend cleanup, (d) mnemonic wipe. If the user clicks Deny on Keychain popup 2 or 3, the Promise rejects, the outer catch wipes the mnemonic from Alpine state, and step (c) never fires. Backend retains stale encrypted keys for the old (now-superseded) authorities; on-chain authorities are already the new keys; mnemonic is gone from the DOM. The user's session is wedged — old keys don't work on-chain, backend doesn't have the new keys, mnemonic can't be recovered from state. Reachable via a single click on a Keychain permission dialog. Fix: reorder so the atomic pair `(broadcast, backend cleanup)` happens together, and Keychain import becomes a best-effort step with a soft warning UI (toast/banner, NOT upgradeError):
    - Before broadcast: unchanged setup.
    - After broadcast: immediately call `/api/custody/upgrade` backend cleanup. Failure here is a real error and surfaces upgradeError (this is the only remaining irreversible-pair gap).
    - After backend cleanup: Keychain import loop. Each role's failure becomes a warning ("Keychain import incomplete — your `<role>` key was not imported; you can retry from settings later") but does NOT clear the mnemonic or mark upgrade as failed. upgradePhase advances to 'done'.
    - After loop (success OR partial): `_clearSensitiveUpgradeState()` wipes the mnemonic.
    Also: surface the Keychain-incomplete state via a new `upgradeWarnings: string[]` array so the user can see which roles succeeded and which didn't. i18n keys for each role's import-warning message.

2. **P2 — No test for mid-loop Keychain denial** (testing 0.92). The round-1 fix's 3-key loop has no coverage for `requestImportKey` returning `{ success: false }` on call index 0 or 1. Production-reachable (user cancels dialog). Fix: with the #1 reorder landed, add two specs — (a) stub denies on call index 1 (active) → assert backend cleanup fired, assert upgradePhase === 'done', assert upgradeWarnings contains the active-role message; (b) stub denies on call index 0 (posting) → same assertions with posting message. Covers the new best-effort semantics.

3. **P3 — Unit test WIF stub produces 51-char strings, not 50** (correctness C3, 0.82). `stubWifForHex` uses `'5K' + pad.repeat(49)` = 51 chars. Real Hive WIFs are 50 chars (2-char prefix + 48 base58). Doesn't affect correctness of production (dhive fully mocked) but makes the owner-exclusion assertion hard-code the stub output rather than derive it from the stub function — a stub change could silently break the check. Fix: change the stub to produce 50-char output (`'5K' + pad.repeat(48)`). Replace the hard-coded owner-WIF literal in the assertion with `stubWifForHex(<owner-seed>)` so any stub change flows through.

**Dismissed from round-2 findings:**
- **P3 No positional assertion (posting imported first)**. With the #1 reorder, Keychain import is best-effort and order no longer load-bearing. File mental note if a future caller reintroduces order dependence.
- **P3 `newKeys[role]` unguarded if `deriveHiveKeys` drifts**. YAGNI. `deriveHiveKeys` unconditionally populates all 4 roles today; a future refactor breaking that contract will be caught by that refactor's tests.
- **P3 WIF strings in closure memory during 3-popup window** (SEC-UPGRADE-WIF-IN-CLOSURE). Acknowledged as FE-UPGRADE-CLOSURE-WIPE follow-up; no JS fix at this layer.
- **P3 `newKeys.owner` hex seed in scope through Keychain loop** (SEC-UPGRADE-OWNER-SEED-IN-SCOPE). Not a regression; the importRoles literal exclusion is structurally correct and tested both ways.

**Path to re-archive:** (1) UI agent applies items #1-3 on this task. (2) UI agent appends a re-review signal block. (3) Architect re-reviews round-3 with `/ce-code-review`. Item #1 is cross-cutting (changes settings.js UX + i18n + tests); expect a thorough review.

## Architect re-review pass (2026-04-28) — STILL OPEN, MOVED BACK TO PENDING

Task was found in `tasks/review/` on 2026-04-28 architect intake but the round-2 P1 hold item #1 has not been applied. Current `frontend/src/pages/settings.js:614` calls `_performUpgradeKeyRotation` which bundles `account_update` broadcast (`:729`) AND the 3-key Keychain import loop (`:747-758`); backend cleanup at `:618` runs only AFTER the helper resolves. Mid-loop Keychain deny (popup 2 or 3) still throws out of the helper before backend cleanup fires — broadcast already landed on chain, mnemonic gets wiped in the catch, user wedged. The exact P1 lockout scenario round-2 specified.

The intervening FE-UPGRADE-CLOSURE-WIPE commit (`d6978a6`, merge `35c3c3b`) restructured this code by extracting `_performUpgradeKeyRotation` for closure-frame hygiene, but did NOT split broadcast and Keychain imports apart, did NOT introduce `upgradeWarnings`, and did NOT change error semantics for mid-loop Keychain deny. Items #2 (test for mid-loop deny) and #3 (50-char WIF stub fix) remain gated on #1.

`git mv`'d back to `tasks/pending/`. Implementer: apply round-2 items #1-3 (P1 lockout fix is the priority), then move back to `tasks/review/`. Note that the new structure (`_performUpgradeKeyRotation` helper) means the reorder is not just "move lines" — it likely splits the helper into `_broadcastAccountUpdate(...)` + `_importKeychainKeys(...)` so the caller can interleave backend cleanup between the two, and the Keychain step can fail without rejecting the helper.

## UI re-review signal (2026-04-28, working tree)

Items #1, #2, #3 from the round-2 hold all landed. Ready for architect round-3 re-review.

**#1 (P1) — `executeUpgrade()` reorder + best-effort Keychain loop.** `frontend/src/pages/settings.js`:
- Split `_performUpgradeKeyRotation()`: now does ONLY seed derivation + `account_update` broadcast. Returns `undefined` (closure-wipe invariant preserved). The Keychain import loop is no longer in this helper.
- New `_performKeychainImport(newSeedPhrase)` helper: re-derives `newKeys` locally so its frame holds the only references; iterates `['posting', 'active', 'memo']`; per-role `requestImportKey` failure becomes a `console.warn` for diagnostics + a localized warning pushed to `this.upgradeWarnings` (keys `upgrade.keychainImportWarning.<role>`); loop continues to next role on denial; never throws.
- `executeUpgrade()` ordering is now (a) validate → (b) `_performUpgradeKeyRotation` (broadcast) → (c) `/api/custody/upgrade` backend cleanup → (d) `_performKeychainImport` (best-effort) → (e) `_clearSensitiveUpgradeState` → (f) `upgradePhase = 'done'`. The (b)→(c) atomic pair lives inside the try/catch; (d) runs OUTSIDE the catch, so a denied popup mid-loop cannot wipe the mnemonic, cannot mark the upgrade as failed, and cannot skip backend cleanup. `newSeedPhrase` is snapshotted into a local `const` before the wipe so (d) can re-derive after `this.newSeedPhrase` is zeroed.
- New reactive field `upgradeWarnings: []`. Reset on `resetUpgrade()` and on entry to `executeUpgrade()` so a previous partial run never leaks into a subsequent success screen.
- Template: the `upgradePhase === 'done'` block now renders an amber `<ul>` of warnings via `<template x-for="(warning, i) in upgradeWarnings">` underneath the existing success copy. Empty on a fully-successful upgrade.
- i18n: added `upgrade.keychainImportWarning.{posting,active,memo}` to `frontend/public/messages/en.json` (real English copy, no emdashes). Stubbed identical English text into the 15 other locale files (`ar, cs, da, de, es, fa, fr, he, it, nl, pl, pt, sv, tr, zh`) per the UI agent stub convention. Appended a fresh `### Added 2026-04-28 (UI-KEYCHAIN-API-MISUSE)` sweep header to `frontend/public/messages/STUBS.md` with 45 lines (15 locales × 3 keys).

**#2 (P2) — Mid-loop Keychain denial unit tests.** `frontend/tests/unit/pages-settings.test.js`, two new specs in the FE-KEYCHAIN-API-MISUSE describe block:
- "best-effort: keychain denies on call index 1 (active) → done + active warning": stub returns `{success: false}` on call index 1, returns success on indices 0 and 2. Asserts `fetch('/api/custody/upgrade')` was called (single fetch call), `upgradePhase === 'done'`, `upgradeError === null`, `upgradeWarnings` contains `upgrade.keychainImportWarning.active`, all 3 import attempts ran (loop continued past denial).
- "best-effort: keychain denies on call index 0 (posting) → done + posting warning": same shape but denies on index 0. Asserts the posting-role warning + that loop continued (active + memo still attempted).

**#3 (P3) — `stubWifForHex` now produces 50-char WIFs + owner-WIF assertion uses stub function.** `frontend/tests/unit/pages-settings.test.js`:
- `stubWifForHex` changed from `'5K' + pad.repeat(49)` (51 chars) to `'5K' + pad.repeat(48)` (50 chars). Comment notes the real Hive WIF length.
- The owner-exclusion assertion in the "executeUpgrade imports posting + active + memo WIFs" test now derives the expected owner WIF via `stubWifForHex('a'.repeat(64))` rather than a hard-coded literal. A future stub-shape change flows through automatically.

**Verification:**
- `npx vitest run tests/unit/pages-settings.test.js` — 41 tests pass (was 38 before; +2 mid-loop denial tests, plus the existing posting-only-then-3-key test still passes against the new helper-split shape).
- `npx vitest run` (full unit suite) — 989/989 tests pass. One pre-existing failed *suite* (`tests/unit/sec-001-equivalence.test.js`) fails to load due to a backend-side import resolution issue unrelated to this task; verified to fail identically on stash.
- `npm run build` — clean (existing chunk-size + dhive-eval warnings unchanged from baseline).

## Architect re-review (2026-05-04) — HELD PENDING FIXES

Round-3 `/ce-code-review` on commit `2343aea`. The reorder + helper split + best-effort import landed cleanly and the round-2 hold P1 lockout (mid-loop deny wedging) is fixed. Round-3 surfaced one P1 second-injection-point + several smaller items.

1. **P1 — Pre-loop throw in `_performKeychainImport` defeats the round-3 lockout fix** (security + adversarial + correctness + testing, anchor 100). The inner try/catch wraps ONLY `requestImportKey` (`settings.js:822-831`). The helper's pre-loop setup is unwrapped:
   ```js
   async _performKeychainImport(newSeedPhrase) {
     if (!isKeychainInstalled()) return;
     const dhive = await import('@hiveio/dhive');           // can reject (network)
     const newSeed = mnemonicToSeedSync(newSeedPhrase);     // can throw
     const newKeys = deriveHiveKeys(newSeed, this.username); // can throw
     const importRoles = ['posting', 'active', 'memo'];
     for (const role of importRoles) {
       const wif = dhive.PrivateKey.fromSeed(newKeys[role]).toString(); // can throw
       try { await new Promise(...requestImportKey...); }
       catch (err) { /* push warning */ }
     }
   }
   ```
   The call site at `executeUpgrade:725` is `await this._performKeychainImport(newSeedPhrase)` OUTSIDE the try/catch (the try/catch already returned via early `return` on the error path at line 711). A throw from `await import('@hiveio/dhive')` (dynamic-chunk fetch fails on flaky network), `mnemonicToSeedSync` (corrupted seed), `deriveHiveKeys`, or `PrivateKey.fromSeed(...).toString()` escapes both the helper and `executeUpgrade`. Terminal state: chain rotated + backend cleaned up + mnemonic NOT wiped (lingers in `this.newSeedPhrase`, XSS-readable on /settings) + `upgradePhase` stuck at 'upgrading' (no recovery UI). Re-opens the FE-UPGRADE-CREDENTIAL-WIPE invariant via a different injection point.

   Fix: wrap the call site in `try/finally` so wipe + `upgradePhase = 'done'` run unconditionally:
   ```js
   try {
     await this._performKeychainImport(newSeedPhrase);
   } catch (err) {
     console.warn('[custody upgrade] keychain helper threw', err);
     this.upgradeWarnings.push(this.$t('upgrade.keychainImportFailed'));
   } finally {
     this._clearSensitiveUpgradeState();
     this.upgradePhase = 'done';
   }
   ```
   Add new i18n key `upgrade.keychainImportFailed` to `frontend/public/messages/en.json` + 15 locale stubs + a fresh `### Added 2026-05-04 (UI-KEYCHAIN-API-MISUSE)` STUBS.md sweep entry. Add a regression test stubbing `mnemonicToSeedSync` (or `deriveHiveKeys`) to throw; assert `upgradePhase === 'done'`, mnemonic wiped (`comp.newSeedPhrase` is empty), `upgradeWarnings` contains the new fallback key.

2. **P2 — Comment-vs-code drift on `newSeedPhrase` snapshot rationale** (correctness + maintainability + adversarial, anchor 100). At `frontend/src/pages/settings.js:614-617`:
   ```js
   // Snapshot the new seed phrase locally so the keychain-import step
   // (which runs AFTER _clearSensitiveUpgradeState wipes reactive state)
   // can still re-derive WIFs without holding onto `this.newSeedPhrase`.
   ```
   Actual order is keychain-import BEFORE wipe (lines 716, 725 of new diff). Comment is wrong. Invites refactor that "fixes" code to match comment, then deletes the now-redundant snapshot, breaking the upgrade. Fix: update the comment to reflect actual ordering AND state the snapshot's real purpose (closure-wipe — the helper receives a primitive-string argument and re-derives in its own frame so derived material doesn't escape):
   ```js
   // Snapshot the new seed phrase locally so the keychain-import helper
   // receives it as a primitive-string argument rather than reading
   // `this.newSeedPhrase` directly. This keeps the helper's frame the
   // only owner of derived material (closure-wipe invariant). The wipe
   // runs AFTER the keychain import (see ORDERING block above).
   ```

3. **P2 — Test gap: memo (idx 2) deny + all-three-deny scenarios uncovered** (testing + correctness, anchor 100). The round-2 hold spec called for "two specs: deny on idx 0 (posting) + idx 1 (active)" — implementer matched literally. But idx 2 (memo) is structurally distinct as the loop's last iteration ("loop continued past denial" assertion is vacuous there); all-three-deny is uncovered (does `upgradePhase` still reach 'done' with 3 warnings?). Add two specs in the existing FE-KEYCHAIN-API-MISUSE describe block:
   ```js
   it('best-effort: keychain denies on call index 2 (memo) → done + memo warning', async () => {
     // similar shape to existing specs; deny on idx === 2; assert posting + active succeeded, memo warning present
   });

   it('best-effort: keychain denies all three roles → done + 3 warnings', async () => {
     // deny on every callback; assert upgradePhase === 'done', upgradeError === null,
     // upgradeWarnings.length === 3, fetch (backend cleanup) was called once.
   });
   ```

4. **P2 — No ordering test: backend cleanup BEFORE first `requestImportKey`** (testing, anchor 75). The whole point of the round-3 reorder is backend cleanup BEFORE keychain loop, so mid-loop denial cannot leave backend with stale encrypted keys. Tests verify both happen but not ORDERING. A refactor swapping (c) and (d) — re-introducing the original lockout — passes the existing tests. Capture a shared sequence counter in `fetch` and `requestImportKey` stubs and assert `fetchSeq < firstImportSeq`.

5. **P3 — `isKeychainInstalled()` race silent return defeats the success-screen UX** (correctness + adversarial, anchor 100). At `_performKeychainImport`:
   ```js
   if (!isKeychainInstalled()) return;
   ```
   Returns without iterating, without pushing warnings. If extension is installed at start of upgrade (proven by the `account_update` sign at step b) but disabled by step (d) (auto-update, manual toggle, content-script crash), helper early-returns silently. User sees clean 'done' screen with NO warnings, but has zero Keychain-bound roles. First post-upgrade vote/comment/transfer fails because Keychain has no key for this account; no UI signal. Fix: push 3 role warnings before the early return:
   ```js
   if (!isKeychainInstalled()) {
     for (const role of ['posting', 'active', 'memo']) {
       this.upgradeWarnings.push(this.$t(`upgrade.keychainImportWarning.${role}`));
     }
     return;
   }
   ```
   Reuses the existing per-role i18n keys (no new keys needed). Add a test: stub `mockIsKeychainInstalled` to return true at `executeUpgrade` start (broadcast happens) but flip to false before `_performKeychainImport` runs (or stub the helper's `isKeychainInstalled` reference). Assert `upgradePhase === 'done'`, `upgradeWarnings.length === 3`, all 3 expected role-warning keys present.

6. **P3 — No test for `upgradeWarnings = []` reset on second-attempt entry** (testing, anchor 75). Inline comment at `settings.js:611-613` calls out this reset's purpose: prevent prior partial run from leaking warnings into a subsequent full-success run. No spec invokes `executeUpgrade` twice on the same component. Add:
   ```js
   it('upgradeWarnings is reset on each executeUpgrade attempt', async () => {
     // first run: deny one role → upgradeWarnings.length === 1
     // second run on same comp: all roles succeed → upgradeWarnings === []
   });
   ```

**Path to re-archive:** (1) UI agent applies items #1-6. (2) `git mv` to `tasks/review/`. (3) Architect runs round-4 `/ce-code-review` on the new diff and archives.

## UI re-review signal (2026-05-04, working tree)

Items #1-6 from the round-3 hold all landed. Ready for architect round-4 re-review.

**#1 (P1) — try/catch/finally wrap around `_performKeychainImport`.** `frontend/src/pages/settings.js`:
- The call site at the end of `executeUpgrade()`'s try block now wraps `await this._performKeychainImport(newSeedPhrase)` in `try { ... } catch (err) { console.warn('[custody upgrade] keychain helper threw', err); this.upgradeWarnings.push(this.$t('upgrade.keychainImportFailed')); } finally { this._clearSensitiveUpgradeState(); this.upgradePhase = 'done'; }`. A throw from any of the helper's pre-loop work (`await import('@hiveio/dhive')`, `mnemonicToSeedSync`, `deriveHiveKeys`, `PrivateKey.fromSeed(...).toString()`) now produces a single fallback warning + clean 'done' screen + wiped mnemonic instead of escaping both helper and `executeUpgrade`.
- New i18n key `upgrade.keychainImportFailed` added to `frontend/public/messages/en.json` ("Keychain import did not complete. You can retry from settings later."). Stubbed identical English text into the 15 other locale files (`ar, cs, da, de, es, fa, fr, he, it, nl, pl, pt, sv, tr, zh`) per the UI agent stub convention. Appended a fresh `### Added 2026-05-04 (UI-KEYCHAIN-API-MISUSE)` sweep header to `frontend/public/messages/STUBS.md` with 15 lines (15 locales × 1 key).
- Regression test "best-effort: helper throws (mnemonicToSeedSync rejects pre-loop) → done + fallback warning" forces the 3rd `mnemonicToSeedSync` call (the one inside `_performKeychainImport`'s pre-loop work) to throw via `vi.mocked(mnemonicToSeedSync).mockImplementation(...)` with a counter (calls 1+2 inside `_performUpgradeKeyRotation` succeed so the broadcast lands; only call 3 throws). Asserts `upgradePhase === 'done'`, `upgradeError === null`, mnemonic wiped (`newSeedPhrase`/`oldSeedPhrase` are empty), `upgradeWarnings` contains `t:upgrade.keychainImportFailed`.

**#2 (P2) — Comment-vs-code drift fix on the `newSeedPhrase` snapshot.** Comment at `frontend/src/pages/settings.js:614-621` rewritten to reflect actual ordering (keychain import runs BEFORE wipe, in the finally block) and state the snapshot's real purpose (closure-wipe — both helpers receive the seed phrase as a primitive-string argument rather than reading `this.newSeedPhrase` directly, so each helper's frame is the only owner of the derived material it produces).

**#3 (P2) — Memo deny + all-three-deny tests.** `frontend/tests/unit/pages-settings.test.js`, two new specs in the FE-KEYCHAIN-API-MISUSE describe block:
- "best-effort: keychain denies on call index 2 (memo) → done + memo warning": stub denies on index 2, asserts `fetchCalls.length === 1`, `upgradePhase === 'done'`, `upgradeWarnings` contains memo role key, `importKeyCalls.length === 3` (posting + active still attempted before).
- "best-effort: keychain denies all three roles → done + 3 warnings": stub denies on every callback, asserts `fetchCalls.length === 1` (backend cleanup fired exactly once, no retry on import failure), `upgradePhase === 'done'`, `upgradeError === null`, `importKeyCalls.length === 3`, `upgradeWarnings` contains exactly the 3 role-warning keys in `[posting, active, memo]` order.

**#4 (P2) — Ordering test: backend cleanup BEFORE first `requestImportKey`.** New spec "backend cleanup runs BEFORE the first keychain import attempt" captures a shared `seq` counter; both `fetch` and `requestImportKey` stubs assign `++seq` to `fetchSeq` / `firstImportSeq` on first invocation; asserts `fetchSeq < firstImportSeq`. Refactor guard: a swap of (c) backend cleanup and (d) keychain loop fails this assertion even though existing best-effort tests still pass.

**#5 (P3) — `isKeychainInstalled()` race surfaces 3 role warnings.** `frontend/src/pages/settings.js:824-837` (already in working tree from prior session): the early-return at the top of `_performKeychainImport` now pushes 3 per-role warnings (`upgrade.keychainImportWarning.{posting,active,memo}`) before returning, reusing the existing in-loop denial keys (no new i18n keys needed). New spec "isKeychainInstalled flips to false at helper time → done + 3 role warnings" stubs `mockIsKeychainInstalled.mockReturnValue(false)`, asserts `upgradePhase === 'done'`, `upgradeError === null`, `importKeyCalls.length === 0` (helper early-returned), `upgradeWarnings` contains exactly the 3 role keys in `[posting, active, memo]` order.

**#6 (P3) — `upgradeWarnings = []` reset on second-attempt entry test.** New spec "upgradeWarnings is reset on each executeUpgrade attempt" invokes `executeUpgrade()` twice on the same component: first attempt denies posting (warning surfaces), second attempt all-success (warnings cleared). Re-seeds sensitive fields between attempts (since the wipe ran). Asserts `upgradePhase === 'done'` after each attempt, first attempt's `upgradeWarnings` contains the posting warning, second attempt's `upgradeWarnings === []`.

**Verification:**
- `npx vitest run tests/unit/pages-settings.test.js` — 47/47 pass (was 41 before; +6 round-4 hold tests).
- `npx vitest run` (full unit suite) — 1024/1024 across 59 test files pass.
- `npm run build` — clean (existing chunk-size + dhive-eval warnings unchanged from baseline).

## Architect re-review (2026-05-15) — HELD PENDING FIXES

Round-4 `/ce-code-review` on commit `0a6b176`. The try/catch/finally wrap landed cleanly and the round-3 P1 pre-loop-throw injection point is closed (correctness, security, maintainability, project-standards all confirm zero findings). Round-4 surfaced 2 cross-reviewer-converged P1s + 1 P2 — the same wedged-state class reachable via non-throw injection paths the wrap was not designed for.

1. **P1 — Hung Keychain callback bypasses the round-4 try/finally** (adversarial + reliability + julik-frontend-races converge, anchor 100). `frontend/src/pages/settings.js:847` (inside `_performKeychainImport` loop body). Each role's import is `await new Promise(r => requestImportKey(username, wif, r))`. The Hive Keychain extension does not guarantee the callback fires if the user dismisses the popup by closing the extension UI, the content script wedges, or the extension is uninstalled mid-flow. A never-settling Promise means `await` never returns; the `finally` at the call site never runs. Terminal state matches the round-3 wedge exactly — chain rotated + backend cleaned + mnemonic still in `this.newSeedPhrase` + `upgradePhase` stuck at `'upgrading'` with no recovery UI. Fix: `Promise.race` each `requestImportKey` against a 30-45s timeout; the existing per-role catch handles the rejection so the loop continues to the next role on timeout:
   ```js
   const rolePromise = new Promise((resolve, reject) => {
     window.hive_keychain.requestImportKey(this.username, wif, (res) =>
       res.success ? resolve(res) : reject(new Error(res.message || 'Keychain import failed'))
     );
   });
   await Promise.race([
     rolePromise,
     new Promise((_, reject) => setTimeout(() => reject(new Error('keychain timeout')), 45_000)),
   ]);
   ```
   A new i18n key `upgrade.keychainImportTimeout.{posting,active,memo}` may be appropriate to distinguish timeout from denial in the warning surface; alternatively reuse the existing per-role `keychainImportWarning.<role>` if the distinction does not matter to the user (recommendation: reuse the existing keys — the user's recovery action is the same either way). Stub across 15 non-English locales + STUBS.md sweep entry if new keys are added. Add a regression spec that stubs a never-resolving `requestImportKey` for one or more roles and asserts (a) the helper returns after the timeout fires, (b) `upgradePhase === 'done'`, (c) mnemonic wiped (`newSeedPhrase` is empty), (d) `upgradeWarnings` contains the affected role warning(s).

2. **P1 — No concurrent-invocation guard on `executeUpgrade()`** (julik-frontend-races P1 + adversarial P2 + reliability P3-with-fix converge, anchor 100 after cross-reviewer promotion). `frontend/src/pages/settings.js:606`. The opening guard is a field-presence check (`!this.oldSeedPhrase.trim() || !this.upgradePassword`), not a phase guard. The `this.upgradePhase = 'upgrading'` assignment is synchronous but Alpine's reactive DOM update that hides the "Upgrade" button via `x-show="upgradePhase === 'enter-old'"` is batched and runs asynchronously. A double-click that lands inside the microtask window passes the field check, re-enters the method, and starts a parallel flow → two `account_update` broadcasts + two `/api/custody/upgrade` POSTs + potentially two 3-popup Keychain sequences. Fix: one-line phase guard at the top of `executeUpgrade()`:
   ```js
   if (this.upgradePhase !== 'enter-old') return;
   ```
   Add a regression spec that invokes `executeUpgrade()` twice without awaiting between calls and asserts exactly one broadcast (single `client.broadcast.sendOperations` / equivalent call recorded) and exactly one `/api/custody/upgrade` POST.

3. **P2 — Backend-cleanup fetch has no timeout** (reliability, anchor 75). `frontend/src/pages/settings.js:662` (the `fetch('/api/custody/upgrade', { method: 'POST', ... })` call). No `signal: AbortSignal.timeout(...)`, no manual race. If the backend hangs after `account_update` lands on-chain, the flow blocks on `await fetch(...)` until OS-level TCP teardown — minutes for a half-open socket, unbounded for a stalled response stream. During the hang, `upgradePhase` is stuck at `'upgrading'` with no escape and the mnemonic stays in reactive state. Different boundary than items #1 and #2 but the same wedged-state class. Fix: pass `signal: AbortSignal.timeout(20000)` to the fetch (20s budget — adjust based on the backend cleanup's normal p99). The existing fetch error path runs on abort; set `upgradeError` to a localized timeout-specific message. Add a new i18n key `upgrade.backendTimeout` ("Backend cleanup did not respond. The on-chain update succeeded; the server may be temporarily slow. Please contact support if this persists." or similar — no emdash) so the timeout vs. backend-rejection distinction is user-readable; stub across 15 non-English locales + STUBS.md sweep entry per UI agent convention. Add a regression spec that stubs `fetch` to return a never-resolving Promise (or to `await new Promise(() => {})`), runs `executeUpgrade()`, and asserts (a) AbortSignal fires after the budget, (b) `upgradeError` is set to the timeout message, (c) mnemonic is NOT wiped (the failure here is a real error — cleanup never succeeded, so the upgrade is in a partially-applied state the user should be aware of), (d) `upgradePhase` is set to `'error'`, not `'done'`.

**Dismissed from round-4 findings:**

- **P2 — Hold-#1 regression test coupled to `mnemonicToSeedSync` call count** (testing + adversarial converge, anchor 100). The "helper throws — mnemonicToSeedSync rejects pre-loop" spec uses a closure-captured counter to throw on call 3 (assumes 2 calls in `_performUpgradeKeyRotation`, then the 3rd lands in `_performKeychainImport`). Failure mode: a future refactor of `_performUpgradeKeyRotation` that drops one `mnemonicToSeedSync` call would silently route the throw to the broadcast step; the test would still pass but exercise the wrong code path. Dismissed per the preemptive-test-hardening default-dismiss rule — current code matches the assumption and passes correctly; the failure mode requires a future refactor to materialize. Re-evaluate at the time of any `_performUpgradeKeyRotation` refactor.

- **P3 — Ordering test silently degrades if a second `fetch` is added to `executeUpgrade`** (adversarial, anchor 75). The "backend cleanup runs BEFORE the first keychain import attempt" spec captures `fetchSeq` on first invocation without filtering on URL. Future-refactor failure mode: a refactor that adds a second `fetch` to `executeUpgrade` (status probe, telemetry beacon) would silently break the ordering invariant the test claims to enforce. Dismissed per the preemptive-test-hardening default-dismiss rule — current code has one fetch in `executeUpgrade` and the assertion holds.

**Filed separately (not part of this hold block):**

- **P3 — Copy promises a retry path the UI does not expose** (reliability, anchor 75). The fallback warning `upgrade.keychainImportFailed` and the per-role `upgrade.keychainImportWarning.{posting,active,memo}` warnings tell the user to "retry from settings later" but no standalone re-import affordance exists. Filed as `agents/docs/tasks/blocked/ui-keychain-warning-copy-or-retry-action.md` with `[BLOCKED by Architect]` — direction (rewrite copy vs. add re-import button) needs a brainstorm pass before implementation.

**Path to re-archive:** (1) UI agent applies items #1-3. (2) `git mv` to `tasks/review/`. (3) Architect runs round-5 `/ce-code-review` on the new diff and archives if clean.

## UI re-review signal (2026-05-15, working tree)

Items #1, #2, #3 from the round-4 hold all landed. Ready for architect round-5 re-review.

**#1 (P1) — Promise.race timeout on requestImportKey.** `frontend/src/pages/settings.js` `_performKeychainImport` loop body. Each role's `requestImportKey` await now races a 45s `setTimeout` rejection. A hung Keychain callback (dismissed via extension UI, content-script wedge, extension uninstalled mid-flow) was previously never-settling and left the per-role `await` permanently pending — loop stalled, call-site `finally` never ran, user wedged. The race converts a hang into a normal per-role rejection that the existing catch surfaces as a `upgrade.keychainImportWarning.<role>` warning, loop proceeds to the next role. Per architect recommendation: reused the per-role warning keys for both timeout and denial paths (user's recovery action is the same either way — "retry from settings later"). No new i18n keys for timeout vs denial distinction.

**#2 (P1) — Concurrent-invocation phase guard.** `frontend/src/pages/settings.js` `executeUpgrade()` top of method: one-line `if (this.upgradePhase !== 'enter-old') return;`. The only legal entry phase is `'enter-old'` (set by `confirmNewSeed()`). A double-click landing inside Alpine's reactive-DOM-update microtask window previously passed the field-presence check (`!oldSeedPhrase.trim() || !upgradePassword`), re-entered the method, and started a parallel flow (two broadcasts + two backend POSTs + two 3-popup Keychain sequences). The phase set `this.upgradePhase = 'upgrading'` is synchronous, so the second invocation now short-circuits at the guard. All existing upgrade-flow tests updated to set `comp.upgradePhase = 'enter-old'` before invoking `executeUpgrade()` (3 `seedUpgradeState` helpers + 9 inlined setups + the nested `seed()` inside the reset-warnings spec).

**#3 (P2) — AbortSignal.timeout(20_000) on backend cleanup fetch.** `frontend/src/pages/settings.js` `fetch('/api/custody/upgrade', ...)`: added `signal: AbortSignal.timeout(20_000)` to bound the request budget. The catch block now special-cases `err.name === 'TimeoutError' || err.name === 'AbortError'`: routes to the new `upgrade.backendTimeout` i18n key, sets `upgradePhase = 'error'`, and does NOT wipe the mnemonic — the upgrade is partially applied (chain rotated, backend cleanup pending) and the user may need the mnemonic to contact support or for manual recovery. All other catch behavior (wipe + `upgrade.failed` + phase=error) preserved for non-timeout failures.

**i18n.** New key `upgrade.backendTimeout` added to `frontend/public/messages/en.json` ("Backend cleanup did not respond in time. The on-chain update succeeded, so your keys have rotated, but the server has not confirmed cleanup. Please contact support if this persists."). Stubbed identical English text into the 15 other locale files (`ar, cs, da, de, es, fa, fr, he, it, nl, pl, pt, sv, tr, zh`) per UI agent stub convention. Appended a fresh `### Added 2026-05-15 (UI-KEYCHAIN-API-MISUSE)` sweep header to `frontend/public/messages/STUBS.md` with 15 lines (15 locales × 1 key).

**Tests.** `frontend/tests/unit/pages-settings.test.js` FE-KEYCHAIN-API-MISUSE describe block — three new round-5 specs:
- "best-effort: hung requestImportKey callback → done + role warning after timeout": uses `vi.useFakeTimers()`. First requestImportKey callback never fires (hang); active + memo settle normally. `vi.advanceTimersByTimeAsync(46_000)` fires the race's setTimeout. Asserts `fetchCalls.length === 1`, `upgradePhase === 'done'`, posting role warning present, loop continued (3 import attempts), mnemonic wiped.
- "concurrent double-call to executeUpgrade → exactly one broadcast + one backend POST": invokes `executeUpgrade()` twice without awaiting between calls. Spies on `Client.broadcast.sendOperations` independently of fetch. Asserts `sendOpsSpy === 1` and `fetchCalls.length === 1` — the second invocation short-circuits at the phase guard.
- "backend cleanup fetch timeout → upgradeError + phase=error, mnemonic NOT wiped": uses `vi.useFakeTimers()`. Stubs fetch to honor `opts.signal` (rejects with `signal.reason` on abort). `vi.advanceTimersByTimeAsync(21_000)` triggers `AbortSignal.timeout(20_000)`. Asserts `upgradePhase === 'error'`, `upgradeError === 'upgrade.backendTimeout'`, mnemonic preserved (both `newSeedPhrase` and `oldSeedPhrase` match the original inputs).

**Test-fixture update.** The phase-guard addition required `comp.upgradePhase = 'enter-old';` in every upgrade-flow test setup — 3 `seedUpgradeState` helpers (FE-UPGRADE-CREDENTIAL-WIPE, FE-UPGRADE-CLOSURE-WIPE, FE-SAVESESSION-API-MISUSE-SWEEP) and 9 inlined setup blocks across FE-KEYCHAIN-API-MISUSE specs and the nested `seed()` helper in the reset-warnings spec. Each updated site carries a comment explaining the round-5 fixture requirement.

**Verification.**
- `npx vitest run tests/unit/pages-settings.test.js` — 55/55 pass (was 52 before; +3 round-5 hold tests).
- `npx vitest run` (full unit suite) — 1112/1112 across 60 test files pass. Three pre-existing unhandled rejections in `tests/unit/pages-edit.test.js` (abstractEditor cleanup race) reproduce on the standalone run unchanged.
- `npm run build` — clean (existing chunk-size + dhive-eval warnings unchanged from baseline).

## Architect re-review (2026-05-15b) — HELD PENDING FIXES

Round-5 `/ce-code-review` on commit `8c6b352` (9 personas: correctness/security/adversarial at Opus, testing/maintainability/project-standards/learnings/reliability/julik-frontend-races at Sonnet; `ce-agent-native-reviewer` skipped per project `CLAUDE.md`). Round-4 hold #1 (Promise.race 45s timeout on `requestImportKey`), #2 (phase guard), #3 (AbortSignal.timeout(20_000) + TimeoutError catch) all landed. Round-5 surfaced 1 cross-reviewer-converged P1 + 1 P2 + 2 P3s the architect verified empirically before triage.

1. **P1 — Timeout-error recovery story is structurally broken** (reliability + security + adversarial + correctness converge, 4-reviewer cross-promotion, anchor 100). The round-4 hold #3 introduced a deliberate no-wipe-on-timeout decision with the rationale "the upgrade is partially applied (chain rotated, backend cleanup pending) and the user may need the mnemonic to contact support or for manual recovery" — but the recovery affordance does not exist in the UI:
   - The error-phase template at `frontend/src/pages/settings.js:36-41` renders only the localized error string (`x-text="upgradeError"`) and a single button bound to `resetUpgrade()`. There is no `x-text`/`x-for` rendering of `newSeedWords`/`newSeedPhrase` on the error screen, so the preserved mnemonic is invisible to the user.
   - `resetUpgrade()` at `frontend/src/pages/settings.js:949-955` unconditionally calls `_clearSensitiveUpgradeState()`, which wipes `newSeedPhrase`, `oldSeedPhrase`, `newSeedWords`, `confirmInputs`, and `upgradePassword` to empty strings. The "Try Again" button is therefore a one-click destructor for the preserved recovery artifact.
   - Side-finding (security): preserving `oldSeedPhrase` on the timeout path adds zero recovery value — that mnemonic controls the now-defunct keyset after `account_update` landed. Pure XSS surface; nothing to recover from.
   - Worst-of-both-worlds: the mnemonic lingers in DOM-reachable Alpine reactive state indefinitely (any browser extension content script with `tabs`/`scripting` permission can read `Alpine.$data(el).newSeedPhrase`) while delivering none of the support-recovery affordance the design promised.

   **Resolution direction (architect):** revert the no-wipe decision on the timeout branch — wipe both seeds, same as the generic error branch — and pair the wipe with stronger error-phase copy that surfaces the chain-rotated/backend-stale state to the user. The user already saw + confirmed the new mnemonic in the `new-seed` and `confirm-new` phases (so they should have written it down before clicking Execute), and `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` validates the retry-semantics principle (the timeout outcome is uncertain, not failed) but does NOT mandate keeping secrets in DOM state to express that semantic. Concretely:
   - In the `TimeoutError`/`AbortError` catch branch, call `this._clearSensitiveUpgradeState()` before setting `upgradePhase = 'error'`.
   - Update the `upgrade.backendTimeout` English copy to convey: backend cleanup did not confirm in time; on-chain keys have rotated; if Keychain shows your account with posting+active+memo keys you are safe to proceed; otherwise contact support with your account name (NOT the mnemonic — the user keeps the mnemonic via the write-down step earlier). No emdashes.
   - Update the 15 locale stubs accordingly and append a fresh `### Updated 2026-05-15 (UI-KEYCHAIN-API-MISUSE round-6)` entry to `frontend/public/messages/STUBS.md`.
   - Update the fetch-timeout test at `frontend/tests/unit/pages-settings.test.js` to assert mnemonic IS wiped (`comp.newSeedPhrase === ''` and `comp.oldSeedPhrase === ''`) and `upgradePhase === 'error'`. The current assertion (mnemonic preserved) is the round-5 behavior being reversed.

   If the implementer has a stronger design alternative — e.g., a "save your seed phrase" copy-acknowledgement affordance on the error screen that wipes on user click — push back with that proposal before implementing. The reverted-wipe is the simpler safe default but is not the only correct shape.

2. **P2 — Phase-guard comment misdescribes the invariant** (julik-frontend-races, anchor 80). At `frontend/src/pages/settings.js:607-617` the 9-line comment claims the guard exists because *"Alpine's reactive DOM update that hides the 'Upgrade' button (via `x-show=\"upgradePhase === 'enter-old'\"`) is batched. A double-click landing inside the microtask window would otherwise pass the field check, re-enter the method, and start a parallel flow..."*. The diagnosis is wrong on mechanism. JS is single-threaded; `x-on:click` callbacks dispatch synchronously to the handler, which runs to its first `await`; `this.upgradePhase = 'upgrading'` is assigned before yielding. A second synchronous click event fires *after* that assignment, sees the new phase, and is blocked by the guard regardless of how Alpine batches DOM updates. The guard IS load-bearing — it defends against the genuine mid-flight re-entry case where `executeUpgrade` is suspended at an `await` (sendOperations, fetch, _performKeychainImport) and a subsequent invocation starts — but the "Alpine batched DOM update" framing in the comment is misleading. Fix: rewrite the comment to describe the actual invariant — *the phase assignment runs synchronously before the first `await`, so any subsequent invocation (whether synchronously back-to-back or genuinely concurrent via a later `x-on:click`, a stray $watch/x-effect, or any other re-entry path) sees the mutated phase and short-circuits at the guard.*

3. **P3 — `confirmNewSeed()` referenced in comments does not exist** (correctness + adversarial converge, anchor 100, factually verified by architect). `frontend/src/pages/settings.js:616` and the 12 test-fixture comments at `frontend/tests/unit/pages-settings.test.js` (the 3 `seedUpgradeState` helpers + 9 inlined setup blocks) all describe `'enter-old'` as *"set by `confirmNewSeed()`"*. `confirmNewSeed` does not exist in the codebase. The actual setter is `proceedToOldSeed()` at `frontend/src/pages/settings.js:599`. Mechanical fix: `s/confirmNewSeed/proceedToOldSeed/g` across the 13 sites.

4. **P3 — Orphan `setTimeout(45_000)` in `Promise.race` is never cleared on import success** (correctness + reliability + julik-frontend-races converge, anchor 75). At `frontend/src/pages/settings.js:903-909` the timeoutPromise's `setTimeout` is not paired with a `clearTimeout` when `importPromise` wins the race. The timer + closure stay live for up to 45s × 3 roles = ~135s per successful upgrade. **Important fact-check** (architect ran a node repro before triage): the eventual rejection does NOT fire `unhandledrejection` — `Promise.race` internally attaches `.then(resolve, reject)` to losing inputs, so the rejection is *handled* (silently swallowed by the now-settled race's internal reject). julik's specific harm claim about `showErrorToast()` firing on the success screen was empirically falsified; the orphan timer is a cleanliness/resource concern only. Fix: capture the timer id and clear it after the race resolves. Idiomatic 3-line pattern:
   ```js
   let timerId;
   const timeoutPromise = new Promise((_, reject) => {
     timerId = setTimeout(() => reject(new Error('keychain timeout')), 45_000);
   });
   try {
     await Promise.race([importPromise, timeoutPromise]);
   } finally {
     clearTimeout(timerId);
   }
   ```
   The existing per-role `catch (err)` block sits at the next outer scope; the `try/finally` here is purely for `clearTimeout` ordering and does not interfere with the warning-on-rejection path.

**Dismissed from round-5 findings:**

- **P2 — 9 inlined `phase = 'enter-old'` blocks duplicate the helper-function additions** (maintainability M-1, anchor 75). Per `feedback_dismiss_preemptive_test_hardening.md`: the duplication's failure mode is a hypothetical future invariant change touching 12 sites instead of 3. No current failure mode; mechanical grep-replace if it ever materializes. Default-dismiss applies.

- **P2 — Double-click test exercises synchronous back-to-back invocations, not mid-flight re-entry** (julik-frontend-races JFR-R5-03, anchor 75). The current test verifies the guard fires (assertions would fail if removed); it does not exercise the genuine mid-flight scenario where p1 is suspended at an `await` and a second invocation starts. Failure mode is theoretical (future refactor moves `phase = 'upgrading'` past the first await). Default-dismiss per preemptive-test-hardening rule.

- **P3 — `err.name === 'AbortError'` branch in timeout catch is unreachable today** (reliability R-R5-03, anchor 90). No external `AbortController` feeds this fetch; only `AbortSignal.timeout()` does, and per spec that produces `TimeoutError`. Latent trap if a future user-cancel feature is added (cancel path would silently inherit timeout semantics). Dismissed because the future feature's review will catch it, and defensive OR-broadening on error-name discriminators is a tolerable pattern.

**Filed separately (not part of this hold block):**

- **Process note (project-standards PS-001, anchor 100)** — the `git mv pending/ → review/` for the round-5 fix landed in commit `959ac70`, a separate follow-up from the fix commit (`8c6b352`). Per project `CLAUDE.md` rule #8, the move IS the re-review signal and must accompany the fix commit. For round-6, please stage the per-task-file edits AND the `git mv` in the same commit (the round-5 path was: `git add` your edits → `git mv pending/ review/` → `git commit` with both staged). Process observation only; not a blocking hold-item.

**Architect fact-checks performed before triage:**
- Verified `frontend/src/error-tracking.js:15-18` does register a `window.addEventListener('unhandledrejection', ...)` handler that calls `showErrorToast()` — but verified empirically (node repro) that `Promise.race` losing-input rejections do NOT trigger `unhandledrejection` because the race attaches `.then(resolve, reject)` internally. Finding #4's harm-claim downgraded from P1 to P3.
- Verified `proceedToOldSeed()` exists at `frontend/src/pages/settings.js:599` and `confirmNewSeed` does not exist in the codebase. Finding #3 confirmed.
- Verified the error template at `frontend/src/pages/settings.js:36-41` shows error text + `resetUpgrade()` button only — no mnemonic display. Verified `resetUpgrade()` at `:949-955` calls `_clearSensitiveUpgradeState()`. Finding #1's structural-breakage chain confirmed.

**Path to re-archive:** (1) UI agent applies items #1-4 on this task. (2) Stage edits AND `git mv tasks/pending/ui-keychain-api-misuse.md tasks/review/` in one commit (rule #8). (3) Architect runs round-6 `/ce-code-review` on the new diff and archives if clean. Item #1 is cross-cutting (touches settings.js error-phase template + catch branch + i18n + test assertions); expect a thorough review.

## UI re-review signal (2026-05-15, working tree)

Items #1-4 from the round-5 hold all landed. Ready for architect round-6 re-review.

**#1 (P1) — Wipe-on-timeout revert + updated copy.** `frontend/src/pages/settings.js` TimeoutError/AbortError catch branch (~`:732-741`): inserted `this._clearSensitiveUpgradeState();` before `this.upgradePhase = 'error';`. The mnemonic is now wiped on the timeout path (same as the generic error branch). The two surrounding comment blocks were rewritten to drop the round-5 "preserve the mnemonic for support recovery" rationale and state the new rationale explicitly — the user already saw + confirmed the new mnemonic in the new-seed/confirm-new phases, so keeping it in reactive Alpine state past the error screen is pure XSS surface with no recovery value.

**i18n.** `upgrade.backendTimeout` rewritten in `frontend/public/messages/en.json`. New copy: *"Backend cleanup did not confirm in time. Your on-chain keys have already rotated. If Hive Keychain shows your account with posting, active, and memo keys, you are safe to continue. Otherwise contact support with your account name. Do not share your recovery phrase."* No emdashes. Mentions Keychain-check path + contact-support path + explicit "do not share recovery phrase" guard (matches the architect-specified content: chain rotated, Keychain check, support with account name not mnemonic). Stubbed identical English text into all 15 non-English locale files (`ar, cs, da, de, es, fa, fr, he, it, nl, pl, pt, sv, tr, zh`). Appended a fresh `### Updated 2026-05-15 (UI-KEYCHAIN-API-MISUSE round-6)` sub-heading to `frontend/public/messages/STUBS.md` with 15 lines (the existing round-5 `### Added ...` entries above remain so translators can resolve via either section).

**Test update.** `frontend/tests/unit/pages-settings.test.js` round-5 fetch-timeout spec renamed from `"...mnemonic NOT wiped"` to `"...mnemonic IS wiped"`. Assertions flipped: `expect(comp.newSeedPhrase).toBe('')` and `expect(comp.oldSeedPhrase).toBe('')` (was: `.toBe(newMnemonic)` / `.toBe(oldMnemonic)`). The surrounding comment block was updated to cross-reference round-6 hold #1 and document the round-5 → round-6 transition.

**#2 (P2) — Phase-guard comment rewrite.** `frontend/src/pages/settings.js:607-620` (the 9-line block above the `if (this.upgradePhase !== 'enter-old') return;` guard) rewritten to describe the actual invariant — phase assignment runs synchronously before the first `await`, so any subsequent invocation (back-to-back x-on:click, mid-flight re-entry during a suspended await like sendOperations / fetch / _performKeychainImport, stray $watch/x-effect triggered by the phase change) observes the mutated phase and short-circuits. Dropped the misleading "Alpine batched DOM update + microtask window" framing.

**#3 (P3) — `confirmNewSeed` → `proceedToOldSeed` rename.** `frontend/src/pages/settings.js`: the rewritten phase-guard comment (item #2) now references `proceedToOldSeed()` (the actual setter at `:599`). `frontend/tests/unit/pages-settings.test.js`: mechanical replace_all swept 12 sites (3 `seedUpgradeState` helpers + 9 inlined setup comment blocks). Verified via `grep -c confirmNewSeed` — 0 remaining references in either file.

**#4 (P3) — `clearTimeout` for orphan setTimeout in `Promise.race`.** `frontend/src/pages/settings.js` `_performKeychainImport` loop body (~`:907-924`): captured `let timerId` outside the `timeoutPromise` Promise constructor, wrapped `await Promise.race([importPromise, timeoutPromise])` in a `try { ... } finally { clearTimeout(timerId); }`. Successful imports and denied imports both now clear the 45s timer immediately; the prior 45s × 3 = ~135s of orphan timers per successful upgrade is gone. The existing per-role `catch (err)` block sits at the outer scope; the inner `try/finally` does not interfere with the warning-on-rejection path. No test changes needed (the timer cleanup is observable via timer-id introspection only, which is not a useful behavioral assertion; the dismissal note in the architect's hold #4 fact-check already documents that the rejection is silently swallowed by Promise.race's internal handler, so there is no user-visible state change to assert against).

**Verification.**
- `npx vitest run tests/unit/pages-settings.test.js` — 55/55 pass.
- `npx vitest run` (full unit suite) — 1112/1112 across 60 test files pass. Three pre-existing unhandled rejections in `tests/unit/pages-edit.test.js` (abstractEditor cleanup race) reproduce on standalone run unchanged from prior signal.
- `npm run build` — clean (existing chunk-size + dhive-eval warnings unchanged from baseline).

## Architect re-review (2026-05-15c) — HELD PENDING FIXES

Round-6 `/ce-code-review` on commit `1b0c3ed` (9 personas: correctness/security/adversarial at Opus, testing/maintainability/project-standards/learnings/reliability/julik-frontend-races at Sonnet; `ce-agent-native-reviewer` skipped per project `CLAUDE.md`). Round-5 hold #1 (wipe-on-timeout + copy update), #2 (phase-guard comment rewrite), #3 (confirmNewSeed→proceedToOldSeed rename), #4 (clearTimeout(timerId)) all landed cleanly per correctness/security/julik-frontend-races/learnings (zero findings). Round-6 surfaced 1 cross-reviewer-converged P1 + 1 multi-reviewer-converged P1 + 1 P2 + 1 P3 in the new copy + error-screen-recovery surface.

1. **P1 — `upgrade.backendTimeout` copy directs the user to verify Keychain on a path where Keychain import never ran** (adversarial 90 + reliability 95 converge, cross-reviewer promoted to P1, anchor 100). `frontend/public/messages/en.json:995`. The new copy says *"If Hive Keychain shows your account with posting, active, and memo keys, you are safe to continue."* But on the backend-timeout branch the catch at `frontend/src/pages/settings.js:746` returns BEFORE `_performKeychainImport` runs — Keychain has never been asked to import the new keys on this path. Two failure modes:
   - User has no prior Keychain entry for this username → sees nothing → false-panic support contact for what may be a transient slow backend.
   - User has a stale Keychain entry from a pre-upgrade manual install → sees keys → incorrectly concludes "safe" → next signing op fails on stale keys with no UI signal.

   Fix: drop the Keychain-verification sentence entirely and replace with copy accurate to this path. Constraints: (a) accurate (on-chain rotation succeeded, Keychain import did NOT run yet, backend cleanup uncertain), (b) no emdashes, (c) no instructions the user cannot mechanically follow on this path. Direction: tell the user backend cleanup did not confirm in time; on-chain keys have rotated; Keychain has not been updated yet; contact support with your account name; do not share your recovery phrase. Implementer can refine wording. Update the 15 locale stubs accordingly and revise the STUBS.md sweep entry per items #3/#4 below. Existing test at `frontend/tests/unit/pages-settings.test.js:1809` already asserts `upgradeError === 'upgrade.backendTimeout'` — the assertion holds across a copy rewrite.

2. **P1 — "Try Again" button on the backend-timeout error sub-case is a dead-end** (adversarial 75 + reliability 90 converge, anchor 100, factually verified by architect: `startUpgrade()` at `settings.js:567` generates a NEW mnemonic, and `_performUpgradeKeyRotation` would sign with old seed-derived keys → chain rejects since previously-attempted rotation already landed). `frontend/src/pages/settings.js:973` (`resetUpgrade()`) flips phase to `'idle'`; the user clicks "Start"; `startUpgrade()` generates a fresh mnemonic-N+1; user re-enters their original light-account old seed at enter-old; `_performUpgradeKeyRotation` signs `account_update` with old seed-derived keys; chain rejects with `Missing Authority` because the chain's owner key is now mnemonic-N from the prior attempt; falls into the generic `upgrade.failed` catch with no specific guidance. The "Try Again" affordance is the only forward-facing UI on the error screen and it routes the user into a guaranteed failure.

   Fix: conditionally hide the "Try Again" button when `upgradeError === 'upgrade.backendTimeout'`. The error-phase template at `frontend/src/pages/settings.js:36-41` needs a sub-case branch. Recommendation: hide the button entirely on this sub-case and let the (revised per item #1) copy be the user's sole instruction (contact support, page reload, etc.). Alternatives the implementer may prefer:
   - Replace with a "Contact support" link mirroring the copy.
   - Re-purpose the button to call `window.location.reload()` so the user escapes the wedged-state component cleanly.

   Add a unit test asserting the button is hidden (or `disabled`) when `upgradeError === 'upgrade.backendTimeout'` and present on the generic-error case so refactors don't silently re-enable the dead-end.

3. **P2 — `STUBS.md` two-section ambiguity for `upgrade.backendTimeout`** (maintainability 75, anchor 75). `frontend/public/messages/STUBS.md` lines 897-932 now contain two structurally-identical 15-locale listings for the same key under separate `Added 2026-05-15 (UI-KEYCHAIN-API-MISUSE)` and `Updated 2026-05-15 (UI-KEYCHAIN-API-MISUSE round-6)` headings. A grep for `fr: upgrade.backendTimeout` returns two hits; a future cleanup script or translator pass cannot mechanically tell which is canonical. The inline prose note ("translators can resolve via either section") shifts the disambiguation cost to the reader rather than fixing it.

   Fix: collapse to one canonical section by deleting the round-5 `Added 2026-05-15 (UI-KEYCHAIN-API-MISUSE)` block for `upgrade.backendTimeout` entirely (the new round-6 copy supersedes it). Keep only the round-6 entry. Pair with item #4 below to also normalize the heading.

4. **P3 — `STUBS.md` heading deviates from `agents/ui/CLAUDE.md` convention** (project-standards 90, anchor 100). Current heading `### Updated 2026-05-15 (UI-KEYCHAIN-API-MISUSE round-6)`. Documented form (`agents/ui/CLAUDE.md`, Internationalization): `### Added <YYYY-MM-DD> (<task-slug>)`. Deviations: `Updated` is not a documented keyword; the parenthetical uses uppercase + a free-form ` round-6` qualifier that's not part of the task slug `ui-keychain-api-misuse`.

   Fix: after the item #3 collapse, the surviving canonical heading should read `### Added 2026-05-15 (ui-keychain-api-misuse)` — matches both the documented keyword and the slug casing. The prose below already explains "source text was revised", so the heading does not need to encode `round-6` or `Updated` semantics.

**Dismissed from round-6 findings:**

- **P1 — Wipe-on-timeout vs 3-word-confirm asymmetry** (adversarial 75, anchor 75). The mnemonic-loss vector requires a user to (a) memorize 3 random words during the confirm step (`CONFIRM_WORD_COUNT = 3` at `frontend/src/pages/settings.js:8`, architect-verified) but (b) skip transcribing the full 12 words despite the explicit "Write it down" instruction in the new-seed phase. User triage 2026-05-15c: the trade-off is accepted — users who memorize the sample confirm words and skip transcribing the rest accept the recovery risk; the architect's round-5 rationale stands. Re-evaluate if the confirm-step UX is revisited in a separate task.

- **P3 — Stale `auth.token`/`auth.custody` after timeout branch** (adversarial 60, anchor 50). `auth.loginFromResponse` never runs on the timeout branch; client retains the old JWT/custody marker. Window is narrow; the item #2 "Try Again" hide and the copy-mandated support-contact route the user to support or a page reload before further in-session API calls fire. Re-evaluate if reported.

- **P3 — Cross-tab phase-guard limit** (adversarial 50, anchor 50). The phase-guard is per-Alpine-instance; multi-tab users can race two parallel flows. Chain rejection bounds the damage (only one `account_update` lands; the other fails with auth error and routes through the standard error path). Aligns with PEvO's single-instance / no-distributed-coordination posture per `agents/docs/solutions/conventions/...` and project memory `project_single_instance_only.md`. Engineering localStorage-coordination for cross-tab serialization is significant scope for a narrow risk.

- **P3 — Timeout-wipe test asserts only 2 of 5 sensitive fields** (testing 55, anchor 75). `frontend/tests/unit/pages-settings.test.js:1796`. The flipped assertion checks `newSeedPhrase`/`oldSeedPhrase` but not `upgradePassword`, `newSeedWords`, `confirmInputs`. Per `feedback_dismiss_preemptive_test_hardening.md` default-dismiss rule: the generic-error-path test at `pages-settings.test.js:466` already exercises all 5 fields via the same helper, so any mutation to `_clearSensitiveUpgradeState()` itself is caught elsewhere. The gap only opens if someone replaces the helper call with partial inline clears specifically in the timeout branch — plausible but narrow.

- **P3 — No `vi.getTimerCount()` assertion for `clearTimeout(timerId)`** (testing 45, anchor 50). The architect's round-5 hold-#4 fact-check concluded "no useful behavioral assertion possible" based on the empirically-falsified `unhandledrejection` harm claim; the testing reviewer correctly notes `vi.getTimerCount()` is one such assertion. Per `feedback_dismiss_preemptive_test_hardening.md` default-dismiss rule: failure mode is cleanliness-only (~135s of orphan timers per upgrade) with no user-visible effect; the architect's prior fact-check covered the user-visible harm dimension and the dismissal stands on those grounds.

**Architect fact-checks performed before triage:**
- Verified `CONFIRM_WORD_COUNT = 3` at `frontend/src/pages/settings.js:8` and the `pickRandomIndices(this.newSeedWords.length, CONFIRM_WORD_COUNT)` call at `:593` — the confirm-new phase samples 3 random words, does not enforce the full 12. Dismissed-finding mnemonic-loss vector is real; rationale for dismissal is user-triage acceptance of the trade-off, not absence of the bypass path.
- Verified `startUpgrade()` at `:567` generates a NEW mnemonic on each invocation and that `_performUpgradeKeyRotation` signs with old seed-derived keys (no in-memory short-circuit to the prior attempt's mnemonic). Finding #2's chain-rejection-on-retry claim confirmed.
- Verified `_performKeychainImport` is structurally unreachable from the TimeoutError catch branch (catch at `settings.js:746` returns before the call site at `:782`). Finding #1's "Keychain import never ran on this path" claim confirmed.

**Path to re-archive:** (1) UI agent applies items #1-4 on this task. (2) Stage edits AND `git mv agents/docs/tasks/pending/ui-keychain-api-misuse.md agents/docs/tasks/review/ui-keychain-api-misuse.md` in a single commit (rule #8; round-5 PS-001 process note remains in effect). (3) Architect runs round-7 `/ce-code-review` on the new diff and archives if clean. Items #1 + #2 touch the settings.js error-phase template + en.json + locale stubs + tests; the scope is small but cross-cutting, expect a focused review.

## UI re-review signal (2026-05-15, working tree)

Items #1-4 from the round-6 hold all landed. Ready for architect round-7 re-review.

**#1 (P1) — `upgrade.backendTimeout` copy rewritten to drop the Keychain-verification sentence.** `frontend/public/messages/en.json:995`. New copy: *"Backend cleanup did not confirm in time. Your on-chain keys have already rotated, but Hive Keychain has not been updated yet. Please contact support with your account name. Do not share your recovery phrase."* No emdashes. The four content points the architect specified are present: (a) chain rotated, (b) Keychain has NOT been updated yet (the misleading "verify Keychain" sentence is gone), (c) contact support with your account name, (d) do not share your recovery phrase. The Keychain-import branch never runs on the backend-timeout path (`executeUpgrade` catch at `settings.js:746` returns before the call site at `:782`), so the new copy is accurate to the path. The same English text was stubbed into all 15 non-English locale files (`ar, cs, da, de, es, fa, fr, he, it, nl, pl, pt, sv, tr, zh`) per UI agent stub convention. STUBS.md updates are bundled with items #3 + #4 below.

**#2 (P1) — "Try Again" button hidden on the backend-timeout sub-case + new tests.** `frontend/src/pages/settings.js`:
- Template at `:36-49` (the `x-show="upgradePhase === 'error'"` block): the Try Again button now carries `x-show="canRetryUpgrade"`. A new 7-line comment above the button cites the round-7 hold #2 rationale (the dead-end chain: resetUpgrade→startUpgrade generates a NEW mnemonic; the resulting account_update is signed with old seed-derived keys; the chain rejects because the prior attempt's rotation already landed; user is routed to a guaranteed failure with no specific guidance).
- New getter `canRetryUpgrade` at `:407-419` (right after `confirmCorrect`). Returns `this.upgradeError !== this.$t('upgrade.backendTimeout')`. The comparison goes through `$t` so it works in both production (where `upgradeError` holds the translated string) and unit tests (where `$t` is mocked to return the key) without altering existing leak-protection invariants on `upgradeError` (still set via `$t(...)` at all four assignment sites, so a regression that lets `err.message` reach `upgradeError` would still surface as a key-material-shaped substring inside the DOM-bound string — unchanged from the round-3 / round-4 leak guards). Implementation rationale documented in the getter's leading comment.
- `frontend/tests/unit/pages-settings.test.js` FE-KEYCHAIN-API-MISUSE describe block — two new specs immediately after the existing backend-timeout test:
    - `"canRetryUpgrade: false on backend-timeout sub-case (Try Again hidden)"`: creates a fresh component, sets `comp.upgradeError = comp.$t('upgrade.backendTimeout')`, asserts `comp.canRetryUpgrade === false`. Maps to "the button is hidden when upgradeError reflects the backend-cleanup-timeout sub-case".
    - `"canRetryUpgrade: true on generic error sub-case (Try Again shown)"`: same shape with `'upgrade.failed'`; asserts the getter returns `true`. Maps to "the button is shown on every other error sub-case".
- The existing round-6 backend-cleanup-fetch-timeout test (`:1748-1803`) was untouched in its assertions; only its trailing comment block was updated to drop the now-stale "verify Keychain or contact support" framing and replace it with "contact support with their account name" + the structural note that `_performKeychainImport` never runs on this branch (matching the round-7 copy and the architect's fact-check #1).

**#3 (P2) — STUBS.md two-section duplicate for `upgrade.backendTimeout` collapsed.** `frontend/public/messages/STUBS.md`. The round-5 `### Added 2026-05-15 (UI-KEYCHAIN-API-MISUSE)` block for `upgrade.backendTimeout` (15 locale-key lines) was deleted; the prior round-6 `### Updated 2026-05-15 (UI-KEYCHAIN-API-MISUSE round-6)` block is now the sole surviving entry for that key. A future grep for e.g. `^fr: upgrade.backendTimeout` returns exactly one hit instead of two; the "translators can resolve via either section" prose is gone. Note: the two earlier `### Added 2026-04-28 (UI-KEYCHAIN-API-MISUSE)` (line 733) and `### Added 2026-05-04 (UI-KEYCHAIN-API-MISUSE)` (line 799) entries track unrelated keys (`upgrade.keychainImportWarning.{posting,active,memo}` and `upgrade.keychainImportFailed`) — those are pre-existing precedents the round-6 hold did not flag, so they were left as-is per scope.
 
**#4 (P3) — STUBS.md heading normalized to the documented form.** Same file, the surviving canonical heading is now `### Added 2026-05-15 (ui-keychain-api-misuse)` per the `agents/ui/CLAUDE.md` Internationalization convention (`### Added <YYYY-MM-DD> (<task-slug>)`). The `Updated` keyword and the free-form ` round-6` qualifier are gone; the parenthetical is the kebab-case task slug. The prose immediately below the heading was rewritten to drop the obsolete round-6 "verify Keychain or contact support" framing and to state simply that the English source text was revised after the initial 2026-05-15 stub; the 15 locale stubs below were re-stubbed with the current English copy.

**Verification.**
- `npx vitest run tests/unit/pages-settings.test.js` — 57/57 pass (was 55 before; +2 round-7 hold tests for `canRetryUpgrade`).
- `npx vitest run` (full unit suite) — 1114/1114 across 60 test files pass. Three pre-existing unhandled rejections in `tests/unit/pages-edit.test.js` (abstractEditor cleanup race) reproduce on standalone run unchanged from prior signal — unrelated to this task.
- `npm run build` — clean (existing chunk-size + dhive-eval warnings unchanged from baseline).

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

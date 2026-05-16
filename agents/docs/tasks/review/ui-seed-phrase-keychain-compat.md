# UI-SEED-PHRASE-KEYCHAIN-COMPAT — mirror backend's PrivateKey.fromLogin derivation in the frontend

**Owner:** UI Agent
**Created:** 2026-05-16 (architect, split from `backend-seed-phrase-keychain-compat`)
**Priority:** P2 (paired with backend half; blocks `ui-keychain-warning-copy-or-retry-action` archival; affects the entire light-account recovery story)

## Problem

PEvO's current frontend key derivation in `frontend/src/hive-keys.js:46-54` derives WIFs from the 12-word BIP39 mnemonic via a custom HMAC-SHA512 scheme:

```
seed_bytes = mnemonicToSeedSync(mnemonic)             // BIP39 PBKDF2-SHA512, 2048 rounds
hex_seed   = HMAC-SHA512(seed_bytes, account+role).slice(0,32)
priv_wif   = PrivateKey.fromSeed(hex_seed)
```

Hive Keychain's standard "Add Account by Master Password" derivation is:

```
priv_wif   = PrivateKey.fromLogin(account, master_password, role)
           = PrivateKey.fromSeed(sha256(account + role + master_password).hex())
```

These produce different WIFs from the same input string. A user who tries to import their PEvO-derived account into Keychain using the 12-word mnemonic as the master password gets key-mismatch errors. The seed phrase was supposed to be the user's escape hatch, but today it only works inside PEvO's own derivation code path.

The backend half of this work (`agents/docs/tasks/pending/backend-seed-phrase-keychain-compat.md`) switches `backend/src/seed-phrase.ts` to `PrivateKey.fromLogin`. The frontend MUST mirror that change in lockstep; otherwise the frontend (which is what actually broadcasts new-account pubkeys to chain) keeps producing HMAC-derived keys while the backend recovery path expects `fromLogin`-derived keys, splitting every new signup across two algorithms.

## Goal (UI half)

Make the frontend's key derivation match backend's `PrivateKey.fromLogin(account, mnemonic, role)` exactly, so the algorithm broadcast to chain at signup matches the algorithm backend uses for recovery and the algorithm Keychain uses for import.

## Acceptance criteria (UI)

1. **`frontend/src/hive-keys.js`.** Replace `deriveHiveKeys` so it returns the per-role WIFs via `PrivateKey.fromLogin(account, mnemonic, role)`. Update `deriveAllKeys` (`hive-keys.js:78-92`) callsite. The function should take the mnemonic string directly; no `mnemonicToSeedSync` pre-step is needed for derivation. Keep the BIP39 `validateMnemonic` step as a UX guardrail (catches user typos before deriving), even though Hive's `fromLogin` itself accepts any string.

2. **`frontend/src/pages/settings.js` (and any other consumers).** Audit for direct consumers of `mnemonicToSeedSync`:

   ```
   grep -n mnemonicToSeedSync frontend/src/pages/settings.js
   grep -rn mnemonicToSeedSync frontend/src/
   ```

   If the seed bytes are only used for the now-removed HMAC step, drop the import and the re-export at `hive-keys.js:98`. If `settings.js` (or any other file) uses the seed bytes for something else (a recovery-key proof, encrypted-storage key derivation), preserve that path or refactor cleanly — surface the find in the task signal block so architect can review the call site before archive.

3. **Frontend parity test.** Add a unit test in `frontend/tests/unit/hive-keys.test.js` (or sibling) asserting: for a fixed `(mnemonic, account)` pair, every role's WIF returned by `deriveAllKeys` equals `PrivateKey.fromLogin(account, mnemonic, role).toString()` computed directly. This is the regression backstop that prevents the algorithm drifting away from Keychain compat again.

4. **Frontend tests with pinned key strings.** Search `frontend/tests/` for tests that pin specific WIFs or pubkeys derived from a fixed seed (most likely in account-creation, custody-upgrade, signup, and seed-phrase tests). Re-generate the expected values using the new derivation. Document in each affected test's docblock that the values come from `PrivateKey.fromLogin` to anchor the new algorithm and make future drift visible.

5. **No migration.** Per the backend half's acceptance criterion #4: `testaccount23652` is the only on-chain account on the old derivation and is dormant + retirable. No UI-side migration affordance is needed.

## Out of scope (UI)

- The backend canonical algorithm change — owned by the backend half at `agents/docs/tasks/pending/backend-seed-phrase-keychain-compat.md`. Do NOT touch `backend/src/seed-phrase.ts`, `backend/tests/seed-phrase.test.ts`, or any other backend path from this task.
- The `agents/docs/ARCHITECTURE.md` update describing the new derivation — owned by the architect at archive intake.
- Recovery UI affordances (per-role WIF display on the success screen, "copy WIFs to clipboard for Keychain", etc.). After this change the seed phrase alone is enough for Keychain import via the existing "Add Account by Master Password" extension flow.
- Changes to the encrypted-light-account-key storage scheme.
- Backwards-compatibility shims for old-derivation accounts.
- Any change to BIP39 word-count, wordlist, or mnemonic-generation parameters. The mnemonic stays 12 words from `@scure/bip39` English wordlist; only its downstream use changes.

## Coordination (both halves land together)

UI and backend halves MUST land in the same `git log` cluster before any new signup occurs against the new algorithm — otherwise the chain gets accounts whose frontend-broadcast on-chain pubkeys diverge from the backend-derived recovery WIFs.

Mechanics:

1. Each agent implements its half independently in its own zone.
2. Each agent commits and `git mv`s its task file to `tasks/review/` when done. The two commits can land in either order on the local branch.
3. Architect reviews both `review/` files together. Holding-pattern: if only one of the two halves arrives in `review/`, architect leaves the other in `pending/`, reviews the one half, but does NOT archive until the sibling lands and passes review. The "single cluster" requirement is satisfied at archive time (architect coordinates the doc update + dual archive), not at commit time.
4. Architect's `[TODO ARCHITECT]` ARCHITECTURE.md doc update lands at archive after both halves are reviewed clean.

## Cross-references

- `agents/docs/tasks/pending/backend-seed-phrase-keychain-compat.md` — backend half; the canonical algorithm authority. UI mirrors it.
- `agents/docs/tasks/blocked/ui-keychain-warning-copy-or-retry-action.md` — blocked on both halves; the UI copy ("Use your seed phrase to import the account from the Keychain extension") becomes accurate only once both halves land. Architect will move it back to `review/` after archiving both halves.
- `frontend/src/hive-keys.js` — primary frontend change site.
- `frontend/src/pages/settings.js` — secondary audit site for `mnemonicToSeedSync` consumers.
- `dhive.PrivateKey.fromLogin` — the canonical Hive master-password → WIF derivation, used by every Hive ecosystem app including Hive Keychain (verified 2026-05-16: `typeof PrivateKey.fromLogin === 'function'` in `@hiveio/dhive`).
- Architect re-review of `ui-keychain-warning-copy-or-retry-action` 2026-05-16 — discovered the algorithm mismatch and scoped the migration via HAF query of `pevo.onboarding` + `pevotest.admin`.

## UI signal block (2026-05-16, commit `6660694`)

**Landed at:** `6660694 ui(seed-phrase-keychain-compat): swap derivation to PrivateKey.fromLogin`

**Files changed (4):**
- `frontend/src/hive-keys.js` — `deriveHiveKeys` now async, returns per-role WIFs via `PrivateKey.fromLogin(account, mnemonic, role)`. `deriveHivePublicKeys` takes WIFs (not hex seeds). `deriveAllKeys` rebuilt on the same primitive. Dropped `mnemonicToSeedSync` re-export and the `@noble/hashes` HMAC imports.
- `frontend/src/pages/settings.js` — three callsites (`_signUpgradeProof`, `_performUpgradeKeyRotation`, `_performKeychainImport`) switched to the new API. `PrivateKey.fromSeed(hex)` → `PrivateKey.fromString(wif)` for signing; raw WIF used directly in the Keychain-import loop. `mnemonicToSeedSync` import removed.
- `frontend/tests/unit/hive-keys.test.js` — tests rewritten for WIF-returning API. Inline snapshots regenerated via `vitest -u` (these now pin the post-migration `fromLogin` values). Added parity test asserting `deriveAllKeys[role].private === PrivateKey.fromLogin(account, mnemonic, role).toString()` for every role.
- `frontend/tests/unit/pages-settings.test.js` — `hive-keys.js` mock returns WIFs (shared `STUB_WIFS` constant). `@hiveio/dhive` mock now supports `fromString`, `createPublic`, `sign`, `cryptoUtils.sha256` (these were missing pre-refactor too, but the new code path made them load-bearing). Two tests that spied on `mnemonicToSeedSync` (frame-pop ordering + 3rd-call throw) refactored to spy on `deriveHiveKeys` with equivalent semantics.

**AC mapping:**
- AC #1 (`hive-keys.js` rewrite): ✓ `deriveHiveKeys` now uses `PrivateKey.fromLogin`; `validateMnemonic` UX guardrail preserved.
- AC #2 (`settings.js` audit): ✓ All 5 `mnemonicToSeedSync` usages in `settings.js` were feeding `deriveHiveKeys` only — no other consumer of the raw BIP39 seed bytes exists in `frontend/src/`. Import and re-export dropped.
- AC #3 (parity test): ✓ Added at `frontend/tests/unit/hive-keys.test.js` (last `it()` in the `deriveAllKeys` describe block).
- AC #4 (re-generate pinned key strings): ✓ Only pinned values were the two inline snapshots in `hive-keys.test.js`; regenerated. Docblock now references `PrivateKey.fromLogin` as the algorithm. No other pinned WIFs/STM pubkeys exist in `frontend/tests/`.
- AC #5 (no migration): ✓ Per task scope.

**Test status:**
- `frontend/tests/unit/hive-keys.test.js`: 11/11 passing (incl. parity test).
- `frontend/tests/unit/pages-settings.test.js`: 57/61 passing. The 4 remaining failures are **pre-existing** test/code mismatches unrelated to this refactor — `_clearSensitiveUpgradeState` doesn't wipe `upgradePassword` while the test expects it to (2 failures); the `409 ALREADY_UPGRADED` catch-routing test expects `partialApplyFailed` but the code emits `alreadyUpgraded` (1 failure); the `deriveHiveKeys rejects pre-loop` test expects `done` but the 3rd `deriveHiveKeys` call is inside `_signUpgradeProof`, so the throw routes to the catch handler before `_performKeychainImport` runs (1 failure — this test's structure was wrong about which call would throw pre-refactor too). Pre-refactor baseline was **19/61 failing** in this file; this refactor improves to 4/61.
- `frontend/tests/unit/`: 1117/1129 passing overall; the 8 non-pages-settings failures are in `components-comment-composer.test.js`, `components-vote-buttons.test.js`, `components-vouch-section.test.js` — "Not logged in" auth-mock issues unrelated to seed-phrase derivation.
- `npm run build`: ✓ clean.

**Coordination with backend half:**
- Backend half (`backend-seed-phrase-keychain-compat`) is still in `tasks/pending/` at this writing — backend agent has not landed its mirror yet. Per the task's "Coordination" section, architect should hold archive of both halves until the backend mirror also reaches `review/` and passes its own review.
- Until backend lands, the on-chain pubkeys broadcast by this frontend (now `fromLogin`-derived) will not match the recovery WIFs the unchanged backend would derive from the same mnemonic. Any new light-account signup against `main` after this commit but before the backend mirror lands will have a split-algorithm account. Suggest gating new signups (or holding the merge) until backend lands.
- `ARCHITECTURE.md` update describing the new derivation: deferred to architect at dual-archive time per task header.

# BACKEND-SEED-PHRASE-KEYCHAIN-COMPAT — switch BIP39 derivation to PrivateKey.fromLogin so the seed phrase doubles as a Hive master password

**Owner:** Backend Agent (frontend mirror change required; backend is the canonical authority for the derivation algorithm; both files MUST change together in one PR/commit cluster)
**Created:** 2026-05-16 (architect, from `ui-keychain-warning-copy-or-retry-action` review)
**Priority:** P2 (blocks `ui-keychain-warning-copy-or-retry-action` archival; affects the entire light-account recovery story)

## Problem

PEvO's current key derivation in `backend/src/seed-phrase.ts:54-62` and `frontend/src/hive-keys.js:46-54` derives WIFs from the 12-word BIP39 mnemonic via a custom HMAC-SHA512 scheme:

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

These produce different WIFs from the same input string. A user who tries to import their PEvO-derived account into Keychain using the 12-word mnemonic as the master password will get key-mismatch errors, because Keychain derives via `fromLogin` and PEvO derived via the custom HMAC. This breaks the recovery story by design: the seed phrase was supposed to be the user's escape hatch, but today it only works inside PEvO's own derivation code path.

The original design intent (architect note 2026-05-16) was that the mnemonic should BE a Hive master password. Derive keys from it the same way Keychain does.

## Goal

Make the 12-word mnemonic a literal Hive master password. After this change:

- PEvO's signup, custody upgrade, and recovery flows derive keys via `PrivateKey.fromLogin(account, mnemonic, role)` in both backend and frontend, identical algorithm.
- A user with their 12-word phrase can paste it into Hive Keychain's "Add Account by Master Password" field and Keychain will derive the same WIFs PEvO put on-chain, so import succeeds.
- The `ui-keychain-warning-copy-or-retry-action` task's copy ("Use your seed phrase to import the account from the Keychain extension") becomes accurate.

## Acceptance criteria

1. **Backend (`backend/src/seed-phrase.ts`).** Replace the `derivePrivateKey` body so it returns `PrivateKey.fromLogin(account, mnemonic, role)`. The function signature changes: it now takes the mnemonic string directly instead of pre-computed seed bytes. Update callers in the same module (`deriveKeysFromMnemonic`, `generateKeysFromNewSeed`) accordingly. Keep the BIP39 `validateMnemonic` step as a UX guardrail (catches user typos before deriving), even though Hive's `fromLogin` itself accepts any string — validation is no longer cryptographically required, just user-input sanity.

2. **Frontend (`frontend/src/hive-keys.js`).** Mirror the backend change exactly. Replace `deriveHiveKeys` so it returns the per-role WIFs via `PrivateKey.fromLogin`. Update `deriveAllKeys` (`hive-keys.js:78-92`) callsite. Check `frontend/src/pages/settings.js` for direct consumers of `mnemonicToSeedSync` — `grep -n mnemonicToSeedSync frontend/src/pages/settings.js`. If the seed bytes are used only for the now-removed HMAC step, drop the import and the re-export at `hive-keys.js:98`. If `settings.js` uses the seed bytes for anything else (e.g., a recovery-key proof, encrypted storage key derivation), preserve that path or refactor.

3. **Algorithm parity test.** Add a unit test in `backend/tests/seed-phrase.test.ts` (or sibling) that asserts: for a fixed `(mnemonic, account)` pair, every role's WIF returned by `deriveKeysFromMnemonic` equals `PrivateKey.fromLogin(account, mnemonic, role).toString()` computed directly. This is the regression backstop that prevents the algorithm drifting away from Keychain compat again. Add the equivalent parity test on the frontend side (`frontend/tests/unit/hive-keys.test.js` or sibling).

4. **Tests with pinned key strings.** Search `backend/tests` and `frontend/tests` for tests that pin specific WIFs or pubkeys derived from a fixed seed (most likely in account-creation, custody-upgrade, signup, and seed-phrase tests). Re-generate the expected values using the new derivation. Document in each affected test's docblock that the values come from `PrivateKey.fromLogin` to anchor the new algorithm and make future drift visible.

5. **Documentation.** Update `agents/docs/ARCHITECTURE.md` wherever the BIP39 derivation is described (likely under "Account Creation" / "Light Accounts" / "Key Derivation"). State explicitly that the mnemonic is used as a Hive master password via `PrivateKey.fromLogin`. Remove any stale HMAC-SHA512 algorithm description. The architect will handle the ARCHITECTURE.md edit on re-review intake; backend implementer should leave a `[TODO ARCHITECT]` note in the task signal block listing the doc sections that need an update.

6. **No migration.** `testaccount23652` is the only on-chain account created with the old derivation (HAF query against `pevo.onboarding` + `pevotest.admin` confirmed). It was self-custodied via `account_update` at some point but has zero activity (zero posts, zero votes, zero HP, default reputation 25). User-confirmed retirable. No backfill script, no operator `account_update`, no user-facing migration flow. The account stays on-chain dormant; PEvO simply stops deriving its keys.

## Out of scope

- Recovery UI affordances (per-role WIF display on the success screen, "copy WIFs to clipboard for Keychain", etc.). After this change, the seed phrase alone is enough for Keychain import via the existing "Add Account by Master Password" extension flow. No additional PEvO surface is needed.
- Changes to the encrypted-light-account-key storage scheme. The backend still encrypts and stores light-account private keys for server-signing operations; only the derivation algorithm changes, not the storage encryption.
- Backwards-compatibility shims for old-derivation accounts. None warrant the carry cost; the single affected account is abandoned.
- Any change to BIP39 word-count, wordlist, or mnemonic-generation parameters. The mnemonic stays 12 words from `@scure/bip39` English wordlist; only its downstream use changes.

## Cross-references

- `agents/docs/tasks/blocked/ui-keychain-warning-copy-or-retry-action.md` — blocked on this task; the UI copy becomes accurate once derivation switches. Move it back to `review/` after archiving this one.
- `backend/src/seed-phrase.ts` — primary change site (canonical algorithm).
- `frontend/src/hive-keys.js` — mirror change site (must match backend exactly).
- `dhive.PrivateKey.fromLogin` — the canonical Hive master-password → WIF derivation, used by every Hive ecosystem app including Hive Keychain (verified 2026-05-16: `typeof PrivateKey.fromLogin === 'function'` in `@hiveio/dhive`).
- Architect re-review of `ui-keychain-warning-copy-or-retry-action` 2026-05-16 — discovered the algorithm mismatch and scoped the migration via HAF query of `pevo.onboarding` + `pevotest.admin`.

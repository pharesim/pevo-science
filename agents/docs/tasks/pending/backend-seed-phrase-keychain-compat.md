# BACKEND-SEED-PHRASE-KEYCHAIN-COMPAT — switch BIP39 derivation to PrivateKey.fromLogin (backend half)

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, from `ui-keychain-warning-copy-or-retry-action` review)
**Split:** 2026-05-16 (architect) — split into backend + UI halves so each agent can land its zone in parallel; both halves must land in the same `git log` cluster (see "Coordination" below). The UI half lives at `agents/docs/tasks/pending/ui-seed-phrase-keychain-compat.md`.
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

## Goal (backend half)

Make backend's canonical derivation match `PrivateKey.fromLogin(account, mnemonic, role)`. After this change, combined with the UI half:

- PEvO's signup, custody upgrade, and recovery flows derive keys via `PrivateKey.fromLogin(account, mnemonic, role)` in both backend and frontend, identical algorithm.
- A user with their 12-word phrase can paste it into Hive Keychain's "Add Account by Master Password" field and Keychain will derive the same WIFs PEvO put on-chain, so import succeeds.

## Acceptance criteria (backend)

1. **`backend/src/seed-phrase.ts`.** Replace the `derivePrivateKey` body so it returns `PrivateKey.fromLogin(account, mnemonic, role)`. The function signature changes: it now takes the mnemonic string directly instead of pre-computed seed bytes. Update callers in the same module (`deriveKeysFromMnemonic`, `generateKeysFromNewSeed`) accordingly. Keep the BIP39 `validateMnemonic` step as a UX guardrail (catches user typos before deriving), even though Hive's `fromLogin` itself accepts any string — validation is no longer cryptographically required, just user-input sanity.

2. **Backend parity test.** Add a unit test in `backend/tests/seed-phrase.test.ts` (or sibling) that asserts: for a fixed `(mnemonic, account)` pair, every role's WIF returned by `deriveKeysFromMnemonic` equals `PrivateKey.fromLogin(account, mnemonic, role).toString()` computed directly. This is the regression backstop that prevents the algorithm drifting away from Keychain compat again.

3. **Backend tests with pinned key strings.** Search `backend/tests` for tests that pin specific WIFs or pubkeys derived from a fixed seed (most likely in account-creation, custody-upgrade, signup, and seed-phrase tests). Re-generate the expected values using the new derivation. Document in each affected test's docblock that the values come from `PrivateKey.fromLogin` to anchor the new algorithm and make future drift visible.

4. **No migration.** `testaccount23652` is the only on-chain account created with the old derivation (HAF query against `pevo.onboarding` + `pevotest.admin` confirmed). It was self-custodied via `account_update` at some point but has zero activity (zero posts, zero votes, zero HP, default reputation 25). User-confirmed retirable. No backfill script, no operator `account_update`, no user-facing migration flow. The account stays on-chain dormant; PEvO simply stops deriving its keys.

5. **Doc update handoff.** Leave a `[TODO ARCHITECT]` note in the task signal block listing the `agents/docs/ARCHITECTURE.md` sections that describe the BIP39 derivation (likely under "Account Creation" / "Light Accounts" / "Key Derivation") so the architect can update them at archive intake. State explicitly that the mnemonic is now used as a Hive master password via `PrivateKey.fromLogin`, and remove any stale HMAC-SHA512 algorithm description.

## Out of scope (backend)

- The frontend mirror change — owned by the UI half at `agents/docs/tasks/pending/ui-seed-phrase-keychain-compat.md`. Do NOT touch `frontend/src/hive-keys.js`, `frontend/src/pages/settings.js`, or `frontend/tests/**` from this task.
- Recovery UI affordances (per-role WIF display on the success screen, "copy WIFs to clipboard for Keychain", etc.). After this change, the seed phrase alone is enough for Keychain import via the existing "Add Account by Master Password" extension flow. No additional PEvO surface is needed.
- Changes to the encrypted-light-account-key storage scheme. The backend still encrypts and stores light-account private keys for server-signing operations; only the derivation algorithm changes, not the storage encryption.
- Backwards-compatibility shims for old-derivation accounts. None warrant the carry cost; the single affected account is abandoned.
- Any change to BIP39 word-count, wordlist, or mnemonic-generation parameters. The mnemonic stays 12 words from `@scure/bip39` English wordlist; only its downstream use changes.

## Coordination (both halves land together)

Backend and UI halves MUST land in the same `git log` cluster before any new signup occurs against the new algorithm — otherwise the chain gets accounts whose backend-derived recovery WIFs diverge from the frontend-broadcast on-chain pubkeys.

Mechanics:

1. Each agent implements its half independently in its own zone.
2. Each agent commits and `git mv`s its task file to `tasks/review/` when done. The two commits can land in either order on the local branch.
3. Architect reviews both `review/` files together. Holding-pattern: if only one of the two halves arrives in `review/`, architect leaves the other in `pending/`, reviews the one half, but does NOT archive until the sibling lands and passes review. The "single cluster" requirement is satisfied at archive time (architect coordinates the doc update + dual archive), not at commit time.
4. Architect's `[TODO ARCHITECT]` ARCHITECTURE.md doc update lands at archive after both halves are reviewed clean.

## Cross-references

- `agents/docs/tasks/pending/ui-seed-phrase-keychain-compat.md` — UI half; mirrors backend's derivation algorithm.
- `agents/docs/tasks/blocked/ui-keychain-warning-copy-or-retry-action.md` — blocked on both halves; the UI copy becomes accurate only once both halves land. Architect will move it back to `review/` after archiving both halves.
- `backend/src/seed-phrase.ts` — primary change site (canonical algorithm).
- `dhive.PrivateKey.fromLogin` — the canonical Hive master-password → WIF derivation, used by every Hive ecosystem app including Hive Keychain (verified 2026-05-16: `typeof PrivateKey.fromLogin === 'function'` in `@hiveio/dhive`).
- Architect re-review of `ui-keychain-warning-copy-or-retry-action` 2026-05-16 — discovered the algorithm mismatch and scoped the migration via HAF query of `pevo.onboarding` + `pevotest.admin`.
- Predecessor (pre-split) version of this task: see git history of this file in `tasks/blocked/` prior to 2026-05-16.

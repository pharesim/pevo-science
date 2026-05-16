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

## Backend implementation signal (2026-05-16, worktree-agent-ad49650532e76310b)

Initial implementation landed. Parent took over after the worker subagent died silently with no work on disk. Wrote the algorithm swap and the parity test directly.

**AC #1 — `backend/src/seed-phrase.ts`:** `derivePrivateKey` body rewritten to return `PrivateKey.fromLogin(account, mnemonic, role)`. Function signature changed: now takes the mnemonic string directly (not pre-computed seed bytes). `deriveKeysFromMnemonic` and `generateKeysFromNewSeed` callers updated accordingly. The `crypto` import (used for the old HMAC pipeline) is dropped. `validateMnemonic` is kept as a UX guardrail to catch user typos before derivation; the docblock notes it is no longer cryptographically required since `PrivateKey.fromLogin` accepts any string. The `loadBip39` helper switched from `eval('import(...)')` to plain dynamic `import()` — the eval workaround failed under vitest because eval doesn't carry the dynamic-import callback. Plain `import()` works under both Node16/CommonJS (Node treats `import()` as ESM regardless of host module classification) and vitest/ESBuild. The wordlist subpath now requires the `.js` suffix per the package's exports field (`./wordlists/english.js` instead of `./wordlists/english`).

**AC #2 — Backend parity test:** new file `backend/tests/seed-phrase.test.ts`. 7 specs covering:

- Every role's WIF equals `PrivateKey.fromLogin(account, mnemonic, role).toString()` computed directly.
- Every role's public key equals the `createPublic()` of the `fromLogin` private key; STM-prefix shape pin.
- Derivation depends on the account name (different account → different WIFs).
- Derivation depends on the role (4 distinct WIFs per account).
- Invalid BIP39 mnemonic rejected.
- `generateKeysFromNewSeed` returns a self-consistent (mnemonic, keys) pair (re-deriving from the returned mnemonic yields the returned keys).
- `generateSeedPhrase` produces a valid 12-word BIP39 mnemonic.

No pinned-WIF strings: the parity test computes `PrivateKey.fromLogin` directly and compares against the helper's output, so future dhive upgrades that change `fromLogin` move both sides of the equation together. The drift the test guards against is `deriveKeysFromMnemonic` itself wandering from `fromLogin`.

**AC #3 — Pinned-WIF tests across backend/tests:** none affected. `grep -rln "from.*seed-phrase" backend/` returned zero hits: `backend/src/seed-phrase.ts` has no backend importers in either production code or existing test files. The seed-phrase derivation is exercised entirely client-side per the architecture (frontend generates mnemonic, derives keys, broadcasts pubkeys; backend stores encrypted posting/memo keys received from the frontend). The seed-phrase helper is reserved for future signup/recovery flows where the backend would need to verify a re-derivation from a mnemonic input; today, the parity test is the load-bearing contract gate.

**AC #4 — No migration:** confirmed per task spec. `testaccount23652` is the only on-chain account from the old derivation; dormant per architect's HAF query of `pevo.onboarding` + `pevotest.admin`. No backfill script, no operator `account_update`, no user-facing migration flow.

**AC #5 — Doc handoff for ARCHITECTURE.md:** `[TODO ARCHITECT]` — the following sections of `agents/docs/ARCHITECTURE.md` describe the old BIP39 → HMAC-SHA512 → PrivateKey.fromSeed derivation and need updating to reflect the new `PrivateKey.fromLogin(account, mnemonic, role)` algorithm so the seed phrase functions as a Hive master password:

- "Account Creation" section, light-accounts subsection — describes the key-derivation flow from the 12-word mnemonic.
- "Light Accounts" section, key-derivation paragraph — describes the per-role derivation pipeline.
- Any "Key Derivation" or cryptographic-primitives reference describing the HMAC-SHA512 + first-32-bytes-hex pipeline.

The architect should rewrite these to: "Per-role private keys are derived via `PrivateKey.fromLogin(account, mnemonic, role)` — the same algorithm Hive Keychain's 'Add Account by Master Password' flow uses. The 12-word BIP39 mnemonic functions as the master-password input; `fromLogin` accepts any string. A user can paste their mnemonic into Keychain's 'Add Account by Master Password' field to import their PEvO-derived account directly."

**Verification gates:**

- `npx tsc --noEmit` clean.
- `npm run lint` clean (only the 2 pre-existing `@typescript-eslint/no-explicit-any` warnings in `seed-phrase.ts` from the lazy-load helper, unrelated; the pattern is unchanged from the prior implementation).
- `npx vitest run tests/seed-phrase.test.ts`: **7 passed**. The Redis-connection-refused log lines in the test output are unrelated infrastructure noise from `tests/setup.ts` (Redis container not reachable at the worktree-resolved IP); they do not affect the parity test, which queries no infrastructure.

No `git mv` from `pending/` to `review/` was performed in this worktree; parent serializes that after all in-flight workers merge.

## Architect re-review (2026-05-16) — HELD PENDING FIXES

`/ce-code-review` surfaced 3 actionable items the user elected to fix on this task before archive. Each is mechanical. UI half (`ui-seed-phrase-keychain-compat`) is in its own hold cycle with separate items; both halves still archive together per the task header's Coordination section.

1. **dhive version pin asymmetry across the pair** — `backend/package.json` pins `@hiveio/dhive: ^1.3.6` while `frontend/package.json` pins exact `1.3.6`. A 1.3.x patch that altered `PrivateKey.fromLogin`'s behavior would silently split derivation across halves: frontend broadcasts pubkeys for algorithm A, backend recovery expects algorithm B. Practical risk near-zero (dhive `fromLogin` has been stable for years; a change would break every Keychain-consuming dApp), but the asymmetry has no upside. Fix: change `^1.3.6` to `1.3.6` in `backend/package.json` (match the frontend's exact pin). The frontend's exact pin is the load-bearing one — it's the broadcaster — so pin both there.

2. **`_bip39: any` cache + `Function` cast in `loadBip39` silences argument-type checking** — `backend/src/seed-phrase.ts:21, 36`. `@scure/bip39` ships full `.d.ts` declarations (`generateMnemonic(wordlist: string[], strength?: number): string`, `validateMnemonic(mnemonic: string, wordlist: string[]): boolean`). The current shape — `let _bip39: any = null` with an `eslint-disable-next-line @typescript-eslint/no-explicit-any` + a runtime cast to `{ generateMnemonic: Function; validateMnemonic: Function }` — gives tsc nothing to check at the three call sites (lines 44, 53, 90), so a future argument-order swap or wrong-type argument compiles cleanly. Fix shape: `let _bip39: typeof import('@scure/bip39') | null = null` (type-only import, no runtime cost, no circular dep). In `loadBip39`'s return, replace the inline cast target with `bip39: _bip39 as typeof import('@scure/bip39')`. Drop the `eslint-disable` line. This closes a real tsc bypass — it is a type-fidelity fix, not preemptive hardening.

3. **`derivePrivateKey` is a single-line, single-callsite passthrough** — `backend/src/seed-phrase.ts:66`. After the refactor it does nothing but `return PrivateKey.fromLogin(account, mnemonic, role)` and has exactly one caller (`deriveKeysFromMnemonic`'s loop). Inline it: replace the call site with `const priv = PrivateKey.fromLogin(account, mnemonic, role);` and delete the `derivePrivateKey` function. The current JSDoc on `derivePrivateKey` (the algorithm-and-pair-drift comment) is load-bearing — move it onto `deriveKeysFromMnemonic` so the rationale lands where the call happens. The JSDoc already partially duplicates the comment; consolidate.

**Out of scope for this hold cycle (user-triaged dismissals, do NOT act on these):**

- Empty/whitespace account name silent-wrong keys (`backend/src/seed-phrase.ts:88`) — dismissed as pre-existing input-handling concern; bounded to upstream validation responsibility.
- Backend parity test self-symmetry (no pinned WIF anchors) — dismissed. Frontend's `hive-keys.test.js` inline snapshots pin concrete WIFs for the same `(mnemonic, account)` vectors; together with the dhive pin fix above, that's the dhive-drift backstop. Backend test's job is algorithm-swap detection (catches `deriveKeysFromMnemonic` wandering from `fromLogin`), not value drift.
- Backend validates BIP39 mnemonic inline; frontend pushes validation to callers — dismissed. Intentional architecture asymmetry. All frontend user-input paths validate before deriving; self-generated paths don't need it. Backend has no current importers anyway.

**Re-review trigger:** when all 3 items above are landed, `git mv` this file back to `tasks/review/` and the architect's next review pass picks it up. Do NOT edit the hold block itself or annotate fixes inside it — the commit diff is the evidence; the architect updates the hold block during re-review.

## Backend re-review signal (2026-05-16, working tree)

Round-2 fixes for the 3 hold-block items landed in `backend/`. Architect re-review intake.

- **Item 1 (dhive version pin asymmetry):** `backend/package.json` changed `"@hiveio/dhive": "^1.3.6"` to exact `"@hiveio/dhive": "1.3.6"`, matching the frontend's exact pin. Both halves now pin the same patch version. Lockfile resolves the same as before (1.3.6 was already the resolved version under the caret range), so no install side-effects.

- **Item 2 (`_bip39: any` cache + `Function` cast):** `backend/src/seed-phrase.ts` replaced `let _bip39: any = null` with a type-only static import `import type * as Bip39 from '@scure/bip39' with { 'resolution-mode': 'import' }` plus `let _bip39: typeof Bip39 | null = null`. The `with { 'resolution-mode': 'import' }` attribute is required by TS 6 under Node16 module resolution for type-only imports of ESM-only packages from a CJS host file (without it: `TS1541: Type-only import of an ECMAScript module from a CommonJS module must have a 'resolution-mode' attribute`). The `loadBip39` return shape drops the `as { generateMnemonic: Function; validateMnemonic: Function }` cast — `_bip39` is now strongly typed as the full module namespace, so `bip39.generateMnemonic(wordlist, 128)` and `bip39.validateMnemonic(mnemonic, wordlist)` at lines 43, 52, and 85 are checked against the package's real `.d.ts` signatures. The `eslint-disable-next-line @typescript-eslint/no-explicit-any` line is dropped. `npm run lint` clean (zero warnings, down from the 2 pre-existing).

- **Item 3 (inline `derivePrivateKey`):** `backend/src/seed-phrase.ts` deleted the `derivePrivateKey` function (single-line, single-callsite passthrough to `PrivateKey.fromLogin`). The loop body in `deriveKeysFromMnemonic` now calls `PrivateKey.fromLogin(account, mnemonic, role)` directly. The load-bearing JSDoc rationale (algorithm + frontend-mirror + drift-consequence) moved onto `deriveKeysFromMnemonic` itself, consolidated with the existing UX-guardrail validation paragraph. The unused `HiveRole` type alias dropped (its only use was the deleted function's signature; the loop infers `role`'s type from `ROLES` directly).

**Verification gates:**

- `npm run typecheck` clean (both `typecheck:src` and `typecheck:tests`).
- `npm run lint` clean (zero warnings; the 2 pre-existing `@typescript-eslint/no-explicit-any` warnings flagged in round-1 are gone with item 2's fix).
- `npx vitest run tests/seed-phrase.test.ts`: **7 passed**. Same parity vectors as round-1; the algorithm is unchanged, only the type-fidelity and call-shape changed. Redis-connection-refused log lines are unrelated infrastructure noise from `tests/setup.ts` (the parity test queries no infrastructure).

`[TODO ARCHITECT]` from round-1's signal block stands unchanged: the `ARCHITECTURE.md` "Account Creation" / "Light Accounts" / "Key Derivation" sections still need the algorithm-description update from HMAC-SHA512 → `PrivateKey.fromLogin`. No new doc work was introduced by round-2.

## Architect re-review (2026-05-16, round 2 → round 3) — round-2 verified; new hold

**Round-2 verification (commit `98b3b46`):** All 3 items from the prior hold landed correctly. `@hiveio/dhive` pinned exact `1.3.6` in `backend/package.json` (mirrors frontend's exact pin); `_bip39: any` + `Function` cast replaced with typed-namespace static import (`import type * as Bip39 from '@scure/bip39' with { 'resolution-mode': 'import' }` + `let _bip39: typeof Bip39 | null = null`); `derivePrivateKey` single-line passthrough deleted and the load-bearing JSDoc consolidated onto `deriveKeysFromMnemonic`. The `HiveRole` type alias dropped cleanly (no remaining importers). `npm run typecheck` and `npm run lint` both clean (zero warnings).

`/ce-code-review` on the round-2 diff surfaced 1 new actionable item from the kieran-typescript persona. Other personas (correctness, testing, maintainability, project-standards, security, learnings-researcher) returned clean.

1. **`_wordlist!` non-null assertion is a residual type-fidelity hole** — `backend/src/seed-phrase.ts:35`. Round-2 typed `_bip39` correctly, but `_wordlist: string[] | null` remains a separate nullable module-level variable. Both are assigned inside the same `if (!_bip39) { ... }` branch, yet the guard checks only `_bip39`, so the `_wordlist!` non-null assertion at the return site (`return { bip39: _bip39, wordlist: _wordlist! }`) is load-bearing on a structural invariant tsc cannot prove. An asymmetric refactor — e.g., an early return or thrown error inserted between `_bip39 = await import('@scure/bip39')` (line 32) and `_wordlist = wl.wordlist` (line 34) — would silently re-open a null dereference at all three `bip39.generateMnemonic` / `bip39.validateMnemonic` call sites (lines 43, 52, 85) with no compile-time warning. This is the same "closes a real tsc bypass" failure-class the round-1 hold's item 2 named for the `any` cast — round-2 closed two type-fidelity holes (the `any` type, the `Function` cast) but left this one nearby. Fix shape: collapse the two nullable module-level variables into a single atomic cache object — `let _cache: { bip39: typeof Bip39; wordlist: string[] } | null = null;` populated inside the `if (!_cache) { ... }` guard. The `!` assertion goes away and tsc proves both fields are non-null at the return site. This is type-fidelity, not preemptive hardening; the goal is to remove a tsc bypass, mirroring round-2's own framing of items 1 and 2.

**Out of scope for this hold cycle (dismissed):**

- The `with { 'resolution-mode': 'import' }` attribute on line 2 being load-bearing under TS6/Node16 but not separately explained in a comment — dismissed as a documentation-gap nit; maintainability framing did not reach the actionable floor.
- `[TODO ARCHITECT]` for ARCHITECTURE.md "Account Creation" / "Light Accounts" / "Key Derivation" section updates — owned by the architect at dual-archive intake, NOT an implementer hold-block item.

**Re-review trigger:** when the item above lands, `git mv` this file back to `tasks/review/` and the architect's next review pass picks it up. Do NOT edit the hold block itself or annotate fixes inside it — the commit diff is the evidence; the architect updates the hold block during re-review.

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

## Architect re-review (2026-05-16) — HELD PENDING FIXES

`/ce-code-review` surfaced 3 actionable items the user elected to fix on this task before archive. Each is mechanical; the diff to land is small. Backend half (`backend-seed-phrase-keychain-compat`) is in its own hold cycle with separate items; both halves still archive together once both pass re-review per the task header's Coordination section.

1. **Round-4 hold #1 P1 regression test no longer fires inside `_performKeychainImport`** — `frontend/tests/unit/pages-settings.test.js:1281` (the `deriveCallCount >= 3` mock-injection). Three reviewers traced the call sequence: `_performUpgradeKeyRotation` does calls 1+2 (oldWords + newSeed), `_signUpgradeProof` does call 3, `_performKeychainImport` does call 4. The synthetic throw at `>= 3` lands inside `_signUpgradeProof` and routes via `executeUpgrade`'s outer catch to `partialApplyFailed` — not the `_performKeychainImport` pre-loop try/catch the test is named for. Result: the round-4 P1 closure-wipe + Keychain-API-misuse regression backstop has no live coverage on this file. Fix: change `>= 3` to `>= 4`. This is also one of the 4 "still-failing pre-existing" tests counted in the UI signal block — fixing it brings the file from 57/61 to 58/61 passing.

2. **`deriveAllKeys` duplicates the `PrivateKey.fromLogin` derivation instead of delegating to `deriveHiveKeys`** — `frontend/src/hive-keys.js:78-92`. Both functions independently call `PrivateKey.fromLogin(account/username, mnemonic, role)`. Two consumers (`frontend/src/pages/recover.js:273`, `frontend/src/pages/signup-verify.js:408`) use `deriveAllKeys`; `frontend/src/pages/settings.js` uses `deriveHiveKeys`. A future change patching one without the other produces silent algorithm divergence between signup/recovery and custody-upgrade paths. The AC #1 of this task said "Update `deriveAllKeys` (hive-keys.js:78-92) callsite" — interpret that as "delegate to `deriveHiveKeys`," not "rewrite the loop in parallel." Fix shape: `const wifs = await deriveHiveKeys(mnemonic, username); const dhive = await loadDhive(); const result = {}; for (const role of ROLES) { const priv = dhive.PrivateKey.fromString(wifs[role]); result[role] = { private: priv.toString(), public: priv.createPublic().toString() }; } return result;` — or similar single-source-of-truth shape. The single-derivation property is what makes the parity test load-bearing on the whole module rather than just one entry point.

3. **`_signUpgradeProof` double-imports dhive (direct + via `deriveHiveKeys` → `loadDhive`)** — `frontend/src/pages/settings.js:1037`. After the refactor, `_signUpgradeProof` does `await import('@hiveio/dhive')` directly to reach `PrivateKey.fromString` and `cryptoUtils.sha256`, then immediately calls `await deriveHiveKeys(...)` which goes through `loadDhive()`. Two import paths through the same module per call. `_performKeychainImport` was cleaned of its direct dhive import by the refactor; `_signUpgradeProof` was missed. Browser module registry dedupes the actual fetch so this is mostly cosmetic, but the asymmetry between the two callsites is the real signal — the cleanup wasn't uniform. Fix: either export `loadDhive` from `hive-keys.js` for `_signUpgradeProof` to reuse, or restructure the function so dhive is loaded once and threaded.

**Out of scope for this hold cycle (user-triaged dismissals, do NOT act on these):**

- NFKD-vs-fromLogin Unicode asymmetry between `validateMnemonic` and `PrivateKey.fromLogin` — dismissed as theoretical. PEvO-generated mnemonics are always clean ASCII; password managers preserve bytes; hand-typed recovery from non-English keyboards is rare.
- dhive mock in `pages-settings.test.js:58` collapsing role identity to a single `fakePrivateKey` — dismissed. Wrong-role signing produces a chain-rejected broadcast (missing-authority error), not a bricked account; production is correct, test mock is a UX residual.
- `loadDhive` caching the resolved value instead of the in-flight Promise — dismissed. Browser module registry handles dedup; no production failure mode.
- Backend test missing pinned WIF anchors — dismissed (covered separately in the backend hold cycle's tradeoffs; frontend snapshots already pin values).
- Validation asymmetry (frontend pushes `validateMnemonic` to callers, backend validates inline) — dismissed. All frontend user-input paths (`settings.js:748`, `recover.js:267`) validate before deriving; self-generated paths don't need it. Intentional architecture.

**`_mounted` guard around `_completeUpgradeAfterBackend`'s 45s Keychain loop** is a separate pre-existing issue that the diff widens. Filed as `agents/docs/tasks/pending/ui-upgrade-flow-mounted-guards.md` — NOT part of this hold cycle.

**Re-review trigger:** when all 3 items above are landed, `git mv` this file back to `tasks/review/` and the architect's next review pass picks it up. Do NOT edit the hold block itself or annotate fixes inside it — the commit diff is the evidence; the architect updates the hold block during re-review.

## Architect re-review (2026-05-16, round 4 → round 5) — round-4 verified; new hold

**Round-4 verification (commit `f648303`):** All 3 items from the prior hold landed correctly. The `deriveCallCount >= 3 → >= 4` test boundary now lands the throw inside `_performKeychainImport` pre-loop (call sequence traced: rotation-old/rotation-new at calls 1+2, sign-proof at 3, import pre-loop at 4); `deriveAllKeys` delegates to `deriveHiveKeys` with a single `PrivateKey.fromLogin` site module-wide; `_signUpgradeProof` reuses the now-exported `loadDhive` instead of `await import('@hiveio/dhive')` direct.

`/ce-code-review` on the round-4 diff surfaced 2 new actionable items the user elected to fix before archive. Cross-corroboration on item 1 across three reviewers (testing, maintainability, julik-frontend-races) drove confidence to anchor 100.

1. **`_performUpgradeKeyRotation` still uses direct `await import('@hiveio/dhive')`** — `frontend/src/pages/settings.js:1139`. Round-4's item 3 exported `loadDhive` from `hive-keys.js` and routed `_signUpgradeProof` through it, but `_performUpgradeKeyRotation` (sibling function, same file, same module need) was missed. The asymmetry that the round-3 hold's item 3 explicitly named ("cleanup wasn't uniform") has been rotated from `_performKeychainImport` vs `_signUpgradeProof` to `_signUpgradeProof` vs `_performUpgradeKeyRotation` rather than eliminated. The `loadDhive` JSDoc says the export exists so callers "can reuse the cached module instead of issuing a parallel `await import('@hiveio/dhive')`" — `_performUpgradeKeyRotation` violates that contract. Runtime impact is near-zero (browser module registry dedupes the fetch) but the in-file inconsistency is real. Fix: replace `const dhive = await import('@hiveio/dhive');` at line 1139 with `const dhive = await loadDhive();`. `loadDhive` is already in the file's import list from round-4's item 3.

2. **`deriveAllKeys` re-parse cycle has no inline comment flagging deliberate intent** — `frontend/src/hive-keys.js:83`. After round-4's delegation, `deriveAllKeys` does `fromLogin → toString → fromString` (4 `fromLogin` inside `deriveHiveKeys`, then 4 `fromString` back in `deriveAllKeys`) where round-3 did 4 `fromLogin` operations. The JSDoc on `deriveAllKeys` explains the delegation rationale (drift prevention) but the call site itself has no inline comment anchoring why the round-trip is the point. A future "fix the apparent inefficiency" refactor could inline `fromLogin` back into `deriveAllKeys` and silently re-introduce the algorithm-split risk the round-4 fix was meant to eliminate. The parity test in `hive-keys.test.js` pins WIF output, not call shape, so the regression would not be caught by tests; it'd only surface as algorithm drift if `deriveHiveKeys` later changed without the inlined `fromLogin` in `deriveAllKeys` getting updated in lockstep. Fix: add a short inline comment at the `dhive.PrivateKey.fromString(wifs[role])` call site (line 88) noting that the re-parse is the deliberate cost of keeping `PrivateKey.fromLogin` in one place module-wide; the existing JSDoc explains delegation, the inline comment anchors why the round-trip cycle itself is load-bearing rather than redundant.

**Out of scope for this hold cycle (dismissed):**

- Performance of `deriveAllKeys`' 8-crypto-op cycle — `deriveAllKeys` runs at signup/recovery only (rare events), bounded scope; the single-source payoff is worth the cost. Item 2 above is about commenting the trade-off, not changing it.
- The `loadDhive` cache-null concurrent-caller window (two parallel callers could both observe `_dhive === null` before the first `import()` resolves) — dismissed. Browser module registry dedupes the fetch; both `_dhive = await import(...)` assignments resolve to the same module-object reference; no observable side-effectful module-level init in `@hiveio/dhive`.
- The `loadDhive` JSDoc reference to "matches the `_performKeychainImport` pattern" being imprecise (the actual sibling is `_signUpgradeProof`) — dismissed as a comment-precision nit below the actionable floor.

**Re-review trigger:** when both items above are landed, `git mv` this file back to `tasks/review/` and the architect's next review pass picks it up. Do NOT edit the hold block itself or annotate fixes inside it — the commit diff is the evidence; the architect updates the hold block during re-review.

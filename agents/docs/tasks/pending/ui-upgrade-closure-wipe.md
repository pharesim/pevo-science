# FE-UPGRADE-CLOSURE-WIPE — Zero closure-captured key material on custody upgrade

**Owner:** UI Agent
**Priority:** P3
**Created:** 2026-04-21
**Surfaced by:** FE-UPGRADE-CREDENTIAL-WIPE archive review (2026-04-21d).

## Context

FE-UPGRADE-CREDENTIAL-WIPE's `_clearSensitiveUpgradeState()` helper zeros the reactive Alpine fields, but local `const` bindings inside `executeUpgrade()`'s try block (`oldSeed`, `oldKeys`, `newSeed`, `newKeys`, `newPubKeys`, `ownerKey`, `wifPosting`) survive until GC. Defense-in-depth — no concrete exploit today; attack requires heap-scraping browser state or an Error object that captures the frame.

## Goal

Narrow the window where derived key material is reachable. Options:

1. Scope the derivation into a narrower IIFE or helper function that exits before the wipe call, so the frame is dropped.
2. Explicit `.fill(0)` on seed buffers + overwrite each key object's fields to empty strings at end-of-try, before the wipe.
3. Document the scope limit in `_clearSensitiveUpgradeState`'s comment and accept the JS "no deterministic zero-on-release" constraint.

Prefer option 1 — JS engines are permissive about overwrite-then-GC.

## Non-goals

Rewriting the upgrade flow. Porting to WebCrypto (bigger scope).

## Deliverable

Move to Review with a heap-snapshot sketch or unit test showing the derivation frame is dropped before the wipe completes.

## Architect re-review (2026-05-04) — HELD PENDING FIXES

Round-1 `/ce-code-review` on commit `d6978a6`. The helper extraction is structurally correct and the comment block on the reachability invariant is load-bearing for security-critical defense-in-depth code. Three test gaps in the FE-UPGRADE-CLOSURE-WIPE describe block surfaced — collectively, the structural-narrowing claim the commit ships is not enforced by any test.

1. **P1 — All four closure-wipe tests pass against a no-op `_performUpgradeKeyRotation` stub** (testing + adversarial + correctness, anchor 100). A future refactor that defines `_performUpgradeKeyRotation = async () => {}` (empty no-op) and inlines the actual derivation/broadcast back into `executeUpgrade()` passes ALL FOUR tests:
   - "extracts ... helper": `expect(typeof comp._performUpgradeKeyRotation).toBe('function')` — a no-op is still a function.
   - "exits before wipe (happy path)" / "exits before wipe (error path)": event-ordering wraps preserve `perform:enter`/`perform:exit` around the no-op; ordering still preserved.
   - "returns undefined": no-op returns undefined.

   The "regression guard against future inlining" the comment claims is illusory. Fix: spy on `mnemonicToSeedSync` (or `dhive.Client.broadcast.sendOperations`) and assert it's called between `perform:enter` and `perform:exit`. That mutation-kills the no-op-stub regression — if derivation moves out of the helper, the spy fires *before* `perform:enter` (or *after* `perform:exit`), failing the ordering assertion.

2. **P1 — Test "exits before wipe (error path)" is mislabeled — exercises post-helper fetch failure, not helper-internal errors** (testing + adversarial + correctness, anchor 100). The test stubs `fetch` to fail, but `fetch` runs AFTER `_performUpgradeKeyRotation` already returned successfully. The "perform:exit" event fires on normal helper resolution before any failure. So `exitIdx < wipeIdx` is trivially true by linear control flow. Note: at HEAD (post-keychain-round-3) the helper is broadcast-only; the realistic helper-internal failure mode is `sendOperations` rejection. Fix: add a test that stubs `dhive.Client.broadcast.sendOperations` to reject mid-helper, asserts the throw propagates, asserts `executeUpgrade`'s catch handler runs `_clearSensitiveUpgradeState()`, asserts ordering still holds (frame pop on rejection).

3. **P2 — No coverage for `!isKeychainInstalled()` branch through the helper at d6978a6 shape** (testing, anchor 75). At commit d6978a6 the helper bundles broadcast + Keychain; the `isKeychainInstalled()` check guards the Keychain block. No test exercises the false branch through this helper. At HEAD the helper is broadcast-only and Keychain moved to `_performKeychainImport` (covered by the sibling `ui-keychain-api-misuse.md` round-4 hold's no-Keychain warnings item). At THIS task's level: add a test asserting the broadcast-only helper still broadcasts when Keychain is uninstalled (the broadcast must not depend on Keychain availability) — this locks the helper's invariant after the round-3 split.

**Path to re-archive:** (1) UI agent applies items #1-3. (2) `git mv` to `tasks/review/`. (3) Architect runs round-2 `/ce-code-review` on the test-file delta and archives.

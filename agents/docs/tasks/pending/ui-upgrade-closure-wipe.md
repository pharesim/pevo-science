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

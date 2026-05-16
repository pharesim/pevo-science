---
title: "Exact-pin cross-half crypto libraries — backend and frontend must pin byte-identical algorithm versions"
date: 2026-05-16
category: conventions
module: backend/package.json + frontend/package.json
problem_type: convention
component: tooling
severity: medium
applies_when:
  - "Adding a new dependency that powers BOTH backend and frontend halves of an algorithm where two consumers must compute byte-identical output from the same input — key derivation, signature generation, hash functions, encryption primitives, BIP39/mnemonic libraries, anything where the canonical state on chain or in the DB was produced by one half and the other half re-derives or verifies it"
  - "Reviewing a PR that adds or changes a dependency on `@hiveio/dhive`, `@scure/bip39`, `argon2`, `@noble/hashes`, or any future cross-half cryptographic primitive — check both `backend/package.json` and `frontend/package.json` for asymmetric pin styles (`^x.y.z` on one side, exact `x.y.z` on the other)"
  - "Auditing why a 'recovery WIF mismatch' or 'signature verification fails after deploy' bug shows up only after an upstream patch release — the silent algorithm-split window is the canonical cause"
  - "Setting up a new repo where backend and frontend share derivation logic and the dependency-pin policy is being established for the first time"
related_components:
  - authentication
tags:
  - dependency-pinning
  - cryptographic-primitives
  - cross-half-derivation
  - algorithm-split
  - silent-failure
  - keychain-compat
  - bip39
---

# Exact-pin cross-half crypto libraries — backend and frontend must pin byte-identical algorithm versions

## Context

PEvO derives Hive private keys via `PrivateKey.fromLogin(account, mnemonic, role)` from `@hiveio/dhive`. The frontend calls this at signup to broadcast pubkeys to chain (the canonical state). The backend calls the SAME function later for recovery and key-management flows. Both halves MUST compute byte-identical output from the same `(account, mnemonic, role)` triple, or every new light-account signup ends up with on-chain pubkeys that no longer round-trip to the backend's recovery WIFs — silently, with no error at signup time.

Round-1 `/ce-code-review` on `backend-seed-phrase-keychain-compat` caught an asymmetric pin: `backend/package.json` had `"@hiveio/dhive": "^1.3.6"` while `frontend/package.json` had exact `"@hiveio/dhive": "1.3.6"`. dhive's `PrivateKey.fromLogin` has been stable for years; the practical risk in this specific case is near-zero. But the asymmetry has no upside, and the failure mode if it ever triggers is silent + permanent (every account derived under the split would have unrecoverable recovery WIFs without per-account rederivation under the algorithm the broadcaster used). Round-2 fix (commit `98b3b46`): tightened backend to exact `1.3.6` matching frontend.

This convention generalizes that fix: any library powering both halves of a write/recovery (or write/verify) pair is exact-pinned in both `package.json` files.

## Guidance

When a library powers both halves of a write/recovery (or write/verify) pair:

1. **Both `package.json` files use exact pins (no `^`, no `~`, no range)** for that dependency. The two pins MUST be byte-identical version strings.
2. **The broadcaster's pin is load-bearing.** For PEvO this is the frontend (browser generates mnemonic, derives, broadcasts pubkeys to chain). The frontend's pin determines what gets written to canonical state. The backend's pin matches exactly so recovery re-derivation produces the same WIFs.
3. **In practice the rule is symmetric** — both halves exact-pin the same version string. Treating one side as "broadcaster" and the other as "reader" is a useful mental model for thinking about pin direction but the operational rule is "match exactly, both sides."
4. **Loosen the pin only when** (a) the upstream library documents stability for the specific function across patches AND (b) the function's input/output is reflected back in the canonical state somehow (e.g., the input is recoverable, or a downstream verification step catches mismatches). For cryptographic primitives where the input is a user secret (mnemonic, password) and the output is what's written to chain, NEITHER condition is true — exact-pin always.
5. **Test discipline:** add a parity test (or cross-half integration test) that fails if the algorithm produces different output across the two halves. PEvO's `backend/tests/seed-phrase.test.ts` does this for `PrivateKey.fromLogin`: every role's WIF returned by `deriveKeysFromMnemonic` is compared against `PrivateKey.fromLogin(account, mnemonic, role).toString()` computed directly. The parity test is the runtime-invariant complement to the version-pin invariant — both are load-bearing.

## Why This Matters

The failure mode is uniquely bad: silent at signup time, permanent for any account created during the split window, and not surfaced by any error log. The user finds out their recovery doesn't work only when they try to use it — by which time the on-chain pubkey is canonical and unfixable without per-account rederivation under the algorithm the broadcaster used.

Library patch releases (`1.3.6 → 1.3.7`) typically don't alter algorithm output — the semver contract says they shouldn't. But:

- "Shouldn't" is not "won't." Cryptographic libraries have shipped behavior-changing patches in the past (argument-order tweaks, hashing-step adjustments, edge-case handling). Treating semver patches as "always safe" for cross-half algorithm libraries is taking a risk that has no upside.
- The fix after-the-fact is expensive. A single account's broken recovery is a support ticket. Many accounts' broken recovery is a project-shaping problem (every affected user needs per-account rederivation tooling, and you have to know which version the broadcast happened under). The pin discipline costs one line per `package.json` and prevents the class entirely.
- Cross-half algorithm-split is the kind of bug that doesn't show up in tests because tests run with one lockfile state. Production runs with whatever's in node_modules at deploy time. CI passing is no defense if the prod lockfile diverges from CI's (e.g., a re-install on a different day under a `^` pin can resolve to a new patch version).

The reviewer's framing in round-1 was "the asymmetry has no upside" — that's the right calibration. The rule isn't "this WILL break"; it's "tightening the pin costs nothing and eliminates a class of silent failure entirely."

## When to Apply

- When adding any new dependency on a cryptographic library (key derivation, signatures, hashing, encryption, KDF, mnemonic libraries).
- When upgrading a cross-half crypto library and the lockfile shows divergent resolved versions across the two halves.
- When reviewing a PR that touches `backend/package.json` or `frontend/package.json` and adds or changes a dependency that the OTHER half also depends on.
- When a new "recovery mismatch" or "signature verification failure" bug report surfaces — the asymmetric pin window is the first thing to rule out.

## Examples

### Before (asymmetric — algorithm-split window exists under upstream patches)

```jsonc
// backend/package.json
"dependencies": {
  "@hiveio/dhive": "^1.3.6",     // ← caret allows 1.3.x patches to land
  ...
}

// frontend/package.json
"dependencies": {
  "@hiveio/dhive": "1.3.6",      // ← exact pin
  ...
}
```

Under this shape, an `npm install` on the backend host could resolve to `1.3.7` (or later 1.3.x) while the frontend stays at `1.3.6`. If `1.3.7` ever altered `PrivateKey.fromLogin`'s output (argument-order interpretation, internal hashing primitive, anything), every new signup would broadcast pubkeys derived under the frontend's `1.3.6` while the backend's recovery path would compute WIFs under `1.3.7`. The two halves silently diverge.

### After (symmetric — algorithm-split window closed)

```jsonc
// backend/package.json
"dependencies": {
  "@hiveio/dhive": "1.3.6",      // ← exact, matches frontend
  ...
}

// frontend/package.json
"dependencies": {
  "@hiveio/dhive": "1.3.6",      // ← exact (broadcaster's pin)
  ...
}
```

The two halves resolve to byte-identical library code regardless of when `npm install` is run on either side. Upgrading the library is now a deliberate cross-half operation: both `package.json` files change in the same commit, the parity test runs against the new version, and any algorithm change is caught at commit time rather than discovered at recovery time months later.

### Parity test (the runtime-invariant complement)

`backend/tests/seed-phrase.test.ts` pins the algorithm-level invariant:

```typescript
it('every role WIF equals PrivateKey.fromLogin(account, mnemonic, role).toString()', () => {
  const keys = deriveKeysFromMnemonic(mnemonic, account);
  for (const role of ROLES) {
    expect(keys[role].private).toBe(
      PrivateKey.fromLogin(account, mnemonic, role).toString()
    );
  }
});
```

The version pin keeps the two halves on the same dhive bits; the parity test keeps `deriveKeysFromMnemonic` from drifting away from `PrivateKey.fromLogin` itself. Together they close both the "library changed under us" failure and the "our wrapper drifted from the library" failure.

## Related

- `agents/docs/tasks-archive.md` — `BACKEND-SEED-PHRASE-KEYCHAIN-COMPAT (archived 2026-05-16)` archive entry; the task this convention emerged from.
- Commit `98b3b46` — `backend(seed-phrase-keychain-compat): round-2 hold fixes (3 items)`; landed the exact-pin alignment as item 1.
- `backend/src/seed-phrase.ts` + `frontend/src/hive-keys.js` — both halves of PEvO's derivation pair.
- `backend/tests/seed-phrase.test.ts` — the parity test that complements the version pin.
- Future candidates for the same discipline: `@scure/bip39` (mnemonic generation/validation — backend and frontend both validate), `@hiveio/dhive` cryptoUtils (signature operations).

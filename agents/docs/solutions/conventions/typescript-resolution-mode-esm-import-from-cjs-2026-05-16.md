---
title: "Typed static imports of ESM-only packages from CJS host files (TS 6 + Node16) require `with { 'resolution-mode': 'import' }`"
date: 2026-05-16
category: conventions
module: backend/tsconfig.json + ESM-only dependencies in CJS host files
problem_type: convention
component: tooling
severity: low
applies_when:
  - "Typing an ESM-only package (one whose `package.json` has `\"type\": \"module\"` or whose `exports` field defines only the `\"import\"` condition) in a TypeScript host file classified as CommonJS, under `\"module\": \"Node16\"` / `\"NodeNext\"` / `\"node16\"` module resolution"
  - "Replacing a `let _x: any = null` cache with a typed `let _x: typeof X | null = null` for a lazy-loaded ESM package that the host file dynamically imports via `await import('pkg')` — the type-only static import that enables the `typeof X` annotation is what triggers the TS1541 error"
  - "Seeing TS1541 (`Type-only import of an ECMAScript module from a CommonJS module must have a 'resolution-mode' attribute`) and trying to figure out the minimum-syntax fix"
  - "Reviewing a TS PR that adds an `import type * as X from 'esm-only-pkg'` line in `backend/` and doesn't carry the `with { 'resolution-mode': 'import' }` attribute"
related_components:
  - tooling
tags:
  - typescript
  - resolution-mode
  - esm
  - cjs
  - dynamic-import
  - typed-cache
  - node16
  - lazy-load
---

# Typed static imports of ESM-only packages from CJS host files need `with { 'resolution-mode': 'import' }`

## Context

PEvO's `backend/` is compiled as CommonJS (no `"type": "module"` in `backend/package.json`), but several runtime dependencies are ESM-only — most notably `@scure/bip39`. The runtime pattern is straightforward: use dynamic `import('pkg')` (which Node treats as ESM regardless of host module classification). The type-level pattern is more awkward.

To type a lazy-loaded ESM-only module cache cleanly — e.g., `let _bip39: typeof Bip39 | null = null` so tsc verifies argument types at the eventual `bip39.generateMnemonic(...)` call sites — you need a static type-only import that references the package's `.d.ts`. Under TypeScript 6 (or 5.x with strict module-resolution flags) running `"module": "Node16"` / `"NodeNext"` / `"node16"`, that static type-only import does NOT work in its naive form:

```typescript
import type * as Bip39 from '@scure/bip39';
//                                          ^
// TS1541: Type-only import of an ECMAScript module from a CommonJS module
//         must have a 'resolution-mode' attribute
```

The compiler refuses because Node16 resolution looks up type imports against the host file's module classification (CJS), and the ESM-only package's `exports` field doesn't define a CJS condition, so type resolution fails.

The fix is the `with { 'resolution-mode': 'import' }` import attribute: it tells the compiler to resolve the type lookup against the ESM conditions of the package's `exports` field, regardless of the host file's classification.

This convention is non-obvious for three reasons: the error message is dense; the fix syntax is recent (TS 6 / late 5.x); and the `any` workaround (write `let _x: any = null` and silence the eslint warning) is initially tempting but leaves a tsc bypass that allows argument-type mistakes at every consumer call site.

## Guidance

When you need to type a lazy-loaded ESM-only package in a CJS host file (no `"type": "module"` in the host's nearest `package.json`):

1. **Use a static type-only import with the resolution-mode attribute:**

   ```typescript
   import type * as PackageName from 'esm-only-pkg' with { 'resolution-mode': 'import' };
   ```

   `import type` ensures the import is erased at compile time (no runtime cost, no CJS-require attempt). The `with { 'resolution-mode': 'import' }` attribute is what unblocks the TS1541 rejection — it scopes the type resolution to the ESM half of the package's `exports`.

2. **Annotate the module-level cache with `typeof PackageName`:**

   ```typescript
   let _cache: typeof PackageName | null = null;
   ```

   This gives tsc the full namespace type to check call sites against. Avoid `any` here — it disables argument-type checking at every consumer call site.

3. **Hydrate the cache via dynamic `import()` at runtime:**

   ```typescript
   async function loadPkg() {
     if (!_cache) {
       _cache = await import('esm-only-pkg');
     }
     return _cache;
   }
   ```

   Plain dynamic `import()` works under both Node16/CJS and vitest/ESBuild's ESM bundling — Node treats `import()` as ESM regardless of host module classification. (An older PEvO workaround used `eval('import(...)')` to dodge a TypeScript-emit issue; that workaround failed under vitest because eval doesn't carry the dynamic-import callback. Plain `import()` is correct under both runners.)

4. **Match the package's `exports` field for subpath imports:** if the package's `exports` lists subpaths with explicit file extensions (e.g., `"./wordlists/english.js"`), include the `.js` suffix in your dynamic import literal — TypeScript can't synthesize the suffix when the exports declaration is explicit.

5. **Do NOT use `let _x: any` as a substitute.** It silences tsc at every consumer site (argument-order swaps, wrong-type arguments compile cleanly). The whole point of typing the lazy-load is to keep the call sites checked.

## Why This Matters

The `with { 'resolution-mode': 'import' }` attribute is a load-bearing syntactic detail that future maintainers will be tempted to delete — it looks like an oddity. The convention exists to prevent that deletion from re-introducing the TS1541 error (or worse, motivating a regression to `let _x: any`).

The cost of NOT following this convention:

- **`any` workaround path:** every call site loses argument-type checking. A future argument-order swap (`generateMnemonic(strength, wordlist)` instead of `(wordlist, strength)`) compiles cleanly and fails only at runtime, possibly silently if the strength argument coerces to a truthy wordlist-like shape. This is the exact tsc bypass that `backend-seed-phrase-keychain-compat` round-2 had to close.
- **Naive `import type` without attribute path:** typecheck breaks on next compile under Node16/NodeNext. CI fails loud; the fix is the attribute, but the syntax is dense enough that the loop costs the developer 20-30 minutes the first time.
- **Switching to ESM host (`"type": "module"`) to dodge it:** large rewrite (every `require`-style import in the codebase shifts), introduces ESM-CJS interop concerns at every backend↔dep boundary, doesn't fit PEvO's current backend module classification.

The attribute is the small-edit fix the language explicitly designed for this scenario. The convention is just to write it the first time and not delete it.

## When to Apply

- Adding a new dependency that's ESM-only (check the dep's `package.json` for `"type": "module"` or an `exports` field with only an `"import"` condition).
- Refactoring an existing `let _x: any` cache to a typed `let _x: typeof X | null` cache (this is where the round-2 PEvO fix surfaced the pattern).
- Hitting TS1541 on a type-only import of an ESM-only package in a CJS file.
- Reviewing a TS PR that adds a static type-only import in a backend file — verify the attribute is present.

## Examples

### Before (TS1541 error under Node16/TS6, or the `any`-cache workaround that bypasses tsc)

```typescript
// Path A: TS1541 compile error
import type * as Bip39 from '@scure/bip39';
//                                          ^^^^^^^^^^^^^^^^^^^^
//   error TS1541: Type-only import of an ECMAScript module from a
//   CommonJS module must have a 'resolution-mode' attribute.

let _bip39: typeof Bip39 | null = null;
```

```typescript
// Path B: the `any` workaround — compiles, but the consumer calls
// (bip39.generateMnemonic, bip39.validateMnemonic) lose argument-type
// checking entirely. A future argument-order swap compiles cleanly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _bip39: any = null;

async function loadBip39() {
  if (!_bip39) {
    _bip39 = await import('@scure/bip39');
  }
  return _bip39 as { generateMnemonic: Function; validateMnemonic: Function };
  //                                  ^^^^^^^^                ^^^^^^^^
  //                       Function widens both call-site argument
  //                       lists to `(...args: any[])`.
}
```

### After (typed static import with attribute; tsc verifies call sites)

```typescript
import type * as Bip39 from '@scure/bip39' with { 'resolution-mode': 'import' };

let _bip39: typeof Bip39 | null = null;
let _wordlist: string[] | null = null;

async function loadBip39() {
  if (!_bip39) {
    _bip39 = await import('@scure/bip39');
    const wl = await import('@scure/bip39/wordlists/english.js');
    _wordlist = wl.wordlist;
  }
  return { bip39: _bip39, wordlist: _wordlist! };
}

// Now bip39.generateMnemonic(wordlist, 128) at call sites is checked
// against the package's real .d.ts signature
// (wordlist: string[], strength?: number) => string.
```

### Combine with atomic-cache shape to remove the `!` assertion entirely

A related pattern surfaced in the same task (round-3): when the lazy cache stores multiple correlated values, collapse them into a single atomic object so the `if (!_cache)` guard provably narrows both fields and the `!` non-null assertion goes away.

```typescript
import type * as Bip39 from '@scure/bip39' with { 'resolution-mode': 'import' };

let _cache: { bip39: typeof Bip39; wordlist: string[] } | null = null;

async function loadBip39() {
  if (!_cache) {
    const bip39 = await import('@scure/bip39');
    const wl = await import('@scure/bip39/wordlists/english.js');
    _cache = { bip39, wordlist: wl.wordlist };
  }
  return _cache;
  //     ^^^^^^ tsc proves non-null inside this function body after the guard
}
```

The atomic-cache pattern is itself documented at `agents/docs/solutions/conventions/ts-closure-denarrowing-nullable-property-hoist-2026-05-04.md`; pair the two conventions for the cleanest shape (typed + atomic, no `any`, no `!`).

## Related

- `agents/docs/solutions/conventions/ts-closure-denarrowing-nullable-property-hoist-2026-05-04.md` — the sibling convention for collapsing two correlated nullable variables into one atomic cache; pairs naturally with this one for lazy-load helpers.
- `agents/docs/tasks-archive.md` — `BACKEND-SEED-PHRASE-KEYCHAIN-COMPAT (archived 2026-05-16)` archive entry; round 2 introduced this convention to PEvO.
- Commit `98b3b46` — `backend(seed-phrase-keychain-compat): round-2 hold fixes (3 items)`; landed the typed static import + atomic-cache combo.
- `backend/src/seed-phrase.ts` — canonical PEvO example of the pattern.
- TypeScript handbook on `resolution-mode` attribute — external reference (TypeScript 5.3+).

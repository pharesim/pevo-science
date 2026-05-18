---
title: "`satisfies Record<K, ...>` is the canonical fix for mapped-type / `Set` overclaims of union completeness"
date: 2026-05-17
module: backend/src
problem_type: convention
component: typescript
severity: medium
applies_when:
  - "A mapped-type or `Set` declaration is used to enumerate values of a named union (e.g., `ScriptReturn`, `VALID_MODES`)"
  - "The author wants 'adding a new member to the union without updating this enumeration is a compile error'"
  - "The current declaration uses `Set<UnionType>`, `Record<string, ...>`, or `{ [key]: ... }` without a `satisfies` constraint"
tags:
  - typescript
  - satisfies
  - mapped-type
  - union-completeness
  - exhaustiveness
  - discipline-interface
related_components:
  - typescript_constructs
---

# `satisfies Record<K, ...>` for mapped-type / Set completeness

When a TypeScript declaration enumerates members of a named union, the natural shapes (`Set<T>`, `Record<string, ...>`, plain object literal) verify per-element type but do NOT verify union-completeness. Adding a new member to the union compiles silently. `satisfies Record<UnionType, ...>` (TypeScript 4.9+) is the canonical fix.

## Context

PEvO has at least two instances of this overclaim documented this session:

**Instance 1 — `ScriptReturn` mapped type (`backend/src/lib/redis-scripts.ts`):**

```ts
export type SharedScriptName = keyof typeof SHARED_SCRIPTS;

// JSDoc claimed: "a future script added without an entry here is a compile error"
export type ScriptReturn = {
  RATE_LIMIT_CHECK_AND_CONSUME: [number, number];
  INCR_AND_EXPIRE_ON_ZERO_TO_ONE: number;
  RELEASE_LOCK_IF_TOKEN_MATCHES: 0 | 1;
};

export async function evalScript<N extends SharedScriptName>(
  redis: Redis, name: N, keys: string[], args: (string | number)[],
): Promise<ScriptReturn[N]> { ... }
```

The JSDoc's claim is **false**. `SharedScriptName = keyof typeof SHARED_SCRIPTS` auto-extends when a script is added to `SHARED_SCRIPTS`, but `ScriptReturn` is a standalone type with hardcoded keys. Adding a fourth script to `SHARED_SCRIPTS` produces `ScriptReturn[NewScriptName]` resolving to `never` (or `unknown` depending on context), not a compile error at the definition site.

**Instance 2 — `VALID_MODES` Set (`backend/src/routes/orcid.ts`):**

```ts
type OrcidMode = 'signup' | 'login' | 'accredit' | 'link' | 'fresh_auth' | 'session_auth';

// Pre-fix JSDoc claimed: "a missing OrcidMode literal becomes a compile error"
const VALID_MODES: ReadonlySet<OrcidMode> =
  new Set<OrcidMode>(['signup', 'login', 'accredit', 'link', 'fresh_auth', 'session_auth'])
  satisfies ReadonlySet<OrcidMode>;
```

The `Set<OrcidMode>` typing prevents typos in the array literal (each element must be a valid `OrcidMode` literal) but does not require every union member to appear. A future `OrcidMode` addition without updating the array compiles silently and fails at runtime when `/start` rejects the unknown mode with 400 BAD_REQUEST.

## Guidance

Use `satisfies Record<UnionType, ...>` at the definition site to make the constraint compile-enforced.

**`satisfies` is value-level only — the type-alias form does not compile.** A pseudocode shape like `export type ScriptReturn = { ... } satisfies Record<SharedScriptName, unknown>` is convenient shorthand for describing intent, but `satisfies` is a postfix operator on expressions (TS 4.9+) and cannot appear after a type-alias right-hand side; the parser reports `';' expected` (TS1109). The working canonical attaches `satisfies` to a value (object literal carrying the shape) and re-exports the public type via `typeof`:

```ts
// For mapped types — the working canonical form:
const _SCRIPT_RETURN_SHAPE = {
  RATE_LIMIT_CHECK_AND_CONSUME: [0, 0] as [number, number],
  INCR_AND_EXPIRE_ON_ZERO_TO_ONE: 0 as number,
  RELEASE_LOCK_IF_TOKEN_MATCHES: 0 as 0 | 1,
} satisfies Record<SharedScriptName, unknown>;
//  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//  Both divergence directions now fail at the definition site:
//    - SHARED_SCRIPTS key missing from ScriptReturn → compile error
//      (Record<SharedScriptName, unknown>'s required-keys check fails)
//    - ScriptReturn key not in SHARED_SCRIPTS       → compile error
//      (object-literal excess-property check that `satisfies` enforces)
export type ScriptReturn = typeof _SCRIPT_RETURN_SHAPE;
```

Two things make the value-shape form work: (a) each placeholder value carries an `as <type>` annotation so `typeof _SCRIPT_RETURN_SHAPE[K]` recovers the intended per-key type (without the annotations, `typeof` would infer narrowed literal types like `0` instead of `number`); (b) the `_` underscore prefix signals "internal implementation detail" — only `ScriptReturn` is part of the public API. The `_SCRIPT_RETURN_SHAPE` constant is a runtime artifact (small object literal that survives into the emitted JS), but its cost is negligible against the load-bearing exhaustiveness invariant it underwrites.

For `Set`-of-union shapes where you also want literal-typo protection:

```ts
// Build via a Record<UnionType, true> intermediate to get true exhaustiveness:
const VALID_MODES_RECORD = {
  signup: true,
  login: true,
  accredit: true,
  link: true,
  fresh_auth: true,
  session_auth: true,
} satisfies Record<OrcidMode, true>;
const VALID_MODES: ReadonlySet<OrcidMode> = new Set(
  Object.keys(VALID_MODES_RECORD) as OrcidMode[],
);
```

OR document the existing pattern honestly (the path round-4 took for `VALID_MODES`):

```ts
// VALID_MODES — Set<OrcidMode> + satisfies ReadonlySet<OrcidMode> verifies
// that each initializer element is a valid OrcidMode literal (prevents
// typos in the array). It does NOT enforce union-completeness — a future
// OrcidMode added without updating this array compiles silently and falls
// through to /start's 400 BAD_REQUEST at runtime. The dispatch-side
// assertNever in the /callback switch over storedMode is the compile-time
// exhaustiveness backstop.
const VALID_MODES = new Set<OrcidMode>([...]) satisfies ReadonlySet<OrcidMode>;
```

The honest-comment path is acceptable when (a) the runtime fallback fails loudly and deterministically, (b) a separate dispatch-side `assertNever` arm provides the actual compile-time exhaustiveness, and (c) the comment explicitly names what the construct does and doesn't enforce. The `satisfies Record` path is preferable when no such backstop exists or when the union grows frequently.

## Why This Matters

The failure mode is **silent type-system divergence**: a developer reads the JSDoc/comment and trusts that a future change will fail loudly, but TypeScript actually accepts the divergence. The bug surfaces later as a runtime fall-through (400 BAD_REQUEST), a `never`-typed call result, or an audit-emission case the new union member doesn't reach. The chain from "added to union" to "discovered missing" can span weeks if no test exercises the new value.

The class is documented broadly in `discipline-interface-tsc-perimeter-omission-2026-05-11.md` — TypeScript discipline constructs frequently protect less than their authors believe. This convention is the canonical fix-shape for the union-completeness sub-class.

## When to Apply

Use `satisfies Record<UnionType, ...>` whenever:

1. A declaration enumerates members of a named union (string-literal union, `keyof typeof`, etc.).
2. The author expects the enumeration to stay in sync with the union as the union grows.
3. The cost of getting silently out of sync exceeds the cost of the `satisfies` clause (~one line + the runtime sentinel value like `true` or `unknown`).

Skip the constraint and use an honest comment when:

1. A separate dispatch-side `assertNever` arm provides the actual exhaustiveness backstop.
2. The runtime fallback for an unmapped value is loud and deterministic (e.g., 400 BAD_REQUEST at the entry point, not a silent fall-through).
3. The union is stable and unlikely to grow.

## Examples

**`ScriptReturn` — the canonical fix (value-shape + `typeof` form):**

```ts
// Before
export type ScriptReturn = {
  RATE_LIMIT_CHECK_AND_CONSUME: [number, number];
  INCR_AND_EXPIRE_ON_ZERO_TO_ONE: number;
  RELEASE_LOCK_IF_TOKEN_MATCHES: 0 | 1;
};

// After — value-shape + `typeof` (the working analog; the type-alias form
// `type X = { ... } satisfies Record<...>` does not compile)
const _SCRIPT_RETURN_SHAPE = {
  RATE_LIMIT_CHECK_AND_CONSUME: [0, 0] as [number, number],
  INCR_AND_EXPIRE_ON_ZERO_TO_ONE: 0 as number,
  RELEASE_LOCK_IF_TOKEN_MATCHES: 0 as 0 | 1,
} satisfies Record<SharedScriptName, unknown>;
export type ScriptReturn = typeof _SCRIPT_RETURN_SHAPE;
```

The two-line addition collapses both divergence directions to a compile error at the definition site. The placeholder values carry `as <type>` annotations so `typeof` preserves the original per-key precision; without them, `typeof` would infer narrowed literal types (e.g., `0` instead of `number`) and downstream `ScriptReturn[N]` consumers would lose type information.

**`VALID_MODES` — the honest-comment path (chosen by round-4 implementer):**

The existing `Set<OrcidMode> satisfies ReadonlySet<OrcidMode>` pattern was kept because (a) `/callback`'s `switch (storedMode) { default: return assertNever(storedMode); }` already enforces dispatch-side exhaustiveness, (b) `/start`'s `isOrcidMode(mode)` check rejects unknown modes with loud 400 BAD_REQUEST, and (c) `OrcidMode` is a small bounded union. The docstring was rewritten to accurately describe per-element vs union-completeness and name the `assertNever` backstop.

## Cross-references

- `agents/docs/solutions/conventions/discipline-interface-tsc-perimeter-omission-2026-05-11.md` — broader rule: TS discipline constructs protect less than authors believe; verify what's actually checked
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — adjacent: when a wrapper type is added, audit every call site for the new constraint

Surfaced in: `backend-custody-upgrade-seed-phrase-reauth` round-4 hold item 2 (kieran-typescript KT-1, P1/85, commit `62066cb`, hold `21457d8`); `backend-custody-broadcast-orcid-fresh-auth` round-3 hold item 2 (correctness + kieran-typescript P2/100, commit `f29028f`).

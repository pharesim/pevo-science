---
title: "Caching wrappers must not cache transient-failure discriminated-union variants"
date: 2026-05-11
category: conventions
module: backend/src/cache.ts
problem_type: convention
component: caching
severity: high
applies_when:
  - "A cached function returns a discriminated union with a success variant AND one or more transient-failure sentinels (e.g., `{status: 'ok', ...}` | `{status: 'haf_unavailable'}`)"
  - "A caching wrapper (`hafCache.getOrSet`, any TTL cache helper) caches any non-null/undefined return value without inspecting the discriminant"
  - "Writing a `getOrSet`-style helper: verify the predicate the helper uses filters to success-variant only, not to all truthy objects"
  - "Adding a new failure sentinel to a discriminated-union return type that is already consumed by a caching wrapper"
  - "Reviewing a route handler that calls a HAF-backed helper through a cache layer: confirm transient HAF errors cannot be promoted to cached answers"
  - "Wrapping any chain-state-dependent helper (HAF queries, Hive API reads) where the helper distinguishes 'authority unreachable' from 'authority answered'"
tags:
  - caching
  - discriminated-union
  - transient-failure
  - fail-open
  - hafCache
  - getOrSet
---

# Caching wrappers must not cache transient-failure discriminated-union variants

## Context

During the round-1 code review of `backend-bridge-write-haf-lag-and-retry-amplification` (commit `d513d7d`), four independent reviewer personas — correctness, reliability, adversarial, and kieran-typescript — all flagged the same issue at `backend/src/routes/bridge.ts:256`. The GET `/api/bridge/check` handler wraps `checkExistingBridge(identifier, parsed)` inside `hafCache.getOrSet(...)`. The function returns a discriminated union: `{status: 'ok', exists, author, permlink, ...}` on success, and `{status: 'haf_unavailable'}` when the HAF query fails (the fail-closed-on-write / fail-open-on-read discriminated-union pattern introduced by the task).

`QueryCache.getOrSet` at `backend/src/cache.ts:68-77` caches any return value that is not null or undefined. Because `{status: 'haf_unavailable'}` is a non-null object, it passes that check and gets stored for the full 30-second TTL. The four independent catches signal a real trap that is not obvious from either layer in isolation — the discriminated-union design at one layer composed with the cache-anything-non-null check at the other layer to produce a silent failure-extension behavior.

## Guidance

When a function returns a discriminated union with both success variants and non-null transient-failure variants, never pass it directly to a generic `getOrSet` wrapper that caches any non-null/undefined return value. Cache only success variants explicitly.

**Pattern 1 — inline conditional caching (preferred for individual call sites)**

```ts
// BEFORE — caches ALL variants, including the failure sentinel
const result = await hafCache.getOrSet(
  cacheKey,
  () => checkExistingBridge(identifier, parsed),
  30_000,
);

// AFTER — caches only the success variant
const cached = hafCache.get<BridgeCheckResult>(cacheKey);
const result = cached ?? await checkExistingBridge(identifier, parsed);
if (!cached && result.status === 'ok') {
  hafCache.set(cacheKey, result, 30_000);
}
```

The failure sentinel is never stored. On a HAF blip, the next call re-runs the live query rather than serving the cached failure for up to 30 seconds.

**Pattern 2 — discriminator-aware `shouldCache` predicate (preferred when multiple call sites face the same composition)**

Extend `QueryCache.getOrSet` to accept an optional predicate:

```ts
getOrSet<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs: number,
  shouldCache?: (value: T) => boolean,  // defaults to: v => v != null
): Promise<T>
```

Call sites that return discriminated unions pass a union-aware predicate:

```ts
const result = await hafCache.getOrSet(
  cacheKey,
  () => checkExistingBridge(identifier, parsed),
  30_000,
  r => r.status === 'ok',
);
```

Pattern 1 is the right fix for a single call site. Pattern 2 is the right fix when multiple call sites across the codebase face the same composition.

**Audit heuristic.** Run:

```bash
grep -rn 'getOrSet' backend/src/
```

For each hit, inspect the wrapped function's TypeScript return type. If it is a discriminated union with a non-null failure variant, apply Pattern 1 or Pattern 2.

## Why This Matters

Two individually correct patterns compose into a new failure mode:

- The discriminated-union design is the correct TypeScript idiom for "success + known failure modes." It gives callers exhaustive type checking and explicit error handling. It is documented in `agents/docs/solutions/conventions/correlated-options-discriminated-union-2026-04-28.md`.
- The `getOrSet` wrapper is the correct idiom for memoizing expensive lookups. Its null/undefined sentinel check is correct for functions that return null on "nothing found."

The trap emerges purely from composition. The cache treats union variants as opaque values and has no way to know which variant represents a cache-worthy success versus a transient failure that should be retried on the next call.

In the bridge case: HAF recovers from a blip in 1-2 seconds. Without the fix, `/check` keeps serving the stale `haf_unavailable` sentinel — mapped to `{exists: false}` (fail-open) — for the remainder of the 30-second TTL window. A user who tries to register a bridge whose existence answer is correctly `false` would see a stale "no bridge found" non-answer for up to 30 seconds after HAF comes back online. In a scenario where the fail-open mapping matters for correctness (registering a bridge that is believed not to exist but actually does), the window could drive a data-integrity error.

This also violates the project-wide principle that caches in PEvO are performance layers over an authoritative source, not authority themselves (auto memory [claude]: `feedback_dont_relitigate_settled_ssot`). A cache that extends a transient "couldn't reach authority" sentinel into a full TTL window elevates that non-answer to "authoritative response for the next 30 seconds." The principle demands that when authority is unreachable, the cache must not step in with a stale failure — it must stand aside and let the next call try the authority again.

The meta-principle generalizes beyond this site. Any time a recommended abstraction (cache wrapper, serializer, middleware) operates on values produced by another recommended abstraction (discriminated union, option type, result type), check that the consuming abstraction's invariants cover all variants the producing abstraction can emit. The null/undefined sentinel in `getOrSet` was designed for "nothing found" nullables, not for typed failure objects. Discriminated unions promote typed failure objects by design. That is the exact composition gap.

A parallel instance of this meta-principle (two correct patterns creating a new failure mode at composition) is illustrated in `agents/docs/solutions/conventions/pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md`, where correct serialization and correct redaction policies composed into a redaction bypass.

## When to Apply

Apply this rule whenever all of the following hold:

1. You are calling `QueryCache.getOrSet` (or any equivalent memoize / cache-aside helper that caches any non-null/undefined return value).
2. The wrapped function's return type is a discriminated union with two or more variants.
3. At least one failure or degraded variant is a non-null object — an object with a status discriminator, an Error subclass, a typed sentinel.

The quick test: "Does my cached function return more than one variant, and is any failure variant a non-null object?" If yes, the generic null/undefined check will cache the failure variant. Use Pattern 1 or Pattern 2.

If the cached function returns a plain nullable (`T | null | undefined`) where null means "not found" and there is no failure-variant object, the default behavior is correct and no change is needed. This is the common case `getOrSet` was designed for; the discriminated-union case is the new shape that the wrapper's contract doesn't cover.

## Examples

**Canonical instance: `backend/src/routes/bridge.ts:256`**

`checkExistingBridge` returns `BridgeCheckResult`:

```ts
type BridgeCheckResult =
  | { status: 'ok'; exists: boolean; author?: string; permlink?: string; title?: string; created?: string };
  | { status: 'haf_unavailable' };
```

Pre-fix, the call at line 256 passes the function directly into `hafCache.getOrSet`. `QueryCache.getOrSet` at `cache.ts:68-77` caches any non-null/undefined return. `{status: 'haf_unavailable'}` is a non-null object — cached for 30 seconds. All `/check` calls within that window hit the cache and return `{exists: false}` (the fail-open mapping of `haf_unavailable`). HAF recovers in 1-2 seconds but the cache keeps serving the stale sentinel.

Post-fix (Pattern 1 applied per the round-2 hold):

```ts
// bridge.ts, GET /api/bridge/check handler
const cached = hafCache.get<BridgeCheckResult>(cacheKey);
const result = cached ?? await checkExistingBridge(identifier, parsed);
if (!cached && result.status === 'ok') {
  hafCache.set(cacheKey, result, 30_000);
}
// haf_unavailable is never stored; next call re-queries live
```

**Sibling sites to audit**

Any `getOrSet` call site wrapping a function that can return a non-null failure sentinel should be reviewed. Candidates in the current codebase:

- HAF-backed query helpers that return a typed sentinel on query failure rather than throwing or returning null.
- ORCID or accreditation status lookups that use a union with a "service unavailable" variant.
- Papers or reputation queries that use a discriminated union to distinguish "computed successfully" from "HAF offline, serve stale" — if the stale/offline variant is a non-null object and goes through `getOrSet`, it will be cached.

Run `grep -rn 'getOrSet' backend/src/` and inspect each wrapped function's TypeScript return type. If the union contains a non-null object representing failure or unavailability, apply Pattern 1 or Pattern 2.

## Cross-references

- `agents/docs/solutions/conventions/per-request-memo-catch-block-negative-cache-contract-2026-05-06.md` — complementary caching-discipline doc covering the dual direction (per-request memo that fails to cache null-failure results, causing re-query amplification). Together the two docs bracket the caching-under-degradation design space: that one says "always cache null failures (per-request)"; this one says "never cache non-null failure sentinels (cross-request TTL)."
- `agents/docs/solutions/conventions/correlated-options-discriminated-union-2026-04-28.md` — the upstream TypeScript discriminated-union convention. Documents the type-level pattern that the cache-poisoning trap depends on.
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — the `outcome: 'uncertain'` / 504-envelope convention for HAF/Hive-unreachable states. The `haf_unavailable` sentinel is a sibling of the ambiguous-outcome pattern; both are non-null failure-state encodings from backend degradation.
- `agents/docs/solutions/conventions/pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md` — separate concern (log-serialization bypass) but illustrates the same meta-principle: two correct patterns composed into a new failure mode.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — call-site audit pattern for wrapping primitives. This convention is a specialization: `getOrSet` is the wrapping primitive, every call site of it whose wrapped function returns a discriminated union must be audited for the cache-poison pattern.

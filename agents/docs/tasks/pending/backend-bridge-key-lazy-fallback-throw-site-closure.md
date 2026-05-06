# BACKEND-BRIDGE-KEY-LAZY-FALLBACK-THROW-SITE-CLOSURE — close the per-request `PrivateKey.fromString` throw site in `getCachedBridgePostingKey`'s lazy fallback

**Owner:** Backend Agent
**Created:** 2026-05-06 (filed at architect review of `backend-bridge-key-claims-route-migration.md`, finding 4)
**Priority:** P2

## Problem

The cache accessor `getCachedBridgePostingKey()` in `backend/src/startup-checks.ts:289-298` has a lazy-fallback path that re-introduces a per-request `PrivateKey.fromString` throw site:

```ts
// Source changed (test override, in-place rotation) or cache is unset.
// Parse lazily. If this throws, it propagates: callers that reach this
// path past the format-validator have a genuine misconfiguration and
// need to surface it. (The validator runs at boot; production paths
// that reach this accessor have already passed validation.)
cachedBridgePostingKey = {
  source,
  parsed: PrivateKey.fromString(source),  // <-- per-request AssertionError throw site
};
```

The whole motivation chain for `BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` and its descendant tasks (including `BACKEND-BRIDGE-KEY-CLAIMS-ROUTE-MIGRATION` which migrated `claims.ts:214, :311` to use this accessor via `getRequiredBridgePostingKey()`) is to eliminate the AssertionError `.actual`/`.expected` Buffer-slice leak surface from `PrivateKey.fromString`. The migration moves the parse from per-request handlers to boot-time. But this lazy fallback still hits the parse per-request when the cache is null + source is truthy.

In production, the boot validator populates the cache before any request handler runs, so the fallback is unreachable. But the fallback is reachable in:
- **Tests** — `_resetBridgePostingKeyCacheForTests()` (or equivalent) nullifies the cache.
- **Hot-reload / dev** — module-cache resets in dev tooling could put a request between cache-null and cache-repopulated.
- **In-place key rotation** — the inline comment at `startup-checks.ts:289` explicitly mentions "Source changed (test override, in-place rotation)" as a fallback trigger. If a future operator-side mechanism rotates `config.pevoBridgePostingKey` at runtime, every request between rotation and next-cache-write hits the parse.

The redact policy (Layer-B `serializers.err`) still strips the leak post-hoc, so this is a **defense-in-depth gap, not an active leak**. But the structural-defense narrative the parent migration chain ostensibly delivers ("removing the throw site is the stronger guarantee") is partially undermined: there is still ONE throw site at the lazy-fallback layer.

## Goal

Eliminate the lazy-fallback per-request `PrivateKey.fromString` throw site, OR sanitize it at the throw boundary so the AssertionError surface never reaches a logger.

## Acceptance

Pick one of three approaches; document the choice in the implementation:

1. **(Strict) Replace the lazy parse with a structured error.** If cache is null + source is truthy, throw `BridgeKeyCacheUnpopulated` (or a sibling) instead of attempting `PrivateKey.fromString`. Forces all callers through the boot validator. Test code that legitimately needs to populate the cache uses the `_init...ForTests` hook explicitly. Closes the throw site fully.

2. **(Behavior-preserving) Wrap the lazy parse in try/catch.** Catch `AssertionError` (and any other unexpected throw shape) and re-throw as `BridgeKeyCacheUnpopulated` (or a new sibling class) without the `.actual`/`.expected` properties. Behavior-preserving for tests; throw-site is sanitized.

3. **(Document and accept)** Add an explicit comment that the fallback is the only remaining throw site and is reachable only in test/dev/rotation paths; rely on the redact policy as the active mitigation. Update the helper's docstring to reflect "throw-site guarantee scopes to all production callers, with the lazy-fallback path explicitly documented as a test-and-rotation surface."

The implementer chooses the trade-off. (1) is the strongest guarantee but most invasive (test code must be audited for the new throw shape). (3) is the smallest change but accepts the gap as a documented property. (2) is the middle ground.

## Verify

- `npx tsc --noEmit` clean.
- `npm run lint` clean.
- Existing `startup-checks.test.ts` and `claims.test.ts` continue to pass.
- If approach (1) or (2): add a new test asserting the fallback path's error class is `BridgeKeyCacheUnpopulated` (or sibling), NOT `AssertionError`.

## Out of scope

- The redact policy at `logger.ts` is the existing active mitigation; do not change.
- The non-fallback paths (cache-warm production reads) are unchanged by this task.
- The errorHandler `err.name` projection is a separate concern, dismissed as wrong-but-survivable in the parent task's review. Don't bundle.

## Coordination

- Surfaced from architect review of `backend-bridge-key-claims-route-migration.md` (commit 83c6a28), finding 4.
- Adversarial reviewer flagged it as P2 conf 75; security flagged the same code path as residual risk corroborating.
- Parent task `BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` is currently held at round-4 (`tasks/pending/backend-bridge-key-startup-validation-and-pino-redact.md`); coordinate with that task if its hold round also touches `startup-checks.ts:289-298`. The fallback is in parent-task surface, but the `claims.ts` migration is what made it newly load-bearing for the round-1 hold of this descendant task to surface it.

---

## Backend round-1 signal block — implementation complete (2026-05-06)

**Approach chosen:** approach (2) — behavior-preserving try/catch rewrap.

**Why (2) over (1) or (3):** (1) was NOT straightforward — the existing `lazy fallback: parses on first access if init was skipped` test (`tests/startup-checks.test.ts:253-265`) and the `cache invalidates when config.pevoBridgePostingKey changes` test (`tests/startup-checks.test.ts:267-277`) both call `getCachedBridgePostingKey()` against a null cache and expect a successful parse — they document lazy-fallback parsing as a load-bearing test-harness contract. Approach (1) would force both tests to call `_initBridgePostingKeyCacheForTests()` ahead of every accessor call; that's invasive and rewrites the rotation-detection contract. (2) preserves all existing behavior (successful parses still populate the cache as before) AND closes the throw site (a parse failure no longer escapes as a raw dhive `AssertionError` with `.actual`/`.expected` Buffer slices). (3) was documentary-only; the architect's mild preference is for structural closure.

**Implementation:**

- `backend/src/startup-checks.ts:331-348` — wrapped the lazy parse in try/catch; on catch, `throw new BridgeKeyLazyParseDivergence()`. Intentionally swallow the dhive error with no message interpolation, no `cause` linkage (avoid pino's recursive cause walk pulling the same Buffer slices through). The previous round-3 `BridgeKeyCacheUnpopulated` carries semantically distinct meaning ("cache is null"); a separate sibling class for the divergence path (`BridgeKeyLazyParseDivergence`) keeps `err.constructor.name` projection in operator dashboards distinguishable.
- `backend/src/startup-checks.ts:368-395` — new exported `BridgeKeyLazyParseDivergence extends Error` class. Fixed redact-safe message; deterministic `name`/`constructor.name` for the redact serializer's `type` projection.
- `backend/src/startup-checks.ts:284-329` — extended the JSDoc on `getCachedBridgePostingKey()` to document the throw-site closure (acceptance criterion's documentation scope).

**Test coverage:**

- `backend/tests/startup-checks.test.ts:13` — added `BridgeKeyLazyParseDivergence` to imports.
- `backend/tests/startup-checks.test.ts:268-321` — new test `lazy fallback throw-site closure: a parse rejection re-throws BridgeKeyLazyParseDivergence (NOT AssertionError)`. Drives the real dhive divergence path via a base58-decodable but network-id-mismatching WIF (`'5J' + '1'.repeat(50)`). Asserts:
    - thrown error is `instanceof BridgeKeyLazyParseDivergence`,
    - `name === 'BridgeKeyLazyParseDivergence'`,
    - `.actual` / `.expected` / `.operator` / `.cause` are all `undefined` (sanitization invariants — the rewrap discards the AssertionError fields and does not chain via `cause`),
    - message does not interpolate the malformed WIF source,
    - round-tripping through `redactErrSerializer` yields `type: 'BridgeKeyLazyParseDivergence'` for operator dashboards.

**Acceptance verification:**

- `cd backend && npx tsc --noEmit` — clean.
- `cd backend && npm run lint` — clean (2 pre-existing warnings in `seed-phrase.ts`, unrelated).
- `cd backend && npx vitest run tests/startup-checks.test.ts tests/routes/claims.test.ts` — 61 passed (2 files). The new throw-site closure test passes (verified in isolation via `-t` filter; 1 passed, 37 skipped).

**Deviations:** none. The task offered "BridgeKeyCacheUnpopulated (or a new sibling class)" — I chose the new sibling class for semantic clarity (cache-unpopulated vs. parse-divergence are distinct operator triggers).

**Out-of-scope deferred per task:** logger.ts redact policy (existing active mitigation, untouched); cache-warm production read paths (untouched); errorHandler `err.name` projection (separate concern, dismissed in parent task).

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

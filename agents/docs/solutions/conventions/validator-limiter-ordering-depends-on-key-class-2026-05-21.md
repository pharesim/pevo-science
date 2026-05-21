---
module: backend/src/middleware
date: 2026-05-21
problem_type: convention
component: authentication
severity: high
applies_when:
  - "Adding or reviewing a rate limiter in `backend/src/middleware/rateLimit.ts` or any Express route file"
  - "The limiter uses `byAccount` keying and requires the auth-extracted username from `verifyHiveSignature`"
  - "The limiter uses URL-param or `byIp` keying and does NOT require the auth-extracted username"
  - "Triaging a validator or body-parse middleware ordering decision relative to `verifyHiveSignature`"
tags:
  - rate-limit
  - middleware-ordering
  - verify-hive-signature
  - by-account
  - cpu-amplification
  - limiter-key-class
related_components:
  - authentication
  - service_object
---

# Middleware ordering for rate limiters depends on the limiter's key class

## Context

PEvO has a "body-validate-before-limiter" pattern documented in the JSDoc on `skipFailedRequests` in `backend/src/middleware/rateLimit.ts`. The pattern states that body validators must run before limiters that opt into `skipFailedRequests: true`, so malformed requests are rejected cheaply before the limiter's per-key counter would otherwise be consumed and refunded indefinitely. The original guidance was monolithic: it said "before the limiter" without specifying where the validator sits relative to `verifyHiveSignature`.

That silence caused an ordering ambiguity during implementation of `validateRetractParams` on `POST /api/papers/:author/:permlink/retract`. The implementer placed the validator AFTER `verifyHiveSignature`, anchoring on the existing custody-sibling pattern (`/upgrade`, `/fresh-auth`, `/session-auth`). The architect's round-1 hold prescription had used a universal-sounding "BEFORE `verifyHiveSignature` or any HAF roundtrip" framing — also unspecific to the per-route key class. Round-2 `/ce-code-review` cross-corroborated the gap (reliability conf 100 + security conf 60): HAF amplification IS closed by the round-1 fix, but ECDSA recovery (~5-10ms per probe) plus the `accounts.sessions_invalidated_at` Postgres point-lookup inside `verifyHiveSignature` remained exposed to JWT spray on malformed URL slugs. Both the implementer and the original architect prescription were partially right. The rule is per-limiter-key-class, not monolithic.

## Guidance

The ordering of body or URL validators relative to `verifyHiveSignature` is determined by how the limiter derives its key.

**URL-keyed (or `byIp`) limiters — validator BEFORE auth:**

The limiter key is derived from URL params or the client IP, neither of which requires an authenticated principal. A malformed URL slug or shape can be detected and rejected before any auth cost is paid.

```js
// POST /api/papers/:author/:permlink/retract
router.post(
  '/:author/:permlink/retract',
  validateRetractParams,  // cheap shape check — runs before ECDSA recovery
  verifyHiveSignature,    // ECDSA + Postgres session-invalidation lookup
  retractLimiter,         // keyed by URL params or byIp; does not need auth
  retractHandler,
);
```

**Header-keyed `byAccount` limiters — validator AFTER auth:**

The limiter key is extracted from the authenticated principal (typically `X-Hive-Username` validated and bound by `verifyHiveSignature`). Auth must run first to produce the key. Body validation follows auth so the limiter receives the correct key and so error attribution lands on a verified actor.

```js
// POST /api/custody/upgrade
router.post(
  '/upgrade',
  verifyHiveSignature,        // auth first — produces the account identity
  validateUpgradeBodyShape,   // body shape check on an authenticated request
  upgradeLimiter,             // keyed by byAccount (username from auth)
  upgradeHandler,
);
```

Mnemonic: if the limiter key comes from the URL or IP, the validator can and should run first. If the limiter key comes from the authenticated identity, auth must run first and the validator follows.

## Why This Matters

**CPU/RPC amplification on URL-keyed routes.** When `skipFailedRequests: true` is set AND the validator runs AFTER `verifyHiveSignature`, a JWT holder can spray requests with malformed URL slugs. Each probe pays ECDSA recovery and a Postgres point-lookup against `accounts.sessions_invalidated_at` inside `verifyHiveSignature`. Because the limiter refunds failed requests, the per-account RPS is effectively unbounded across all probes. Hoisting the validator above `verifyHiveSignature` collapses each probe to a cheap string-shape check. HAF roundtrips and handler costs are already foreclosed by `skipFailedRequests`; the ECDSA and Postgres costs are the residual surface that only the pre-auth validator placement closes.

**`byAccount` keying has a structural dependency on auth.** The `byAccount` key function reads the authenticated username. A validator placed before `verifyHiveSignature` cannot supply that key. Attempting to hoist a `byAccount`-keyed limiter's validator above auth would either crash on missing username or silently key to a wrong/default value. The custody siblings' auth-first ordering is not a style choice — it is a structural requirement of the keying.

**Error attribution.** On `byAccount` routes, body-shape errors logged after auth carry the authenticated Hive account identity. A spray of malformed `/upgrade` requests gets attributed to the JWT-holding account in structured warn logs, not anonymously. On URL-keyed routes the reverse is true: the pre-auth validator's 400 has no authenticated identity to attach, which is correct — the spray class is "any JWT holder hitting random slugs," not a per-account abuse pattern.

## When to Apply

- When adding a new limiter to any route that opts into `skipFailedRequests: true`, determine the key class before deciding where the body/URL validator sits.
- When auditing existing limiter-protected routes in a sweep (e.g., the call-site audit mandated by `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`), check every `skipFailedRequests: true` site against this rule.
- When reordering middleware on auth-bearing routes, verify the validator's position relative to `verifyHiveSignature` matches the limiter key class on that route.
- When the per-route limiter is keyed by URL params, route params, query params, or `byIp` — anything NOT requiring auth extraction — place the validator BEFORE `verifyHiveSignature`.
- When the per-route limiter is `byAccount` (key derived from the authenticated identity) — keep the validator AFTER `verifyHiveSignature`.

## Examples

**`/retract` BEFORE round-3 (the inverted ordering that round-2 review flagged):**

```js
router.post(
  '/:author/:permlink/retract',
  verifyHiveSignature,    // ECDSA + Postgres lookup — pays full auth cost per probe
  validateRetractParams,  // validator runs after auth; malformed slugs already cost ECDSA
  retractLimiter,
  retractHandler,
);
```

ECDSA recovery and the `accounts.sessions_invalidated_at` Postgres lookup execute on every probe, including those with malformed `:author` or `:permlink` slugs. The limiter refunds on failure, so per-account probe rate is unbounded.

**`/retract` AFTER round-3 (the prescribed ordering):**

```js
router.post(
  '/:author/:permlink/retract',
  // URL-keyed limiter: validator runs pre-auth so malformed slugs are rejected
  // before ECDSA recovery and the Postgres session-invalidation lookup.
  validateRetractParams,  // cheap shape check — malformed slugs return 400 here
  verifyHiveSignature,    // auth cost only paid on well-formed requests
  retractLimiter,         // URL-keyed; key does not require auth principal
  retractHandler,
);
```

Malformed `:author` or `:permlink` slugs return 400 before any auth cost. The ECDSA and Postgres amplification surface is closed.

**Custody siblings — ordering preserved (contrast):**

```js
// POST /api/custody/upgrade — byAccount limiter requires auth-first ordering
router.post(
  '/upgrade',
  verifyHiveSignature,        // auth first — upgradeLimiter.keyFn reads the username here
  validateUpgradeBodyShape,   // body check against authenticated request
  upgradeLimiter,             // byAccount keying; cannot be hoisted above auth
  upgradeHandler,
);
```

The same shape applies to `/fresh-auth` (`validateFreshAuthBodyShape` + `freshAuthLimiter`) and `/session-auth` (`validateSessionAuthBodyShape` + `sessionAuthLimiter`). Do NOT unify the custody-sibling ordering with the `/retract` ordering during a future "convention sweep" — they serve different limiter key classes.

## Related

- `backend/src/middleware/rateLimit.ts` — `skipFailedRequests` option and the JSDoc on the body-validate-before-limiter pattern (the pattern this rule extends with the per-key-class qualifier)
- `backend/src/middleware/verifyHiveSignature.ts` — auth middleware performing ECDSA recovery and the `accounts.sessions_invalidated_at` Postgres point-lookup (the costs the URL-keyed pre-auth validator forecloses)
- `backend/src/routes/papers.ts` — `validateRetractParams` and `retractLimiter` (URL-keyed; subject of the `/retract` ordering fix)
- `backend/src/routes/custody.ts` — `validateUpgradeBodyShape`, `validateFreshAuthBodyShape`, `validateSessionAuthBodyShape` alongside `upgradeLimiter`, `freshAuthLimiter`, `sessionAuthLimiter` (all `byAccount`-keyed; preserve auth-first ordering)
- `backend/src/lib/body-record.ts` — shared `assertBodyRecord` and `requireStringField` helpers used by the body-shape validators
- `agents/docs/solutions/conventions/skip-failed-requests-jwt-required-credential-verify-carve-out-2026-05-17.md` — sibling rule for the same limiter call sites: once this doc's key-class rule determines placement, the carve-out doc determines whether `skipFailedRequests` is appropriate. Both rules are needed to configure a `rateLimit()` call correctly on any PEvO custody or auth route.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — audit method that surfaces placement omissions: when a new validator or limiter is added, grep all sibling call sites and verify key-class-consistent placement.
- `agents/docs/solutions/conventions/deferred-refund-gate-must-check-writableEnded-not-just-statusCode-2026-05-17.md` — companion for `byAccount`-keyed limiters with `skipFailedRequests: true` (specifically `upgradeLimiter`): after placing the validator correctly (after auth, per this rule), ensure the refund gate also handles TCP-abort correctly.
- `agents/docs/solutions/conventions/hive-signature-request-binding-shape-2026-04-21.md` — earliest recorded expression of the CPU-amplification concern this rule formalizes (the doc's audit-summary footnote called out "absence of IP rate-limit before `verifyHiveSignature`" as an adjacent regression class).

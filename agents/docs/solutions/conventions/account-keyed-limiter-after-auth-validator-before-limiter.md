---
title: "Account-keyed limiters go after verifyHiveSignature; shape validators go before the limiter"
date: 2026-10-07
category: conventions
module: backend/src/middleware
problem_type: convention
component: authentication
severity: medium
applies_when:
  - "Mounting a `rateLimit()` limiter whose `keyFn` is `byAccount`"
  - "Placing a request-shape validator relative to `verifyHiveSignature` and a limiter on one route"
  - "Reviewing or reordering a route chain that holds `verifyHiveSignature`, a validator and a limiter"
tags: [rate-limit, middleware-ordering, verify-hive-signature, by-account, skip-failed-requests, request-validation]
related_components:
  - middleware
  - rate_limiting
supersedes:
  - validator-limiter-ordering-depends-on-key-class-2026-05-21.md
---

# Account-keyed limiters go after verifyHiveSignature; shape validators go before the limiter

## Context

Several authenticated routes in `backend/src/routes/` mount `verifyHiveSignature`, a shape validator and a `rateLimit()` limiter ahead of the handler. Two orders are in use, and both work:

- `POST /api/papers/:author/:permlink/retract` (`backend/src/routes/papers.ts`): `validateRetractParams`, then `verifyHiveSignature`, then `retractLimiter`.
- `/fresh-auth`, `/session-auth` and `/upgrade` (`backend/src/routes/custody.ts`), `/request` and `/verify` (`backend/src/routes/accreditation.ts`), and `PATCH /metadata` (`backend/src/routes/accreditation-metadata.ts`): `verifyHiveSignature`, then the validator, then the limiter.

The limiter in each of these chains uses `keyFn: byAccount`. The limiter's key fixes where the limiter goes, not where the validator goes.

## Guidance

1. **An account-keyed limiter goes after `verifyHiveSignature`.** `byAccount` in `backend/src/middleware/rateLimit.ts` is `return req.hiveUsername || byIp(req);`, and in `backend/src/` only `verifyHiveSignature` sets `req.hiveUsername`. A `byAccount` limiter mounted before auth keys every request by client IP.
2. **The shape validator goes before the limiter.** A request the validator rejects never reaches the limiter, so it takes no slot. The JSDoc on `skipFailedRequests` in `rateLimit.ts` requires this order on every route that sets `skipFailedRequests: true`.
3. **Validator before or after auth is a cost choice.** A validator that reads only client input (`req.params`, `req.body`) and writes nothing back depends on nothing auth sets.
   - Before auth, a malformed request is refused without running `verifyHiveSignature`, and the validator's 400 also answers callers that sent no credentials.
   - After auth, only a caller that passed `verifyHiveSignature` reaches the validator; a malformed request without credentials gets auth's 401.
4. **Two kinds of validator must follow auth:** one that reads `req.hiveUsername`, and one that rewrites `req.body`. The signature path of `verifyHiveSignature` hashes `req.body` into the message it verifies (`buildCanonicalAuthMessage` in `backend/src/lib/authMessage.ts`), and `validate()` in `backend/src/validation.ts` assigns the schema's parse output to `req.body`. `accreditationRequestSchema` defaults a missing `orcid` to `''`, so mounted before auth it would add a field the client did not sign.

What a pre-auth rejection skips, per path of `verifyHiveSignature`:

- JWT path (`Authorization: Bearer`): `jwt.verify`, then a Postgres query for `accounts.sessions_invalidated_at` when `getAppPool()` returns a pool and the token carries a numeric `iat`.
- Signature path (`X-Hive-*` headers): the timestamp window check, `Signature.fromString`, the replay claim in `isReplaySignature` (Redis `SET ... NX`, or the in-memory map), `hiveClient.database.getAccounts`, and `sig.recover`.

## Why This Matters

- A `byAccount` limiter mounted before auth does not throw. It turns a per-account budget into a per-IP budget, shared by every client behind one address. The JSDoc on `byAccount` says the same: use it only after `verifyHiveSignature`, "otherwise it falls back to IP-based limiting."
- With the validator after the limiter, malformed requests pass through the limiter. Under `skipFailedRequests` each one's slot is refunded when its 400 finishes (`shouldRefund` in `rateLimit.ts`), so malformed requests do not stay counted. On a limiter with no refund option (`accreditationEditLimiter`), or whose `refundStatusCodes` omit the validator's status (`accreditationRequestLimiter` refunds 422 and 500; `validate()` answers 400), malformed requests use up the account's slots.

## When to Apply

- Adding a `rateLimit()` call with `keyFn: byAccount` to a route.
- Adding a validator to a route chain, or moving one across `verifyHiveSignature`.
- Reviewing a route chain: check that every `byAccount` limiter follows `verifyHiveSignature`, and that the validator precedes the limiter.

## Examples

Validator first (handler abbreviated):

```ts
// backend/src/routes/papers.ts
router.post('/:author/:permlink/retract', validateRetractParams, verifyHiveSignature, retractLimiter, handler);
```

`validateRetractParams` reads only `req.params`. `backend/tests/routes/papers-retract-url-shape-validator.test.ts` pins this order: a malformed slug sent without auth headers gets 400 `VALIDATION_ERROR`, not 401, and malformed slugs leave the `paper-retract` counter unset.

Auth first (handlers abbreviated):

```ts
// backend/src/routes/custody.ts
router.post('/upgrade', verifyHiveSignature, validateUpgradeBodyShape, upgradeLimiter, handler);

// backend/src/routes/accreditation.ts
router.post('/request', verifyHiveSignature, validate(accreditationRequestSchema), accreditationRequestLimiter, handler);
```

The custody validators (`validateUpgradeBodyShape`, `validateFreshAuthBodyShape`, `validateSessionAuthBodyShape`) read `req.body` and write nothing back, so nothing in them depends on auth having run. The accreditation chains use `validate()`, which rewrites `req.body`, so they belong after auth under Guidance item 4.

Wrong (not in the codebase):

```ts
// byAccount runs before req.hiveUsername exists, so xLimiter keys by IP
router.post('/x', xLimiter, verifyHiveSignature, validateXBodyShape, handler);
```

## Related

- `backend/src/middleware/rateLimit.ts`: `byAccount`, `byIp`, and the `skipFailedRequests` JSDoc with the validator-before-limiter obligation.
- `backend/src/middleware/verifyHiveSignature.ts`: both auth paths and the only assignments of `req.hiveUsername`.
- `agents/docs/solutions/conventions/skip-failed-requests-jwt-required-credential-verify-carve-out-2026-05-17.md`: when `skipFailedRequests` is permitted on JWT-required routes that verify a credential, such as `freshAuthLimiter` and `sessionAuthLimiter`.
- `agents/docs/solutions/conventions/deferred-refund-gate-must-check-writableEnded-not-just-statusCode-2026-05-17.md`: why the refund gate checks `res.writableEnded` as well as `res.statusCode`.
- `agents/docs/solutions/conventions/hive-signature-request-binding-shape-2026-04-21.md`: the signed message format, including the `sha256(JSON.stringify(body ?? {}))` body hash that a body-rewriting validator before auth could change.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`: grep every call site, rather than recalling them, before claiming a rule holds for all of them.

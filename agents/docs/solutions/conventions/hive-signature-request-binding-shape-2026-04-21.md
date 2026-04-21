---
title: "Hive-signature auth: canonical request-bound message shape"
date: 2026-04-21
category: conventions
module: backend
problem_type: convention
component: authentication
severity: high
applies_when:
  - "Adding or modifying a Hive-signature-authenticated endpoint"
  - "Porting the signing logic to a new client (mobile, CLI, alternate frontend)"
  - "Forking PEvO with a different APP_TAG"
  - "Reviewing auth middleware changes that touch message construction, timestamp window, or body hashing"
tags: [hive-signature, request-binding, domain-separator, replay-protection, app-tag, auth-protocol, sec-001]
---

# Hive-signature auth: canonical request-bound message shape

## Context

`verifyHiveSignature` originally accepted a client-supplied `X-Hive-Message` header and used it verbatim as the signed payload. No binding to HTTP method, path, body, domain, or a fresh nonce. Any signature a victim's posting key produced on any dApp (login prompts elsewhere, Keychain test prompts, prior PEvO calls) could be replayed against any PEvO endpoint. The 5-minute replay cache only caught exact reuse within 5 minutes on PEvO itself, and the timestamp check only ran when `X-Hive-Timestamp` happened to be present. FINDING-001, CVSS 9.6 (CWE-345, CWE-294), shipped fixed 2026-04-20 under SEC-001 / SEC-001-FIXUP / TEST-003.

## Guidance

Every Hive-signature-authenticated request signs one canonical, request-bound string:

```
{APP_TAG}-auth|v1|{METHOD}|{path}|{sha256_hex(body)}|{timestamp}
```

- `APP_TAG` is the deployment's Hive tag (`pevotest` on beta, `pevo` in prod, anything else on forks).
- `v1` is the format version. Bump on any shape change so old clients fail loudly.
- `METHOD` is the uppercase HTTP method.
- `path` is `req.originalUrl` with any query string stripped (the URL the client intends, not router-relative `req.path`). Query strings are never part of the signed payload.
- `sha256_hex(body)` is `sha256(JSON.stringify(body ?? {}))`, hex-encoded. No method-based branching. Bodyless requests hash `'{}'` uniformly.
- `timestamp` is the same ISO-8601 string sent in `X-Hive-Timestamp`.

Required headers: `X-Hive-Username`, `X-Hive-Signature`, `X-Hive-Timestamp`. Missing or >60s-old timestamp is rejected.

Server-side guardrails:
- 60-second timestamp window, `MAX_SIGNATURE_AGE_MS` at [backend/src/middleware/verifyHiveSignature.ts:32](../../../../backend/src/middleware/verifyHiveSignature.ts#L32).
- 5-minute Redis replay cache keyed by signature, SETNX semantics, with in-memory fallback if Redis is down, at [backend/src/middleware/verifyHiveSignature.ts:47-61](../../../../backend/src/middleware/verifyHiveSignature.ts#L47-L61).
- Timing-safe public-key comparison at [backend/src/middleware/verifyHiveSignature.ts:164-172](../../../../backend/src/middleware/verifyHiveSignature.ts#L164-L172).
- JWT Bearer path is unchanged and runs first at [backend/src/middleware/verifyHiveSignature.ts:77-111](../../../../backend/src/middleware/verifyHiveSignature.ts#L77-L111). This convention only touches the Hive-signature branch.
- CORS `allowedHeaders` at [backend/src/app.ts:103](../../../../backend/src/app.ts#L103) lists exactly `Content-Type, Authorization, X-Hive-Username, X-Hive-Signature, X-Hive-Timestamp`. No `X-Hive-Message`.

Drift prevention is mechanical, not by discipline. The single canonical builder lives at [backend/src/lib/authMessage.ts](../../../../backend/src/lib/authMessage.ts) and is imported directly by the frontend equivalence test at [frontend/tests/unit/sec-001-equivalence.test.js:25](../../../../frontend/tests/unit/sec-001-equivalence.test.js#L25), so any byte-level divergence between `signRequest` and `buildCanonicalAuthMessage` fails CI.

## Why This Matters

### Attack-surface closure

| Attack | Blocked by |
|---|---|
| Cross-dApp signature reuse (Keychain prompt on another site) | Domain separator. No other dApp signs strings shaped like `{APP_TAG}-auth\|v1\|POST\|/api/auth/session\|...`. |
| Cross-deployment replay (beta to prod, fork to prod, shared posting keys) | `APP_TAG` in the separator. A signature captured on `pevotest` cannot verify against `pevo`. |
| Cross-endpoint reuse on PEvO | `METHOD` and `path` in the signed string. |
| Body-tamper | `sha256_hex(body)` in the signed string. |
| Time-shift / stale replay | Required `X-Hive-Timestamp`, 60-second window. |
| In-window replay (same signature within 60s) | 5-minute Redis replay cache, SETNX. |

### Why request-binding rather than the auditor's separate-challenge design

The auditor proposed a stricter `/api/auth/keychain-login` endpoint that issues a server-minted single-use nonce, which the client signs. That works, but it adds Redis state and a round-trip to every authenticated request. Request-binding closes the same attack surface without that cost:

- No extra challenge endpoint, no extra network round-trip per auth.
- Standard HMAC-signing shape, same family as AWS SigV4.
- Same closure across all six attack classes in the table above.

This is not mutually exclusive with a challenge-nonce layer. If a future flow genuinely needs single-use semantics (anti-CSRF on a high-value operation, a login form that must not accept any pre-minted signature), the challenge endpoint can be layered on top of the same request-binding. We chose the simpler baseline first.

### Why `APP_TAG` is in the domain separator

Hive accounts are shared across deployments: the same posting key signs for `pevotest`, `pevo`, and any fork. Without `APP_TAG` in the separator, a signature captured against the beta deployment, or harvested from a fork, would verify against production byte-for-byte. Putting `APP_TAG` in the separator makes the signed string unambiguously scoped to one deployment.

### Why uniform body normalization instead of per-method branching

Express body-parser has two different "empty" states and they hash differently:

- `POST` with `Content-Type: application/json` and an empty body: `req.body = {}`, `JSON.stringify` yields `'{}'`.
- `POST` without the `Content-Type` header: `req.body = undefined`, `JSON.stringify(undefined)` yields the literal string `"undefined"` (or `'""'` if coerced). Either way, not `'{}'`.

If the hash is method-branched (hash only on POST/PUT/PATCH, skip on GET/DELETE, special-case empty), the failure modes multiply. Client-side code, server-side code, and Express's Content-Type behavior all have to agree on the branching, and drift hides in the conditional. A single rule (`sha256(JSON.stringify(body ?? {}))` on both sides, client always sends `Content-Type: application/json` and at least `{}` for POSTs, GET/DELETE hash `'{}'`) collapses to one failure mode: the client forgot to send `{}`, which fails loudly and locally on first request. Method-based branching is exactly where client/server auth drift hides. Avoid it.

## When to Apply

- Adding a new authenticated route that accepts Hive-signature auth (as opposed to Bearer JWT). Wire the `verifyHiveSignature` middleware; no per-route auth logic.
- Modifying the canonical auth-message shape. Bump `v1`, update [backend/src/lib/authMessage.ts](../../../../backend/src/lib/authMessage.ts), update [frontend/src/sign-request.js](../../../../frontend/src/sign-request.js), and extend the equivalence test before touching callers. The equivalence test is the contract.
- Onboarding a new frontend caller. Call `signRequest(username, method, path, bodyObject)` and spread the returned `headers` plus `body` into `fetch`. Do not roll a new format, do not set `X-Hive-Message` (the header no longer exists on the server).
- Adding an e2e test or fixture that mints a signed request. Drive the message through `buildCanonicalAuthMessage`; never reconstruct the format string by hand.

## Examples

Live code:

- [backend/src/lib/authMessage.ts](../../../../backend/src/lib/authMessage.ts) single canonical builder.
- [backend/src/middleware/verifyHiveSignature.ts](../../../../backend/src/middleware/verifyHiveSignature.ts) verifier. Path extraction at `:150`, required-timestamp check at `:122-124`.
- [frontend/src/sign-request.js](../../../../frontend/src/sign-request.js) the client helper. Returns `{ headers, body }` ready to spread into `fetch`. GET/HEAD get `body: undefined` on the wire but still hash `'{}'`.
- [frontend/src/auth.js](../../../../frontend/src/auth.js) `connect()` live caller signing `POST /api/auth/session` with body `{}`.
- [frontend/src/api.js](../../../../frontend/src/api.js) `linkExistingAccount()` live caller signing `POST /api/auth/link` with an `{ auth_token }` body.
- [frontend/tests/unit/sec-001-equivalence.test.js](../../../../frontend/tests/unit/sec-001-equivalence.test.js) the TEST-003 byte-equality harness. Drives `signRequest` and `buildCanonicalAuthMessage` for four shapes (POST with `{}`, POST with `{ auth_token }`, GET with no body, GET with an author/permlink path segment) and asserts byte identity.

Concrete canonical string, for a `POST /api/auth/session` login on beta with empty body at timestamp `2026-04-20T12:34:56.000Z`:

```
pevotest-auth|v1|POST|/api/auth/session|44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a|2026-04-20T12:34:56.000Z
```

The hex string is the SHA-256 of the literal string `{}`.

## What we did NOT do

- Did not add a `/api/auth/keychain-login` challenge endpoint. The auditor's alternative was a server-issued-nonce flow. Rejected at this layer because request-binding + domain separator + 60s timestamp + replay cache closes the same attack surface without a Redis round-trip on every auth. A challenge layer can be added later for flows that truly need single-use semantics.
- Did not keep `X-Hive-Message` behind a feature flag. The header was removed outright from the middleware and from the CORS `allowedHeaders` list. Atomic frontend/backend deploy was acceptable for the beta phase; an escape hatch for this specific vulnerability would re-open the entire bypass.
- Did not method-branch the body hash. No "skip the hash for GET", no "special-case empty POST", no branching on `Content-Type`. Both sides always `sha256(JSON.stringify(body ?? {}))`.

## Related

- [agents/docs/api-contracts/common.md](../../api-contracts/common.md) canonical header set and message format for API contracts.
- [agents/docs/api-contracts/auth.md](../../api-contracts/auth.md) session / link endpoint headers.
- [agents/docs/ARCHITECTURE.md](../../ARCHITECTURE.md) auth layer context.
- [agents/docs/tasks-archive.md](../../tasks-archive.md) SEC-001, SEC-001-FIXUP, TEST-003 completion records (2026-04-20).
- [.context/audit-2026-04-21/SUMMARY.md](../../../../.context/audit-2026-04-21/SUMMARY.md) Prior-art status section confirms FINDING-001 closed; flags adjacent regressions (byIp XFF spoof, absence of IP rate-limit before verifyHiveSignature).

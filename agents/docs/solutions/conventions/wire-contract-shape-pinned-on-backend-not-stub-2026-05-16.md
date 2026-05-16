---
title: Wire-contract type-format guards must pin the backend's actual response shape, not a test stub's
date: 2026-05-16
category: conventions
module: backend/src/lib + backend/tests
problem_type: convention
component: testing_framework
severity: high
related_components:
  - authentication
  - documentation
applies_when:
  - Adding or auditing tests that pin the wire shape of a backend response field (timestamp, ID, URL, enum, JSON envelope)
  - Reviewing a contract change that flips a field's emitted shape (number → string, ISO → epoch, seconds → ms)
  - Writing an E2E test stub for a backend endpoint via `page.route(...)` or analogous mock-the-network primitive
  - The contract docs (`agents/docs/api-contracts/*.md`) describe a string-format field (ISO-8601, hex hash, base58 pubkey) the backend issues
  - The TypeScript signature for the response type uses `number` or a loosely-typed primitive that admits multiple semantically-different values
tags:
  - wire-contract
  - testing
  - iso-8601
  - date-parse
  - e2e-stubs
  - shape-divergence
  - type-format-mismatch
  - authentication
---

# Wire-contract type-format guards must pin the backend's actual response shape, not a test stub's

## Context

PEvO has a wire-shape divergence failure mode that surfaces only as behavioral drift (cache always-expired, unexpected re-auth) without ever throwing or logging an error. The 2026-05-16 instance (`backend-expires-at-iso-conformance`, commit `afecd6e`): backend emitted `expires_at` as epoch SECONDS (number) where contract docs at `agents/docs/api-contracts/custody.md:108` and `agents/docs/api-contracts/orcid.md:208,239` documented ISO-8601 string. Frontend reads via `new Date(expiresAt).getTime()`. A numeric epoch-seconds value (e.g., `1746535500`) gets silently interpreted by JavaScript as MILLISECONDS-since-epoch → resolves to ~January 21, 1970 → comparison against `Date.now()` (year 2026) → ALWAYS expired → SPA fresh-auth cache 100% non-functional → every light-account broadcast triggered a full ORCID OAuth round-trip. No exception. No log. Just a quiet ~10× cost amplification per session and an irritating "you're authenticated, but please re-authenticate" UX. Detected only because four independent `/ce-code-review` personas (correctness 90 + security 60 + adversarial 95 + api-contract 100) hit the same finding in the parent UI review of `ui-non-consent-broadcast-fresh-auth-wiring` and synthesized to confidence 100.

The bug had survived the test suite because the E2E spec at `frontend/tests/e2e/non-consent-fresh-auth.spec.js:57` stubbed `expires_at` via `new Date(...).toISOString()` — so the SPA's `new Date(<iso>).getTime()` parsed correctly and the test passed while production emitted a different shape. Backend integration tests prior to the fix pinned `typeof === 'number'`, asserting the WRONG shape — the assertions matched the broken implementation, not the documented contract. Three different assertions across three test files all agreed; none was load-bearing against the contract.

## Guidance

**Rule 1 — Pin wire shape on the backend's actual HTTP response, not on a stub.** For every documented wire-format field (timestamps, IDs, hashes, enums), at least ONE backend integration test that hits the real route must assert BOTH the type AND the format of the emitted value. E2E stubs are correctness-irrelevant for wire-shape pinning by construction — the stub's value domain is whatever the test author wrote, not what production emits.

**Rule 2 — Assert type AND format, not just one.** `expect(typeof x).toBe('string')` alone does not prove `x` is the documented ISO-8601 form (a stringified epoch-seconds value `'1746535500'` passes the typeof check). Pair it with `expect(Number.isFinite(Date.parse(x))).toBe(true)` for ISO timestamps, or with a format regex for other string formats (e.g., `/^0[xX][\dA-Fa-f]{64}$/` for hex hashes). Both halves are necessary — typeof catches the number-regression, format catches the stringified-but-still-wrong-shape regression.

**Rule 3 — When changing a field's emitted shape, type-flip the TypeScript signature.** Flipping `IssuedFreshAuth.expires_at: number → string` (or analog) lets `tsc --noEmit` surface every caller doing numeric arithmetic on the field. The pre-fix code had `number` so `Math.floor(issuedAt / 1000) + N` compiled clean; post-flip the only valid emission expression is one that produces `string`. The type is the audit set, not the diff.

**Rule 4 — Stay aware of `new Date(number)` interpretation.** `new Date(1746535500)` interprets the argument as MILLISECONDS-since-epoch and returns ~Jan 1970. `new Date('1746535500')` calls Date.parse on the string, which returns NaN (not a valid ISO-8601). `new Date('2026-05-16T...')` parses correctly. Mixed-mode comparisons (`new Date(x).getTime() > Date.now()`) silently produce 1970-vs-2026 results — no throw, no warning. If a field can carry either form during a migration window, defensive parsing must explicitly branch on `typeof x === 'string'`.

## Why This Matters

The bug's blast radius was the SPA cache for ALL light-account broadcasts (every vote, comment, publish, edit, vouch, claim). Every transaction triggered a full OAuth round-trip — orcid.org redirect + return-to-callback + state-token roundtrip + `/api/orcid/start` rate-limiter hit. With session caching working as designed, mint rate per user-session is ~1 per mechanism per 5 minutes. With the cache broken, mint rate is ~1 per broadcast — easily 10× the steady state for an active user. The per-IP `startLimiter` (10/min) became a real DoS surface for NAT-shared users. None of this surfaced as an error log or alert; it was indistinguishable from "user is busy."

The deeper learning is structural. The failure mode SHOULD have been impossible to ship — the contract docs were right, the type signature was wrong, the backend implementation matched the wrong type, the test assertions pinned the wrong type, the E2E stub used the right type. Five places had the contract; one source of truth (the docs) was right, four downstream consumers drifted to a different but mutually consistent wrong shape. Without the wire-format-pinning rule above, that drift is undetectable by any single-axis review pass — the four wrong shapes form a self-reinforcing local consensus.

## When to Apply

- **Every backend route handler that returns a typed wire shape** in `agents/docs/api-contracts/*.md`. Add (or audit existing) integration test asserting type + format.
- **Every E2E stub that fakes a backend response** via `page.route(...)`. The stub's shape is documentation, not enforcement — the contract enforcement must live in a backend test.
- **Every TypeScript signature change** that flips a field's primitive type or admitted form. Treat the type as the audit set; check all call sites and downstream consumers.
- **Every time a contract doc says "ISO-8601 string"** or any other explicit format. The example value must match what the backend actually emits — `toISOString()` always emits milliseconds (`.sssZ`), never `:00Z` — and the integration test must assert that exact format class.

## Examples

### Bad — typeof-only pin (the pre-fix state)

```ts
// custody-consent-ops.test.ts (pre-fix)
expect(typeof res.body.data.expires_at).toBe('number');
const now = Math.floor(Date.now() / 1000);
expect(res.body.data.expires_at).toBeGreaterThan(now + 60);
```

This asserted the WRONG type. The contract docs say string. The assertion matched the broken backend, not the documented wire shape. Mutation-kill is inverted: the correct ISO emission would FAIL this test.

### Bad — E2E stub with the right shape but no backend pin

```js
// non-consent-fresh-auth.spec.js (pre-fix)
await page.route('/api/orcid/callback', route => {
  route.fulfill({
    json: {
      data: {
        fresh_auth_proof: 'fake',
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),  // ISO string ✓
        mechanism: 'orcid',
      },
    },
  });
});
```

The stub emits the correct ISO shape. The SPA reads it via `new Date(<iso>).getTime()` and it works in the test. But the test exercised neither the backend route nor the backend's emission — it pinned its own stub's shape. The bug lived in the backend's actual emission code path that no test in this layer hit.

### Good — backend integration test pinning both type and format

```ts
// custody-consent-ops.test.ts (post-fix)
expect(typeof res.body.data.expires_at).toBe('string');
const parsedExpiresAtMs = Date.parse(res.body.data.expires_at);
expect(Number.isFinite(parsedExpiresAtMs)).toBe(true);
const nowMs = Date.now();
expect(parsedExpiresAtMs).toBeGreaterThan(nowMs);
expect(parsedExpiresAtMs).toBeGreaterThan(nowMs + 60_000);
expect(parsedExpiresAtMs).toBeLessThanOrEqual(nowMs + 302_000);
```

Type pin via `typeof`. Format pin via `Number.isFinite(Date.parse(...))`. Bounded-future check pins the TTL window. Mutation-kill: regression to numeric emission fails the typeof check; regression to stringified-epoch-seconds fails the Date.parse check; regression to a different ISO-form that resolves to the past fails the bounded-future check. All three assertion halves are load-bearing.

### Cross-reference: structural sibling at the SQL layer

`agents/docs/solutions/conventions/pg-bigint-default-stringification-defeats-typeof-cast-guards-2026-05-06.md` describes the same failure shape at the pg-driver layer: node-postgres maps `bigint` columns to JS strings by default, so `typeof x === 'string'` passes whether the SQL `::text` cast is present or absent — the assertion's discriminator is defeated by the driver's normalization. Same "typeof alone is not a wire-shape pin" lesson, different normalization point in the stack.

## Related conventions

- `agents/docs/solutions/conventions/pg-bigint-default-stringification-defeats-typeof-cast-guards-2026-05-06.md` — structural sibling at SQL layer.
- `agents/docs/solutions/conventions/helper-contract-flip-untouched-adopter-audit-2026-05-16.md` — the broader convention that the `expires_at` type flip triggered (every consumer of `loginFromResponse` re-audits).
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — Case 3 of that doc establishes the ×4-reviewer-cross-corroboration mandatory-capture signal; this convention exists because that signal fired.
- `agents/docs/solutions/conventions/hive-signature-request-binding-shape-2026-04-21.md` — the canonical request-binding shape convention. Related space (wire-format pinning) but covers signed-message shape rather than response-field shape.

## Sources

- Bug fix: commit `afecd6e` (archived 2026-05-16 — `backend-expires-at-iso-conformance`).
- Detection: `/ce-code-review` of `ui-non-consent-broadcast-fresh-auth-wiring` — ×4 reviewer cross-corroboration (correctness 90, security 60, adversarial 95, api-contract 100 → synthesis 100).
- Verification of `Date.parse` semantics on Node 20.20.2: `Date.parse('1746535500')` returns `NaN`; `Date.parse('2026-05-16T16:54:17.123Z')` returns a valid finite ms timestamp.

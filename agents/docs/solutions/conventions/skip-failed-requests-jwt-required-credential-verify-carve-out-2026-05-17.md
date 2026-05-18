---
module: backend/src/middleware
date: 2026-05-17
problem_type: convention
component: authentication
severity: high
applies_when:
  - "Adopting `skipFailedRequests: true` on a `rateLimit()` call in `backend/src/middleware/rateLimit.ts`"
  - The route in question verifies credentials (password via argon2.verify, fresh-auth proof, etc.)
  - The architect is triaging a "stolen-JWT lockout DoS" finding against the JSDoc misuse warning
tags:
  - rate-limit
  - skip-failed-requests
  - credential-probing
  - threat-model
  - jwt
  - carve-out
related_components:
  - authentication
  - service_object
---

# `skipFailedRequests` on JWT-required credential-verifying routes is permitted under PEvO's threat model

## Context

`backend/src/middleware/rateLimit.ts` exports a `rateLimit()` primitive with an opt-in `skipFailedRequests: true` option. The JSDoc carries a misuse warning (added in task 5 round-3, commit `c9c7c5f`):

> "DO NOT use on credential-probing routes (e.g., /login, /recover) — failed probes would not consume slots, enabling unlimited account enumeration. The option is intended for one-shot ceremonies where failure is benign (transient infrastructure error, malformed body from a hijacked session) and the value at stake is operation success, not attempt-rate-limiting."

Read literally, this prohibits adoption on every route that calls `argon2.verify` or verifies a fresh-auth proof. Yet two such routes adopt it at HEAD:

- `backend/src/routes/custody.ts:57` — `freshAuthLimiter` (account-keyed, 10/min). Route is `POST /api/custody/fresh-auth`. Verifies password via argon2.verify.
- `backend/src/routes/custody.ts:62` — `sessionAuthLimiter` (account-keyed, 10/min). Route is `POST /api/custody/session-auth`. Verifies password via argon2.verify.

Both adoptions were explicitly architect-requested in task 4 round-1 hold item 3 (commit `41e4d60`) to close the legitimate-user-lockout DoS surface: stolen JWT + 10 wrong-password probes = 60s lockout on the mint path. Adversarial review of task 4 round-2 flagged the adoption as enabling unbounded per-account password brute-force; the architect dismissed it as an accepted tradeoff.

Without this carve-out captured in `agents/docs/solutions/`, the architect's reasoning lives in two task hold blocks (`41e4d60` + `c9c7c5f`) that will archive away within ~250 lines of `tasks-archive.md`. Future reviewers reading `custody.ts:57` see the JSDoc warning + the code's adoption and re-litigate the dismissal.

## Guidance

The JSDoc warning's blanket prohibition needs a carve-out for the specific shape PEvO uses.

**Rule shape:**

- **JWT-required credential-verifying routes MAY adopt `skipFailedRequests`** when all of the following hold:
  1. The route requires a valid JWT (via `verifyHiveSignature` middleware or equivalent) before reaching the credential check. Unauthenticated callers cannot probe the credential at all.
  2. The legitimate-user-lockout DoS surface is concrete (stolen JWT or aggressive client can burn slots via failed-status probes faster than the legitimate user can retry their one-shot ceremony).
  3. The argon2 server-wide semaphore (`backend/src/lib/argon2-semaphore.ts` — ~80 verifies/sec aggregate) is acceptable as the brute-force rate-bound. (At PEvO scale + single-instance, this is.)

- **Unauthenticated credential-probing routes MUST NOT adopt `skipFailedRequests`**:
  - `/login`, `/recover`, `/reset` and similar — IP-keyed, reachable without a JWT. Adoption would enable unlimited account enumeration / token brute-force.

The discriminator: "is this route reachable without a valid JWT?" — not "does this route check a credential?". The latter framing is what the JSDoc literally says; the former is what the threat model actually requires.

## Why This Matters

PEvO's threat model treats JWT theft as the accepted upstream prerequisite (memory `project_single_instance_only` + the architect's accepted tradeoff at commit `41e4d60`). A stolen JWT already grants broadcast access via the JWT alone. Allowing additional password brute-force via that same stolen JWT does not materially escalate the attacker's position — they already have account control via the JWT. Conversely, denying `skipFailedRequests` on these routes EXPOSES legitimate users to a 60s mint-path lockout every time a stolen JWT spams 10 wrong-password requests, which is a concrete user-visible defect.

The blanket JSDoc rule was written for the harder case: unauthenticated routes where adopting `skipFailedRequests` would let anyone brute-force any account's credentials with no upstream cost. That rule still applies to `/login`, `/recover`, `/reset`. It does NOT apply to routes that gate credential check behind a valid JWT — those routes have the per-account JWT identity as the implicit attempt-rate primitive, and the legitimate-user-lockout protection is the higher priority.

Without this carve-out captured, two failure modes follow:

1. **Re-litigation drift**: a future reviewer sees the JSDoc warning + the code's adoption + the gap in `docs/solutions/`, decides the adoption is a mistake, and removes `skipFailedRequests: true` from `custody.ts:57` and `:62`. Result: the legitimate-user-lockout DoS reappears, the architect re-discovers it in code review, the cycle restarts.
2. **Over-cautious omission**: a future implementer adds a sibling JWT-required credential-verify route (e.g., `/api/custody/change-password`) and omits `skipFailedRequests` per the JSDoc warning, recreating the lockout surface on the new route. Result: same DoS surface, expanding scope.

The convention documented here is the durable rationale.

## When to Apply

When triaging a `skipFailedRequests` adoption decision on a `rateLimit()` call site, ask in order:

1. **Does the route require a valid JWT?** (Look for `verifyHiveSignature` or equivalent middleware on the router/mount.)
   - No → defer to the JSDoc rule. MUST NOT adopt `skipFailedRequests`.
   - Yes → continue.
2. **Does the route verify a credential (password, fresh-auth proof, signed challenge)?**
   - No (one-shot ceremony like upgrade, accreditation-request) → adopting `skipFailedRequests` is non-controversial. Document the legitimate-user-lockout concern that motivates the adoption.
   - Yes → continue.
3. **Is the legitimate-user-lockout surface concrete?** (Stolen JWT + N failed probes = legitimate user locked out for ≥ windowMs.)
   - No → don't adopt. The DoS surface is hypothetical, not worth the brute-force exposure.
   - Yes → adopt under this carve-out. Add an inline comment at the call site referencing this convention.
4. **Update the call-site comment** to honestly describe the security argument:
   - The route requires JWT, so probing is account-state guessing under an authenticated channel — not unauthenticated credential enumeration.
   - The argon2 server-wide semaphore caps aggregate attack rate at ~80 verifies/sec; this is the brute-force rate-bound (NOT per-account, NOT JWT-issuance-gated).
   - PEvO accepts JWT theft as upstream prerequisite; this carve-out is conditional on that threat model. Cite `agents/docs/solutions/conventions/skip-failed-requests-jwt-required-credential-verify-carve-out-2026-05-17.md` so the rationale survives task archive.

## Examples

**Correct adoption** (current HEAD, PEvO):

```typescript
// backend/src/routes/custody.ts
const freshAuthLimiter = rateLimit({
  name: 'custody-fresh-auth',
  windowMs: 60_000,
  max: 10,
  keyFn: byAccount,
  // Carve-out: JWT-required credential-verify route. Adoption closes the
  // legitimate-user-lockout DoS (stolen JWT + 10 wrong-passwords = 60s lockout
  // on the mint path). Brute-force rate bound by argon2 server-wide
  // semaphore (~80 verifies/sec, not per-account). See
  // agents/docs/solutions/conventions/skip-failed-requests-jwt-required-
  // credential-verify-carve-out-2026-05-17.md for the threat-model rationale.
  skipFailedRequests: true,
});

const sessionAuthLimiter = rateLimit({
  name: 'custody-session-auth',
  windowMs: 60_000,
  max: 10,
  keyFn: byAccount,
  // Same carve-out as freshAuthLimiter above.
  skipFailedRequests: true,
});
```

**Correct omission** (unauthenticated credential-probing routes):

```typescript
// backend/src/routes/auth.ts
const loginLimiter = rateLimit({
  name: 'auth-login',
  windowMs: 3_600_000,
  max: 10,
  keyFn: byIp,
  // NO skipFailedRequests — credential-probing route per the JSDoc warning.
  // IP-keyed; reachable without a JWT. Adoption would enable unlimited
  // credential enumeration.
});

const recoverLimiter = rateLimit({
  name: 'auth-recover',
  windowMs: 3_600_000,
  max: 10,
  keyFn: byIp,
  // Same rationale as loginLimiter. Recover-token guess attack surface.
});
```

**Audit grid** (verified at HEAD 2026-05-17 via task 5 round-3 verbatim call-site audit, updated for task 4 round-2's adoption):

| Site | Keying | skipFailed | Credential-verify? | JWT-required? | Disposition |
|---|---|---|---|---|---|
| `auth.ts:264 loginLimiter` | IP | ❌ | ✓ (argon2) | ❌ | Correct omission |
| `auth.ts:265 resetRequestLimiter` | IP | ❌ | (existence-probing) | ❌ | Correct omission |
| `auth.ts:266 resetLimiter` | IP | ❌ | ✓ (token guess) | ❌ | Correct omission |
| `auth.ts:1072 recoverLimiter` | IP | ❌ | ✓ (token guess) | ❌ | Correct omission |
| `custody.ts:43 broadcastLimiter` | account | ❌ | ❌ | ✓ | N/A — not credential-verify, no DoS concern |
| `custody.ts:51 upgradeLimiter` | account | ✓ | ❌ (signed challenge) | ✓ | Correct adoption — one-shot ceremony |
| `custody.ts:57 freshAuthLimiter` | account | ✓ | ✓ (argon2) | ✓ | **Carve-out adoption — this convention** |
| `custody.ts:62 sessionAuthLimiter` | account | ✓ | ✓ (argon2) | ✓ | **Carve-out adoption — this convention** |
| `accreditation.ts:35 accreditationRequestLimiter` | account | ✓ | ❌ (fresh-auth proof, not new credential) | ✓ | Correct adoption — one-shot ceremony |
| `accreditation.ts accreditationVerifyLimiter` | IP | ✓ | ❌ (token claim, not credential probe) | ❌ | Correct adoption — IP-keyed one-shot ceremony; HAF outage / Redis pre-INCR transients are the legitimate-user-lockout surface; 256-bit token entropy is the brute-force rate-bound |

The grid is the discriminator-in-practice: every site with `skipFailedRequests: true` is JWT-required AND has a concrete legitimate-user-lockout DoS surface that motivates the adoption.

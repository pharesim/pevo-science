# BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT — Widen `password_hash: string` to `string | null` across all account-query call sites and apply the canonical hoist pattern

**Owner:** backend
**Created:** 2026-04-29 (architect, surfaced by cluster C `/ce-code-review` of `backend-auth-resume-signup-timing-guard` round-2)
**Priority:** P1
**Source:** Cluster C round-2 review of `backend-auth-resume-signup-timing-guard.md` (kieran-typescript persona, findings KT-001 through KT-004 at conf 75-100). The round-2 fix correctly widened the `/resume-signup` query type generic and introduced the closure-local hoist pattern at `backend/src/routes/signup-verify.ts:139`. Sibling sites with the same `password_hash: string` (non-nullable) annotation were left unmigrated, perpetuating the audit-incomplete shape that originally caused the round-1 hold (the ORCID-only confirmed-state TypeError oracle).

## Problem

`accounts.password_hash` is documented nullable in the schema (`migrations/0070*` / `password_hash TEXT` with no NOT NULL, plus an explicit `ALTER TABLE accounts ALTER COLUMN password_hash DROP NOT NULL`). The round-2 fix on `/resume-signup` widened the SQL result type generic from `password_hash: string` to `string | null` so TypeScript can prove a null-guard is in place before `argon2.verify`. **Four sibling call sites still type the column as `string` (non-nullable):**

1. **`backend/src/routes/custody.ts:175` (highest risk)** — the `/upgrade` handler types its query result with non-nullable `password_hash`. The handler at line 194 calls `argon2.verify(account.password_hash, password)` **with no runtime null-guard at all**, relying entirely on the (incorrect) type-system claim. Today the route is JWT-authenticated and gated to light-custody accounts — which by current invariant always have a password — so the path is unreachable in practice. **But** if an ORCID-only account ever acquires `custody='light'` via a future code path (e.g., `/api/custody/upgrade` itself, an admin tool, a bulk migration), this fires `argon2.verify(null, password)` → synchronous TypeError → 500 in ~0ms → reopens the email-enumeration oracle the round-2 fix just closed at the sibling endpoint. Reachability is gated, but the type system cannot enforce the gate.
2. **`backend/src/routes/auth.ts:626` (login)** — query types `password_hash: string`. The handler does have a runtime null-guard at line 664 (`if (!account.password_hash)`), so the path is safe today. But TypeScript narrowing the value to `string` from line 626 forward means the line-664 guard is **vacuous** at the type level — a regression that drops the guard would compile cleanly. The runtime call at line 677 (`argon2.verify(account.password_hash, password)`) is the consumer; widening the generic to `string | null` would convert it into a compile error and demand explicit handling.
3. **`backend/src/routes/signup-verify.ts:209` (`/confirm`) and `:341` (`/link`)** — both queries type `password_hash: string`. Neither handler currently calls `argon2.verify` on the column, so there's no runtime crash today. But the type annotation is misinforming the checker about a column the schema-comment at the top of the same file already documents as nullable. Any future code path that adds an `argon2.verify` (e.g., a re-auth step on `/confirm`, a password-set on `/link`) inherits the same blind spot the round-2 fix just patched.
4. **`backend/src/routes/auth.ts:539`** — the resend-verification handler uses `account.password_hash!` (non-null assertion) inside a truthy narrowing branch. The query result IS already correctly typed `string | null` here (unlike sites 1-3), but the `!` was added because the closure-local narrowing across the truthy block didn't carry through cleanly. Replace the `!` with the same hoist pattern Pass 1 introduced at `signup-verify.ts:139`.

The `/resume-signup` round-2 fix at `backend/src/routes/signup-verify.ts:139` is the **canonical reference implementation** of the hoist pattern:

```ts
// Type-narrowing hoist: TS cannot narrow `account.password_hash` across
// the async callback boundary inside `runWithArgon2Slot` even after the
// null-guard above proves it non-null at runtime. The local `const`
// pins the narrowed type for the closure body.
const passwordHash = account.password_hash;
await runWithArgon2Slot(() => argon2.verify(passwordHash, password), { signal });
```

A future contributor seeing the hoist with a clean `tsc --noEmit` may try to "simplify" it away; without an explanatory comment the canonical idiom is unstable across maintainer turnover.

## Goal

1. Widen the SQL result type generic on every account-query call site that reads `password_hash` from `string` → `string | null`. Verify by `tsc --noEmit` after each site that the TS error surfaces at the consuming `argon2.verify` (or other read site) and is closed by an explicit guard or hoist.
2. Apply the canonical hoist pattern at every `argon2.verify(account.password_hash, ...)` consumer wherever the closure boundary causes TS narrowing to fail. Replace any `!` non-null assertions with the hoist pattern (site 4 above).
3. Add the canonical comment on the hoist pattern (one comment block, referenced from each consumer) so the idiom is durable.
4. Add the missing runtime null-guard at the custody-upgrade handler (site 1). Even though reachability is gated by the JWT + custody='light' gate today, the type-system widening will surface the missing guard as a compile error — close it with the same `if (!account.password_hash) { await burnSentinel(password); return sendError(res, 400, 'BAD_REQUEST', 'Invalid email or password'); }` shape the `/resume-signup` fix uses (or the equivalent custody-specific 4xx shape — implementer's call). The burn here is defense-in-depth: even if the gate-by-invariant holds today, having the type system + the runtime guard double-cover is what closes the audit.

## Scope (sites to migrate)

| # | File:line | Query | Consumer | Risk today |
|---|-----------|-------|----------|------------|
| 1 | `backend/src/routes/custody.ts:175` (query) + `:194` (consumer) | `/upgrade` | `argon2.verify(account.password_hash, ...)` with NO guard | Latent: gated by JWT + custody='light', but type-blind |
| 2 | `backend/src/routes/auth.ts:626` (query) + `:677` (consumer) | `/login` | `argon2.verify(account.password_hash, ...)` with line-664 guard | Safe at runtime; type-system off |
| 3 | `backend/src/routes/signup-verify.ts:209` (query for `/confirm`) | `/confirm` | (no `argon2.verify` consumer today) | Latent: future consumer inherits the blind spot |
| 4 | `backend/src/routes/signup-verify.ts:341` (query for `/link`) | `/link` | (no `argon2.verify` consumer today) | Latent: same as #3 |
| 5 | `backend/src/routes/auth.ts:539` (`!` assertion) | `/resend-verification` | `argon2.verify(account.password_hash!, ...)` | Type-rigor: replace `!` with hoist |
| 6 | `backend/src/routes/signup-verify.ts:139` (canonical hoist) | `/resume-signup` (already fixed) | (reference site) | Add canonical comment if missing |

## Acceptance

- All 5 SQL result type generics that read `password_hash` are typed `string | null`. Verified by grep: `grep -nE "password_hash:\s*string\b" backend/src/routes/` returns only matches inside `string | null` annotations or ` /* not null */` comments — no bare `string` annotations on this column.
- `argon2.verify` consumers (sites 1, 2, 5) use the canonical hoist pattern from `signup-verify.ts:139`. The hoist comment cites the audit task file or the canonical site so a future contributor sees the pattern's rationale without grep-archaeology.
- The custody-upgrade handler (site 1) has a runtime null-guard before `argon2.verify`. The guard's response shape is left to implementer judgment but MUST burn the sentinel (or otherwise pay argon2 wall-time) before returning the error response, to keep timing-equalization with the password-mismatch branch closed.
- The `auth.ts:539` `!` assertion is gone, replaced by the hoist pattern.
- `npx tsc --noEmit` clean. `npm run lint` clean.
- Targeted vitest: full backend suite passes (the round-2 fix's parametrized timing test on `/resume-signup` continues to pass, and sites 2 + 5 — login + resend-verification — have existing route-level tests that exercise the password-hash consumer paths).

## Non-goals

- Adding burn-sentinel timing equalization to routes that don't currently have it. The audit is type-rigor on existing handlers.
- Rewriting the schema to enforce `password_hash NOT NULL` for password-set accounts. The current nullable schema accommodates ORCID-only accounts intentionally.
- Migrating the test-side `tests/support/argon2-error-mocks.ts:128` reference (out of scope per Group B's BE-ARGON2-ERROR-HANDLER-EXTRACT round-3 hold-block dismissal — the mock factory's re-export of `actual.isArgonSemaphoreError` is mechanical and not part of this typing audit).
- Adding new tests for sites 3 + 4 (`/confirm` and `/link`). Those handlers don't read `password_hash` today; the type widening is preventive. If a future task adds a consumer, that task adds the test.

## Coordination

This task does NOT block the round-2 archive of `backend-auth-resume-signup-timing-guard.md` (the round-2 fix is correct on its own scope). It does extend the audit cluster the round-2 fix was originally scoped to. Land independently.

The architect filed this task during cluster C review on 2026-04-29 because the audit-incompleteness was visible only after the round-2 fix landed and surfaced the sibling-site pattern by contrast. Per `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` Case 2, this is the documented "annotation must permit null where null is possible" pattern; the new task closes it across the auth/signup-verify/custody surface.

## Files of record

- `backend/src/routes/custody.ts` (sites 1, primary)
- `backend/src/routes/auth.ts` (sites 2, 5)
- `backend/src/routes/signup-verify.ts` (sites 3, 4 + canonical hoist at :139)
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` (the convention this task closes a remaining gap on)

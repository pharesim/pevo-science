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

---

## Architect re-review (2026-05-04) — HELD PENDING FIXES (round 2)

`/ce-code-review` ran on commit `aa32eca` (round-1 implementation: type widening on 4 query sites + canonical hoist application + new custody-upgrade null-guard with burnSentinel) with 8 personas (correctness, testing, maintainability, project-standards, kieran-typescript, security, adversarial, learnings). Round-1 acceptance items 1-5 verified landed correctly:

- All 5 SQL result type generics that read `password_hash` are typed `string | null` (verified via grep — `auth.ts:596, :749`, `custody.ts:192`, `signup-verify.ts:106, :228, :366`; plus `settings.ts:75, :355` already correct from a prior task).
- Canonical hoist pattern applied at every `argon2.verify(account.password_hash, ...)` consumer: `auth.ts:625` (resend-verification, replacing the prior `account.password_hash!`), `auth.ts:807` (login), `custody.ts:232` (custody-upgrade), `signup-verify.ts:158` (canonical site, comment expanded).
- The `auth.ts:625` `!` non-null assertion is gone; replaced by the hoist.
- New runtime null-guard at `custody.ts:223-227` with `burnSentinel(password, abortSignal)` + matching `logCustodyBroadcast(username, 'upgrade_failure').catch(() => {})` + matching `sendError(res, 401, 'UNAUTHORIZED', 'Invalid password')` — observably indistinguishable from the wrong-password branch on wall-time, status, audit-log, and response shape (verified by reading both branches side-by-side; `burnSentinel` goes through `runWithArgon2Slot` with the same signal).
- `tsc --noEmit`: clean. `npm run lint`: clean.
- The cross-route import `import { burnSentinel } from './auth.js';` is explicitly accepted by `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md:59`. No relocation to `lib/` required.

But four items below need to land before this task can archive — one P1 (mutation-fence test on the new sub-branch), one P2 (comment misframes the null-guard's load-bearing reachability), and two P3 polish items.

### Items to address

**1. (P1) New custody-upgrade null-hash sub-branch has zero test coverage.**

- File: `backend/src/routes/custody.ts:223-227` (new branch). Test target: a new file (or an extension of) `backend/tests/routes/custody-upgrade-*.test.ts`.
- The wall-time / status / audit-log convergence between the new null-guard branch and the wrong-password branch is asserted in the comment but NOT locked by any test. Existing `custody-upgrade-argon-error-translation.test.ts` mocks `password_hash: '$argon2id$placeholder'` (non-null) and routes around the new guard. A future PR that drops `await burnSentinel(...)`, removes the audit-log call, or changes the response code (e.g., to `'INVARIANT_VIOLATION'`) lands green and silently reopens the wall-time / status oracle.
- Per `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md`, every sub-branch on a timing-equalized endpoint needs a load-bearing test fence — analogous to the `/login` `NO_PASSWORD_SET` timing test in `recover.test.ts:438-463` and the `/resend-verification` null-hash burn test in `recover.test.ts:602-633`.
- Fix: add a vitest case that DB-seeds a `custody='light'` row with `password_hash=NULL`, sends `/api/custody/upgrade` with a JWT for that row, and asserts:
  - `res.status === 401`
  - `res.body.error.code === 'UNAUTHORIZED'`
  - `res.body.error.message === 'Invalid password'`
  - `logCustodyBroadcast` was invoked with `(username, 'upgrade_failure')` (assert via DB-side audit-log check or mock)
  - Wall-time within the same band as the wrong-password branch (the convention's `TIMING_ORACLE_FLOOR_MS` shape; or a paired-request equivalence test if a floor-only assertion is impractical at this layer)
- Real-DB testing path is in scope of the project's test discipline (root CLAUDE.md "Running Tests"); the carve-out for synthetic mocks does not apply here — the route's HAF / middleware path must run.

**2. (P2) Custody-upgrade null-guard comment misframes the branch as "unreachable today".**

- File: `backend/src/routes/custody.ts:209-220` (comment block).
- Current text: "today the route is gated by JWT + custody='light', and light-custody accounts always carry a password, so this branch is unreachable in practice."
- This framing is wrong today. ORCID-only accounts (`password_hash=NULL`, `custody=NULL` or `'orcid'`) reach this branch via:
  1. `/api/orcid/callback` at `backend/src/routes/orcid.ts:456` mints a JWT with `custody: account.custody || 'light'` — the `||` defaults to `'light'` for null/falsy `custody` fields.
  2. The JWT's `custody='light'` claim passes the `/upgrade` route's `custody !== 'light'` gate.
  3. Without the new null-guard, execution reaches `argon2.verify(null, password)` → synchronous TypeError → 500 in ~0ms.
- The null-guard is **load-bearing today** for any current ORCID-only-account-holder, not future-proofing.
- Fix: rewrite the comment to name the reachable path explicitly (ORCID-only account + JWT-mints-`light`-by-default + `/upgrade`) and drop the "unreachable in practice" framing. The architect will track the `orcid.ts:456 ||` default vs the `/upgrade` gate as a separate concern at this task's archive (it is the underlying invariant violation; the null-guard is the local fix).

**3. (P3) Brittle `signup-verify.ts:145` file:line cross-references in three call sites.**

- Files: `backend/src/routes/auth.ts:587`, `backend/src/routes/auth.ts:752-754`, `backend/src/routes/custody.ts:226`.
- Each site cites the canonical hoist as `signup-verify.ts:145`. Line numbers drift on any insertion above the canonical block.
- Fix: replace each `signup-verify.ts:145` reference with a symbol/handler-based reference, e.g., "see `/resume-signup` handler in `signup-verify.ts`" or "see the canonical block in BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT". Greppable and stable across line drift.

**4. (P3) Canonical hoist comment lacks precondition list — invites cargo-cult application.**

- File: `backend/src/routes/signup-verify.ts:145-156` (canonical comment).
- The comment explains WHAT the hoist does and WHY at this site, but does not enumerate the preconditions that make the hoist load-bearing. The hoist is needed when ALL of:
  1. The property's static type is nullable (or otherwise needs narrowing).
  2. A control-flow guard above proves it non-null at runtime.
  3. The consumer is inside a closure that captures the parent object by reference (TS de-narrows at the closure boundary).
- Without these preconditions explicit, a future contributor may apply the hoist at a synchronous closure where TS DOES narrow correctly, or at a non-nullable property where the hoist is meaningless.
- Tighten "the narrowing does NOT carry across the async closure boundary" → "the narrowing does NOT carry across the closure boundary" (synchronous closures over mutable property accesses also lose narrowing; the closure boundary itself is the load-bearing aspect, not the async).
- Fix: add a 3-bullet precondition list to the canonical comment; tighten "async closure" → "closure boundary".

### Items dismissed during architect triage (do NOT address)

- **Cross-route `burnSentinel` import suggests promotion to `lib/`** (maintainability conf 50). Convention `auth-structured-log-shape-2026-04-29.md:59` already explicitly accepts auth.ts → custody.ts cross-import for `burnSentinel`. No relocation needed.
- **`logCustodyBroadcast(...).catch(() => {})` audit-log indistinguishability not test-locked** (adversarial conf 50). Subsumed by item 1's mutation-fence test, which will assert the audit-log entry is emitted in the null-hash branch.
- **Cross-route import circular precondition** (adversarial conf 50). Auth.ts does not currently import from custody.ts; if a future change introduced such an import, the circularity surfaces at module-load time, not selectively at runtime — caught at boot.
- **Hoist comment redundancy across 3 cross-reference sites** (maintainability conf 50). The cross-references are minimal one-line "see canonical at ..." pointers; proportionate.
- **Custody-upgrade null-guard comment length proportionality** (maintainability conf 50). 12-line block is proportionate to a defensive-null-guard whose reachability requires explanation; item 2 will make the explanation accurate, not necessarily shorter.
- **Helper-test infra polish** (testing conf 60). Forward-compat polish for the helper module; not blocking this task.

### Re-review signal

When items 1-4 land, `git mv` this file back to `tasks/review/`. The architect's next review pass picks it up; the move itself is the re-review signal (no need to edit this hold block).

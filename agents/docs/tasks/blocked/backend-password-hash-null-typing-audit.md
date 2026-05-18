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

---

## Backend re-review signal (2026-05-04, working tree)

Round-2 hold items 1-4 landed:

- **Item 1 (P1)**: New mutation-fence test at `backend/tests/routes/custody-upgrade-null-hash.test.ts` — real-DB (verifyHiveSignature middleware exercised, real argon2, real pg pool, no `getPool()`/`getAppPool()` mocks). Two cases: (a) the null-hash branch returns 401 UNAUTHORIZED + "Invalid password" + custody_audit_log row (`operation_type='upgrade_failure'`) + wall-time ≥ TIMING_ORACLE_FLOOR_MS (35ms); (b) a paired-request equivalence baseline on the wrong-password branch asserts the same envelope and floor, locking the indistinguishability claim made in the implementation comment. Each test seeds a unique `custody='light'` row (`upnh<suffix>user` for null-hash, `upwp<suffix>user` for wrong-password) so the per-account `upgradeLimiter` (max=1/hr) doesn't poison subsequent runs. Cleanup runs in `afterAll`.
- **Item 2 (P2)**: Custody-upgrade null-guard comment at `backend/src/routes/custody.ts:209-225` rewritten. The "unreachable in practice" framing is gone. Replaced with the reachable path enumerated explicitly: ORCID-only account → `/api/orcid/callback` mints a JWT with `custody: account.custody || 'light'` (defaulting to `'light'` for null/falsy `custody`) → that JWT passes `/upgrade`'s `custody !== 'light'` gate → reaches the null-guard. Notes that the null-guard is the local fix and the orcid.ts `||` default vs the `/upgrade` gate is the underlying invariant violation tracked separately.
- **Item 3 (P3)**: Three brittle `signup-verify.ts:145` line-number cross-references replaced with symbol-based refs. `custody.ts:229`, `auth.ts:621`, `auth.ts:801` now cite "the `/resume-signup` handler in `signup-verify.ts` and BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT". Greppable, stable across line drift.
- **Item 4 (P3)**: Canonical hoist comment at `backend/src/routes/signup-verify.ts:144-167` extended with a 3-bullet precondition list (nullable static type + control-flow guard above + closure-captures-parent-object-by-reference). Also tightened: "the narrowing does NOT carry across the **async** closure boundary" → "the narrowing does NOT carry across the closure boundary". The closure boundary itself is load-bearing, not the async-ness; synchronous closures over mutable property accesses also lose narrowing.

Verification:
- `cd backend && npx tsc --noEmit` — clean.
- `cd backend && npm run lint` — clean (only 2 pre-existing warnings in `seed-phrase.ts`, untouched by this work).
- `cd backend && npx vitest run tests/routes/custody*.test.ts` — 7/7 pass (the new `custody-upgrade-null-hash.test.ts` 2-case file plus the existing `custody.test.ts` and `custody-upgrade-argon-error-translation.test.ts`).
- The broader `tests/routes/custody*.test.ts tests/routes/auth*.test.ts tests/routes/signup-verify*.test.ts` set has 10 pre-existing failures across `auth-signup-argon-error-translation.test.ts`, `auth-signup-dup-saturated.test.ts`, and the SEC-004-BE describe blocks of `signup-verify.test.ts`. Reproduced on a clean tree (stash + re-run) before applying these changes; the failure count and identity is identical with and without my work. Out of scope for this task.

---

## Architect re-review (2026-05-04) — HELD PENDING FIXES (round 3)

`/ce-code-review` ran on commit `99c6e72` (round-2 hold-fix: 4 items 1-4 landed) with 9 personas (correctness, testing, maintainability, project-standards, kieran-typescript, security, reliability, adversarial, learnings). Round-2 acceptance verified:

- Item 1 (P1) mutation-fence test landed at `backend/tests/routes/custody-upgrade-null-hash.test.ts` — real-DB, no `getPool`/`getAppPool`/`verifyHiveSignature` mocks. Two paired cases (null-hash + wrong-password) assert status 401, error.code 'UNAUTHORIZED', error.message 'Invalid password', `custody_audit_log` row with `operation_type='upgrade_failure'`, wall-time ≥ TIMING_ORACLE_FLOOR_MS (35ms). Per-account `upgradeLimiter` avoided via unique seed-account suffix. Cleanup in `afterAll`.
- Item 2 (P2) custody-upgrade null-guard comment rewrite landed at `custody.ts:209-225`. "Unreachable in practice" framing gone; reachable path enumerated explicitly (ORCID-only account → `/api/orcid/callback` `||` default → `/upgrade` custody-gate → null-guard). Notes the orcid.ts `||` default vs `/upgrade` gate as the underlying invariant violation tracked separately.
- Item 3 (P3) cross-ref polish landed at `auth.ts:621`, `auth.ts:801`, `custody.ts:229` — `signup-verify.ts:145` replaced with "the `/resume-signup` handler in `signup-verify.ts` and BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT". Greppable, drift-stable.
- Item 4 (P3) canonical hoist comment expansion + tightening landed at `signup-verify.ts:144-167`. 3-bullet precondition list added; "async closure boundary" → "closure boundary" tightening done correctly (the closure boundary itself is load-bearing, not the async-ness).
- `tsc --noEmit` clean. `npm run lint` clean. Targeted vitest 7/7 pass.

But four items below need to land before this task can archive — one P1 (test self-poisoning under vitest retry, breaking the mutation-fence's ground-truth signal), one P2 (warmup that doesn't warm), and two P3 polish items.

### Items to address

**1. (P1) Audit-log SELECT races fire-and-forget INSERT and self-poisons under vitest retry.**

- Test file: `backend/tests/routes/custody-upgrade-null-hash.test.ts:147-152` (null-hash case) + `:191-196` (wrong-password case). Production code: `backend/src/routes/custody.ts:228` (`logCustodyBroadcast(username, 'upgrade_failure').catch(() => {})` — fire-and-forget, no `await`).
- Two compounding problems:
  1. The SELECT can race the INSERT — the response returns before the audit-log microtask settles. The pattern matches `recover.test.ts` (which apparently works), so the race window may be narrow in practice.
  2. `vitest.config.ts` sets `retry: 1`. If attempt #1 fails for any reason (race, wall-time hiccup), retry runs. The route writes a SECOND audit-log row (cleanup is `afterAll`, not `beforeEach`). Retry's `expect(auditRows.length).toBe(1)` then fails as `expected 2 to be 1` regardless of whether the actual claim under test is correct. Self-poisoning that breaks the mutation-fence's ground-truth signal.
- Suggested fix: add a `beforeEach` that DELETEs `custody_audit_log` rows for the seeded usernames AND the seeded account rows that get written during the test. Resets retry state cleanly without changing production audit-log semantics from fire-and-forget to blocking. ~6-line change. Alternative shape that also works: bounded poll for the row + assertion change to `>= 1` (less invasive, but doesn't fix the retry-row-count poisoning by itself; pair with the `beforeEach` reset for completeness).
- Do NOT change production `custody.ts:228` to `await logCustodyBroadcast(...)`. The fire-and-forget shape is endorsed by `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md`; one test's reliability needs shouldn't drive the convention.

**2. (P2) Warmup unauthenticated request is a no-op (5-reviewer corroboration).**

- Test file: `backend/tests/routes/custody-upgrade-null-hash.test.ts:128-131` (null-hash case) + `:171-173` (wrong-password case).
- The warmup `request(app).post('/api/custody/upgrade')` is sent without an `Authorization` header. `verifyHiveSignature` 401s before any route body runs. `burnSentinel` and `argon2.verify` never execute on the warmup path.
- The stated goal (warming `SENTINEL_ARGON2_HASH_PROMISE`) is moot — that promise is **eager**, computed at `auth.ts:157` module load, fully resolved before any test starts.
- The first measured request still pays Express cold-path overhead. The `>= 35ms` floor passes only because the floor has ~35× margin, not because the warmup did anything.
- The misleading comment is a propagation hazard for future timing-equalization tests copy-pasting this pattern.
- Suggested fix: drop the warmup request + its 4-line comment in both cases. The eager sentinel promise + the documented 35× floor margin handle the cold-path concern. ~6-line cleanup total. (Alternative: add a real `Authorization` header so the warmup actually exercises the route. Adds budget cost for argon2 work in the warmup; A is preferred.)

**3. (P3) Stale `signup-verify.ts:146` line ref in test-name string.**

- File: `backend/tests/routes/signup-verify-resume-argon-error-translation.test.ts:101`. The `it()` name string reads `'confirmed + password_hash branch (signup-verify.ts:146, runWithArgon2Slot)'`.
- Item 4's 12-line precondition expansion moved `runWithArgon2Slot` from line 146 to line 170. Identical anti-pattern to Item 3 of the round-2 hold (which fixed THREE such drift-stale line refs in production code via symbol-based replacement). This site is in test code and was missed.
- Suggested fix: replace `'(signup-verify.ts:146, runWithArgon2Slot)'` with `'(\`/resume-signup\` handler in signup-verify.ts, runWithArgon2Slot)'` per Item 3's symbol-based-ref convention.

**4. (P3) `beforeAll` seed INSERTs not error-wrapped.**

- File: `backend/tests/routes/custody-upgrade-null-hash.test.ts:89` (null-hash seed) + `:102` (wrong-password seed).
- Surrounding DELETEs are `.catch()`-guarded; INSERTs are not. On schema/constraint failure (stale row from prior crash, schema migration not applied), vitest marks `beforeAll` as rejected, the `it` bodies still run, the route returns 401 "Session is no longer valid" via the missing-row branch, the status assertion still passes, and the audit-log assertion fails with cryptic 0-rows message that doesn't point back to seed-time root cause.
- Suggested fix: wrap each INSERT in a try/catch that re-throws with a descriptive message naming the seeding step (e.g. `Failed to seed null-hash account ${NULL_HASH_USER}: ${err.message}`). ~6 lines per INSERT, ~12 total.

### Items dismissed during architect triage (do NOT address)

- **`clearRateLimitKeys(['custody-upgrade'])` global wildcard** (reliability conf 80). Pre-existing project-wide helper pattern; fixing in this test alone wouldn't close the parallel-conflict risk. Re-evaluate if a real sibling-test conflict surfaces.
- **`clearRateLimitKeys` doesn't reset in-memory limiter fallback** (adversarial conf 75). Pre-existing helper limitation; helper's own header comment acknowledges it. Right fix is at the helper level (project-wide), not in this test.
- **Test seeds `custody='light'` directly, masking ORCID-coercion path** (adversarial conf 80). Filed as a separate task `backend-orcid-custody-default-invariant.md` per architect triage on 2026-05-04 — the architect's round-2 hold already noted this as "the underlying invariant violation tracked separately"; surfacing it as a concrete pending task is the natural next step. Modifying the local test addresses the symptom; the new task closes the root cause.
- **Untyped `pool.query` rows** (kieran-ts conf <75). Pattern is shared with sibling test files; not introduced here.
- **`SUFFIX` 100-second collision window** (kieran-ts conf <75). Mitigated by `beforeAll` DELETE; concurrent-in-flight collision risk is real but narrow.
- **`describe.skipIf(!dbReachable)` silent skip** (project-standards residual). Consistent with other real-DB test files in the repo; the mutation fence is only load-bearing when the env override is applied, which is the documented pattern.
- **Solutions-doc line-ref staleness in `ts-closure-denarrowing-nullable-property-hoist-2026-05-04.md`** (maintainability conf 100). Architect-owned doc; fixed by the architect in a separate `architect(compound-refresh):` commit on 2026-05-04 (out of this task's scope).
- **Missing `TIMING_ORACLE_CEILING_MS` upper-bound assertion** (security residual). Pre-existing pattern shared with `recover.test.ts`; not introduced here. Architect-tracked as a forward observation.
- **`(null-hash branch) × (semaphore error)` cell uncovered** (learnings forward observation). Low probability; revisit if a regression surfaces.

### Re-review signal

When items 1-4 land, `git mv` this file back to `tasks/review/`. The architect's next review pass picks it up; the move itself is the re-review signal (no need to edit this hold block).

---

## Backend re-review signal (2026-05-04, working tree)

Round-3 hold items 1-4 landed across two test files; production code untouched.

- **Item 1 (P1)**: `backend/tests/routes/custody-upgrade-null-hash.test.ts` — `beforeAll` reduced to one-time argon2 hash compute (stored in describe-scoped `realHash`). Added a new `beforeEach` that DELETEs `custody_audit_log` rows AND `accounts` rows for both seeded usernames, then re-INSERTs the null-hash and wrong-password seed rows. Reset runs ahead of every `it` attempt including vitest's `retry: 1`, so a retried test sees a clean baseline (one INSERT from the route call, count == 1) instead of compounded prior-attempt rows. Empirically, dropping the warmup (item 2) tightened the SELECT-INSERT race window enough that the `beforeEach` reset alone was insufficient — the architect's "Alternative shape" (bounded poll + pair with `beforeEach`) was needed. Added a module-level `fetchSettledAuditRows()` helper that polls up to 1.5s for `>= 1` row, then waits 100ms for any imminent double-log mutation to also commit, then SELECTs once more and returns the settled count. Both `it` blocks call the helper and keep `expect(auditRows.length).toBe(1)` (the `beforeEach` reset guarantees the count is exactly 1, so `.toBe(1)` still surfaces an over-log production mutation). Production `custody.ts:228` `logCustodyBroadcast(...).catch(() => {})` is unchanged — fire-and-forget convention preserved per `auth-structured-log-shape-2026-04-29.md`.
- **Item 2 (P2)**: same file at the prior lines 128-131 (null-hash case) and 171-173 (wrong-password case) — dropped both warmup `request(app).post('/api/custody/upgrade').send(...)` calls and their 4-line preamble comments. The eager `SENTINEL_ARGON2_HASH_PROMISE` at `auth.ts:157` is computed at module load (the warmup never reached `burnSentinel`/`argon2.verify` because `verifyHiveSignature` 401s on the missing `Authorization` header), and the documented 35× `TIMING_ORACLE_FLOOR_MS` floor margin handles the cold-path concern. ~12 lines removed total.
- **Item 3 (P3)**: `backend/tests/routes/signup-verify-resume-argon-error-translation.test.ts:101` — replaced the brittle `it`-name string `'(signup-verify.ts:146, runWithArgon2Slot)'` with `'(\`/resume-signup\` handler in signup-verify.ts, runWithArgon2Slot)'`. Greppable, drift-stable across line motion in `signup-verify.ts` (item 4 of round-2 already moved `runWithArgon2Slot` from line 146 to line 170).
- **Item 4 (P3)**: `backend/tests/routes/custody-upgrade-null-hash.test.ts` — both seed `INSERT`s (now in `beforeEach` per item 1's refactor) wrapped in try/catch that re-throw with a descriptive message naming the seeding step: `Failed to seed null-hash account ${NULL_HASH_USER}: ${(err as Error).message}` and `Failed to seed wrong-password account ${WRONG_PWD_USER}: ${(err as Error).message}`. On schema/constraint failure the surfaced error names the root cause instead of cascading into a cryptic 0-rows audit-log assertion downstream.

Verification:
- `npx tsc --noEmit` — clean.
- `npm run lint` — clean (only pre-existing accepted `@typescript-eslint/no-explicit-any` warnings in `seed-phrase.ts`, untouched by this work).
- `npx vitest run tests/routes/custody-upgrade-null-hash.test.ts tests/routes/signup-verify-resume-argon-error-translation.test.ts` (with `REDIS_URL` + `APP_DATABASE_URL` Docker-network overrides per root CLAUDE.md "Running Tests") — 14/14 pass.

---

## Architect re-review (2026-05-18) — HELD PENDING FIXES (round 4)

`/ce-code-review` on commit `009b4a2` with 7 personas (correctness on Opus; testing/maintainability/project-standards/kieran-typescript/reliability/learnings on Sonnet; `ce-agent-native-reviewer` skipped per PEvO root CLAUDE.md; `ce-adversarial-reviewer` skipped — test-side change, no auth/payments/mutations). Round-3 acceptance verified across all 4 items: `beforeEach` reset + bounded-poll `fetchSettledAuditRows`, warmup drop, symbol-based test-name ref (signup-verify.ts:146 → `/resume-signup` handler + runWithArgon2Slot), and try/catch error wrap on seed INSERTs with descriptive re-throw. 14/14 vitest pass against real Postgres + Redis. User-triaged 2026-05-18; one one-word fix held, several findings dismissed below.

### Items held (must fix before archive)

1. **(P3 testing, anchor 90)** Stale comment value at `backend/tests/routes/custody-upgrade-null-hash.test.ts:117`. The `beforeEach` rationale comment reads "Without this beforeEach, vitest.config.ts's `retry: 1` means a retried `it` sees the audit-log row from attempt #1...". The actual `vitest.config.ts` value is `retry: 3`. The fix is correct under any retry count; the stale number misleads a future reader diagnosing a flake who checks the config to verify the rationale. One-word fix: `retry: 1` → `retry: 3`.

### Items dismissed during architect triage (recorded for transparency)

- (P1 kieran-typescript, anchor 90) `(err as Error).message` casts at lines 136, 160 — dismissed: test-only catch where `pool.query` always rejects with an `Error` subclass (pg driver); no pino serializer in play, no log payload affected. Same risk class as round-1 dismissal of `new Error(String(x))` "drops structured fields" in the sibling decrerr task at anchor 30. The canonical narrowing convention's load-bearing property (pino's serializer needs an Error instance) doesn't apply at this test-only re-throw site.
- (P2 reliability R1, anchor 75) `fetchSettledAuditRows` 100ms settle / 1.5s poll heuristic constants lack documented rationale — dismissed: test infrastructure heuristic, failure mode is theoretical-only (compound condition: real production double-log AND second INSERT >100ms). Per `feedback_dismiss_preemptive_test_hardening`; tune if CI flakes.
- (P2 kieran-typescript KT-2, anchor 60) Hand-rolled structural type for `pool` parameter in `fetchSettledAuditRows` — dismissed below confidence gate; same risk class as `any` in test mocks already endorsed by the `## Typecheck` section in `agents/backend/CLAUDE.md`.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. Round-5 architect re-review scopes `/ce-code-review` to the round-4 commit. Anchor: one-word change at one location. Trivial single commit.

---

## [BLOCKED by Architect] (2026-05-18, backend startup intake)

Round-4 hold item 1 prescribes a one-word comment fix at `backend/tests/routes/custody-upgrade-null-hash.test.ts:117` (the `vitest.config.ts` retry-count value mentioned in the `beforeEach` rationale comment: `retry: 1` → `retry: 3`).

The cited file no longer exists at HEAD. Commit `1f1be4e` (`backend(custody-upgrade-seed-phrase-reauth): replace password re-auth with seed-phrase-derived pubkey + signed-challenge proof`, 2026-05-16) deleted `backend/tests/routes/custody-upgrade-null-hash.test.ts` along with `custody-upgrade-argon-error-translation.test.ts` and the `custody.upgrade.null_hash_unreachable` log-shape test inside `custody.test.ts`. The deletion is correct on its own scope: `POST /api/custody/upgrade` no longer accepts a `password` body field, so the password-hash null-guard branch the test was fencing no longer exists in production.

The round-4 hold's other items were all dismissed at architect triage (recorded above). Items 2-3 were the typescript-cast / heuristic-rationale dismissals that explicitly did NOT require action. So the entire round-4 hold reduces to the one-word fix at a deleted file.

Backend cannot land the held item. The fix target is gone; the production branch the test was fencing is gone. Per `agents/backend/CLAUDE.md` "Boundaries", this contradicts the task description and the right move is to surface the conflict to the architect rather than guess.

**Architect decision needed:** either

- (a) **Archive directly.** The round-4 hold's only actionable item is moot; the production scope this task closed (5 SQL-generic widenings, canonical hoist + comment, custody-upgrade null-guard + burnSentinel timing-equalization, cross-ref polish, beforeEach reset + bounded-poll pattern at the now-deleted test) all landed across rounds 1-3 and survived past the seed-phrase-reauth migration on the parts that weren't password-specific. Archive the task with a brief note that round-4's item 1 was made moot by the seed-phrase-reauth migration.

- (b) **Re-scope the held item.** If the architect wants the analogous `retry: 1` → `retry: 3` comment-value drift fix landed somewhere else that inherited the pattern (e.g., a different test file's `beforeEach` rationale comment that copy-pasted the stale retry-count value), name that file in a new round-4 hold-item-1 replacement and move the task back to `pending/`. Filed `agents/docs/tasks/pending/backend-recover-test-retry-self-poisoning-fix.md` is the natural inheritor of the convention; if its `beforeEach` rationale comment lands with the same `retry: 1` typo, the inheritor task picks up the fix there.

- (c) **Some other disposition** the architect wants.

Backend is parking the task in `blocked/` rather than `review/` because there is no positive signal of completion to re-review against — the held item never landed and never can. Architect signal needed before this task can move forward in any direction.

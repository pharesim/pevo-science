---
title: "Wrapping-primitive adoption must be verified by grep, not mental audit; null-path types must permit null where null is possible"
date: 2026-04-22
category: conventions
module: backend/src/routes
problem_type: convention
component: authentication
severity: high
applies_when:
  - "Introducing a new wrapping primitive (semaphore, lock, helper, decorator) through which every call site of an underlying class must pass"
  - "Claiming 'all X calls are wrapped' or 'all Y paths are equalized' as an acceptance criterion"
  - "Reviewing a task whose acceptance contains a grep-verifiable universal-coverage claim"
  - "Adding a TypeScript SQL result type for a column that is nullable in the database schema or left unset by any documented account type (ORCID-only, passwordless, unverified, locked)"
  - "An implementer lists affected call sites in the signal block without having run a grep to back it"
  - "A new endpoint or route is added after a wrapper primitive is established — check whether it calls the underlying library directly"
  - "Re-reviewing a hold-block fix whose invariant is 'all call sites now go through the wrapper'"
related_components:
  - development_workflow
  - testing_framework
tags:
  - wrapping-primitive
  - call-site-audit
  - semaphore
  - concurrency
  - null-type
  - sql-result-type
  - authentication
  - argon2
  - partial-fix
  - security-fix-review
  - code-review
---

# Wrapping-primitive adoption must be verified by grep, not mental audit; null-path types must permit null where null is possible

## Context

PEvO commit `3e6f093` (BE-ARGON2-JSLEVEL-CONCURRENCY-CAP) introduced `runWithArgon2Slot(fn)` in `backend/src/lib/argon2-semaphore.ts` — a JS-level semaphore capping concurrent argon2 operations to prevent libuv thread-pool saturation from reopening the timing oracle that `burnSentinel` was designed to close. The task's implementer signal explicitly listed ten wrapped sites across `backend/src/routes/auth.ts`, `signup-verify.ts`, and `custody.ts`. The stated acceptance criterion was: "Semaphore wraps every `argon2.hash(...)` / `argon2.verify(...)` call on auth paths." Two independent reviewers caught the miss during `/ce-code-review`: `backend/src/routes/settings.ts:384` calls `argon2.hash(password, ARGON2_OPTIONS)` directly. The file never imports `runWithArgon2Slot`. The endpoint is `/api/settings/set-password`, an authenticated auth path. The attack path is concrete: hold 4 semaphore slots via concurrent `/login` unknown-user attempts, then issue a 5th concurrent authenticated set-password call that bypasses the semaphore entirely, driving total concurrent argon2 ops to 5 and saturating the libuv pool. `burnSentinel` catches and swallows the resulting throw, reopening the timing oracle the semaphore was introduced to close. The miss was invisible because the audit was mental rather than a grep of the raw class.

PEvO commit `e627dcf` (BE-AUTH-RESUME-SIGNUP-TIMING-GUARD) added `burnSentinel` on two early-return branches of `/api/auth/resume-signup` in `backend/src/routes/signup-verify.ts` (lines 113-115 and 124-126) to equalize wall-time against the happy-path `argon2.verify`. The SQL result type at line 99-102 declared `password_hash: string` (non-nullable). An ORCID-only account in confirmed signup state has `password_hash = NULL` in the database and `verify_token LIKE 'confirmed:%'`. That account passes both burn guards — "unknown email" at line 108 and "non-confirmed state" at line 124 — and reaches `argon2.verify(account.password_hash, password)` at line 130. Because `password_hash` is `NULL` at runtime despite the TypeScript annotation, `argon2.verify(null, password)` throws a `TypeError` synchronously. The error bubbles to the catch block at line 143 and returns HTTP 500 `INTERNAL_ERROR` in approximately 0ms. An attacker probing `/resume-signup` can distinguish ORCID-only accounts in confirmed state (distinctive ~0ms 500) from all other branches (~50ms via `burnSentinel`). The null path was invisible because the TypeScript annotation declared non-nullable, and the mental model "confirmed state implies email verified AND password set" did not account for ORCID-only accounts.

## Guidance

**When a task introduces a wrapping primitive through which every call site of a class must pass, acceptance verification must begin with a grep — never a mental enumeration.** The implementer producing a list of wrapped sites from memory reliably covers the files actively worked on and misses files that incidentally call the same underlying library. After introducing a primitive like `runWithArgon2Slot`, run two greps and compare:

```bash
# Step 1: find every direct call to the class being wrapped across all source files.
# The wrapper file itself is a known exception; every other hit is a candidate miss.
grep -rn "argon2\.hash\|argon2\.verify" backend/src/ --include="*.ts"

# Step 2: find every file that imports the wrapper
grep -rln "runWithArgon2Slot" backend/src/ --include="*.ts"
```

Any file appearing in step 1 but not step 2 (excluding the wrapper's own implementation file) is an unwrapped call site. At the time of the settings.ts miss, this two-grep comparison would have immediately surfaced `settings.ts:384`: it imports `argon2` and `ARGON2_OPTIONS` but has no `runWithArgon2Slot` import and no wrapping call. The grep takes seconds; the mental audit missed the site entirely. The corresponding rule for reviewers: a task whose acceptance contains a universal-coverage claim ("wraps every X") must run the grep during `/ce-code-review`; the implementer's signal block listing sites is a claim that needs verification, not evidence.

**TypeScript SQL result type annotations must permit `null` (as `string | null`) for every column that can be `NULL` in the database or that any documented application state would leave unset.** When a type annotation declares a column non-nullable, the TypeScript compiler accepts downstream code that treats the value as always-present — including passing it directly to a function that throws on `null`. The symptom appears at runtime as an uncaught `TypeError`, not a type error, because the annotation lied. Before accepting a type annotation as non-nullable, verify the column's database-level constraint (`NOT NULL`) and cross-reference against every documented account type and lifecycle state. ORCID-only accounts are a permanent fixture of PEvO's account model; any column that ORCID-only accounts leave unset is nullable in practice regardless of what any particular code path assumes:

```ts
// Wrong: declares non-nullable, but ORCID-only accounts have password_hash = NULL
const { rows } = await pool.query<{
  id: number;
  password_hash: string;        // false; crashes with TypeError on ORCID-only accounts
  verify_token: string | null;
}>('SELECT id, password_hash, verify_token FROM accounts WHERE email = $1', [normalizedEmail]);
// argon2.verify(null, password) throws TypeError at runtime. No compile-time error.

// Correct: annotate nullable, then guard explicitly or use the sentinel-fallback pattern
const { rows } = await pool.query<{
  id: number;
  password_hash: string | null;  // honest; compiler forces handling at the call site
  verify_token: string | null;
}>('SELECT id, password_hash, verify_token FROM accounts WHERE email = $1', [normalizedEmail]);

// Now argon2.verify(account.password_hash, password) is a compile error unless guarded.
// Use the sentinel-fallback pattern from timing-equalization-sub-branch-oracles-2026-04-21.md:
const sentinelHash = await SENTINEL_ARGON2_HASH_PROMISE;
const passwordValid = await runWithArgon2Slot(() =>
  argon2.verify(account.password_hash ?? sentinelHash, password)
).catch(() => false);
```

**When the two patterns interact — a wrapper primitive with a type-obscured null path — the null path bypasses the wrapper's invariant entirely.** The `settings.ts` miss was a call-site audit failure. The `resume-signup` null-hash case was a type annotation failure that hid a sub-branch from the timing-equalization audit. Neither is a subtype of the other. Both share the same root mechanism: an invariant ("all argon2 calls go through the semaphore"; "all known-account branches pay argon2 time") was accepted as true without mechanically verifying it against every code path.

## Why This Matters

In the `settings.ts` case, the invariant failure has a concrete attack path. The semaphore exists specifically to prevent libuv thread-pool saturation from reopening the timing oracle. A single unwrapped `argon2.hash` call on an authenticated auth endpoint undermines the invariant: an attacker holding 4 semaphore slots can drive a 5th concurrent argon2 op through the unguarded path, saturate the pool, and observe the oracle reopen via `burnSentinel`'s silent-catch behavior. The code comment inserted by the semaphore task ("semaphore wraps every argon2 op on auth paths") becomes a false attestation that actively discourages future scrutiny.

In the `resume-signup` case, the null-hash `TypeError` produces a ~0ms HTTP 500 response distinguishable from every other branch (~50ms via `burnSentinel`). The fix specifically closed user-enumeration timing oracles on the endpoint. The null path re-opens an enumeration oracle for ORCID-only accounts in confirmed signup state — a real account class, not a theoretical edge. The oracle is of the same class the task was filed to close. A non-nullable type annotation was the sole reason the null path was invisible during review.

In both cases, false security claims derived from incomplete audits are more dangerous than acknowledged gaps, because they terminate future scrutiny.

## When to Apply

1. Any task or PR introduces a new primitive wrapper (semaphore, lock, rate-limiter, helper, decorator) through which every call site of an underlying library or class must pass: grep the raw library/class across ALL source files and compare against the wrapper's import sites before declaring adoption complete.
2. Any task acceptance criterion includes a statement of the form "all X calls now go through Y" or "every X is wrapped by Y": mechanically verify the claim by grep before accepting. Statements made by the implementer in the signal are not evidence; they are claims that need verification.
3. Any TypeScript SQL result type annotation for a column that is nullable in the database schema or that any documented account type (ORCID-only, passwordless, unverified, locked) would leave NULL: annotate the type as `string | null` (or the appropriate nullable form) and let the compiler enforce handling.
4. Any endpoint that calls a wrapped library function directly (without the wrapper import appearing in the file): treat this as a candidate missed call site, not as evidence the wrapper is unnecessary for that endpoint.
5. Any security fix that claims to "wrap all X calls" or "equalize all Y paths" is landed: run `grep -rn` for the unwrapped form before the fix ships. If the fix is already merged, run the grep during review and file a follow-up task for any missed sites found.
6. Any new file or route added after a wrapping primitive is established in the codebase: check whether the new file calls the underlying library directly, regardless of whether the file's author was aware of the wrapper.
7. Any hold-block or re-review cycle on a task whose invariant is "all call sites are wrapped": the re-review must include the grep, not just a re-read of the fix diff.

## Examples

### Case 1: `settings.ts` unwrapped `argon2.hash` (missed call site)

The semaphore was introduced in commit `3e6f093`. All call sites in `auth.ts`, `signup-verify.ts`, and `custody.ts` were wrapped. `settings.ts` was not in scope of the implementer's mental audit.

**Before (missed — `backend/src/routes/settings.ts:384`, `runWithArgon2Slot` never imported):**

```ts
// backend/src/routes/settings.ts:1-14 (imports)
import argon2 from 'argon2';
// ... no import of runWithArgon2Slot ...
import { ARGON2_OPTIONS } from '../lib/argon2-options.js';

// backend/src/routes/settings.ts:384 (POST /api/settings/set-password)
const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);
// Direct argon2.hash call bypasses the semaphore entirely.
// An attacker holding 4 semaphore slots via /login can drive this
// as a 5th concurrent op, saturating the libuv pool.
```

**After (correct — wrap via `runWithArgon2Slot`, add the import):**

```ts
// backend/src/routes/settings.ts:1-15 (imports)
import argon2 from 'argon2';
import { runWithArgon2Slot } from '../lib/argon2-semaphore.js';
import { ARGON2_OPTIONS } from '../lib/argon2-options.js';

// backend/src/routes/settings.ts:384
const passwordHash = await runWithArgon2Slot(() => argon2.hash(password, ARGON2_OPTIONS));
```

**The grep that would have caught it before ship:**

```bash
# Step 1: find every direct argon2.hash / argon2.verify call
grep -rn "argon2\.hash\|argon2\.verify" backend/src/ --include="*.ts"
# Output includes: backend/src/routes/settings.ts:384

# Step 2: find every file that imports the wrapper
grep -rln "runWithArgon2Slot" backend/src/ --include="*.ts"
# Output does NOT include settings.ts → miss is immediately visible
```

### Case 2: `resume-signup` null-hash timing oracle (type annotation hiding a null path)

The `burnSentinel` guards at lines 113-115 and 124-126 in `signup-verify.ts` correctly block the "unknown email" and "non-confirmed state" branches. The confirmed-state branch at line 130 reaches `argon2.verify` — but for an ORCID-only account, `password_hash` is `NULL` at runtime despite the `string` annotation. The TypeScript compiler accepted the code because the annotation lied.

**Before (wrong type annotation obscures null path — `backend/src/routes/signup-verify.ts:99-102`):**

```ts
const { rows } = await pool.query<{
  id: number;
  password_hash: string;       // non-nullable annotation; compiler sees no problem
  verify_token: string | null;
}>(
  'SELECT id, password_hash, verify_token FROM accounts WHERE email = $1',
  [normalizedEmail],
);

// ... both burn guards pass for an ORCID-only account in confirmed state ...

// signup-verify.ts:130 — runtime: account.password_hash is null
const passwordValid = await runWithArgon2Slot(() =>
  argon2.verify(account.password_hash, password)  // TypeError: null passed to argon2.verify
);
// TypeError propagates to catch at line 143 → 500 INTERNAL_ERROR in ~0ms.
// ~0ms 500 is distinguishable from ~50ms burnSentinel branches → enumeration oracle.
```

**After (correct annotation forces the compiler to surface the null case):**

```ts
const { rows } = await pool.query<{
  id: number;
  password_hash: string | null;  // honest; matches database + ORCID-only reality
  verify_token: string | null;
}>(
  'SELECT id, password_hash, verify_token FROM accounts WHERE email = $1',
  [normalizedEmail],
);

// Now account.password_hash has type string | null.
// The compiler rejects argon2.verify(account.password_hash, password) directly.
// Use the sentinel-fallback pattern to handle null-hash without short-circuiting:

const sentinelHash = await SENTINEL_ARGON2_HASH_PROMISE;
const passwordValid = await runWithArgon2Slot(() =>
  argon2.verify(account.password_hash ?? sentinelHash, password)
).catch(() => false);
// ORCID-only accounts now pay ~50ms (argon2.verify against sentinel) instead of ~0ms TypeError.
// No sub-branch is cheap relative to the burnSentinel branches above.
```

**The annotation check that would have caught it:**

```bash
# Grep for password_hash column reads without the | null annotation
grep -n "password_hash: string[^|]" backend/src/routes/signup-verify.ts
# Output: signup-verify.ts:101  password_hash: string;
# Flag for manual cross-reference: does any account type leave this column NULL?
# Answer: ORCID-only accounts → annotation is wrong → fix before ship.
```

## Related

- [object-shape-fix-every-reset-site-2026-04-21.md](object-shape-fix-every-reset-site-2026-04-21.md) — closest structural cousin. That doc addresses the same "fix covered the reported site but not sibling sites" meta-pattern applied to Alpine component state resets: grep every assignment site of the shared object, not just the bug-manifestation site. This doc addresses the same audit-completeness failure for wrapping primitives (grep every call site of the class being wrapped) and for nullable type annotations (annotate every column accurately). Both docs are instances of the same underlying failure mode: accepting an invariant claim without mechanically verifying it across the full code surface.
- [timing-equalization-sub-branch-oracles-2026-04-21.md](timing-equalization-sub-branch-oracles-2026-04-21.md) — directly complementary on the null-hash axis. That doc's rule is: enumerate every sub-branch of the equalized target that can short-circuit the expensive work. This doc's null-hash case (`resume-signup` ORCID-only account passing `null` to `argon2.verify`) is one concrete instance of that rule: the null-hash sub-branch skipped the expensive work entirely via a runtime TypeError. The annotation fix (annotating `password_hash: string | null`) is the prerequisite that makes the sub-branch visible to both the compiler and to a reviewer applying the sub-branch enumeration checklist.
- [verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md](verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md) — sibling lesson from the same semaphore task. That doc captures the arithmetic-chain verification rule ("`UV_THREADPOOL_SIZE=16` gives ~4 concurrent argon2 ops, not 16"). This doc captures the call-site coverage rule. Both are necessary for the semaphore's invariant to hold; neither is sufficient alone.
- [tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md](tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md) — complementary check on the test-infrastructure side. The semaphore task also shipped with a concurrency test whose mutation-kill claim held only under production env (`UV_THREADPOOL_SIZE=16`) but not under Vitest (fallback `MAX_CONCURRENT_ARGON2_OPS=1`). Missed call sites and vacuous mutation tests are two sides of the same coin: the code-under-test and the test-that-verifies-it both need to be audited against the invariant they claim to enforce.

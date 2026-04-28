---
title: "Wrapping-primitive adoption must be verified by grep, not mental audit; null-path types must permit null where null is possible; error-class propagation is a cross-product audit"
date: 2026-04-22
last_updated: 2026-04-28
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
  - "A wrapping primitive can throw multiple distinct error classes (e.g. queue-full, shutting-down, abort) that must each be propagated by handler code"
  - "A new error class is added to a wrapped primitive — every call site that previously handled prior classes must be re-audited for the new class at every syntactic shape (try/catch, inline .catch(), helper function)"
  - "Wrapped call sites use mixed syntactic shapes — try/catch AND inline .catch() — across the same codebase; helper-centralized translation does not propagate to inline .catch() sites"
  - "An implementer's signal block selectively rethrows a subset of required error classes, leaving sibling classes silently swallowed"
  - "A swallow-on-failure rationale invokes the fix's own purpose (e.g. 'preserved for timing equalization') to justify dropping a structured error class that signals the same failure mode the fix exists to close"
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
  - error-class-rethrow
  - cross-product-audit
  - multi-error-class
  - inline-catch
  - rationale-laundering
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

**When the wrapping primitive can throw multiple distinct error classes, the audit acquires a second axis: error-class propagation.** Adoption verification proves every call site routes through the wrapper. Cross-product verification proves every call site correctly propagates every error class the wrapper can throw. With N error classes and M syntactic shapes (try/catch, inline `.catch()`, helper-function calls), there are N × M cells in the propagation matrix. Adding error classes incrementally — one per task, each task reviewed in isolation — implicitly treats the matrix as N rows reviewed independently, leaving cells in older sites unverified for newer classes. The structural failure mode: an inline `.catch()` block correctly rethrows the most-recently-added error class (proving the implementer was aware of the site) but still swallows N-1 prior classes that nobody re-checked when those earlier classes were added. The cross-product rule: when a new error class is added to a wrapped primitive, audit every site that handles prior error classes — at every syntactic shape — for correct propagation of the new class. Helper-function updates (e.g., centralizing translation in `handleArgonQueueFull`) do not reach inline `.catch()` sites; each `.catch()` is an independent cell.

```bash
# Step 3 (new): for each call site of the wrapper, verify every exported error
# class is correctly propagated. Run after the two-grep adoption check.
grep -rn "runWithArgon2Slot" backend/src/ --include="*.ts"
# For each hit, identify the syntactic shape (try/catch, inline .catch(), helper call).
# For inline .catch() shapes specifically, extract the rethrow guard and confirm it
# covers ALL currently-exported error classes from the wrapper, not just the latest.
grep -nA3 "runWithArgon2Slot.*\.catch\|\.catch.*runWithArgon2Slot" backend/src/ -r --include="*.ts"
# A guard like `if (err instanceof ArgonAbortError) throw err;` covering only the
# newest class is an incomplete cell — needs all three classes (or the appropriate
# union) before the swallow path is safe.
```

## Why This Matters

In the `settings.ts` case, the invariant failure has a concrete attack path. The semaphore exists specifically to prevent libuv thread-pool saturation from reopening the timing oracle. A single unwrapped `argon2.hash` call on an authenticated auth endpoint undermines the invariant: an attacker holding 4 semaphore slots can drive a 5th concurrent argon2 op through the unguarded path, saturate the pool, and observe the oracle reopen via `burnSentinel`'s silent-catch behavior. The code comment inserted by the semaphore task ("semaphore wraps every argon2 op on auth paths") becomes a false attestation that actively discourages future scrutiny.

In the `resume-signup` case, the null-hash `TypeError` produces a ~0ms HTTP 500 response distinguishable from every other branch (~50ms via `burnSentinel`). The fix specifically closed user-enumeration timing oracles on the endpoint. The null path re-opens an enumeration oracle for ORCID-only accounts in confirmed signup state — a real account class, not a theoretical edge. The oracle is of the same class the task was filed to close. A non-nullable type annotation was the sole reason the null path was invisible during review.

In both cases, false security claims derived from incomplete audits are more dangerous than acknowledged gaps, because they terminate future scrutiny.

In the cross-product case (Case 3 below), the failure mode compounds across tasks: each task reviews its own new error class, each review passes, and the accumulated cells that were never cross-verified become a latent oracle. The implementer at `auth.ts:401, 407` selectively rethrew `ArgonAbortError` (the most-recently-added class) — proving site awareness — but left `ArgonQueueFullError` and `ShuttingDownError` swallowed. Under saturation or shutdown, the dup-burn returns 409 in ~0ms while the parallel non-dup path returns 503 in ~0ms via `handleArgonQueueFull`. Two oracles compound: a status-code differential (409 vs 503) directly leaks email existence; a saturation-timing differential (~0ms saturated vs ~100ms non-saturated) leaks saturation state. The semaphore's entire purpose — closing libuv saturation timing oracles — is undermined by a new oracle one syntactic level up. Rationales like "preserved swallow for timing-oracle equalization" must be challenged at review time when the failure mode the swallow creates is the same class of failure the wrapper was built to prevent.

## When to Apply

1. Any task or PR introduces a new primitive wrapper (semaphore, lock, rate-limiter, helper, decorator) through which every call site of an underlying library or class must pass: grep the raw library/class across ALL source files and compare against the wrapper's import sites before declaring adoption complete.
2. Any task acceptance criterion includes a statement of the form "all X calls now go through Y" or "every X is wrapped by Y": mechanically verify the claim by grep before accepting. Statements made by the implementer in the signal are not evidence; they are claims that need verification.
3. Any TypeScript SQL result type annotation for a column that is nullable in the database schema or that any documented account type (ORCID-only, passwordless, unverified, locked) would leave NULL: annotate the type as `string | null` (or the appropriate nullable form) and let the compiler enforce handling.
4. Any endpoint that calls a wrapped library function directly (without the wrapper import appearing in the file): treat this as a candidate missed call site, not as evidence the wrapper is unnecessary for that endpoint.
5. Any security fix that claims to "wrap all X calls" or "equalize all Y paths" is landed: run `grep -rn` for the unwrapped form before the fix ships. If the fix is already merged, run the grep during review and file a follow-up task for any missed sites found.
6. Any new file or route added after a wrapping primitive is established in the codebase: check whether the new file calls the underlying library directly, regardless of whether the file's author was aware of the wrapper.
7. Any hold-block or re-review cycle on a task whose invariant is "all call sites are wrapped": the re-review must include the grep, not just a re-read of the fix diff.
8. Any new error class is added to a wrapping primitive (export, rename, or behavior change of an existing class): treat as a mandatory cross-product audit trigger. Grep every existing call site of the wrapper across all syntactic shapes (try/catch, inline `.catch()`, helper-function calls) and confirm the new class is correctly propagated at each. The implementer's signal block listing sites is a claim, not verification. Helper-function updates do NOT reach inline `.catch()` sites; each `.catch()` is an independent cell.
9. Any cross-task incremental error-class addition where N > 1 distinct error classes have been added across separate tasks: the cumulative state has N × (#sites) cells. Per-task review verified only the diagonal (each task's own new class). At any point N > 1, run the full cross-product audit, not just the new row.
10. Any review-time rationale that justifies swallowing a structured error class by invoking the fix's own purpose (e.g., "preserved swallow for timing equalization", "preserved swallow for clean shutdown"): challenge the rationale. Distinguish between native crashes (often legitimate to swallow as best-effort) and structured error classes that the wrapping primitive declares as control-flow signals (almost never legitimate to swallow at the wrapper-consumer layer — they exist precisely to be propagated). When the failure mode the swallow creates is the same class of failure the wrapper was built to prevent, the rationale is laundered.

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

### Case 3: argon2 dup-burn `.catch()` sites swallow N-1 of N error classes (cross-product audit gap)

`auth.ts:401, 407` — two inline `.catch()` chains on the `/signup` 409 dup-email burn paths. Each `.catch()` is a Shape C site (inline callback, not function-level try/catch and not routed through `handleArgonQueueFull`). Three distinct error classes were added to `runWithArgon2Slot` across three separate tasks:

- `ArgonQueueFullError` — added by `BE-ARGON2-JSLEVEL-CONCURRENCY-CAP` round-2 (commit `e7f0285`). The round-2 hold block fixed `burnSentinel` to rethrow this class but did not touch the inline `.catch()` blocks at lines 401, 407.
- `ShuttingDownError` — added by `BE-ARGON2-SEMAPHORE-SHUTDOWN-DRAIN` (commit `66f010f`). The implementer's signal block explicitly stated "preserved the existing silent-swallow-and-log on the 409 dup-signup burn paths (auth.ts:401, 407). Those swallow ArgonQueueFullError today for timing-oracle equalization, and they continue to swallow ShuttingDownError for the same reason — the handler still returns a fast, clean 409 rather than hanging."
- `ArgonAbortError` — added by `BE-ARGON2-SEMAPHORE-ABORT-SIGNAL` (commit `3dcc30d`). This task selectively added `if (err instanceof ArgonAbortError) throw err;` to both `.catch()` blocks at 401, 407 — proving the implementer was aware of the sites but only fixed the one error class their task introduced.

Cumulative state at the cluster's HEAD (commit `3dcc30d`): the `.catch()` rethrew only `ArgonAbortError`. `ArgonQueueFullError` and `ShuttingDownError` were still silently swallowed. Cluster `/ce-code-review` on 2026-04-28 surfaced this with 4-reviewer convergence (correctness 0.97, security 0.95, reliability 0.92, adversarial 0.92). The architect held all three cluster tasks pending the round-3 fix.

**Before round-3 fix (`auth.ts:401`, after `BE-ARGON2-SEMAPHORE-ABORT-SIGNAL` landed):**

```ts
// auth.ts:401 — verify_token IS NULL branch (account exists, fully verified)
if (password) await runWithArgon2Slot(
  () => argon2.hash(password, ARGON2_OPTIONS),
  { signal: abortSignal }
).catch((err) => {
  if (err instanceof ArgonAbortError) throw err;
  // ArgonQueueFullError ← SWALLOWED. Round-2 fixed burnSentinel, missed this .catch().
  // ShuttingDownError   ← SWALLOWED. Shutdown-drain task explicitly "preserved" the swallow.
  logger.warn({ err }, 'argon2 signup-dup burn failed — timing oracle may be open');
});
return sendError(res, 409, 'DUPLICATE', 'Email already registered');
// Under saturation: this 409 returns in ~0ms (burn skipped via swallow).
// Under non-saturation: this 409 returns in ~100ms (argon2.hash completes — equalized vs new-signup).
// Under saturation, the parallel non-dup path hits handleArgonQueueFull → 503 in ~0ms.
// Attacker observes: 409 = email registered; 503 = email novel. Direct enumeration oracle.
// AND: same dup email under non-saturation = ~100ms 409; under saturation = ~0ms 409 — saturation oracle.
```

**After round-3 fix (extend the rethrow guard to all three semaphore error classes):**

```ts
// auth.ts:401 — round-3 fix
if (password) await runWithArgon2Slot(
  () => argon2.hash(password, ARGON2_OPTIONS),
  { signal: abortSignal }
).catch((err) => {
  if (
    err instanceof ArgonAbortError ||
    err instanceof ArgonQueueFullError ||
    err instanceof ShuttingDownError
  ) throw err;
  // Only genuine non-semaphore argon2 native failures stay swallowed. Those don't
  // create a status-code differential (a native crash on the dup path lets the 409
  // proceed; a native crash on the happy path also propagates to the outer catch).
  logger.warn({ err }, 'argon2 signup-dup burn failed — non-semaphore failure mode');
});
return sendError(res, 409, 'DUPLICATE', 'Email already registered');
// Under saturation: ArgonQueueFullError propagates to the outer catch's
// handleArgonQueueFull → 503. Both dup and non-dup return 503. No status-code differential.
// Non-saturated equalization preserved (~100ms argon2.hash still pays on the dup path).
```

**The grep that would have caught the gap during the abort-signal task's review:**

```bash
# Find every inline .catch() chained onto runWithArgon2Slot
grep -nA3 "runWithArgon2Slot.*\.catch\|\.catch.*runWithArgon2Slot" backend/src/routes/auth.ts
# Output includes auth.ts:399-403 and auth.ts:405-409.
# For each .catch() block, extract the rethrow guard. If the guard names only
# the newest error class added by this task, that's an incomplete cell — the
# guard must enumerate every error class currently exported by argon2-semaphore.ts.

# Cross-check: list all error classes exported by the wrapping primitive
grep -E "^export class .*Error" backend/src/lib/argon2-semaphore.ts
# Output: ArgonQueueFullError, ShuttingDownError, ArgonAbortError.
# Compare against each .catch() block's rethrow guard. Missing class = oracle.
```

**Why the implementer's "timing-equalization" rationale was wrong.** The dup-burn pays argon2.hash time on the dup path SO THAT the dup branch matches the new-signup branch's wall-time on the non-saturated path — closing the timing oracle that would otherwise distinguish dup from new by latency. Under saturation or shutdown, both branches fail fast anyway (the new-signup hash also throws ArgonQueueFullError → 503 in ~0ms via handleArgonQueueFull). Equalization on the saturated path is automatic; the swallow doesn't preserve it, it ADDS a status-code differential (409 vs 503) that becomes a new enumeration oracle on top of the saturation timing oracle the swallow tries to mask. The rationale conflated two distinct goals: "preserve cost equalization for native argon2 crashes" (legitimate — those are non-semaphore failures with no status-code differential) versus "preserve swallow for the wrapping primitive's structured error classes" (illegitimate — those exist precisely to be propagated, and propagating them through the outer catch produces uniform 503s across both branches). When the rationale invoked the fix's own purpose ("equalization") to justify swallowing the errors that signal the failure mode the fix exists to close, the rationale was laundered.

## Related

- [object-shape-fix-every-reset-site-2026-04-21.md](object-shape-fix-every-reset-site-2026-04-21.md) — closest structural cousin. That doc addresses the same "fix covered the reported site but not sibling sites" meta-pattern applied to Alpine component state resets: grep every assignment site of the shared object, not just the bug-manifestation site. This doc addresses the same audit-completeness failure for wrapping primitives (grep every call site of the class being wrapped) and for nullable type annotations (annotate every column accurately). Both docs are instances of the same underlying failure mode: accepting an invariant claim without mechanically verifying it across the full code surface.
- [timing-equalization-sub-branch-oracles-2026-04-21.md](timing-equalization-sub-branch-oracles-2026-04-21.md) — directly complementary on the null-hash axis. That doc's rule is: enumerate every sub-branch of the equalized target that can short-circuit the expensive work. This doc's null-hash case (`resume-signup` ORCID-only account passing `null` to `argon2.verify`) is one concrete instance of that rule: the null-hash sub-branch skipped the expensive work entirely via a runtime TypeError. The annotation fix (annotating `password_hash: string | null`) is the prerequisite that makes the sub-branch visible to both the compiler and to a reviewer applying the sub-branch enumeration checklist.
- [verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md](verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md) — sibling lesson from the same semaphore task. That doc captures the arithmetic-chain verification rule ("`UV_THREADPOOL_SIZE=16` gives ~4 concurrent argon2 ops, not 16"). This doc captures the call-site coverage rule. Both are necessary for the semaphore's invariant to hold; neither is sufficient alone.
- [tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md](tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md) — complementary check on the test-infrastructure side. The semaphore task also shipped with a concurrency test whose mutation-kill claim held only under production env (`UV_THREADPOOL_SIZE=16`) but not under Vitest (fallback `MAX_CONCURRENT_ARGON2_OPS=1`). Missed call sites and vacuous mutation tests are two sides of the same coin: the code-under-test and the test-that-verifies-it both need to be audited against the invariant they claim to enforce.

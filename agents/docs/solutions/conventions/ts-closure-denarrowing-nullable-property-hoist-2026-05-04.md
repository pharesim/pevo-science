---
title: "TypeScript de-narrows nullable properties at closure boundaries — hoist to a const local before capture"
date: 2026-05-04
category: conventions
module: backend/src/routes
problem_type: convention
component: authentication
severity: high
applies_when:
  - A TypeScript property's static type is nullable (e.g., `string | null`)
  - A control-flow guard above the closure proves the property non-null at runtime
  - The consumer of the property is inside a closure (lambda, callback, or async arrow)
  - The closure captures the parent object by reference, not a destructured copy
  - The property could theoretically be reassigned between the guard and the capture point
  - "TS strict mode (5.x) is in effect and the nullable type is derived from a Postgres column without NOT NULL"
  - The non-null assertion (`!`) was previously used as a workaround
related_components:
  - development_workflow
  - database
tags:
  - typescript
  - type-narrowing
  - closure-boundary
  - nullable-property
  - hoist-pattern
  - password-hash
  - sql-result-types
---

# TypeScript de-narrows nullable properties at closure boundaries — hoist to a const local before capture

## Context

TypeScript's control-flow analysis narrows nullable property types within a scope when guarded by an if-check. That narrowing does not survive a closure boundary. When code reads `account.password_hash` inside a callback (even a synchronous one), TS treats the property access as a fresh read on a mutable object reference and widens the type back to `string | null`, discarding the narrowing the if-guard established in the outer scope.

This friction surfaced concretely during the `backend-password-hash-null-typing-audit` task (commit `aa32eca`, 2026-04-29), which widened four SQL result type generics from `password_hash: string` to `password_hash: string | null` to match the actual schema constraint (no `NOT NULL` — ORCID-only accounts legitimately have null). The correct widening immediately produced TS errors inside `runWithArgon2Slot(() => argon2.verify(account.password_hash, password), ...)` closures that had previously compiled because the type was falsely non-nullable. The round-2 hold-block on that task (2026-05-04) identified that the initial canonical comment lacked the three required preconditions, which risked cargo-cult application of the hoist pattern at sites where it adds no value.

## Guidance

When a nullable property is guarded by a control-flow check and then consumed inside a closure, hoist the narrowed value to a `const` local before the closure. The local binding is an invariant that TS narrows once at assignment and never widens; the closure captures the local, not the property.

**Three required preconditions — all three must hold before applying the hoist:**

1. The property's static type is nullable (or otherwise union-typed and needs narrowing).
2. A control-flow guard above the hoist site proves the value non-null at runtime.
3. The consumer is inside a closure body that captures the parent object by reference, causing TS to lose the narrowing from the outer scope.

**Do NOT apply this pattern when:**

- The property type is already non-nullable. The hoist is noise.
- The consumer is in the same synchronous scope as the guard, not inside a closure. TS narrows correctly there and no hoist is needed.
- The null case and non-null case need the same response and a sentinel fallback is cleaner. In that situation prefer the `?? sentinelHash` shape from `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` Case 2.

```ts
// Canonical pattern
if (!account.password_hash) {
  return sendError(res, 403, 'NO_PASSWORD_SET', 'No password set on this account.');
}

// Precondition 1: password_hash: string | null (nullable type)
// Precondition 2: guard above proves non-null
// Precondition 3: consumer is inside a closure passed to runWithArgon2Slot

const passwordHash = account.password_hash;  // pinned as `string` by TS here
const valid = await runWithArgon2Slot(
  () => argon2.verify(passwordHash, password),  // `passwordHash: string` — no TS error
  { signal: abortSignal },
);
```

Canonical reference site: `backend/src/routes/signup-verify.ts:145` (/resume-signup handler). Additional applied sites: `backend/src/routes/auth.ts:625` (resend-verification, replaces a prior `account.password_hash!` non-null assertion), `backend/src/routes/auth.ts:807` (login), `backend/src/routes/custody.ts:232` (custody-upgrade).

## Why This Matters

**The TS narrowing-loss mechanic.** TypeScript's control-flow analysis tracks bindings, not arbitrary property accesses. When you write `if (!account.password_hash) { return; }`, TS narrows `account.password_hash` to `string` in the local scope. But when you pass a closure `() => account.password_hash` to another function, TS models the closure invocation as occurring at an indeterminate future time, during which `account.password_hash` may have been reassigned. TS conservatively widens it back to `string | null` inside the closure body. This applies to synchronous closures too — the boundary itself (not the async nature of the outer call) is what loses the narrowing.

**Alternative: `!` non-null assertion (`account.password_hash!`).** Compiles, but strictly worse. It bypasses the type system entirely. A future refactor that removes the if-guard — or changes the property semantics — silently compiles and shifts a type error into a runtime crash. The narrowing claim is invisible to reviewers and to TS itself.

**Alternative: `?? sentinelHash`.** Correct for monolithic consumers where the null and non-null paths produce the same observable shape (burn the sentinel, short-circuit the timing side-channel). Covered by `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` Case 2. Does not apply when the null branch returns a different HTTP status or response body — for example, the custody-upgrade null-guard at `custody.ts:223-227` returns 401 with a sentinel-burn on the null branch and runs `argon2.verify(passwordHash, password)` on the non-null branch. A `?? sentinelHash` there would conflate two distinct outcomes.

**The hoist: explicit, type-checked, safe.** The `const` local is narrowed exactly once, at assignment, with the full information available at that point in the outer scope. It never widens. It reads as a direct documentary claim: "this value was proven non-null by the guard above." Future contributors can see the narrowing reasoning without inspecting TS internals.

Cross-link: `correlated-options-discriminated-union-2026-04-28.md` — compile-time enforcement compounds. Hoisting a nullable property to a `const` local is the same class of "make the proof visible to TS" intervention as replacing correlated optional fields with a discriminated union. Both patterns trade implicit runtime assumptions for explicit type-system claims that future changes must satisfy.

## When to Apply

Apply the hoist pattern when ALL of the following are true:

1. **Nullable static type.** The property (or variable) has type `T | null`, `T | undefined`, or another union that requires narrowing before use.
2. **Above-guard proves non-null.** A control-flow check (if-return, if-throw, if-continue, or assert) has already established at the point of the hoist that the value is non-null.
3. **Closure boundary between guard and consumer.** The consumer reads the property inside a callback, arrow function, or any function literal passed to another function — even if that outer function is synchronous.
4. **Null and non-null cases require different responses.** If both cases could use a single expression (e.g., `?? sentinelHash`), prefer that shape from `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` Case 2 instead.
5. **The caller cannot be refactored to accept the narrowed value directly.** If the closure can be replaced by extracting a named function that takes `passwordHash: string` as a parameter, that is also acceptable and arguably more testable. The hoist is the minimal in-place fix.

**Do NOT apply when:**

- The property type is already `string` (non-nullable). Adding a hoist `const` is noise.
- The consumer is in the same synchronous scope as the guard with no closure involved. TS narrows correctly; the hoist is redundant.
- The same property appears in multiple independent closures in the same function. One hoist covers all of them — do not hoist once per closure.

## Examples

### Before (non-null assertion — incorrect)

```ts
// backend/src/routes/auth.ts (pre-aa32eca shape, with the false non-nullable type)
const { rows } = await pool.query<{
  password_hash: string;  // ← was falsely non-nullable; TS did not complain
}>(/* ... */);
const account = rows[0];

if (!account.password_hash) {
  return sendError(res, 403, 'NO_PASSWORD_SET', 'No password set.');
}

const valid = await runWithArgon2Slot(
  () => argon2.verify(account.password_hash!, password),  // !: bypasses TS
  { signal: abortSignal },
);
```

After widening to `string | null`, the `!` assertion still compiles but silences a real type claim. Removing the if-guard above does not produce a TS error. A regression that skips the guard is not caught until runtime.

### After (hoist — correct)

```ts
// backend/src/routes/signup-verify.ts:145 (/resume-signup handler — canonical site)
const { rows } = await pool.query<{
  password_hash: string | null;  // correct: ORCID-only accounts have null
}>(/* ... */);
const account = rows[0];

if (!account.password_hash) {
  // Precondition 1: type is string | null
  // Precondition 2: this guard proves non-null for all paths below
  return sendError(res, 403, 'NO_PASSWORD_SET', 'No password set on this account.');
}

// Precondition 3: consumer is inside a closure passed to runWithArgon2Slot —
// TS de-narrows account.password_hash at the closure boundary.
// Hoist to a const local so the narrowed type is pinned for the closure body.
const passwordHash = account.password_hash;  // string (narrowed at assignment)
const valid = await runWithArgon2Slot(
  () => argon2.verify(passwordHash, password),  // passwordHash: string — TS satisfied
  { signal: abortSignal },
);
```

### What TS reports if the hoist is dropped while the type is `string | null`

```
Argument of type 'string | null' is not assignable to parameter of type 'string'.
  Type 'null' is not assignable to type 'string'.
```

This error appears at the `argon2.verify(account.password_hash, ...)` call inside the closure. Adding `!` silences it; hoisting fixes it.

### Contrast: custody-upgrade null-guard (complementary case, not a sentinel-fallback candidate)

```ts
// backend/src/routes/custody.ts:223-232
if (!account.password_hash) {
  // Null and non-null branches produce different HTTP responses.
  // Cannot collapse to ?? sentinelHash — see wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md Case 2.
  await burnSentinel(password, abortSignal);
  logCustodyBroadcast(username, 'upgrade_failure').catch(() => {});
  return sendError(res, 401, 'UNAUTHORIZED', 'Invalid password');
}

const passwordHash = account.password_hash;  // hoist: pinned as string
const valid = await runWithArgon2Slot(
  () => argon2.verify(passwordHash, password),
  { signal: abortSignal },
);
```

The `?? sentinelHash` shape from `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` Case 2 collapses both branches into one expression — correct when the response shape is identical. Here the 401 response on the null branch diverges from the valid/invalid check on the non-null branch, so the hoist is the right fix and `?? sentinelHash` does not apply.

## Related

- `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` (Case 2) — sibling fix shape (`?? sentinelHash`) for the same nullable column at the same call site. Use that shape when the null branch must still run the expensive op for timing equalization; use the hoist when the null branch needs a different response.
- `timing-equalization-sub-branch-oracles-2026-04-21.md` — the hoist pattern preserves timing equalization on the non-null branch: the narrowed `const passwordHash` flows into `argon2.verify` on the live branch, and the null branch is handled by the guard above the closure (typically with a sentinel burn to keep wall-time matched). Cross-reference for reviewers applying the sub-branch enumeration checklist.
- `correlated-options-discriminated-union-2026-04-28.md` — meta-pattern: compile-time enforcement compounds; prose enforcement decays. The hoist-to-`const` pattern is a structural fix that makes the de-narrowing impossible, matching that convention's principle.
- `test-helper-closure-capture-over-arg-threading-2026-05-04.md` — sibling closure-capture pattern in test helpers. The directionality is opposite: that convention closes over a kit-local dependency to avoid threading it; this convention hoists a value out of the parent object's reference to avoid letting the closure capture it (which would trigger de-narrowing). Listed for awareness so a reader doesn't conflate "closure capture" across the two domains.

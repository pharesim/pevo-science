---
title: "Test-fabricated error shape masks a dead production branch"
date: 2026-06-09
category: agents/docs/solutions/conventions/
module: settings-fresh-auth
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "Writing unit tests for error-handling branches that inspect fields on a typed error class"
  - "Reviewing a guard of the form err.<field> or result.<field> for correctness"
  - "Constructing test errors via Object.assign or an object literal instead of the real constructor"
  - "Adding or changing error discriminators (code, status, reason) on ApiRequestError or any typed result class"
tags:
  - error-shape
  - dead-code
  - test-fidelity
  - api-request-error
  - object-assign-antipattern
  - fresh-auth
  - frontend
---

# Test-fabricated error shape masks a dead production branch

## Context

A required recovery behavior never executed in production while every unit test stayed green.

The flow: on a `401 FRESH_AUTH_REQUIRED` response, `withSettingsFreshAuth` (in `frontend/src/lib/settings-fresh-auth.js`) is supposed to re-mint the single-use fresh-auth proof and retry the settings action once. The retry guard read:

```js
if (err.status === 401 && REMINTABLE_REASONS.includes(err.details?.reason)) {
  // re-mint + retry once
}
```

But the error reaching that guard is always an `ApiRequestError`, and that class never sets `.status`. Its constructor (in `frontend/src/api.js`) carries only `code`, `data`, `details`, `retryAfterSeconds`, and `name`:

```js
export class ApiRequestError extends Error {
  constructor(code, message, data, details, retryAfterSeconds) {
    super(message);
    this.code = code;
    this.data = data || null;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds ?? null;
    this.name = 'ApiRequestError';
    // No this.status — there is no HTTP status field on this class.
  }
}
```

So `err.status` was always `undefined`, the `&&` short-circuited to `false`, and every retriable 401 fell straight through to the generic `{ freshAuthFailed: true }` outcome. The re-mint-and-retry path was dead code.

The reason it was invisible: the unit test's `codedError` helper hand-built the error and attached a `.status` field the real constructor never produces:

```js
const codedError = (code, status, reason) =>
  Object.assign(new Error(code), { code, status, details: reason ? { reason } : undefined });
```

The "401 re-mint+retry" test passed `codedError('FRESH_AUTH_REQUIRED', 401, 'expired')`, satisfying `err.status === 401`. The test exercised a shape production never emits, and certified a branch production never reached.

## Guidance

Three rules, in priority order:

1. **Construct typed errors and result objects in tests via the real constructor or factory.** Never hand-fabricate a stand-in with `Object.assign(new Error(), {...})` or a bare object literal. A hand-built object can carry fields the real type never sets (and omit fields it always sets). If the test builds the error the same way production does, a missing or misnamed field shows up as a test failure instead of slipping through.

   ```js
   import { ApiRequestError } from '../../src/api.js';

   const err = new ApiRequestError('FRESH_AUTH_REQUIRED', 'Re-auth required', null, { reason: 'expired' });
   // err.status is undefined here, exactly as in production.
   // A guard on err.status now fails the test instead of passing it.
   ```

2. **When writing or reviewing any code that branches on `err.<field>` or `result.<field>`, open the type definition and confirm that field is actually set at every throw/return site.** A guard on a field the class never populates is silently always-false (or always-true). The check is mechanical: grep the constructor or factory for assignments to the field name you are branching on.

3. **For `ApiRequestError` specifically, branch on `err.code` and `err.details?.reason`. There is no HTTP `.status` on the class.** The discriminators are:
   - `err.code` — e.g. `'FRESH_AUTH_REQUIRED'`, `'UNAUTHORIZED'`, `'SERVICE_UNAVAILABLE'`, `'DUPLICATE'`.
   - `err.details?.reason` — e.g. `'missing'`, `'expired'`, `'malformed'`, `'wrong_mechanism'`, `'target_mismatch'`.

   The class deliberately abstracts the HTTP status away at the throw sites in `request()`; consumers discriminate on the envelope's `code` / `details`, not on a transport-layer status.

## Why This Matters

A fabricated-shape test is worse than no test. It runs green, so it broadcasts confidence that the behavior is covered, while the behavior is in fact absent. The gap surfaces only in production, and only on the exact path the test claimed to exercise. Here, a retriable 401 that should have recovered silently instead degraded to a generic failure for the user.

The failure is doubly hidden: the dead branch produces no exception and no log (it just evaluates false and falls through), and the test that "covers" it actively masks the defect by feeding the code a shape the rest of the system can never produce. CI gives no signal in either direction. The only way to catch it is to make the test's error-construction match production's error-construction, so the field-name divergence becomes a hard failure.

## When to Apply

Apply this whenever any of the following is true:

- Code branches on a field of a custom error or result class (`err.status`, `err.code`, `result.kind`, `err.details?.reason`, etc.), especially in retry, recovery, or fallback logic, where the untaken branch is the consequential one and is easy to leave untested.
- A test builds error or result instances by hand (`Object.assign(new Error(), {...})`, an object literal with a `code` field, a `throw { code: ... }`) instead of calling the real constructor or factory.
- Reviewing error-handling, retry, or account-state-recovery logic, where the cost of a silently-dead branch is a user-visible behavior that never runs.

## Examples

**Before — broken guard, fabricating helper, green test, dead branch:**

```js
// settings-fresh-auth.js — the guard production actually ran
catch (err) {
  if (err?.code !== 'FRESH_AUTH_REQUIRED') throw err;
  clearCachedConsentOpProof();

  // BUG: ApiRequestError never sets .status, so this is always false.
  if (err.status === 401 && REMINTABLE_REASONS.includes(err.details?.reason)) {
    // re-mint + retry once — UNREACHABLE in production
  }
  return { freshAuthFailed: true }; // every 401 lands here instead
}
```

```js
// lib-settings-fresh-auth.test.js — the helper that hid it
const codedError = (code, status, reason) =>
  Object.assign(new Error(code), { code, status, details: reason ? { reason } : undefined });

// Passes, but only because codedError invented a .status the real class lacks.
run.mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 401, 'expired'));
```

**After — guard on the fields the class actually exposes, test builds the real error:**

```js
// settings-fresh-auth.js — discriminate on code (already established upstream)
// plus the reason in details. No HTTP status involved.
catch (err) {
  if (err?.code !== 'FRESH_AUTH_REQUIRED') throw err;
  clearCachedConsentOpProof();

  // err.code === 'FRESH_AUTH_REQUIRED' is established by the line above;
  // the remintability decision is purely the reason classification.
  if (REMINTABLE_REASONS.includes(err.details?.reason)) {
    // re-mint + retry once — now actually reachable
  }
  return { freshAuthFailed: true };
}
```

```js
// lib-settings-fresh-auth.test.js — build the error production builds
import { ApiRequestError } from '../../src/api.js';

run.mockRejectedValueOnce(
  new ApiRequestError('FRESH_AUTH_REQUIRED', 'Re-auth required', null, { reason: 'expired' })
);
// No fabricated .status. The test now exercises the same shape production emits,
// so a guard on err.status would fail here instead of passing.
```

**Reviewer detection heuristic.** A custom error or result class plus a test helper that builds instances via `Object.assign(new Error(), {...})` (or a bare object literal) is a smell. Diff the helper's field set against the real constructor's field set:

- `ApiRequestError` constructor sets: `code`, `data`, `details`, `retryAfterSeconds`, `name`.
- The `codedError` helper set: `code`, `status`, `details`.

`status` appears in the helper but not the constructor. That mismatch is the bug's fingerprint. Any field the helper carries that the constructor does not (or vice versa) is a candidate for a guard that tests one reality and ships another. The durable fix is to delete the helper and construct via the real type, which makes such divergences impossible by construction.

## Related

- `wire-contract-shape-pinned-on-backend-not-stub-2026-05-16.md` — the HTTP-transport sibling of this learning. Same family ("pin the real shape, not a stub"), different layer: that one is a backend response format (`expires_at` epoch vs ISO) diverging from a stub; this one is an in-memory error class's field set diverging from a hand-fabricated test object.
- `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — the umbrella principle this instantiates: a test that stays green when the code under test is mutated (here, deleting the dead `err.status === 401` branch) is not testing that code.
- `object-shape-fix-every-reset-site-2026-04-21.md` — prior art on tests that seed object shape directly masking field-name bugs.
- `vi-spyon-mockimplementation-bypasses-function-under-test-2026-05-12.md` and `test-marker-stub-vacuous-or-fallback-2026-05-15.md` — sibling "stub makes the test vacuously green" failures.

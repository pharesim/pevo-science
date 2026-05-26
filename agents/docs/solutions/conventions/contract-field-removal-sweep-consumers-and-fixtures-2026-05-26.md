---
title: Removing a contract field must sweep every consumer and its test fixtures
date: 2026-05-26
category: conventions
module: frontend/src/pages + frontend/tests/unit
problem_type: convention
component: testing_framework
related_components:
  - authentication
  - frontend_stimulus
severity: high
applies_when:
  - "Removing or renaming a field from a backend response body that more than one frontend surface reads"
  - "Migrating SPA consumers to a changed API response contract"
  - "A unit test mocks a backend response shape to drive routing or branching logic"
  - "Reviewing a diff that changes a response contract but only edits some of its consumers"
tags:
  - contract-change
  - field-removal
  - test-fixture
  - masking-green-test
  - multi-consumer-sweep
  - wire-shape
  - pending-signup
  - sibling-call-site
---

# Removing a contract field must sweep every consumer and its test fixtures

## Context

When a backend response field is **removed** (not added), the change fans out to every frontend surface that reads that field. Two failure modes compound:

1. **The audit set is wider than the diff.** Consumers that "already worked" before the removal are not in the diff that performs the migration, so a diff-focused implementer and a diff-focused reviewer both miss them.
2. **Test fixtures are themselves consumers of the wire shape.** A unit test that mocks the backend response to drive routing/branching logic encodes a *snapshot* of the contract in its fixture. A fixture that still supplies the removed field keeps its test green against a field the live backend no longer sends, giving false confidence the consumer is contract-aligned, and actively masking any consumer that was never migrated.

Concrete incident (2026-05-26): the signup session-binding work removed `auth_token` from the `POST /api/auth/login` PENDING_SIGNUP (409) response body (`data` is now `{ email }` only). The SPA migrated two of **three** PENDING_SIGNUP handlers (`login.js`, `sign-in-modal.js`) but missed the third, `signup.js` `_resolveExistingAccount()`, which still read `loginErr.data.auth_token` and encoded `auth_token=undefined` into a `/signup/verify` redirect, dead-ending duplicate-email recovery. The unit test for that path mocked `data: { auth_token: 'pending-token', email }` and asserted `auth_token=pending-token` in the redirect, so it stayed green against a field the backend no longer emits. The miss was caught only by an exhaustive cross-consumer code review (security + correctness personas grepping every consumer), not by the test suite, which could not catch it by construction.

## Guidance

On a contract **field removal or rename**, before declaring the migration done:

1. **Grep all production consumers of the field across the whole frontend**, not just the obvious entry point. PEvO has multiple handlers for the same backend state (e.g. the three PENDING_SIGNUP handlers: `login.js`, `sign-in-modal.js`, and `signup.js` `_resolveExistingAccount()`) that must stay in sync. A claim that "all consumers are migrated" must be backed by a grep of the removed field name, not by mental enumeration of the sites you happened to edit.
2. **Grep the test fixtures for the removed field name too** (e.g. the field name in `*.test.js` mock bodies). A fixture that still supplies the field is a *writer* of the dead field, invisible to a "find readers of X" sweep, and it will stay green while masking a missed consumer.
3. **Update fixtures to model the current wire shape.** A test that feeds a consumer a field the backend never sends is testing a fiction. Drop the removed field from the mock body so the fixture matches the live response; the test then exercises the real `{ email }`-only shape and fails loudly if a consumer still depends on the removed field.

The same fan-out discipline applies to additions where coverage must be uniform: if N call sites gain a new behavior, N tests should pin it. (In the same review, three `api.js` functions gained `credentials: 'same-origin'` but only two had tests pinning it, so a regression dropping it from the untested third would have been invisible.)

## Why This Matters

A green test for a removed-field consumer is **worse than no test**: it certifies the consumer as contract-aligned while the consumer is actually broken, and it suppresses the signal that would have pointed at the un-migrated sibling. The fixture and the consumer agree on a field the wire no longer carries, so both sides of the assertion are stale in lockstep and the assertion passes. The gap then surfaces only in production (here, a user re-signing up with an existing email hits a dead "invalid link" page) or in an exhaustive cross-consumer review.

This is distinct from a *vacuous* assertion (one that passes because the asserted value coincides with a default) and from a *truthy-stub* trap (one where a marker stub never lets the fallback branch run). Here the test is structurally fine; its **fixture** is stale, decoupled from the wire shape the backend now emits.

Note the boundary against the project's "dismiss preemptive test hardening" stance: this is not preemptive hardening. The test already exists and is actively wrong, pinning a removed field. Updating it to the live shape removes a false-positive, it does not add speculative coverage.

## When to Apply

- Removing or renaming a field in any backend response body that more than one frontend surface consumes.
- Reviewing a diff that changes a response contract: enumerate every consumer of the changed field (grep, do not eyeball the diff), and check each consumer's test fixture for the old field name.
- Migrating SPA consumers to a changed API contract, especially when several handlers branch on the same backend state.

## Examples

Missed consumer left on the removed contract (the bug):

```js
// signup.js _resolveExistingAccount() — NOT migrated; backend no longer sends auth_token
if (loginErr.code === 'PENDING_SIGNUP' && loginErr.data) {
  const params = new URLSearchParams({
    auth_token: loginErr.data.auth_token,  // now undefined -> "auth_token=undefined"
    email: loginErr.data.email,
  });
  Alpine.store('router').navigate(`/signup/verify?${params}`);  // dead-ends on invalid-link page
}
```

Migrated consumer (the shape the sweep should converge every site to):

```js
// login.js / sign-in-modal.js — migrated
if (loginErr.code === 'PENDING_SIGNUP') {
  const params = new URLSearchParams({ resume: '1' });
  if (loginErr.data?.email) params.set('email', loginErr.data.email);
  Alpine.store('router').navigate(`/signup/verify?${params}`);
}
```

Masking fixture (green against a removed field) vs. the fix:

```js
// BEFORE — fixture supplies the removed field; test passes against a fiction
loginWithPassword.mockRejectedValue({
  code: 'PENDING_SIGNUP',
  data: { auth_token: 'pending-token', email },  // backend no longer sends auth_token
});
expect(navArg).toContain('auth_token=pending-token');  // green while production is broken

// AFTER — fixture models the live { email }-only shape; asserts the real contract
loginWithPassword.mockRejectedValue({ code: 'PENDING_SIGNUP', data: { email } });
expect(navArg).toContain('resume=1');
expect(navArg).not.toContain('auth_token');
```

## Related

- `conventions/wire-contract-shape-pinned-on-backend-not-stub-2026-05-16.md` — structural sibling, the **inverse** direction: a stub emitting the contract-correct shape while the backend emits the wrong shape (backend regressed, stub hid it). Together the two entries triangulate the full fixture-vs-wire-shape failure space: fixture-too-new (that doc) and fixture-too-old/stale-removed-field (this doc).
- `conventions/object-shape-fix-every-reset-site-2026-04-21.md` — same "grep every consumption site; mental enumeration is not sufficient" discipline applied to a multi-write-site object-shape fix.
- `conventions/helper-contract-flip-untouched-adopter-audit-2026-05-16.md` — un-touched adopters silently inherit a behavioral gap when a shared contract shifts underneath them; diff-touched sites are not the audit set.
- `conventions/req-query-as-string-cast-silent-coerce-2026-05-16.md` — adjacent downstream effect, not the same problem: the removed field's absence is what surfaced as the `URLSearchParams` "undefined"-string-is-truthy trap that the rewritten `signup-verify.js init()` now guards against.

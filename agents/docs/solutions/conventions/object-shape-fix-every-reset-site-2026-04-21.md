---
title: "Object-shape fixes must cover every reset site, not just the bug-manifestation site"
date: 2026-04-21
category: conventions
module: frontend/src/pages
problem_type: convention
component: frontend_stimulus
severity: high
applies_when:
  - "Fixing a field-name mismatch between backend wire format and Alpine component state"
  - "Adding a new field to a shared response object consumed by an Alpine component"
  - "Optimistically updating Alpine component state after a mutation handler without a fresh server fetch"
  - "Hiding a sensitive action via Alpine x-show or x-if for a specific user branch"
  - "Closing an architect-gated Review task — run /ce-code-review, not a re-read of the diff"
related_components:
  - authentication
  - testing_framework
tags: [object-shape, field-name-mismatch, alpine, x-show-vs-guard, partial-fix, code-review]
---

# Object-shape fixes must cover every reset site, not just the bug-manifestation site

## Context

PEvO's `GET /api/settings/email` returns a mixed-casing response: `hasEmail`, `verified`, `pendingChange` camelCase, but `has_password` snake_case (see `backend/src/routes/settings.ts:77, 82-86`). Alpine components on `frontend/src/pages/settings.js` consume it as `emailStatus`. When SEC-004-UI added the Set-Password surface, the template guard was originally `emailStatus.hasPassword` — `undefined === false` → feature silently dead on arrival. The architect's P0 review caught it and listed 4 must-fix sites.

The follow-up fix covered 3 of the 4 obvious sites: the `x-if` template guard, the optimistic spread in `handleSetPassword` success, and the `loadEmailStatus` catch fallback. It missed the 4th: `handleEmailDelete` (line 510) resets `emailStatus = { hasEmail: false, custody: this.custody }` with no `has_password` key. Same bug class re-introduced — for an ORCID user who deletes their email, the Set-Password surface disappears (`undefined === false` is false).

`/ce-code-review` on the fix caught the missed site. Three reviewers (correctness 0.92, testing 0.85, maintainability 0.72) independently flagged it → cross-reviewer-boosted ~1.0 confidence. A fourth related finding (`handleResendVerification` only UI-hidden, not body-guarded) surfaced in the same review pass.

## Guidance

**Treat the shared state object as a shape contract.** Every site that writes, resets, or partially reconstructs `emailStatus` (or any similarly shared Alpine state object fed from an API boundary) must include every key the template and other handlers rely on. Before landing a fix, grep every assignment site:

```bash
grep -n "emailStatus\s*=" frontend/src/pages/settings.js
```

Any assignment that doesn't include the contract fields is a latent bug. When the value isn't in a fresh server response (optimistic update after mutation, delete success, catch fallback), carry it forward from the existing object or provide a safe default:

```js
// Correct: carry forward has_password on delete
this.emailStatus = {
  hasEmail: false,
  custody: this.custody,
  has_password: this.emailStatus?.has_password ?? false,
};

// Wrong: reset without has_password re-introduces the undefined === false bug
this.emailStatus = {
  hasEmail: false,
  custody: this.custody,
};
```

**Add a body-level guard to every handler that should be gated by a UI branch.** `x-show` and `x-if` hide the DOM but don't protect the method. Any Alpine handler that should not fire for a particular branch (ORCID branch, light-account-only flows, etc.) must guard at the top of the function body too:

```js
async handleResendVerification() {
  // ORCID branch has no password; guard at the handler level so a console
  // or XSS caller can't bypass the x-show hide.
  if (this.isResending || this.orcidToken) return;
  ...
}
```

**Tests that seed shape directly mask field-name bugs.** Any test that does `comp.emailStatus = { has_password: false, ... }` bypasses the real data path. It will pass whether the template reads `hasPassword` or `has_password` — the bug is invisible. At least one test per shape-gated feature should feed data through the mocked API boundary (`mockFetchEmailStatus.mockResolvedValue({ data: { has_password: false, ... } })`) and assert the resulting component state. This catches field-name drift at the boundary it actually matters.

**Run `/ce-code-review` on fixes for multi-site bugs before marking tasks ready for archive.** Manual re-reading of a diff is not sufficient for bug classes that manifest at multiple scattered write sites. The architect's review caught the original P0 (field-name mismatch). The `/ce-code-review` pass on the architect-gated fix caught a 5th site the architect review had missed. Two review mechanisms, two different partial-fix sites found. The loop is load-bearing, not ceremony. See also: `feedback_architect_ce_code_review.md` in auto memory.

## Why This Matters

The Set-Password surface was feature-dead from merge until the architect caught it. After the fix, it was feature-dead *for ORCID users who deleted their email* until the `/ce-code-review` caught the missed reset site. Same bug class, two different sites, two different review passes to find them all. A single-pass manual fix reliably misses sites because the bug-manifestation site draws the fixer's eye — the reset/fallback/delete paths are architecturally distant from the symptom.

The backend casing mismatch on `/api/settings/email` is a permanent fixture of the wire format (tracked as `BE-SETTINGS-EMAIL-CASING` for eventual normalization). Until normalized, every new field added to that object is a trap for Alpine code that doesn't explicitly check the wire-format name.

The `x-show` / handler-guard split matters because PEvO has security invariants that need layered defense. SEC-004's invariant is "the ORCID branch never transmits a password." Hiding a button satisfies the invariant for a well-behaved user. A handler-body guard satisfies it for any caller — including console users during development (who then commit the broken flow they tested), XSS, and future refactors that call the handler from a different code path.

## When to Apply

1. Fixing a field-name mismatch or any object-shape bug: grep EVERY assignment, reset, fallback, and optimistic-spread site of the object before calling the fix complete. The bug-manifestation site is rarely the only site.
2. Adding a new field to an Alpine-consumed API response: update the template read, the optimistic success spread, the error-path fallback, and every handler that resets or rebuilds the object.
3. Any UI element hidden with `x-show` or `x-if` to suppress a sensitive action for a particular branch: add a matching early-return guard at the top of the handler body.
4. Any time a test seeds a shape directly (`comp.foo = { ... }`) rather than through a mocked API response: add a companion test that feeds data through the mock boundary, so field-name drift breaks the test.
5. Closing an architect-gated fix on a Review-section task: run `/ce-code-review` on the diff before marking ready-for-archive. Do not substitute manual re-reading.

## Examples

**Bug-manifestation site — template guard using wrong casing:**

```html
<!-- frontend/src/pages/settings.js:168 (broken) -->
<template x-if="!emailLoading && emailStatus && emailStatus.hasPassword === false">
  <!-- Set-Password form: never renders because hasPassword is undefined -->
</template>

<!-- Fixed: match the wire-format snake_case -->
<template x-if="!emailLoading && emailStatus && emailStatus.has_password === false">
```

**Missed reset site — `handleEmailDelete` success callback (the site the architect review listed 3 fixes around but skipped):**

```js
// Before: re-introduces the undefined === false bug for ORCID users who delete email
this.emailStatus = {
  hasEmail: false,
  custody: this.custody,
};

// After: carry forward has_password so the Set-Password surface stays visible
this.emailStatus = {
  hasEmail: false,
  custody: this.custody,
  has_password: this.emailStatus?.has_password ?? false,
};
```

**Body-level guard on a handler whose button is hidden by x-show:**

```js
// Before: only x-show hides the button; handler fires if called directly
async handleResendVerification() {
  if (this.isResending) return;
  this.isResending = true;
  await resendVerification(this.email.trim(), this.password);  // POSTs empty password on ORCID branch
}

// After: body guard matches the template condition
async handleResendVerification() {
  if (this.isResending || this.orcidToken) return;
  this.isResending = true;
  await resendVerification(this.email.trim(), this.password);
}
```

**Test that catches field-name drift at the boundary (better than hand-seeding shape):**

```js
// Hand-seeded — passes whether template reads hasPassword or has_password
it('shows set-password surface', () => {
  const comp = createComponent();
  comp.emailStatus = { has_password: false };  // bypasses the API mapping
  expect(/* template rendered */).toBeVisible();
});

// Mock-fed — breaks if the wire contract changes
it('shows set-password surface from API response', async () => {
  mockFetchEmailStatus.mockResolvedValue({ data: { hasEmail: true, has_password: false } });
  const comp = createComponent();
  await comp.loadEmailStatus();
  expect(comp.emailStatus.has_password).toBe(false);
});
```

## Related

- `agents/docs/TASKS.md` entry `BE-SETTINGS-EMAIL-CASING` — follow-up to normalize the wire format.
- `feedback_architect_ce_code_review.md` (auto memory) — architect must `/ce-code-review` every Review-section task; this doc is the "why" story behind that rule.
- [wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md](wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md) — applies the same "grep every site, don't trust mental enumeration" meta-pattern to wrapping primitives (semaphore, lock, helper) on backend call sites, plus the null-path type annotation axis. Different domain, same failure mode.
- [helper-contract-flip-untouched-adopter-audit-2026-05-16.md](helper-contract-flip-untouched-adopter-audit-2026-05-16.md) — third corner of the same enumeration-completeness triangle. This doc covers incomplete enumeration of reset/write sites for shared state objects (bug fix trigger). The wrapping-primitive doc covers incomplete enumeration of call sites at helper introduction (adoption trigger). The sibling covers incomplete re-grading of adopters after a helper's defaulting semantics change (contract-flip trigger). Three distinct triggers, one shared meta-failure: mental enumeration accepted in lieu of grep verification.

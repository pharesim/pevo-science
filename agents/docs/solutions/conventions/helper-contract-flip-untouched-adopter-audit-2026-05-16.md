---
title: "When a shared helper's internal defaulting semantics change, re-grade every call site against the new contract — diff-touched sites are not the audit set"
date: 2026-05-16
category: conventions
module: frontend/src
problem_type: convention
component: authentication
severity: high
applies_when:
  - "A shared helper's defaulting semantics flip from force-reset (`?? false`, `?? null`, `?? default`) to preserve-on-undefined (`if (data.x !== undefined) this.x = data.x`)"
  - "A shared helper's defaulting semantics flip the opposite way (preserve → force-reset, or coerce → identity)"
  - "A helper-internal coercion is removed or added (`null` → `''`, `undefined` → `0`, case normalization, trim, etc.)"
  - "A required/optional contract flips on a helper field — previously-required field becomes optional with a default, or previously-optional becomes required"
  - "Timeout, retry, or numeric default changed inside a shared helper rather than at call sites"
  - "Refactoring an existing helper that already has multiple adopters, and the change touches behavior under the absence of a field rather than the addition of a field"
  - "Reviewing a task whose acceptance lists 'N call sites adopted' or 'all sites pass field X explicitly' without backing the claim with a grep of ALL call sites of the helper"
  - "The diff is correct at every touched site but the helper's contract has shifted out from under non-diff-touched adopters"
  - "An implementer's mental model is 'I touched N sites; everything else is unaffected' — the model is structurally wrong for contract-flip refactors"
  - "The helper manages session, identity, auth, or other state where stale values from a prior context persist in a store, cache, or singleton"
  - "A helper centralizes defaulting that callers previously relied on; existing callers that omit fields silently inherit the new behavior"
related_components:
  - development_workflow
  - testing_framework
tags:
  - helper-refactor
  - contract-change
  - preserve-on-undefined
  - force-default
  - audit-pattern
  - cross-reviewer-corroboration
  - frontend
  - auth-flow
---

## Context

During architect re-review of `ui-auth-loginfromresponse-helper-adoption` (commit `5f52523`) on 2026-05-16, a shared helper's internal defaulting semantics were flipped: identity fields previously force-reset on absence (`is_accredited ?? false`, `accreditation ?? null`) became preserve-on-undefined (`if (data.x !== undefined) this.x = data.x`). The implementer audited the six call sites they touched in the diff and confirmed each passes explicit field values. **Two un-touched call sites — `frontend/src/components/sign-in-modal.js:79` and `frontend/src/pages/signup.js:337`** — already used the helper correctly and were skipped because their adoption was complete. After the semantic flip, those two sites silently inherited stale store state from prior sessions instead of resetting it. **No code at those sites changed; the contract changed underneath them.**

The defect was caught by the correctness reviewer's two-grep audit (raw field writes vs `loginFromResponse` call sites) and corroborated by the learnings-researcher's cross-reference. Standard diff review missed it entirely — the diff is structurally correct at every site it touches; the regression lives at sites the diff does not appear in.

This is the **inverse failure mode** of [`wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`](./wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md). That convention covers missed adoption — files still using the old inline pattern that should route through the new helper. Here, adoption is complete; the defect is that the new contract re-grades already-adopted sites as non-conforming without touching their code. The audit primitive is also inverted: existing convention says "grep for inline writes that should be helper calls"; this convention says "grep for ALL helper call sites and re-evaluate each against the new contract semantics."

## Guidance

When a helper's internal defaulting semantics change, **the audit set is every call site of the helper, not just the ones touched by the diff.** The implementer's "I touched N sites" set is wrong by construction: the contract change propagates to every adopter, including those whose code did not move in the diff.

### Two-grep audit recipe

Run BOTH greps; cross-reference is mandatory:

```bash
# Step 1: Find all raw field writes (sites that bypass the helper — verifies adoption is complete)
grep -rn "auth\.token\s*=\|auth\.isAccredited\s*=\|auth\.expiresAt\s*=" frontend/src/ --include='*.js'

# Step 2: Find all helper call sites (the audit set for the new contract)
grep -rn "loginFromResponse" frontend/src/ --include='*.js'
```

Substitute the helper name and field list for the actual refactor. **The residual audit set is every file in step-2 results, NOT just the files in the diff.** Re-evaluate each residual site against the **new** contract, not the old one.

### The invariant to check at each residual site

For each call site of the helper:

1. Identify which fields in the helper's contract changed semantics (preserve-on-undefined, default removed, coercion changed, etc.).
2. Inspect the response payload (or argument shape) this site passes.
3. Ask: **does the payload cover every field whose defaulting semantics changed?**
4. If no, the site is now non-conforming. The site's code did not change; its conformance did.

### Two fix options at each non-conforming site

- **(a) Per-site explicit override.** Pass the missing fields with explicit values matching what the old helper provided by default. Smallest blast radius; the helper stays permissive and callers opt in to full coverage. Preferred when only a small number of sites are non-conforming.
- **(b) Helper-level guard.** Restore the old default inside the helper conditional on an identity-change signal (boolean param or sentinel field). Only viable if identity-change can be signaled cheaply. More complex; avoid unless many sites would otherwise need identical overrides.

### Documentation obligations

Whichever fix shape lands, two documentation steps belong with the fix:

- **Helper docblock note** — state which fields require callers to coerce on identity-change payloads. Future readers of the helper see the contract obligation without spelunking call sites.
- **One-line comments at each currently-correct touched site** — document why the coercions are load-bearing (the helper's preserve-on-undefined branch would carry stale state if they were stripped). Without this, a future reader sees `is_accredited: data.is_accredited ?? false` and assumes the `?? false` is redundant (it was, under the old helper). Stripping it silently reintroduces the regression.

## Why This Matters

The defect window is real and user-visible. In PEvO's concrete case: **cross-user re-login on a shared device.** User A logs out, user B password-logs-in via sign-in-modal. The password-login response per `backend/src/routes/auth.ts:836` carries `{token, expires_at, username, custody}` but not `is_accredited` or `accreditation`. Under the old helper, both fields were force-reset to `false`/`null`. Under the new helper, they are preserved from the store. User A's `is_accredited=true` and `accreditation` object carry forward into user B's session for the ~60s window before the polling loop's first round-trip self-corrects. During that window B's UI shows A's accreditation badge and publish/review/edit affordances — a silent cross-user privilege leak.

Standard diff review does not catch this class of defect because **the diff is correct at every site it touches.** The regression is structural: it lives at sites the diff does not appear in. Type-checking does not catch it either — the helper's signature is `loginFromResponse(data: LoginPayload)` with `data.is_accredited?: boolean`; both `undefined` and `false` are type-valid; the contract change is in the conditional logic, not in the type.

The implementer's reasoning — "I touched N sites; everything else is unaffected" — is the load-bearing mental model that needs replacing. For adoption sweeps (introducing a new helper), the model is correct: untouched sites are by definition not yet adopters. For **contract-flip refactors**, the model inverts: untouched sites are already-adopters whose conformance assumption has changed. The new audit set is the full population of helper call sites, re-graded.

## When to Apply

Run this audit whenever a helper's internal defaulting semantics change. Concrete triggers:

- `?? default` removed or changed to `if (x !== undefined)` preserve (or vice versa)
- Coercion removed: `null` → `''`, `undefined` → `0`, case normalization, trim, etc.
- Required/optional contract flipped: field previously required now optional with a default, or optional now required
- Timeout, retry, or numeric default changed inside a helper rather than at call sites
- Any change where the helper previously provided a safe fallback value and now delegates that responsibility to callers

**Does NOT apply** to purely additive changes (new field added, new optional param with backward-compatible default, helper signature widened without changing behavior for existing payloads). Applies to any change in what the helper does when a field is absent or undefined.

### Timing

Run the audit at **signal-block-write time**, not at architect re-review intake. See [`load-bearing-greps-at-signal-block-write-time-2026-05-06.md`](./load-bearing-greps-at-signal-block-write-time-2026-05-06.md) for the general principle. The implementer is closer to the helper's contract intent than the reviewer; the implementer must be the one who runs the grep and lists each residual site's disposition (no-op / override added / hold) in the signal block. The reviewer's job is to verify the list, not to discover it.

### Related conventions

- [`wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`](./wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md) — **direction-of-audit inverse.** That doc asks "did all sites adopt the helper?" This doc asks "do all already-adopted sites still hold against the helper's new contract?" Complementary: run both — exhaustive-call-site at helper introduction, contract-flip audit at every later semantics change.
- [`sql-semantic-shift-cross-surface-audit-2026-05-12.md`](./sql-semantic-shift-cross-surface-audit-2026-05-12.md) — **closest structural sibling.** Same audit imperative (re-grade all adopters, not just the diff-touched sites), same root cause (semantic shift at a shared surface propagates silently to consumers), different layer (SQL gate semantics vs JS/TS helper defaulting). The two together cover the SQL-layer and JS/TS-layer instances of the same generalized failure mode.
- [`object-shape-fix-every-reset-site-2026-04-21.md`](./object-shape-fix-every-reset-site-2026-04-21.md) — **structural cousin.** Covers incomplete enumeration of reset/write sites for shared Alpine state objects. Different trigger (bug fix vs helper refactor) but same incomplete-enumeration failure mode.
- [`correlated-options-discriminated-union-2026-04-28.md`](./correlated-options-discriminated-union-2026-04-28.md) — **adjacent contract-shape.** Type-level encoding of correlated optional fields. The runtime-behavioral complement to this convention; useful when deciding how to structure the per-site fix at non-conforming sites.

## Examples

### Before (force-reset on absence)

```js
loginFromResponse(data) {
  this.token = data.token;
  this.username = data.username;
  this.isConnected = true;
  this.expiresAt = data.expires_at;
  this.isAccredited = data.is_accredited ?? false;   // force-reset
  this.accreditation = data.accreditation ?? null;   // force-reset
  this.custody = data.custody ?? 'self';
  this._saveSession();
  this._startAccreditationPolling();
}
```

### After (preserve-on-undefined)

```js
loginFromResponse(data) {
  if (data.token && data.expires_at) {
    this.token = data.token;
    this.expiresAt = data.expires_at;
  }
  if (data.username !== undefined) this.username = data.username;
  if (data.is_accredited !== undefined) this.isAccredited = data.is_accredited;   // preserve
  if (data.accreditation !== undefined) this.accreditation = data.accreditation;  // preserve
  if (data.custody !== undefined) this.custody = data.custody;
  this.isConnected = true;
  this._saveSession();
  this._startAccreditationPolling();
}
```

### Residual non-conforming site (untouched by diff, now stale)

```js
// frontend/src/components/sign-in-modal.js:79
// Password-login response shape per backend/src/routes/auth.ts:836:
//   { token, expires_at, username, custody }
// `is_accredited` and `accreditation` are absent. Old helper reset them; new helper preserves them.
auth.loginFromResponse(res.data);   // NON-CONFORMING after contract flip
```

### Fix option (a) — per-site explicit override

```js
// frontend/src/components/sign-in-modal.js:79
// Password-login response omits is_accredited/accreditation; coerce explicitly so
// stale accreditation state from a prior user's session is not inherited.
auth.loginFromResponse({
  ...res.data,
  is_accredited: false,
  accreditation: null,
});
```

### Generalized audit recipe (substitute your helper and fields)

```bash
# Step 1: Find raw field writes that bypass the helper (verify adoption is complete)
grep -rn "this\.fieldA\s*=\|this\.fieldB\s*=" src/ --include='*.js'

# Step 2: Find all helper call sites (the audit set after a contract flip)
grep -rn "myHelper(" src/ --include='*.js'

# Residual set = step-2 results NOT in the diff
# Re-evaluate each residual site: does its payload cover every field whose
# defaulting semantics changed in the helper? If not, apply fix option (a) or (b).
```

### Signal-block obligation

When landing a contract-flip refactor, the implementer's signal block MUST include the residual-site disposition list:

> ### Audit of all helper call sites against new contract
>
> Ran `grep -rn "loginFromResponse" frontend/src/ --include='*.js'`. 8 call sites total. Diff touched 6 (all explicitly pass `{is_accredited, accreditation}` per new contract). 2 residual sites:
>
> - `frontend/src/components/sign-in-modal.js:79` — password-login response omits `is_accredited`/`accreditation`. **Added explicit `is_accredited: false, accreditation: null` override** (commit X). Conforming.
> - `frontend/src/pages/signup.js:337` — same shape, same fix (commit X). Conforming.

The reviewer's job is to verify each entry against the diff, not to discover residual sites the implementer missed.

## Prevention

- **At PR-author time:** when authoring any helper refactor whose internal conditional logic changes (not just signature widening), run the two-grep audit before writing the signal block. List every residual site explicitly with a disposition.
- **At reviewer time:** when reviewing any task with "helper adoption" or "helper refactor" in the title and a multi-site diff, demand the residual-site disposition list in the signal block. If absent, run the audit yourself and surface missing sites as a hold-block item.
- **At convention-doc maintenance time:** when a new failure instance of this pattern surfaces, append a concrete example to this doc's `applies_when` list rather than filing a new convention. The audit primitive is general; the triggers will accumulate.

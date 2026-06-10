---
title: "A sync op moved across a try boundary relocates its catch scope; audit wrapper migrations by mechanism, not by test-pinned sites"
date: 2026-06-10
category: conventions
module: backend/src + migration audit workflow
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - "Folding a synchronous operation (key parse, config assertion, schema validation) into an async helper that call sites await inside a try/catch"
  - "Inlining an async helper back to its call sites, which moves operations across try boundaries in the other direction"
  - "Migrating multiple call sites to a shared helper when only some sites have failure-shape tests"
  - "A catch block's response code or retry semantics depends on whether an error escapes synchronously or rejects the awaited call"
  - "Writing or rewording a helper docblock that describes how adopters handle its error classes"
related_components:
  - authentication
tags:
  - catch-scope
  - async-refactor
  - helper-extraction
  - error-envelope
  - audit-by-mechanism
  - docblock-rot
  - error-handling
---

# A sync op moved across a try boundary relocates its catch scope; audit wrapper migrations by mechanism, not by test-pinned sites

## Context

`broadcastAdminCustomJson` (`backend/src/hive.ts`) centralizes the admin custom_json envelope, including the `PrivateKey.fromString(config.pevoAdminPostingKey)` parse that previously ran inline at each call site. Migrating a call site to the helper therefore moves that synchronous parse across the call site's try boundary: the parse used to throw synchronously wherever it sat; after migration it runs inside the awaited helper, so the same fault surfaces as a rejection of the `await` expression and lands in whichever try wraps the call.

In the migration of the papers retraction, accreditation `/verify`, and `broadcastAccreditationAndSeed` sites (commit abaf65a5), the first two sites already parsed the key inside their try, so nothing changed. At `broadcastAccreditationAndSeed` (`backend/src/routes/signup-verify.ts`) the old parse sat OUTSIDE the inner try, so the set-but-malformed-key edge silently moved from an outer-escape 500 to an inner-catch 502 BROADCAST_FAILED. The change shipped green through typecheck, lint, and every migrated-route suite, and was found only by a multi-reviewer architect pass. (At triage it was accepted as the better shape for that site, since the account row is already finalized there and the 502 envelope matches the stuck-recovery design. The lesson is that it shipped unnoticed, not that it was wrong.)

The contrast: the sibling migration of `handleAccredit`/`handleLink` (`backend/src/routes/orcid.ts`, commit d29f9708) handled the identical mechanism correctly from the start, keeping a discarded-result validation parse outside the inner try, because the SEC-002-TOCTOU-LOCK specs pin the 504-ambiguous-vs-502 distinction there. The audit attention went where the tests were. The mechanism applied equally at the unpinned site.

## Guidance

**The mechanism.** When a synchronous operation moves from a call site into an async helper and the call site awaits that helper inside a try/catch, the synchronous throw becomes a rejected promise caught by that try. An error that previously escaped a scope now lands in it (and inlining a helper moves errors in the opposite direction). Which catch absorbs the fault is a structural property of the call site, invisible to type checks and to any test that does not drive that exact fault.

**The audit recipe.** When migrating call sites into (or out of) a wrapping helper:

1. Grep for the synchronous operation at every call site (here: `PrivateKey.fromString(config.pevoAdminPostingKey)` across `backend/src/`).
2. For each site, identify which try wraps the replacement `await helper(...)` call, and where the old sync statement sat relative to that try.
3. For every site where the operation crossed a try boundary, verify the failure envelope pre/post: does a fault that used to escape now land in a catch (or vice versa), and does the response code, retry licensing, or lock/cleanup behavior change?
4. Never scope this audit by which sites have failure-shape tests. Test pins mark where breakage is DETECTED, not where it EXISTS; the unpinned sites are exactly the ones that ship silent shape changes.

**Preserving a shape that must not move.** When a site's failure envelope must survive the migration and the helper cannot surface the fault to the right scope, keep a discarded-result validation call outside the try, with a comment stating the invariant it holds (mechanism and scopes, not coordination context):

```ts
// Admin-key validation parse, deliberately OUTSIDE the inner try: a
// malformed-key throw must escape fn synchronously to
// withOrcidBindingLock's acquired/unavailable-branch catch (504
// ambiguous-outcome envelope + lock release) rather than land in the
// inner catch as a 502 BROADCAST_FAILED. broadcastAdminCustomJson
// re-parses the key internally; the parse result is discarded here.
PrivateKey.fromString(config.pevoAdminPostingKey);
let result;
try {
  result = await broadcastAdminCustomJson(customJsonPayload);
} catch (err) { /* timeout / rejection discrimination */ }
```

This is the canonical form, not a workaround: the redundant parse exists solely to preserve the synchronous-throw path.

**Companion rule for the helper's docblock: state the contract, never enumerate adopters.** The `AdminKeyNotConfiguredError` docblock on this same helper rotted twice in successive reviews, first by enumerating per-caller handling that was wrong at write time (WoT callers were described as catching the error inline and reporting `skipped`, when every `wot.ts` site actually pre-guards the key before calling), then by describing the guard as a forward-looking safety net just before a migration made the throw live. The durable form states the caller obligation and the default: pre-guard the key at the call site whenever the unset-key path needs a response shape more specific than `handleBroadcastError`'s generic 502; otherwise let the throw fall through. Any enumeration of adopter behaviors goes stale the moment a site is added or changes its guard.

## Why This Matters

Silent failure-envelope changes ship green. A suite that exercises broadcast success, timeout, and rejection never constructs a set-but-malformed admin key, so the catch-scope relocation passes everything. Where the shape is security-relevant the same naive migration is an exploitable regression: at the orcid sites, an inner-catch 502 instead of the wrapper-escape 504 would tell a client whose broadcast may have landed on chain that it definitively failed, licensing a duplicate-bind retry. The only difference between the site that shipped silently changed and the sites that were handled carefully was the presence of test pins, which is precisely the wrong audit-scoping signal.

## When to Apply

- Any helper extraction that absorbs synchronous operations (key parses, config assertions, validations) that call sites previously ran inline.
- Helper inlining, where helper-internal operations move out into call-site scopes.
- Migrations where some call sites carry failure-shape tests and others do not: the audit set is every site where the sync op crosses a try boundary, not the pinned subset.
- Catch blocks whose behavior is branch-sensitive (response code, retry semantics, lock release, cleanup ordering) with respect to where an error originates.
- Helper docblocks describing error-class handling: state the contract, not the current adopter list.

## Examples

Before, at `broadcastAccreditationAndSeed` (parse outside the inner try; malformed key escapes):

```ts
const adminKey = PrivateKey.fromString(config.pevoAdminPostingKey); // outside try
let result;
try {
  result = await broadcastJsonWithTimeout({ ... }, adminKey);
} catch (err) {
  handleBroadcastError(res, err, broadcastErrOpts);
  return 'handled';
}
```

After (parse inside the awaited helper; the same fault now lands in the inner catch as a 502, with no failing test):

```ts
let result;
try {
  result = await broadcastAdminCustomJson({ ... }); // helper parses the key internally
} catch (err) {
  handleBroadcastError(res, err, broadcastErrOpts); // now also catches the malformed-key fault
  return 'handled';
}
```

The orcid sites show the shape-preserving form (see the validation-parse snippet under Guidance).

## Related

- `conventions/helper-extraction-express5-response-ordering-2026-04-28.md` — same family (helper extraction silently relocating a failure mode); that entry covers the response/cleanup ordering axis, this one the catch-scope axis.
- `conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — the exhaustive call-site enumeration this audit plugs into.
- `conventions/route-level-error-class-coverage-after-helper-extraction-2026-04-29.md` — the per-route error-class coverage discipline after the same kind of extraction.
- `conventions/convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md` — the general principle this instantiates: derive audit scope from the semantic mechanism, not from a convenient syntactic or coverage-based proxy.
- `conventions/helper-contract-flip-untouched-adopter-audit-2026-05-16.md` — the adopter-side audit when a helper's contract changes; the docblock-contract rule above is its documentation-side mirror.
- `conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — the 504 ambiguous-outcome contract that makes the orcid sites' failure shape security-relevant.

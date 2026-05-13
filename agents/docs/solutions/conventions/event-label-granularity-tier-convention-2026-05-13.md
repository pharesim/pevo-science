---
title: Event-label granularity tier follows the catch's scope
date: 2026-05-13
category: conventions
module: backend
problem_type: convention
component: logging
severity: medium
applies_when:
  - Tagging a new catch-block logger.error / logger.warn site with an event discriminator
  - Splitting an existing handler's outer-catch into outer + inner catches around named external calls
  - Reviewing a route file where some logger.error sites have event labels and others do not
  - Reasoning about whether an existing event label is "too coarse" or "too specific"
tags:
  - "logging"
  - "structured-logs"
  - "event-discriminator"
  - "operator-dashboards"
  - "convention"
related_components:
  - backend/src/routes
---

# Event-label granularity tier follows the catch's scope

## Context

PEvO routes tag catch-block `logger.error` / `logger.warn` emissions with an `event:` field so operator dashboards can filter by failure class across the `backend/*` surface. The `event:` field is the canonical aggregator discriminator (see [[auth-structured-log-shape]]); the `route:` field is a coarser sibling for handler-level filtering.

As more routes adopt the pattern (custody, bridge, accreditation, orcid), two distinct granularity tiers have emerged in the labels themselves:

- **Coarse tier** — `<module>.<endpoint>.internal_error`. Used by `custody.broadcast.internal_error` (the original) and by `bridge.lookup.internal_error` / `bridge.check.internal_error` (added in `backend-bridge-outer-catch-event-discriminators`, commit `efe951e`).
- **Specific-failure-class tier** — `<module>.<endpoint>.<failure_class>`. Used by `bridge.register.identifier_resolution_failed` and `bridge.register.metadata_fetch_failed` (same commit), and by the `bridge.lock.nonce_drift` / `bridge.lock.redis_outage` events inside `acquireBridgeLock`.

The rule for which tier to use was documented only in commit messages and code-review discussion. A future maintainer adding a third catch to `/register`, or splitting `/check`'s outer catch after a refactor, has no in-repo signal about which tier to apply. The drift is silent and only visible once an operator dashboard breaks. This doc captures the rule so the next site lands consistently.

## Guidance

**One catch block, one event label. The tier follows the catch's scope.**

- **A catch wrapping the whole handler body** → coarse tier: `<module>.<endpoint>.internal_error`. The label names *where* the failure was caught, not *what* failed, because the catch's scope is too broad to make a meaningful failure-class claim.
- **A catch wrapping a single named external call** → specific tier: `<module>.<endpoint>.<failure_class>`, where `<failure_class>` names *what was being attempted*. The catch's scope is narrow enough that the failure class is unambiguous.

Concretely, when a handler grows from one outer-catch to outer-plus-inner-catches around named external calls, the inner catches take specific-failure-class labels and the outer keeps `.internal_error`. The asymmetry is intentional: a catch's narrowness IS the signal that a specific label is meaningful.

Naming rules for the `<failure_class>` slot:
- Use snake_case (matches the rest of the `event:` field convention).
- Describe the operation that was being attempted in past-tense passive (e.g., `identifier_resolution_failed`, `metadata_fetch_failed`, `key_derivation_failed`). The "failed" suffix is conventional but optional when the action verb already implies failure (e.g., `nonce_drift`, `redis_outage`).
- Avoid leaking implementation details (e.g., the upstream library name) — the label should survive a refactor that swaps the implementation. `metadata_fetch_failed` survives swapping CrossRef for arXiv; `crossref_fetch_failed` does not.

## Why This Matters

Operator dashboards built on these labels make claims about failure-class distribution: *"X% of bridge.register failures are identifier-resolution failures, Y% are metadata-fetch failures."* That claim is only meaningful if the labels actually correspond to distinct failure classes — which is only true when each label is bound to a single tight catch scope.

If a maintainer adds a new external call into an existing inner-catch (rather than wrapping it in its own catch), the existing label silently widens: `identifier_resolution_failed` starts including network-timeout errors from the new call. The dashboard claim becomes false without any visible change to the label string.

Conversely, if a maintainer tags an outer-catch with a specific failure-class label, the label silently lies — the catch's actual scope is the whole handler, so the label over-claims.

The tier rule preserves the invariant: **label specificity ≤ catch specificity**. A coarse label on a narrow catch is allowed (under-claiming is safe). A specific label on a broad catch is forbidden (over-claiming corrupts the dashboard).

## When to Apply

- New `event:` tagging on a catch site in any `backend/src/routes/*.ts` file.
- Splitting an existing outer-catch into outer + inner catches: the inner catches need specific-failure-class labels; the outer keeps `.internal_error`.
- Adding a new external call into a handler: if it joins an existing catch, the label stays coarse and gets a `.internal_error` suffix (or matches the existing label's tier). If it gets its own catch, the label is specific.
- Reviewing a PR that adds `event:` discriminators: cross-check each label against the wrapping catch's scope.

## Examples

**Coarse tier — outer-catch wrapping whole handler body:**

```ts
// backend/src/routes/bridge.ts /check handler
try {
  // entire handler body: signature verify, accreditation lookup, HAF query, response
} catch (err) {
  logger.error({
    err,
    route: 'bridge.check',
    event: 'bridge.check.internal_error',
  }, 'bridge /check internal error');
  return sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
}
```

The catch scope is the whole handler. Multiple distinct failure modes (HAF outage, signature verify throw, response-write error) flow into this catch. A specific label would over-claim; `.internal_error` correctly admits the catch can't discriminate.

**Specific tier — inner-catch wrapping one named external call:**

```ts
// backend/src/routes/bridge.ts /register handler
let canonical;
try {
  canonical = await resolveToCanonical(identifier);
} catch (err) {
  logger.error({
    err,
    route: 'bridge.register',
    event: 'bridge.register.identifier_resolution_failed',
    identifier,
  }, 'bridge /register identifier resolution failed');
  return sendError(res, 502, 'IDENTIFIER_RESOLUTION_FAILED', '...');
}

let metadata;
try {
  metadata = await lookupPreprint(canonical);
} catch (err) {
  logger.error({
    err,
    route: 'bridge.register',
    event: 'bridge.register.metadata_fetch_failed',
    identifier,
  }, 'bridge /register metadata fetch failed');
  return sendError(res, 502, 'METADATA_FETCH_FAILED', '...');
}
```

Each catch wraps a single named call. The labels are bound to the operation that failed, so the dashboard claim *"N% of register failures are identifier-resolution failures"* is meaningful.

**Wrong — specific label on broad catch:**

```ts
// ANTI-PATTERN — do not do this
try {
  // entire handler body including TWO external calls
  const canonical = await resolveToCanonical(identifier);
  const metadata = await lookupPreprint(canonical);
  // ... rest of handler
} catch (err) {
  logger.error({
    err,
    event: 'bridge.register.identifier_resolution_failed',  // LIES: this catch fires for
                                                             // metadata_fetch errors too
  }, '...');
}
```

The label over-claims. Operators querying `event = 'bridge.register.identifier_resolution_failed'` will get a mix of two distinct failure classes, and the dashboard claim becomes meaningless.

## Related

- [[auth-structured-log-shape]] — establishes `event:` as the canonical aggregator discriminator and the `<module>.<endpoint>.<sub_event>` naming scheme. This doc refines the `<sub_event>` slot's tier rule.
- [[pino-err-slot-sibling-bypass-redact-policy]] — the spread-after-literal convention that protects `event:` from caller-supplied overrides. Tier rule and spread rule together define the load-bearing shape of catch-block log emissions.
- [[chain-write-timeout-ambiguous-outcome]] — sibling discriminator convention for `outcome:` slot semantics (success/failure/timeout).
- Task: `backend-bridge-outer-catch-event-discriminators` (archived after re-review on 2026-05-13).
- Task: `backend-bridge-custody-broadcast-discrimination` (the round-2 work that introduced the original `custody.broadcast.internal_error` label).

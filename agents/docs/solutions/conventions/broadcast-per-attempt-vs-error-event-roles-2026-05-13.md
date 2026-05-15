---
title: Per-attempt audit event vs error event on broadcast routes — distinct roles, intentional duplication
date: 2026-05-13
category: conventions
module: backend
problem_type: convention
component: logging
severity: medium
applies_when:
  - Reviewing a broadcast-route diff that emits both a per-attempt audit event and an error event on the failure path
  - Adding a new broadcast route and deciding which fields to emit on which event
  - Triaging an adversarial-reviewer finding that flags the per-attempt and error events as duplicate or field-misaligned
  - Building or extending operator dashboards that key on broadcast-event labels
tags:
  - "logging"
  - "structured-logs"
  - "broadcast"
  - "audit-log"
  - "operator-dashboards"
  - "convention"
related_components:
  - backend/src/routes
  - backend/src/lib/broadcast-error.ts
---

# Per-attempt audit event vs error event on broadcast routes — distinct roles, intentional duplication

## Context

PEvO's broadcast routes (`/api/custody/broadcast`, `/api/bridge/register`) emit two structured log events on every failure: a **per-attempt audit event** (`event: 'custody.broadcast.attempt'` or `'bridge.register.attempt'`, `outcome: 'failure' | 'timeout'`) and an **error event** (`event: 'broadcast_failed'` or `'broadcast_timeout'`). The per-attempt event fires on every attempt regardless of outcome (including success); the error event fires only on failures. On a failure path BOTH events fire from the same catch block.

At code-review time this looks like structural duplication. Three independent adversarial-reviewer findings during the architect review of commit `14249db` (`backend-broadcast-attempt-helper-extraction`) flagged variants of this pattern:
- "Per-attempt event AND `broadcast_failed`/`broadcast_timeout` event both fire on failures — operators must dedupe across both event labels"
- "Bridge `handleBroadcastError` logContext omits `op_types`/`op_count` that the per-attempt event includes — field-parity break"
- "Failure/timeout audit emits no `err` payload — operators can't distinguish chain rejection from network error on the *.attempt stream alone"

All three were dismissed at user triage on the same underlying rationale: **the two events answer different questions, so their distinct (overlapping but not identical) field sets are intentional, not drift.** The rationale lives only in triage prose — future adversarial reviews will surface the same finding pattern, and re-deriving the dismissal each time wastes cycles. This doc captures the rule so the next review can dismiss-or-fix on cited reasoning.

## Guidance

**Two events on the failure path are intentional. They answer different operator questions, so they carry different field sets.**

| | Per-attempt audit event | Error event |
|---|---|---|
| **Event labels** | `<module>.<endpoint>.attempt` (e.g., `bridge.register.attempt`) | `broadcast_failed`, `broadcast_timeout` |
| **When it fires** | Every attempt — success, failure, timeout | Failures only (one event per failure class) |
| **Emitted by** | `makeLogBroadcastAttempt(...)` factory (`backend/src/lib/broadcast-error.ts`) | `handleBroadcastError(...)` (same file) |
| **Primary operator surface** | Retry-amplification dashboards, success-rate analytics | Incident-response triage, error-detail debugging |
| **Required-field set** | `event`, `outcome`, `username`, `op_types`, `op_count`, `route` (+ route-specific context: `identifier` for bridge) | `event`, `err` (with full `err.message`, `err.name`, `err.cause` chain via pino's recursive serializer), narrower contextual fields |
| **Operator query shape** | "What fraction of attempts succeed?" → counts per `outcome`; "Which op-class amplifies retries?" → group by `op_types` | "Why did this specific failure throw?" → read `err.message`; "Is this a pattern across users?" → filter by `err.name` |

### Why both events fire on failures (intentional duplication)

The dashboard analytic "success rate = `count(outcome=success) / count(*)`" needs the *denominator* to include failures. Suppressing the per-attempt event on the failure path would make the denominator unreliable — operators would have to join across event labels (per-attempt for successes + error events for failures) and assume the join preserves cardinality. That assumption breaks under several common conditions (sampling rates differ across pino transports; one event lost due to back-pressure; tagging discrepancies). Emitting both events keeps the per-attempt stream self-sufficient as an attempt-count source of truth.

The cost — operators dedupe across event labels for total-failure counts — is paid only by failure-count analytics, not by amplification analytics. Dashboards that care about failure-count dedup it explicitly (`SELECT count(*) FROM events WHERE event IN ('bridge.register.attempt', 'broadcast_failed') AND outcome = 'failure' GROUP BY tx_id` or similar). Dashboards that care about amplification key on the per-attempt event alone and don't need dedup.

### Why field sets diverge (intentional asymmetry)

- **Per-attempt events carry `op_types` / `op_count`** because the amplification analytic is per-op-class. "Which op-classes drive retry storms?" requires partitioning by `op_types`. If error events also carried these fields, the per-attempt event would be the only source — but a dashboard keying on error events alone shouldn't need them for its question (debugging an exception).
- **Error events carry `err` (full message, name, cause chain)** because incident triage needs the actual exception detail. The per-attempt event intentionally omits `err` — adding it would either (a) couple the audit-log dashboard's payload size to error-detail verbosity, or (b) duplicate the `err` slot's redact-policy compliance burden (see [[pino-err-slot-sibling-bypass-redact-policy]]). The error event is the authoritative `err`-carrying surface.
- **`identifier` on bridge per-attempt events** is route-specific context for amplification-by-paper analytics. The bridge error event also omits it for the same dual-source reason above.

The asymmetry is real and load-bearing. A future "let's harmonize" refactor that aligns the field sets would either bloat the per-attempt event (regression on dashboard payload size and `err`-redact discipline) or strip context from one of the two events (regression on either amplification analytics or incident triage).

## Why This Matters

Without this rationale captured, every future architect-review of a broadcast-route change will surface adversarial findings on:
1. The structural duplication (two events for one throw)
2. Field-set divergence between the per-attempt event and the error event
3. The per-attempt event's omission of `err` on failure paths

Each finding will look correct on its face — *"two events for one failure looks like a bug"* is a reasonable initial reading. But the dismissal rationale is non-obvious and operator-domain-specific: it requires understanding what dashboards operators actually build on these events. Capturing the rule here lets future reviewers (and adversarial subagents) cite the doc, dismiss-on-cited-reasoning, and skip the re-derivation cycle.

The rule also constrains future "harmonization" refactors. A maintainer who notices the duplication and proposes a unify-into-one-event refactor would break dashboard analytics in ways that surface only after the refactor lands (silent-drift class). This doc is the trip-wire: "you're about to remove an event — read the role table first."

## When to Apply

- **Reviewing diffs that add or modify broadcast-route catch blocks.** If both `logBroadcastAttempt(...)` and `handleBroadcastError(...)` are called, that's the intended pattern, not a defect.
- **Reviewing adversarial-reviewer findings on broadcast routes.** Three known finding patterns are dismissable-on-cited-reasoning via this doc:
  - "Structural duplication of attempt + error events"
  - "Field-set drift between per-attempt event and error event"
  - "Per-attempt event omits `err` payload on failure"
- **Adding a third broadcast route** (orcid, accreditation, etc.). The role split applies: emit per-attempt events for amplification analytics, error events for incident triage. Don't combine.
- **Proposing a refactor that would suppress one of the two events on failure paths.** Read the role table; verify the dashboards that would break aren't load-bearing.

## Examples

**Failure path emitting both events (canonical pattern, `custody.ts` ~line 600):**

```ts
try {
  const tx = await sendOperations([op]);
  logBroadcastAttempt('success', { tx_id: tx.id });
  return sendOk(res, { tx_id: tx.id });
} catch (err) {
  // Per-attempt audit event: fires regardless of outcome.
  // Surface for retry-amplification dashboards. Carries op_types/op_count
  // for per-op-class partitioning. Does NOT carry err — that lives on the
  // error event below.
  logBroadcastAttempt(err instanceof BroadcastTimeoutError ? 'timeout' : 'failure');

  // Error event: fires only on failures. Surface for incident-response
  // triage. Carries full err (message, name, cause chain) via pino's
  // recursive serializer; this is the authoritative err-carrying event.
  return handleBroadcastError(err, res, {
    logContext: { username, op_types, op_count, route: 'custody.broadcast' },
  });
}
```

**Operator query (per-attempt event for amplification analytic):**

```sql
-- "Which op-classes drive retry storms on bridge.register?"
SELECT op_types, count(*) AS attempts, count(*) FILTER (WHERE outcome = 'failure') AS failures
FROM pino_events
WHERE event = 'bridge.register.attempt'
  AND ts >= now() - interval '1 hour'
GROUP BY op_types
ORDER BY failures DESC;
```

**Operator query (error event for incident triage):**

```sql
-- "What exception classes are firing on broadcast_failed in the last hour?"
SELECT err->>'name' AS err_name, err->>'message' AS err_message, count(*)
FROM pino_events
WHERE event = 'broadcast_failed'
  AND ts >= now() - interval '1 hour'
GROUP BY err->>'name', err->>'message'
ORDER BY count DESC;
```

**Anti-pattern — suppressing the per-attempt event on failure:**

```ts
// DO NOT do this
try {
  const tx = await sendOperations([op]);
  logBroadcastAttempt('success', { tx_id: tx.id });
  return sendOk(res, { tx_id: tx.id });
} catch (err) {
  // Skipping logBroadcastAttempt('failure') here "cleans up" the duplication
  // but breaks the success-rate dashboard's denominator.
  return handleBroadcastError(err, res, { logContext: {...} });
}
```

The success-rate dashboard's denominator now counts only successes; the failure-rate dashboard has to join across event labels (per-attempt for successes, error events for failures) and assume the join preserves cardinality. That assumption breaks under sampling, back-pressure, or label discrepancies — the dashboard goes wrong silently.

## Related

- [[event-label-granularity-tier-convention]] — sibling rule for the `<sub_event>` slot's tier (one catch block, one event label; label specificity must not exceed catch specificity).
- [[auth-structured-log-shape]] — establishes `event:` as the canonical aggregator discriminator. This doc refines the multi-event case for broadcast routes specifically.
- [[pino-err-slot-sibling-bypass-redact-policy]] — the `err`-slot rule that justifies keeping `err` on the error event and NOT on the per-attempt event (avoiding dual-source redact-policy compliance burden).
- [[chain-write-timeout-ambiguous-outcome]] — sibling for `outcome:` slot semantics (success/failure/timeout); applies to the per-attempt event's `outcome` field.
- Task: `backend-broadcast-attempt-helper-extraction` (archived 2026-05-13) — the review where this rationale was triaged.
- Code: `backend/src/lib/broadcast-error.ts` — `makeLogBroadcastAttempt` factory + `handleBroadcastError` co-located.
- Per-key retry counter (TODO): not yet implemented. The factory at `backend/src/lib/broadcast-error.ts:makeLogBroadcastAttempt` deliberately omits `attempt_n` until a per-key counter mechanism exists. See [[task-slug-citations-in-comments-go-stale-on-archive]] for why this is anchored on a behavioral condition rather than a task slug.

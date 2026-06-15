---
title: Operator alerting for permanent post-broadcast failures is deferred; keep the wire copy honest until it lands
date: 2026-06-15
category: conventions
module: backend/src/lib/broadcast-error.ts
problem_type: convention
component: error_handling
severity: low
applies_when:
  - "Tempted to wire PagerDuty / Slack / email alerting for permanent post-broadcast cascade failures"
  - "Editing the user-facing copy for POST_BROADCAST_OPERATOR_REQUIRED (502) or the post_broadcast_write_failed log event"
  - "A real permanent-cascade incident fires in production and the operator asks how they were supposed to find out"
  - "Reviewing a finding that 'no outbound alerting exists' for permanent post-broadcast failures"
tags:
  - alerting
  - operator
  - reliability
  - post-broadcast
  - deferred-feature
  - dedup
  - observability
related_components:
  - error_handling
  - logging
---

# Operator alerting for permanent post-broadcast failures is deferred; keep the wire copy honest until it lands

## Context

When a Hive op broadcasts successfully but the downstream cascade write fails with a class automatic reconciliation will NOT close (JS `TypeError`/`SyntaxError`/`RangeError`, or SQLSTATE class `23*`/`42*` integrity/schema-drift on the DB path), `broadcast-error.ts` classifies the failure `severity: 'permanent'` and surfaces it as a `502 POST_BROADCAST_OPERATOR_REQUIRED`. The chain op is durable; an operator must intervene to reconcile.

There is **no outbound alerting integration** in the codebase — no PagerDuty, no Slack webhook, no email. The only operator signal is `logger.error({ event: 'post_broadcast_write_failed', severity: 'permanent', ... })`. Operators learn of permanent cascades by grepping logs. Two review findings surfaced this: a reliability finding that the original wire copy "support has been notified" was a false promise (no alert fires), and an adversarial finding that even a wired alert would flood under sustained failure because the `.error` log fires once per retry with no dedup.

The user decided (2026-06-15, confirming a 2026-05-15 call): operator alerting is a **future feature, deferred indefinitely**, NOT "no alerting." It is not dismissed as out-of-scope — it is parked until alerting becomes a priority (a real permanent-cascade incident, or growth past single-instance). PEvO runs single-instance on one host with operator = self, so log-grep is an acceptable interim signal.

## Guidance

While alerting is deferred, two things must hold, and a third applies when it is eventually built:

1. **Keep the user-facing wire copy honest about the current no-alert state.** The `POST_BROADCAST_OPERATOR_REQUIRED` message must say something true for today, e.g. "please contact support" — NOT "support has been notified," which promises an alert that does not fire. The honest-passive copy is the current state; do not regress it to a false promise.

2. **Do not re-raise the deferral at routine sweeps.** The decision is recorded; the user re-elevates when the trigger fires. A standing reviewer finding of "no alerting exists" is expected, not a defect to re-file.

3. **When alerting IS wired (future), honor these constraints:**
   - **Best-effort, fire-and-forget.** Failure to alert must NOT change the HTTP response shape. The alert is a side channel, not part of the request contract.
   - **Dedup.** N retries of the same `(event, tx_id, failed_step)` triple within a short window (~5 minutes) must produce ONE alert, not N. Make the dedup key derivation predictable so the operator can read the suppressed-count alongside the primary alert.
   - **Flip the copy back to an honest "notified" variant** matching the wired backend (e.g. "operations team has been paged" for PagerDuty, "support has been notified via Slack" for a webhook), and update the SPA-facing copy in `api-contracts/common.md` if the wording changes meaningfully.
   - **Fires on `permanent` only**, never on `transient`.

The alerting-backend menu, in rough effort order, for whoever builds it later: no-alerting (log-grep, the status quo) → log-tail script (operator-side cron/systemd, no backend code) → Slack incoming-webhook (one env var, backend POSTs the structured event) → email-on-cron (persistent buffer such as a Redis list, daily digest) → PagerDuty (third-party SDK, incident lifecycle — likely overweight for single-instance beta).

## Why This Matters

The expensive failure mode is a false promise on the wire: telling a user "support has been notified" when no alert mechanism exists erodes trust precisely at the moment something went wrong. The honest-passive copy is the floor. The dedup constraint matters because the permanent-failure log fires per retry; an alerting integration without dedup would flood the operator under exactly the sustained-failure conditions where signal clarity matters most. Recording the deferral as a convention (rather than leaving a dangling blocked task) keeps the option menu and the dedup/fire-and-forget contract discoverable without a non-actionable task sitting in the queue.

## When to Apply

Consult this before wiring any outbound alerting for permanent post-broadcast failures, before editing the `POST_BROADCAST_OPERATOR_REQUIRED` user-facing copy, or when triaging a "no operator alerting exists" finding. The in-code anchor is the `severity: 'permanent'` branch and the honest-passive-copy comment in `broadcast-error.ts`; the operator-facing signal is the `post_broadcast_write_failed` log event.

## Examples

The current honest-passive wire copy (status quo, keep it honest):

```
Your operation is confirmed on Hive (tx <id>). A backend write failed and could
not be reconciled automatically; please contact support.
```

A future wired-Slack variant (only after the webhook + dedup actually exist):

```
Your operation is confirmed on Hive (tx <id>). A backend write failed; support
has been notified and will reconcile it.
```

The dedup contract, when built: three retries of `(post_broadcast_write_failed, <tx_id>, account_update)` inside the 5-minute window produce one alert carrying a suppressed-count of 2, not three separate pages.

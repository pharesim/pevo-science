# BACKEND-POST-BROADCAST-OPERATOR-ALERTING — Wire outbound alerting + dedup for `event:'post_broadcast_write_failed' severity:'permanent'`

**Owner:** backend (after user decision on alerting backend)
**Created:** 2026-05-11 (architect, batch-1 review triage of broadcast-idempotency cluster round-2)
**Status:** [BLOCKED by User-input on alerting backend]

## Context

Round-2 of `backend-broadcast-idempotency-cluster-followup` added `severity: 'transient' | 'permanent'` to `PostBroadcastWriteError` and routed `'permanent'` throws through a new 502 `POST_BROADCAST_OPERATOR_REQUIRED` HTTP code with a user-facing message that today says "support has been notified."

The message is wire-visible to SPA error pages, but **no PagerDuty, Slack webhook, email, or other outbound alerting integration exists in the codebase**. The only operator signal is `logger.error({event:'post_broadcast_write_failed', severity:'permanent', ...})`. Operators learn of permanent cascade failures only by greping logs.

Two cross-reviewer findings in batch-1 review surfaced this:
- **Reliability R1** (conf 100): "support has been notified" is a false promise; no alert mechanism actually fires.
- **Adversarial A4** (conf 65): even if alerting were wired, the current `.error` log fires once per retry with no dedup → operator dashboard would flood under sustained permanent-failure conditions.

The user-facing message accuracy fix (rename "support has been notified" to something honest about today's state, e.g. "please contact support") is filed as hold-block **item 3** on `backend-broadcast-idempotency-cluster-followup` (in `tasks/pending/`) and is NOT in this task's scope. That fix lands ahead of this task and stops the wire lie; this task is the separate work of actually wiring alerting so the eventual replacement message ("support has been notified" with real support routing) can be honest again.

## Why blocked

The alerting-backend decision is strategic and depends on the operator's preferences:
- **No alerting at all** (operator-grep is the alert): document the decision in a `solutions/conventions/` entry, dismiss this task. Keep the post-item-3 honest message ("please contact support") indefinitely.
- **Log-tail script**: minimal-effort. Operator runs a script that tails the log file and emails/notifies on `event:'post_broadcast_write_failed' severity:'permanent'`. No code change; configuration-only.
- **Slack incoming-webhook**: low-effort. Backend posts to a configured webhook URL on the event. Adds an env var (`OPERATOR_SLACK_WEBHOOK_URL`); backend HTTP POSTs the structured event payload.
- **Email-on-cron**: medium-effort. Backend writes events to a small persistent buffer (Redis list, DB table); a cron job emails the buffer contents daily.
- **PagerDuty or similar**: higher-effort. Adds a third-party SDK dependency, manages incident lifecycle (create, ack, resolve). Probably overweight for single-instance beta.

The user runs PEvO single-instance on `toolshed` with operator = self. Whether the operator wants real alerting at this stage or accepts log-greping is the gating decision.

## Acceptance (once unblocked)

1. **Pick alerting backend.** Document the choice + rationale in this task's body. If the choice is "no alerting": file a `solutions/conventions/` entry recording the decision and dismiss this task.
2. **Wire the chosen backend.** Implementation depends on choice:
   - Slack webhook: add `OPERATOR_SLACK_WEBHOOK_URL` to `.env.example` and config validation. Add a small `lib/operator-alerts.ts` helper that POSTs structured events. Wire `handleBroadcastError` `severity:'permanent'` branch to fire-and-forget the helper (the alert is best-effort; failure to alert should NOT change the HTTP response).
   - Log-tail script: write a `scripts/operator-alerts/tail-and-notify.sh` (or similar). Document operator-side cron/systemd setup in README. No backend code change.
   - Email-on-cron: add `OPERATOR_ALERT_EMAIL` env var; persistent buffer (Redis list `${appTag}:operator_alerts`); cron job in deploy.sh or a separate process.
3. **Add dedup discipline.** Whichever backend is chosen, ensure that N retries of the same `(event, tx_id, failed_step)` triple within a short window (e.g., 5 minutes) produce ONE alert, not N. The dedup key derivation should be predictable so operators can recognize the throttled-suppression count alongside the primary alert.
4. **Test the alerting path.** Unit + integration coverage that asserts: (a) the alert fires on `severity:'permanent'`, (b) it does NOT fire on `severity:'transient'`, (c) dedup correctly suppresses within-window repeats, (d) failure to alert does NOT change the HTTP response shape.
5. **Update the user-facing message back to "support has been notified"** (or whatever honest variant matches the wired backend; e.g., "operations team has been paged" for PagerDuty, "support has been notified via Slack" for webhook). This re-opens the wire-message-accuracy contract that item 3 of the cluster hold-block closed by rewriting to the post-item-3 placeholder.
6. **Update `agents/docs/api-contracts/common.md`** if the user-facing message wording changes meaningfully so SPA error-page copy aligns with the contract.

## Out of scope

- Any alerting beyond `event:'post_broadcast_write_failed' severity:'permanent'`. Other operator concerns (RC exhaustion, DB pool starvation, HAF lag spikes) are out of scope; future tasks can adopt the same infrastructure once it exists.
- Web UI for managing alerts (dashboards, ack flows). Stays log-grep + chosen-backend.

## References

- Cluster context: `agents/docs/tasks/pending/backend-broadcast-idempotency-cluster-followup.md` round-2 hold item 3.
- Architect batch-1 review findings R1 (reliability) and A4 (adversarial).

## Block transitions

Move to `tasks/pending/` when:
1. The user decides on the alerting backend (one of the options above, or "no alerting"), AND
2. Cluster hold-block item 3 has landed (the message text is now honest about today's no-alert state), AND
3. The user authorizes the implementation work.

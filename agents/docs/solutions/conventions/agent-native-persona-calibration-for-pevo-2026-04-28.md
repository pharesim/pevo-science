---
title: "ce-agent-native-reviewer persona overproduces findings for projects with no agent surface; reframe as ops/monitoring or dismiss"
date: 2026-04-28
category: conventions
module: review
problem_type: convention
component: code_review
severity: medium
applies_when:
  - "Running /ce-code-review on a PEvO diff (any role)"
  - "Triaging findings from the ce-agent-native-reviewer persona"
  - "A finding cites 'headless API agents', 'LLM clients', 'MCP consumers', 'typed-SDK consumers', 'machine-actionable URLs', or 'envelope-shape contracts for agent integration'"
  - "A finding recommends adding fields, types, or shapes whose stated beneficiary is a hypothetical non-frontend, non-operator consumer"
related_components:
  - code_review_workflow
  - architect_synthesis
tags:
  - code-review
  - agent-native
  - persona-calibration
  - ce-code-review
  - synthesis
  - architect-triage
---

# ce-agent-native-reviewer persona overproduces findings for projects with no agent surface

## Context

The compound-engineering plugin's `/ce-code-review` skill includes `ce-agent-native-reviewer` as an always-on persona. Its general philosophy ("any action a user can take, an agent can also take") is calibrated for projects that ship agent integrations: MCP servers, LLM-facing tool registries, headless SDKs, autonomous-agent products. The persona evaluates whether HTTP envelopes are structured enough for automated agents to branch on, whether response fields are machine-actionable, whether typed contracts surface for SDK consumers.

PEvO is not one of those projects today. The HTTP API has one consumer: the Alpine+Vite frontend SPA served by the same backend. There is no MCP server, no LLM-facing tool registry, no headless SDK, no third-party agent integration. ORCID linking, paper publishing, and reviewing are fundamentally human-driven scientific activities; the frontend is a browser-served UI that humans click buttons in.

Cluster A's review pass (cluster-A drain + abort-signal + handle-broadcast-error + sibling tasks, 2026-04-28) surfaced four agent-native findings whose framing assumed agent consumers PEvO does not have:
- **`verify_location: '/settings'` not actionable for headless agents** — `/settings` is a human-only UI page; the relative path resolves natively in the frontend SPA, the only consumer.
- **`details: Record<string, unknown>` lacks typed interface** — the frontend is JS, not TS; backend-side typed envelope interfaces would not propagate to the consumer.
- **Aborted requests log only at `debug`** — real ops concern, but framed as agent-blindness rather than operator-blindness.
- **503 shutdown vs queue-saturation indistinguishable** — real ops concern (canary monitors), but framed as agent-branching rather than ops-discrimination.

Two of the four were dismissed entirely; two were kept after reframing to ops/monitoring. The pattern is consistent: the persona's lens fits projects with agent integrations and overproduces noise on projects without them.

## Guidance

**Architect triage of /ce-code-review findings on PEvO must apply the API Consumer Surface filter (root `CLAUDE.md`).** Specifically:

1. When a finding cites "headless agents", "LLM clients", "MCP consumers", "typed-SDK consumers", or recommends fields/shapes whose stated beneficiary is a non-frontend, non-operator consumer, **reframe or dismiss** before walking the finding through user-triage.

2. **Reframe is appropriate** when the finding has a real consumer that *is* present today, even if not the one the persona named. The two reframes that fit PEvO:
   - **Ops/monitoring tooling** (canary monitors, status probes, log correlation, automated rollback) — these consume HTTP responses and log streams, and represent the closest analog to "agents" against PEvO's API today.
   - **Frontend ergonomics** — sometimes a finding about "consumer typed contracts" is really a frontend-types concern. The PEvO frontend is JS, not TS, so this rarely applies, but it's the second-most-likely real consumer.

3. **Dismiss is appropriate** when reframing does not produce a real consumer:
   - The finding assumes typed-SDK consumers (PEvO ships no SDK).
   - The finding assumes MCP/LLM tool consumers (PEvO has no MCP server and is not exposed as agent tools).
   - The finding adds fields/shapes purely for hypothetical future integrators (YAGNI per the beta-stability stance in `agents/docs/api-contracts/common.md`).

4. **Do not dismiss reflexively.** Some findings are genuinely useful even when the persona's framing is overreach — finding #6 (abort-event log invisibility) and finding #9 (503 shutdown-vs-saturation discrimination) from the cluster A pass are both real ops concerns that deserved follow-up tasks. The reframe filter sorts by *whether a real consumer exists*, not by *whether the persona said "agent"*.

## When to apply

1. The architect is synthesizing `/ce-code-review` results before walking findings through user-triage.
2. The finding originates from `ce-agent-native-reviewer` (or any reviewer adopting the agent-native lens).
3. The finding's stated beneficiary is a consumer not present in PEvO today.

Apply the filter:
- **Real consumer (frontend or ops)** -> reframe and surface to triage with the consumer named explicitly.
- **No real consumer** -> dismiss with rationale "agent-native overreach; no consumer surface in PEvO today" before reaching triage.

## Why this matters

Persona overreach without filtering inflates triage queues with non-issues, taxing the user's attention budget, and risks normalizing dismissal at triage time (which then causes legitimate findings to be dismissed alongside noise). Filtering at synthesis time keeps triage focused on findings the user can act on.

The filter also keeps the persona honest: the cases where it *is* right (ops monitoring, future agent integration) survive the filter. Cluster A's findings #6 and #9 made it through with a reframe; #11 and #12 were dismissed. That's the calibration the persona needs against this project.

## Future revisit

If PEvO ever ships an MCP server, an LLM-facing tool registry, a headless SDK, or a typed TypeScript frontend, this learning becomes obsolete and the persona's general framing becomes correct. Update or supersede this entry at that time.

## Related

- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — same general shape (persona overproduction risks calibration drift); different mechanism (audit completeness rather than consumer fit).
- Root `CLAUDE.md` "API Consumer Surface" — the project-fact this learning leans on. Do not let one drift away from the other.

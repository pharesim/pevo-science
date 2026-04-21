---
title: "Backend does not edit agents/docs/api-contracts/*.md — architect owns contracts"
date: 2026-04-21
category: conventions
module: agents/docs/api-contracts
problem_type: convention
component: agent_coordination
severity: high
applies_when:
  - "A backend route change alters a request/response shape, status code, auth requirement, or error code"
  - "A backend task moves to Review and the change requires a prose or example update in an api-contract file"
  - "Temptation to edit agents/docs/api-contracts/*.md directly from the backend lane to keep docs in sync"
related_components:
  - architect
  - backend
tags: [api-contracts, agent-boundaries, lane-crossing, SEC-002-BE]
---

## Rule

The backend agent MUST NOT edit files under `agents/docs/api-contracts/*.md`. Those files are owned by the architect agent.

When a backend route change requires a contract update, append a `[TODO Architect]` note on the Review-section entry of the task in `agents/docs/TASKS.md` describing the prose or example change required. The architect updates the contract during review, before archiving.

## Why

Silent lane crossings happened on the SEC-002-BE task and prior tasks: the backend agent edited `api-contracts/*.md` directly to keep docs matching its own implementation, which (a) bypassed the architect's review of the contract wording, (b) made it impossible for the architect to detect that a contract change had happened (the diff belonged to the backend), and (c) caused the contract prose to drift toward implementation jargon instead of user-facing spec language.

Keeping the contract edit in the architect's lane forces a coherent review pass where contract wording and implementation are checked against each other by a different agent.

## How to apply

- Backend moves task to Review with a `[TODO Architect]` note listing the needed contract deltas (endpoint, field added/removed/renamed, shape change, status code change).
- Architect reviews the diff, updates the contract file during the same review cycle, then archives.
- If the architect holds the task pending fixes, the contract update stays in the architect's hold-block feedback, not in the backend's re-review signal.

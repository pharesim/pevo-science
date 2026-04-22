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

## Hold-block split rule (added 2026-04-22)

Three architect review passes in a row (BE-DISCIPLINE-CANONICALIZE, BE-ORCID-TOCTOU-LOCK, plus one earlier) produced hold blocks that *appeared* to delegate a contract edit back to the backend via phrasing like "apply X and update `api-contracts/Y.md` to match." In each case the backend correctly applied the edit (the hold block read as authorization), and in each case the next reviewer flagged it as a boundary violation. The phrasing was the architect's mistake.

Clarification, now mirrored in `agents/backend/CLAUDE.md` Boundaries:

- Hold-block items that need both code and contract changes **always split** into two lanes: the backend lands the code in its round-N fix commit; the architect lands the contract edit during the archive pass.
- "Do NOT edit `agents/docs/api-contracts/*.md`" is categorical. A hold-block item asking backend to update a contract is the architect's phrasing error; treat it as "backend lands the code; architect lands the contract" and leave the contract file untouched from the backend lane.
- If the required code change is unclear without the contract context, move the task to `blocked/` with a `[BLOCKED by Architect]` note asking for disambiguation instead of editing the contract yourself.

This removes the recurring "hold-block authorized the edit, but the boundary rule is categorical" ambiguity that cost reviewer cycles on three tasks.

---
title: Reviewer discovery pattern — when reviewing error-classification tasks, look one error class up
date: 2026-05-18
category: conventions
module: code-review + frontend/src/pages
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - Reviewing a task that classifies async errors into recovery paths (retry vs consume-quota-slot vs user-action)
  - Reviewing a fix that branches on an error envelope's `code` or `details.retriable` field
  - A failure mode burns a constrained quota slot (rate-limited endpoint, finite-budget action) on the wrong path
  - Adversarial reviewer surfaces a cascade adjacent to the one a task was scoped around
  - Brainstorming or task-scoping work on async-error-classification features
tags: [code-review, error-classification, reviewer-heuristic, cascade-discovery, retriable-errors, accreditation, quota-protection, task-scoping]
---

# Reviewer discovery pattern — when reviewing error-classification tasks, look one error class up

## Context

In async client-server flows where errors are classified into recovery paths and a constrained downstream resource (a quota slot, a rate-limited action, an irreversible state transition) is reached by a uniform "not retriable" fallback, each task that fixes the cascade at one error class tends to surface the next adjacent class one round later. The pattern is invisible if you only look at the task in hand. It's visible the moment you ask "what's the next error class up?"

PEvO's accreditation-verify work landed across three rounds (2026-05-16 to 2026-05-18). Each round fixed an error-handling cascade and surfaced the next adjacent one:

- **Cascade A** — task `ui-accreditation-verify-retriable-handling` (archived 2026-05-17): backend-emitted retriable envelopes (`503 ACCREDITATION_GATE_UNAVAILABLE`) were routing to a "Request New" CTA, burning 1 of 3/24h `/accreditation/request` slots, re-emailing the user, and producing 5+ confused clicks before they realized their accreditation actually succeeded. Fix: SPA branches on `err.code === 'ACCREDITATION_GATE_UNAVAILABLE'` or `err.details?.retriable === true` → Retry CTA instead of "Request New".

- **Cascade B** — task `ui-accreditation-verify-network-error-retriable` (round-2 hold as of 2026-05-18): fetch-layer errors (`TypeError` from offline/DNS/CORS, `AbortError` from the 30s fetch timeout) — one error class UP from envelope-wrapped errors — routed to the same "Request New" path. Fix: SPA's `_isNetworkError(err)` discriminator on `err?.name` → Retry CTA. The follow-up task was filed because the original task's `/ce-code-review` finding #5 noticed that `_isRetriable` only handled envelope-wrapped errors and asked "what about raw `TypeError`?"

- **Cascade C** — surfaced 2026-05-18 by the adversarial reviewer during architect review of cascade B's commit. `AbortError`-after-server-success: fetch reaches server, broadcast commits, `deleteToken` runs, response is lost (AbortError at 30s timeout). User clicks Retry on the now-deleted token → backend returns `400 BAD_REQUEST` → SPA classifies as `ApiRequestError` (not retriable, not network) → falls through to "Request New" → burns slot. Cascade B+A's failure mode displaced one MORE error class up. Filed as `backend-verify-post-success-retry-idempotency` for a grace-period record fix.

Three rounds, three correct fixes, one cascade chain. Each fix was correct in scope. None over-reached.

## Guidance

When reviewing — or scoping — a task that classifies errors into recovery paths, walk the error-class stack outward from the layer the task addresses and ask three questions:

1. **What is the next error class up the stack from the one being fixed?** Move from inside-out: handler-emitted envelope → fetch-layer (`TypeError`, `AbortError`) → after-success-but-response-lost.
2. **Does that next class produce the same downstream cascade?** If the recovery branch is uniform on "not retriable → \[burns quota slot / triggers user-action / loses progress\]", every unfixed layer above the most-recently-fixed one inherits the cascade.
3. **Should the task scope expand to fix N + N+1, or is N+1 an explicit follow-up?** Make the decision explicit at scoping time. Don't let it surface only at review time, round after round.

The error-class stack is the discovery axis. A typical fetch-then-handler call stratifies as:

1. Validation errors (4xx envelope from schema check / authz).
2. Server errors with retriable signaling (5xx envelope, `details.retriable: true`, `code: SERVICE_UNAVAILABLE`).
3. Server errors without retriable signaling (5xx envelope, generic).
4. Fetch-layer errors (`TypeError`, `AbortError`).
5. After-success-but-response-lost (server committed, client got step 4 error, retry sees post-success state).

Each layer can route to the same downstream CTA ("burn a quota slot", "Request New", "log out the user", "redirect to home") if the recovery path is uniform on a single-axis predicate.

The heuristic fires at two moments:

- **Task-scoping time** (architect, `/ce-plan`, `/ce-brainstorm`): leftmost catch, cheapest. Map the cascade chain at the outset; decide which classes go in this task vs. queued as siblings.
- **Review time** (`/ce-code-review` adversarial reviewer, architect re-review): backstop. The adversarial reviewer naturally catches these because it constructs failure scenarios — but only after the implementer has landed.

## Why This Matters

Each cascade round produces a correct, well-scoped fix. None of the round-by-round fixes are wrong. But the cumulative trajectory — one cascade per cycle, each fix surfacing the next — is predictable churn that upfront scoping can collapse. The user pays for three review-then-fix-then-re-review cycles when one scoping conversation could have authored a single broader task or three explicit sibling tasks with the cascade chain mapped at the outset.

PEvO's accreditation-verify cascade chain consumed three architect review passes, three implementer rounds, and one architect brainstorm follow-up to traverse three error classes. The leftmost catch — asking "what's the next error class up?" at cascade-A scoping time — would have surfaced cascades B and C as explicit sibling-or-included items in one decision.

## When to Apply

Apply at both task-scoping time AND review time on tasks that meet all three criteria:

- Classify async errors into recovery paths in client-side or client+backend code.
- Have a uniform downstream cascade gated on a single-axis predicate ("not retriable", "user-input required", "give up").
- Touch a constrained resource (quota slot, rate-limited mutation, irreversible state, finite budget) at the end of the fallback path.

Skip when:

- The cascade is not uniform — each error class has a distinct, well-fitted recovery path. The discovery axis doesn't apply.
- There is no constrained downstream resource. If the fallback is idempotent and free, repeated cascades cost only UX confusion, not real resource burn.
- The task is explicitly scoped to one error class with the chain mapped elsewhere (e.g., the brainstorm doc already enumerates siblings). In that case the heuristic was applied at scoping time; review-time just verifies the partition.

## Examples

PEvO's accreditation-verify three-round trajectory is the worked example (see Context section). At cascade A's scoping time, the architect would have asked:

- **Q1:** What's the next error class up from "backend-emitted retriable envelope"? Answer: fetch-layer errors (`TypeError`, `AbortError`).
- **Q2:** Does fetch-layer produce the same cascade? Yes — same `_isRetriable === false` branch routes to "Request New" → burns slot.
- **Q3:** Fix in this task or queue?

A reasonable answer at scoping time would have been "queue B as a sibling task; fix A here". That's exactly what would have produced the same outcome as the actual trajectory, but with cascade B filed BEFORE round-2 of cascade A landed. Cascade C would have surfaced at cascade B's scoping moment (one error class up from fetch-layer is "fetch reached server but response lost") and been queued the same way.

Three correct fixes. One cascade chain. Three rounds of architect review compressed into one scoping conversation.

## Related conventions

- `agents/docs/solutions/conventions/cascade-fns-rethrow-permanent-errors-2026-05-16.md` — implementer-side counterpart: cascade functions must filter throws and only re-throw permanent-class errors so the recovery-path discriminator routes correctly. This convention applies the reviewer lens to the same routing axis.
- `agents/docs/solutions/conventions/route-level-error-class-coverage-after-helper-extraction-2026-04-29.md` — same "enumerate error subclasses" muscle, applied to test coverage. Helper-level tests don't cover route-level error-class coverage; each concrete subclass needs its own integration test.
- `agents/docs/solutions/conventions/cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md` — sibling reviewer-discovery convention: when adding a gate at one site, audit all sibling composition sites in the same file before declaring "Items NOT in scope".
- `agents/docs/solutions/conventions/architect-hold-block-risk-class-separation-2026-05-07.md` — when the adjacent cascade is genuinely a different risk class, file as a separate task rather than bundling.
- `agents/docs/solutions/conventions/auth-gate-revives-pre-existing-read-side-oracle-2026-05-17.md` — same shape applied to a different axis: the defect lives adjacent to the change, reviewer must look one step out.
- `agents/docs/solutions/conventions/frontend-error-sanitization-2026-04-21.md` — frontend error-handling surface (`ApiRequestError`, `err.message`, x-text bindings) where these cascades live.

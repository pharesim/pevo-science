---
title: Defensive gates must co-land their SPA-reachable un-blocking surface, or be feature-flagged off until it lands
date: 2026-05-16
category: conventions
module: backend
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - Adding a code path that closes-default on a new required input (fresh-auth proof, capability token, rate-limit-bypass token, feature-flag check, etc.)
  - Reviewing a backend task that introduces a new gate without also widening the SPA-reachable endpoint that produces the gate's pass-condition
  - Scoping a task split between "gate now, mint/issue/check later" — that split is the footgun this convention exists to catch
  - Approving a task whose integration tests use the lib-level primitive directly instead of the SPA-reachable round-trip
  - Architect review of any new defensive-security surface where the consume side and the mint/issue side live in different routes
tags:
  - task-design
  - architect-review-cycle
  - defensive-security
  - fresh-auth
  - feature-flag
  - co-land-discipline
  - mint-vs-consume
---

# Defensive gates must co-land their SPA-reachable un-blocking surface, or be feature-flagged off until it lands

## Context

When a backend agent adds a defensive gate — code that closes-default on a new required input the SPA must obtain through a separate endpoint — the gate's pass-condition has two halves: the **consume side** (the route that checks the input) and the **mint/issue side** (the SPA-reachable route that produces the input). It is natural to scope these as separate tasks because they touch different files and have independent test surfaces.

This convention exists because that scoping is a footgun. Splitting "consume now, mint later" produces a closed-default state that closes the security gap by also closing the feature.

## Guidance

**When designing or reviewing a defensive-gate task, the consume side and the SPA-reachable mint/issue side MUST land in the same commit or PR — OR the gate MUST be feature-flagged off until both sides land.** No third option. Architect review of a defensive-gate task must explicitly verify both halves before approving the scope; backend implementation must not split them across separate commits without the feature flag.

Concretely, the architect-side checks before approving a defensive-gate task scope:

1. Identify the route(s) the SPA will call to obtain the input the gate requires.
2. Verify those routes accept the new input shape (action enum, body field, capability type) the gate consumes.
3. If they don't, either: widen the task to cover both sides in one commit, OR require a runtime feature flag on the gate that defaults closed in production until a follow-up commit widens the mint surface.
4. Integration tests must exercise the SPA-reachable round-trip, not just the lib-level primitive bypass. A test that uses `issueFreshAuthToken` directly (or the moral equivalent at any other gate's primitive) does not prove the SPA can reach the happy path.

The implementer's signal block flagging an "out-of-scope deferral" is not sufficient mitigation by itself. Out-of-scope deferrals are normal task hygiene; they don't license the architect to approve a scope that ships a closed-default outage.

## Why This Matters

Defensive gates and SPA-reachable mint surfaces share a coordination property that's invisible from inside either route's code: the *feature* is reachable only when both halves agree on the input shape. A gate-only commit closes the security gap perfectly — and closes the feature perfectly too. A future architect or reviewer looking at the gate code in isolation sees correct logic, passing tests, sound state-machine handling, and no obvious defect. The user-visible defect ("change-email returns 401 FRESH_AUTH_REQUIRED forever for every user") lives in the gap between "tests pass" and "SPA can actually use the feature."

The closed-default-is-secure framing makes this especially easy to rationalize. The argument "the security gap is closed; the feature being unreachable is a temporary inconvenience" is technically correct and operationally wrong: deploying a known-broken feature to production fails users and reduces the credibility of future defensive work (operators learn that "security fix" means "feature break" and start pushing back on the next legitimate gate). The feature flag is the cheap mitigation; co-landing is the correct one when feasible.

## When to Apply

- New fresh-auth gates on routes that require a proof minted at a separate route (`set_password`, `change_email`, and any future per-state mechanism gate).
- New capability-token gates where the token is issued by a sibling route.
- New rate-limit-bypass surfaces where the bypass token is minted elsewhere.
- New feature-gated endpoints where the feature check is performed against a value the SPA must read from another route first.
- Any task whose acceptance criteria include "verifies the consume side" but not "verifies the SPA can complete the round-trip end-to-end."

## Examples

**Originating incident (2026-05-16):** `BACKEND-SETTINGS-EMAIL-REAUTH-FRESH-AUTH` (commit `b27bcdf`, archived in `agents/docs/tasks-archive.md`) landed the consume side of the change-email fresh-auth gate. The gate closes the JWT-only takeover chain (stolen JWT → change email to attacker address → /auth/reset-request → /auth/reset → password under attacker control → /custody/broadcast as victim). The implementation is correct: per-state mechanism matrix is right, target-binding collision-freedom holds, test coverage is good. But `POST /api/orcid/start` and `POST /api/custody/fresh-auth` both 400-reject `action: 'change_email'`. The SPA cannot mint the proof. Every State A/B/C/D JWT-path attempt to change email returns 401 FRESH_AUTH_REQUIRED with `details.reason: 'missing'` — the feature is unreachable.

The integration tests at `backend/tests/routes/settings-email-fresh-auth.test.ts` mint proofs via `issueFreshAuthToken` directly, bypassing the SPA-reachable mint surface. The suite passes end-to-end. The implementer's signal block flagged the deferral as "out-of-scope item #1." The architect approved the task scope. The defect was caught at archive-time `/ce-code-review` by the adversarial persona explicitly constructing "what does the SPA actually see today" — not by any earlier review checkpoint.

The follow-up filed to close the gap (`backend-change-email-mint-path-and-followups.md` in `tasks/pending/`, commit `37c9c52`) is the corrective work. The convention exists to prevent the next time.

**Counter-example (the same architect cycle, same fresh-auth primitive):** `BACKEND-SETTINGS-SET-PASSWORD-FRESH-AUTH` (commit `9818e32`) added `set_password` to the orcid `/start` action enum in the same commit that gated the consume side. Mint and consume co-landed; the SPA-reachable round-trip works end-to-end. This is what the convention prescribes.

## Related

- [[hive-signature-request-binding-shape-2026-04-21]] — sibling defensive layer (replay/forgery defense at the middleware) — useful cross-reference for understanding the gate's full composition with the transport-layer auth.
- [[timing-equalization-sub-branch-oracles-2026-04-21]] — another "did you think about this when adding a gate" convention; same shape of "the obvious code is correct; the gap is in what's missing around it."
- `agents/docs/ARCHITECTURE.md` § 6.4 (re-auth contract this gate implements) and § 6.5 invariant #1 (the rule the gate enforces).
- `agents/docs/tasks-archive.md` BACKEND-SETTINGS-EMAIL-REAUTH-FRESH-AUTH (archived 2026-05-16 in commit `492d8e9`) — full archive entry.
- `agents/docs/tasks/pending/backend-change-email-mint-path-and-followups.md` — the corrective follow-up.

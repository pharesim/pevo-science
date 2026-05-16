---
title: "Backend implementer signals must include `[TODO UI]` when changing a wire shape the SPA consumes"
date: 2026-05-16
category: conventions
module: coordination
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - "A backend route change alters request body, response envelope, required fields, error codes, or status-code semantics for an endpoint the SPA calls"
  - "A backend task moves to `tasks/review/` carrying a wire-shape change without coordinating SPA call sites"
  - "Temptation to defer SPA-call-site enumeration to architect-triage instead of running it at implementer signal-block-write time"
related_components:
  - implementer-signal-block
  - api-contracts
  - frontend-spa
  - architect-review-cycle
tags:
  - workflow
  - implementer-signal
  - wire-contract
  - frontend-coordination
  - code-review-gap
  - todo-block
  - cross-agent-handoff
---

# Backend implementer signals must include `[TODO UI]` when changing a wire shape the SPA consumes

## Context

On 2026-05-16 the architect-cycle surfaced two P0 frontend-coordination gaps in a single triage batch. Both followed an identical failure pattern: a backend task closed a security gap by changing a wire shape the SPA actively consumes, the implementer signal flagged contract docs for the architect but said nothing about the SPA, and the gap surfaced only when `ce-api-contract-reviewer` ran during architect-triage. By that point the backend was already in `tasks/review/` and the SPA was broken for every light-account user.

The two cases:

- **Commit `84602f8`** (`backend-custody-broadcast-orcid-fresh-auth`): made `fresh_auth_proof` required on every `POST /api/custody/broadcast` call to close § 6.5 invariant #1 (JWT-alone takeover vector). Seven SPA call sites — `frontend/src/signer.js:16-23` and its callers `publish.js`, `review.js`, `comment-composer.js`, `paper-detail.js`, `vote-buttons.js`, `edit.js`, `vouch-section.js` — still send `{ operations }` with no proof. The implementer signal had two `[TODO Architect]` markers for contract-doc updates, zero `[TODO UI]`.
- **Commit `1f1be4e`** (`backend-custody-upgrade-seed-phrase-reauth`): replaced `POST /api/custody/upgrade` body from `{ password }` to `{ derived_pubkey, signed_proof, signed_at }` per § 6.4 contract. SPA at `frontend/src/pages/settings.js:744` still sends `{ password }`; `:656` still gates on `!this.upgradePassword`; `:809` treats the new 503 as non-retriable (inverted semantics). The implementer signal had `[TODO Architect]` for the contract doc, zero `[TODO UI]`.

Both cases produced immediate P0 user-facing breakage: every light-account user blocked from publish, comment, vote, and upgrade flows. Architect-cycle resolution filed `ui-custody-upgrade-seed-phrase-derive-flow.md`, `ui-non-consent-broadcast-fresh-auth-wiring.md`, and `backend-custody-session-auth-password-mint.md` into `tasks/pending/`, and five backend tasks moved to round-2/3/4 holds.

This convention extends the established `[TODO Architect]` discipline (see `backend-api-contracts-are-architect-owned-2026-04-21.md`) to a second cross-zone handoff direction: backend → UI. The parent rule's framing — implementer surfaces lane-crossing work at signal time so the receiving agent sees it without architect-triage routing — applies identically here.

## Guidance

When a backend task changes a wire shape the SPA consumes, the implementer signal MUST include one of the following — not both, not neither:

### Path (a): `[TODO UI]` block in the implementer signal

A `[TODO UI]` block mirrors the `[TODO Architect]` shape and enumerates the affected SPA call sites by path and (where useful) line:

```
[TODO UI]
Wire-shape change: POST /api/custody/broadcast now requires `fresh_auth_proof` on every call (previously only on consent-op bundles). 401 with code `fresh_auth_required` returned when missing.

Affected SPA call sites:
- frontend/src/signer.js:16-23 (broadcastOps helper — root of the gap)
- frontend/src/pages/publish.js (calls broadcastOps for comment op)
- frontend/src/pages/review.js (calls broadcastOps for review comment)
- frontend/src/pages/edit.js (calls broadcastOps for edit comment)
- frontend/src/components/comment-composer.js
- frontend/src/components/vote-buttons.js
- frontend/src/components/vouch-section.js
- frontend/src/pages/paper-detail.js

UI work: thread a fresh-auth proof through broadcastOps and every caller.
```

### Path (b): sibling `ui-*` task filed directly

A sibling task in `agents/docs/tasks/pending/ui-<kebab-summary>.md` with the call-site enumeration inside it, referenced from the implementer signal by filename. Examples filed during the 2026-05-16 cycle: `ui-non-consent-broadcast-fresh-auth-wiring.md`, `ui-custody-upgrade-seed-phrase-derive-flow.md`.

### Which path

- **Path (a) `[TODO UI]` block** when the UI work is mechanical and well-scoped (thread an existing primitive through existing call sites; rename a body field; flip an error-handling branch). The UI agent picks it up at its next `tasks/pending/` listing scan without the architect-triage routing step.
- **Path (b) filed task** when the UI work has its own design surface (new form fields, new client-side crypto helpers, new error-state UX, new state-machine arms). The dedicated task file gives the UI agent room to design without rooting around in the backend task's signal block.

### How to produce the call-site list

Grep `frontend/src/` for the affected endpoint path AND for any helper that fan-outs to it:

```bash
grep -rn "api/custody/broadcast" frontend/src/
grep -rn "broadcastOps" frontend/src/          # transitive helper consumers
```

Trace through helpers (e.g. `broadcastOps()` in `signer.js`) to enumerate the transitive caller set, not just the direct fetch sites. The enumeration is the load-bearing artifact: a `[TODO UI]` block that says "the SPA needs updating" without naming the paths is not a signal, it's a hand-wave.

If `grep` returns no SPA consumers, write the block anyway with `Affected SPA call sites: none — endpoint not consumed by the SPA, verified via grep at <date>`. The absence is then a positive assertion at architect-triage, not silence.

## Why This Matters

PEvO's agent coordination rules (root `CLAUDE.md` Agent Coordination Rule #2) constrain the backend agent's zone to `backend/`; `frontend/src/` is outside it. The `commit-msg` zone-audit hook (`.githooks/commit-msg`'s `allowed_for_agent()`) enforces this mechanically — a backend-prefix commit staging `frontend/src/*.js` is rejected. This is intentional: it prevents backend changes from drive-by-editing UI without UI-agent review.

The consequence is that **SPA call sites are invisible to backend-zone code review**. When `/ce-code-review` runs against a backend task in `review/`, its diff context is the backend zone; it can flag "this changes a wire shape" but it cannot enumerate which SPA call sites break. Only `ce-api-contract-reviewer`, which reads `agents/docs/api-contracts/*.md` and cross-references the SPA, surfaces the gap — and that runs at architect-triage, after the backend task has already landed in `tasks/review/`.

Without a `[TODO UI]` signal at implementer-time, the architect at triage faces three bad options:

1. **Hold the backend back to `pending/`** with a re-review block asking the implementer to file the UI signal. Wastes a round-trip on routing work the implementer should have done.
2. **File the UI task themselves.** Pulls the architect into per-task UI coordination, which scales badly across a multi-task cycle.
3. **Archive the backend with an outstanding integration gap.** Ships the wire-shape change with the SPA broken, producing immediate P0 user-facing breakage.

Option 3 is what the two 2026-05-16 cases would have produced if `ce-api-contract-reviewer` hadn't caught them. The discipline of the `[TODO UI]` signal moves the routing work to the agent that has the diff context to produce it — the backend implementer who just edited the route handler knows what shape changed and can grep the SPA to enumerate consumers in minutes.

A second-order benefit: the `[TODO UI]` block also catches the failure mode where the wire shape changes but no SPA caller exists yet (purely server-to-server endpoints, or endpoints behind a feature flag). Today such a gap is invisible until a future SPA change lands. With the discipline, the implementer either writes "no SPA consumers" as a positive assertion, or names the call sites — there is no silent third option.

## When to Apply

This discipline triggers on backend changes that alter the contract observable by the SPA:

- **Request body shape** — added required field, removed field, renamed field, type change of a consumed field.
- **Response envelope** — shape change in `{ status, data, error }` or domain-specific response payload the SPA renders.
- **New required field** — any field the route now requires that it did not require before.
- **New error code or error shape** — SPA's error-handling switch needs the new arm.
- **Status-code semantics** — e.g. 503 changing from "retry" to "non-retriable", or 401 gaining a new `code` discriminator.
- **Query-string semantics** — new required query param, renamed param, changed param-value space.
- **Auth requirements** — added/changed auth header, new re-auth shape (`fresh_auth_proof`, signed challenges, etc.).

This discipline does NOT trigger on:

- Internal refactors that preserve the wire shape exactly.
- Log-line additions or changes (operator-facing, not SPA-facing).
- Test-only changes (no production wire impact).
- SQL/migration changes that don't surface through an API change.
- Performance changes (cache TTL, query-plan changes) that don't alter the response.

The bright-line test: if `curl`ing the endpoint before and after the change would produce a different response shape, status code, or error code for any input the SPA sends, the discipline applies. If responses are byte-identical for all SPA-reachable inputs, it does not.

## Examples

### Example 1: Commit `84602f8` (custody-broadcast-orcid-fresh-auth)

**What was written (insufficient):**

```
[TODO Architect]
Update agents/docs/api-contracts/custody.md /broadcast section:
- Document fresh_auth_proof as required on every call
- Document 401 fresh_auth_required error code
```

**What should have been written (path (a) — `[TODO UI]` block):**

```
[TODO Architect]
Update agents/docs/api-contracts/custody.md /broadcast section:
- Document fresh_auth_proof as required on every call
- Document 401 fresh_auth_required error code

[TODO UI]
Wire-shape change: POST /api/custody/broadcast now requires `fresh_auth_proof`
on every call (was: only on consent-op bundles). Returns 401 with code
`fresh_auth_required` when missing.

Affected SPA call sites (grep'd from frontend/src/ for /api/custody/broadcast
and transitive callers of broadcastOps()):
- frontend/src/signer.js:16-23 (broadcastOps helper — root)
- frontend/src/pages/publish.js
- frontend/src/pages/review.js
- frontend/src/pages/edit.js
- frontend/src/pages/paper-detail.js
- frontend/src/components/comment-composer.js
- frontend/src/components/vote-buttons.js
- frontend/src/components/vouch-section.js

UI work: thread fresh-auth proof through broadcastOps and every caller.
Light-account users blocked from publish/comment/vote until this lands.
```

**Alternative (path (b) — filed task):** `agents/docs/tasks/pending/ui-non-consent-broadcast-fresh-auth-wiring.md` referenced from the signal by filename. Task body enumerates the same eight call sites plus the proof-acquisition flow design. Path (b) was the right choice here in retrospect — the UI work involves new proof-mint UX, not just threading a value, so a dedicated task file scales better than a `[TODO UI]` block.

### Example 2: Commit `1f1be4e` (custody-upgrade-seed-phrase-reauth)

**What was written (insufficient):**

```
[TODO Architect]
Update agents/docs/api-contracts/custody.md /upgrade section:
- Replace body schema from { password } to { derived_pubkey, signed_proof, signed_at }
- Document seed-phrase-derived pubkey as upgrade proof
- Document new 503 semantics
```

**What should have been written:**

```
[TODO Architect]
Update agents/docs/api-contracts/custody.md /upgrade section:
- Replace body schema from { password } to { derived_pubkey, signed_proof, signed_at }
- Document seed-phrase-derived pubkey as upgrade proof
- Document new 503 semantics

[TODO UI]
Wire-shape change: POST /api/custody/upgrade body changed from { password }
to { derived_pubkey, signed_proof, signed_at }. 503 status now means
non-retriable (was: retriable).

Affected SPA call sites (grep'd from frontend/src/ for /api/custody/upgrade):
- frontend/src/pages/settings.js:744 (POST body — currently sends { password })
- frontend/src/pages/settings.js:656 (gate currently uses !this.upgradePassword)
- frontend/src/pages/settings.js:809 (503 handling — semantics inverted)

UI work: derive pubkey from seed phrase client-side, sign upgrade challenge,
send new body shape; remove password field from upgrade form; flip 503
handling. Light-account users blocked from upgrade until this lands.
```

**Alternative (path (b) — filed task):** `agents/docs/tasks/pending/ui-custody-upgrade-seed-phrase-derive-flow.md` referenced from the signal. Path (b) was the right choice here too — the UI work introduces a new client-side seed-phrase derivation surface, which warrants design space.

## Related

- `agents/docs/solutions/conventions/backend-api-contracts-are-architect-owned-2026-04-21.md` — the precedent `[TODO Architect]` discipline this convention extends. Same shape, different receiving agent.
- `agents/docs/solutions/conventions/cross-task-hold-block-staleness-2026-04-22.md` — staleness failure mode that this convention prevents from the OTHER direction (backend signaling coordination need before SPA-consumer migration drifts mid-cycle).
- `agents/docs/solutions/conventions/load-bearing-greps-at-signal-block-write-time-2026-05-06.md` — temporal sibling: load-bearing audit work runs at signal-block-write time, not deferred to architect intake. The `[TODO UI]` grep is one instance.
- `agents/docs/solutions/conventions/architect-hold-block-risk-class-separation-2026-05-07.md` — establishes "file a separate task when the risk class is disjoint." Path (b) (sibling `ui-*` task) inherits this disposition pattern directly.
- `agents/docs/solutions/conventions/sql-semantic-shift-cross-surface-audit-2026-05-12.md` — heavier audit checklist when SPA-side fallout is mechanical and multi-layer. This convention is the lighter signal-shape rule; that one is the deeper audit for a specific change class.
- Root `CLAUDE.md` "API consumer surface is the frontend SPA" — the grounding fact that makes this rule load-bearing (SPA is the sole consumer in beta).

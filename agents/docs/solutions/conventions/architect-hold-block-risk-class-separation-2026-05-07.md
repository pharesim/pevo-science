---
title: Architect hold-block separates items by risk class before bundling
date: 2026-05-07
category: conventions
module: agent-coordination
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - Architect re-review on a `tasks/review/` task that produces surviving findings
  - "`/ce-code-review` returned findings spanning multiple persona lenses (some disjoint from the originating task's load-bearing concern)"
  - Held task has reached round 3+ and the surviving finding surface is shifting away from the originating risk class
  - Surviving finding is in a clearly disjoint risk class (naming, JSDoc, helper extraction, sibling-code-path canaries, doc updates)
  - Originating task's diff has stopped shrinking round-over-round but new findings keep arriving
tags:
  - agent-coordination
  - architect-protocol
  - code-review
  - hold-block
  - risk-class
  - token-budget
  - re-review
related_components:
  - documentation
  - tooling
---

# Architect hold-block separates items by risk class before bundling

## Context

The architect's review of a held task in `agents/docs/tasks/review/` rests on a single mechanism: invoke `/ce-code-review` against the round's diff (the architect MUST do this — it is not substitutable by manual reading), triage the findings with the user (root `CLAUDE.md` "Code Review Findings"), then either archive the task or roll the surviving findings into an `Architect re-review (<date>) — HELD PENDING FIXES:` block per root `CLAUDE.md` rule #8 and `git mv` the file back to `tasks/pending/`.

The default behavior at the bundling step is to roll *every* surviving finding into a single hold block on the originating task. That default is wrong when the surviving findings are heterogeneous in risk class.

A `/ce-code-review` pass dispatches 6–11 persona subagents in parallel; each re-reads the diff and produces findings within its lens. The persona set the architect chose for the originating task is calibrated to the originating task's load-bearing concern (e.g., a P1 author-spoofing gate dispatches `correctness`, `security`, `adversarial`, `reliability`, plus the always-on `testing` / `maintainability` / `project-standards` / `learnings`). When polish, JSDoc, helper extraction, naming, mutation-kill canaries for sibling code paths, or contract-doc updates get bundled into the same hold block, the next round forces the *same* persona set to re-read the *whole* diff to verify polish landed correctly. The persona set is now overscoped for the round's actual risk class — and the originating task accumulates rounds 4, 5, 6, each running a full persona fleet.

The friction is not review thoroughness (PEvO accepts that token cost as a deliberate tradeoff). The friction is review *misdirection*: spending the originating task's persona budget on findings whose risk class doesn't need that persona budget.

## Guidance

When `/ce-code-review` surfaces findings on a held task, classify each surviving finding by risk class before bundling. The decision criterion is one question:

> **Would re-review of this finding need the SAME persona set as the originating task's load-bearing concern?**

| Answer | Disposition |
|--------|-------------|
| Yes — finding is in the same risk class as the originating task (a regression here is what the task exists to prevent) | **Bundle** into the hold block on the originating task. Re-review needs the full persona pass. |
| No — finding is polish, naming, JSDoc, helper extraction, doc-update, sibling-code-path canary, or any class whose persona requirements differ from the originating task | **File separately** as a new follow-up task in `agents/docs/tasks/pending/<role>-<kebab-summary>.md`. Architect-input-blocked items go to `blocked/` with `[BLOCKED by Architect]` per rule #6, not `pending/`. |

Reasonable proxies for "different risk class":

- The finding adds or refines a helper used in *other* code paths beyond the originating task's diff.
- The finding cleans up comments, JSDoc, naming, or imports — the persona set for prose/structure review (architect-only spot-check or `maintainability` solo) is much narrower than the originating task's.
- The finding adds canaries for code paths the originating task did not touch.
- The finding is a contract-doc update in `agents/docs/api-contracts/*.md` or `ARCHITECTURE.md` — these reside in architect-owned zones and don't run through the same persona set as a route-handler diff.
- The finding's natural reviewer label (`adversarial`, `kieran-typescript`, `maintainability`, `reliability`, `api-contract`, etc.) is *disjoint* from the originating task's load-bearing label.

When in doubt, file separately. The cost asymmetry favors splitting: a new task in `pending/` gets reviewed once with an appropriately-scoped persona set; bundling forces the originating task's persona set to re-fan-out N more times against a diff that no longer benefits from the original lens.

### Hold-block format under this convention

The hold block on the originating task should:

1. List ONLY same-risk-class items in the numbered fix list.
2. Append a short **`Filed as follow-ups (different risk class):`** subsection naming the new task slugs and a one-line rationale per spinoff.

Example shape:

```markdown
Architect re-review (2026-05-04) — HELD PENDING FIXES:

1. <same-class fix #1 — describe the regression class>
2. <same-class fix #2 — describe the regression class>

Filed as follow-ups (different risk class):
- `backend-pevo-string-helper-adoption-sweep` — coercion-mutation class, distinct from
  the author-spoofing gate that this task closes; gets its own correctness +
  kieran-typescript persona pass when picked up.
- `backend-atomic-triple-key-presence-canaries` — Frankenstein-composition triple
  coherence; sibling-code-path canaries, not author-spoofing canaries.
```

This makes the user's triage-time picture complete: the architect didn't dismiss the items, they were redirected to where their persona budget actually applies.

### Architect-owned spinoffs

Some spinoffs land in architect-owned zones (`agents/docs/api-contracts/*.md`, `ARCHITECTURE.md`, `tasks-archive.md`). For those, the architect can land them *during the archive cycle of the originating task* rather than as separate task files — same-task, different-surface work, where the surface is architect-zoned and doesn't need a re-review of the implementer's diff. This is the `coauthor-trust-model` shape (see Examples below).

Implementer-owned spinoffs always need their own task file because the implementer agent's startup protocol only sees `agents/docs/tasks/pending/<role>-*.md` files for its own role.

## Why This Matters

PEvO already pays a high token cost for compound-engineering reviews and accepts that cost as a deliberate tradeoff. The convention here does not trim review thoroughness. It redirects polish/different-class items to follow-up tasks where they get appropriately-scoped review, rather than getting bundled into the originating task's full multi-persona pass.

The cost shape, concretely:

- A `/ce-code-review` fan-out dispatches 6–11 persona subagents. Each one re-reads the round's diff and reasons within its lens. Per-persona token cost is on the order of tens of thousands to low-hundreds-of-thousands of tokens depending on diff size; per-round wall-clock cost is multiple minutes; orchestrator-context-window pressure compounds across rounds.
- A held task that goes 6 rounds with a 7-persona fleet costs ~42 persona-dispatches. If rounds 4–6 are different-class, ~21 of those dispatches are spent re-reading the originating task's diff with personas that aren't the right ones for the finding.
- The top 5 multi-round tasks of any given week account for roughly half the week's review-token budget. Round-count inflation on held tasks is the dominant budget pressure on review tokens, NOT new-task volume — recent archive analysis showed ~80% of archived work caught real shipping bugs, so the new-task review spend is well-justified.

The structural reason this hits PEvO specifically:

- Root `CLAUDE.md` rule #8 encourages multi-round hold cycles — that's the protocol working as designed.
- `/ce-code-review` produces findings across the persona fleet, so a single round legitimately surfaces same-class AND different-class items together.
- The default bundle-everything disposition treats those classes as homogeneous, but the next round's persona set is calibrated to the originating task's load-bearing concern, which makes the bundle an over-scoped re-review of the polish.
- Splitting at the bundling step preserves the protocol (rule #8 still applies on the originating task; rule #5 still applies to the new follow-up files) while restoring persona-set-to-finding-class fit.

This convention is the bundling-step analog of the persona-calibration filter from `agent-native-persona-calibration-for-pevo-2026-04-28.md`. That filter sorts findings *within* a single triage pass (prune the fleet for the diff); this convention sorts findings *between* rounds across multiple persona passes (split the surviving findings across tasks).

## When to Apply

Apply at every architect re-review on a `tasks/review/` task that produces surviving findings (i.e., at the moment the architect decides to write the `Architect re-review (<date>) — HELD PENDING FIXES:` block):

- Always classify by risk class before drafting the hold block, even on the first round of holds.
- Especially when `/ce-code-review` returned findings from personas that are disjoint from the originating task's load-bearing concern (`maintainability` + JSDoc findings on a P1 security task; helper-naming findings on a reliability task; `api-contract` findings on a route-handler task).
- Especially after round 3+. By then most originating-class issues are closed, and the surviving surface is disproportionately polish; bundling at this stage is where the cost shape is worst.
- Especially when the originating task's diff has stopped shrinking round-over-round but new findings keep arriving — that's the signal that the persona fleet is producing findings that no longer fit the diff's actual risk profile.

Skip the split (i.e., bundle as before) when:

- Every surviving finding genuinely targets the originating task's load-bearing regression class.
- A finding *technically* belongs to a different class but the implementer's only reasonable fix is intertwined with the same lines as a same-class fix (splitting would force a follow-up task to wait on the same diff).
- The originating task has reached a closing round where the remaining N items are small enough that filing N follow-up tasks is more coordination overhead than the saved persona budget recovers (rule of thumb: ≤2 trivial polish items, no new helper, no mutation-kill canaries, no doc updates).

## Examples

### Negative example: `backend-continuation-post-author-consent-gate` (archived 2026-05-06, 6 rounds)

This task closed a P1 continuation-post spoofing gate. Same-class concern: an attacker can mint a continuation post with a forged `pevo.continues = {author, permlink}` to ride on someone else's chain of authority. Persona set for this risk class: `correctness`, `security`, `adversarial`, `reliability`, plus always-on `testing`, `maintainability`, `project-standards`, `learnings`, `kieran-typescript`.

Round-by-round shape:

- **Rounds 1–3 (SAME CLASS — correctly bundled):** author check, type-spoof gate, no-shrink rule, sentinel handling. Each round was a regression in the author-spoofing class; the persona fleet was the right fleet to re-fan-out. This is the convention working.
- **Round 4:** introduced `pevoString` helper closing 3 cast-and-coalesce runtime failure modes. Risk class: coercion-mutation, not author-spoofing. The finding is real and shippable, but its persona set is `correctness` + `kieran-typescript` scoped to coercion edge cases — not the same fleet as the originating task. Round 4 ran a full multi-persona pass anyway.
- **Round 5:** atomic-triple invariant + sentinel-aware `'in'`-based key-presence check. Risk class: Frankenstein-composition triple-coherence (a different malformation class than author-spoofing). Round 5 ran a full multi-persona pass anyway.
- **Round 6:** JSDoc rewrite + inline-comment reframe + 2 OR-arm-deletion mutation-kill canaries. Risk class: prose/structure (no fan-out needed at all) + sibling-code-path canaries. Round 6 ran a full multi-persona pass anyway.

#### What round-3 archive should have looked like under this convention

Round-3 close is the right archive point: the author-spoofing gate is functionally closed. The rounds 4/5/6 findings, when surfaced by `/ce-code-review` at round 3 (or at any of the later rounds), should have been split:

```markdown
Architect re-review (2026-05-02) — HELD PENDING FIXES:

(no surviving same-class items — archive after these spinoffs are filed)

Filed as follow-ups (different risk class):
- `backend-pevo-string-helper-adoption-sweep` — coercion-mutation class, scoped to
  cast-and-coalesce sites across the backend; not author-spoofing.
  Picked up with: correctness + kieran-typescript persona set.
- `backend-atomic-triple-coherence-canaries` — Frankenstein-composition class;
  sentinel-aware 'in'-based key-presence checks + atomic-triple invariant.
  Picked up with: correctness + adversarial persona set.
- `backend-continuation-gate-doc-and-canaries` — JSDoc rewrite + 2 OR-arm-deletion
  mutation-kill canaries. Architect-owned prose plus same-class canaries that the
  closing round can absorb without a fan-out.
```

The originating task archives at round 3 with a same-class scope. The three follow-up tasks each get a single appropriately-scoped review pass when picked up. (`backend-pevo-string-helper-adoption-sweep` already exists in `tasks/review/` as a downstream task — a sibling task could have absorbed rounds 4–5's work earlier under this convention.)

Net: the originating task's persona-pass count drops from 6 to 3, and the 3 follow-ups get 1 pass each at the right scope. Total persona-passes goes from ~6 × 9 ≈ ~54 to ~3 × 9 + 3 × ~4 ≈ ~39, with the additional benefit that each pass is calibrated to the diff under review rather than re-reading the originating diff under a fleet that no longer fits.

### Negative example: `backend-verify-broadcast-attempts-cap` (archived 2026-05-06, 4 rounds)

Originating concern: P1 broadcast-retry amplifier (cap counter, decrement-on-timeout, soft-block, token redaction). Persona fleet: `correctness`, `reliability`, `security`, `adversarial`, plus always-on testing/maintainability/project-standards/learnings.

- **Rounds 1–3 (SAME CLASS):** cap counter, decrement-on-timeout, soft-block, token redaction. Correctly bundled.
- **Round 4 (DIFFERENT CLASS):** `as const` on `__test_seams`, Lua constant rename, `hashTokenForLogs` parity unit specs, `token_hash` field in cap-exceeded warn. This is mostly:
  - TypeScript narrowing polish (`as const`) — `kieran-typescript` class.
  - Lua constant rename — `maintainability` class.
  - Parity unit specs for `hashTokenForLogs` — `testing` class for *previously-shipped* redaction (not regression-prone in the originating fleet's lens).
  - `token_hash` field in cap-exceeded warn — `reliability`/observability class (warn-payload shape).

Under this convention, round 4 should have been filed as `backend-broadcast-cap-polish-and-parity-tests.md` or split into 2 small follow-ups — naming/style polish, and parity-test coverage. The full persona fleet of round 4 was the wrong fleet for that diff; a `maintainability` + `kieran-typescript` + `testing` persona set would have done the job in one pass.

### Positive example: `backend-coauthor-trust-model` (archived 2026-05-06, 5 rounds)

Originating concern: coauthor trust model in the route-handler layer. Persona fleet: `correctness`, `security`, `reliability`, `adversarial`, plus always-on testing/maintainability/project-standards/learnings/kieran-typescript.

Five architect-owned contract-doc updates landed *during the archive cycle*, not as round-6 hold items:

- `agents/docs/api-contracts/custody.md` — coauthor trust narrative.
- `agents/docs/api-contracts/orcid.md` — coauthor verification implications.
- `agents/docs/ARCHITECTURE.md` cluster — coauthor cluster overview.

These are different-risk-class from the route-handler diff — contract-doc prose updates that don't go through the route-handler persona fleet. The architect correctly recognized that and folded them into the same archive cycle as architect-owned, same-task-different-surface work, rather than bundling them as round-6 hold items that would have triggered another full persona fan-out on the route-handler diff.

This is the convention working in its other form: same task, different surfaces, surfaces correctly separated. The route-handler persona fleet ran 5 times on route-handler concerns; the architect-owned contract-doc updates landed once, in the right zone, without a fan-out.

The pattern this case illustrates: when the spinoff lands in an architect-owned zone (per root `CLAUDE.md` rule #2 and `.githooks/commit-msg`'s `allowed_for_agent()`), the architect can absorb it during archive instead of filing a separate `tasks/pending/` file. Implementer-owned spinoffs always need their own task file because the implementer agent's startup protocol only sees `tasks/pending/`.

## Related

- **Sibling — same architect-actor and same artifact (the hold block), complementary axis:** [`cross-task-hold-block-staleness-2026-04-22.md`](./cross-task-hold-block-staleness-2026-04-22.md). Staleness addresses correctness of a single hold item when parallel work lands between rounds; risk-class separation addresses token budget when composing the full hold block. Both are architect-side hold-block discipline at the same authoring moment.
- **Sibling — architect hold-block authorship, complementary discipline:** [`hold-block-must-not-contradict-convention-docs-2026-04-22.md`](./hold-block-must-not-contradict-convention-docs-2026-04-22.md). That doc prevents the architect from authoring a hold item that contradicts an established convention; this doc prevents the architect from over-bundling unlike risk classes into a single hold. Both apply at the same authoring moment.
- **Sibling — same re-review intake checkpoint, different SHA-trust dimension:** [`re-review-intake-supersession-check-2026-05-05.md`](./re-review-intake-supersession-check-2026-05-05.md). Supersession check runs at intake before reviewer dispatch (is the SHA still meaningful?); risk-class separation runs at hold-block composition after `/ce-code-review` returns (which findings belong on this task?). Together they bracket the re-review round.
- **Different axis, same underlying tension (review-round token budget):** [`agent-native-persona-calibration-for-pevo-2026-04-28.md`](./agent-native-persona-calibration-for-pevo-2026-04-28.md). Persona calibration sorts findings *within* a single triage pass (prune the fleet for the diff); risk-class separation sorts findings *between* rounds across multiple passes (split the surviving findings across tasks). The two compose: calibrate the fleet for the originating task; split the surviving findings out so each spinoff gets its own appropriately-calibrated fleet.
- **Enclosing protocol:** root `CLAUDE.md` rule #8 (Review → held-pending-fixes → re-review cycle). This convention refines hold-block composition within that cycle without changing the protocol's mechanics (`git mv` semantics, signal-block conventions, archive trim rules).
- **Per-finding triage step where this convention informs the architect's recommendation:** [`agents/architect/CLAUDE.md`](../../../architect/CLAUDE.md) "Default triage protocol" — when walking findings with the user, the architect's recommendation on each finding (in-place fix / hold-block item / new task / dismiss) should apply this convention's risk-class criterion to decide between "hold-block item" and "new task."

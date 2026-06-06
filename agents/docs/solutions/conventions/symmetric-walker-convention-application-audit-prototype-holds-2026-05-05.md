---
title: When mirroring a convention to a symmetric code path, audit the prototype's full hold history, not just the convention doc
date: 2026-05-05
category: conventions
module: backend/src/routes (chain walkers) + agents/docs/solutions/conventions (convention-doc system)
problem_type: convention
component: development_workflow
severity: high
related_components:
  - chain walkers (forward + backward)
  - security gates (author-consent, type-identity)
  - convention documentation system
  - re-review / hold-block workflow
applies_when:
  - "Porting an existing convention or security gate from a prototype code path to a sibling, symmetric, or inverse code path (e.g., forward walker -> backward walker, read path -> write path, encode -> decode)."
  - "The convention doc being followed has a non-trivial review history with hold-block rounds that strengthened the rule after initial publication."
  - "The mirrored path performs the same security-relevant operation (admission gate, identity check, validation) as the prototype but on a directionally inverted traversal."
  - "Implementer is reading only the convention doc text, not the prototype task's full review/hold-block history in tasks-archive.md or the live task file."
root_cause: inadequate_documentation
resolution_type: workflow_improvement
tags:
  - convention-application
  - symmetric-walkers
  - chain-walkers
  - gate-mirroring
  - hold-block-history
  - pevo-object-identity
  - prototype-audit
  - re-review-cycle
---

# When mirroring a convention to a symmetric code path, audit the prototype's full hold history, not just the convention doc

## Context

PEvO has paired chain walkers in `backend/src/routes/papers.ts`: a forward walker (`resolveContinuationChain`) that assembles a paper's version history by following continues-pointers forward, and a backward walker (`findCanonicalRoot`) that resolves the canonical root URL by walking the same pointers backward. They are symmetric implementations of the same identity-gating contract.

In April 2026, the convention `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` was established and applied to the forward walker. Round-1 of `backend-continuation-post-author-consent-gate` added an AUTHOR consent gate. Round-2 architect re-review surfaced a TYPE identity gap: a consented co-author (bob, listed in alice's `pevo.authors[].hive`) could publish a post with `pevo.type='review'` and `pevo.continues={alice, paper-v1}`, and the forward walker's gate would admit it (author check passed) so review content surfaced as alice's apparent paper body for ~30 minutes. Round-2 hold closed the gap by adding a TYPE identity check (`validPevoPaperWhere(source: 'all')` SQL filter + `isPevoAnyPaper` JS re-check). The convention strengthened to "every gate enforces author + type identity together, not just one" — but that strengthening lived inside the round-2 hold-block on the forward-walker task file, not in the convention doc text.

In May 2026, a sibling task (`backend-canonical-root-walker-author-gate`) was filed to mirror the gate on the backward walker. The implementer read the convention doc and the forward walker's current code, but did not read the forward walker's hold-block history. Round-1 of the backward walker (commit `e2f7e1b`) mirrored the AUTHOR check and the depth cap, but reproduced the original TYPE gap exactly: a consented co-author bob could post `bob/spoof-review` with `pevo.type='review'` + `pevo.continues={alice, paper-v1}`, hit `/api/papers/bob/spoof-review`, walk back through the AUTHOR-only gate, and have the walker return alice/paper-v1 as the canonical root — so bob's URL renders alice's paper. URL aliasing for currently-consented co-authors. Architect re-review on 2026-05-05 surfaced this as a round-2 hold item, the same threat class as the forward walker's round-2 issue, just symmetric direction.

The implementer mirrored the AUTHOR half of the convention but not the TYPE half because the TYPE strengthening landed in the forward walker's round-2 hold, not in the convention doc text. The implementer's mental model of the rule was one round behind the architect's.

## Guidance

When taking on a "mirror gate / convention / pattern X to symmetric direction" task, treat the prototype task file as part of the spec, not just the convention doc.

**Implementer checklist at task start:**

1. Read the convention doc(s) referenced by the task.
2. Locate the prototype task file (the one that originally applied the convention) — check `agents/docs/tasks-archive.md` if it has been archived, or git log against the prototype implementation file.
3. Read the prototype task file from start to finish, including ALL hold blocks (rounds 1 through N), not just the original acceptance criteria.
4. Enumerate every requirement from every round of holds on the prototype, not just round-1. Late-round holds typically encode the strongest version of the rule.
5. Apply ALL of those requirements to the symmetric implementation, even ones not mentioned in the convention doc text.
6. In the symmetric task's signal block, explicitly cite which prototype-round requirements were mirrored (e.g. "mirrored round-1 AUTHOR gate + round-2 TYPE gate from `<prototype-task>`").

**Architect checklist at re-review intake on a mirror task:**

1. Identify the prototype task and load its full hold history (all rounds).
2. Compare the symmetric implementation against the prototype's full hold history, not just the convention doc text.
3. For each round-N hold item on the prototype, verify the symmetric implementation addresses the equivalent in its direction.
4. Treat any prototype-round requirement absent from the symmetric implementation as a hold item, not a deferred follow-up.

**Pre-fan-out checklist when spawning a worker on a mirror task:**

- Include the prototype task file path AND a directive to read all hold blocks in the worker's brief.
- Do not paraphrase the convention; the worker must read the prototype rounds directly.

## Why This Matters

Conventions in this codebase are not static. They evolve through hold-block iterations on the prototype implementation. A convention doc captured at time T reflects the rule as understood at T; the rule then strengthens at T+1, T+2, T+N as architect re-review surfaces gaps the original authors did not anticipate. Those strengthenings land in hold blocks on the prototype task file (and in the prototype's code), but the convention doc text typically lags by one or more rounds before someone updates it.

Sibling and symmetric implementations are filed at T+N+M, well after the rule has strengthened. They are evaluated by the architect against the T+N+M state of the rule (because that is the rule the architect knows). But they are written by implementers who read the convention doc (T-state) plus the prototype's current code, not the prototype's hold history. The implementer's mental model is one or more rounds behind the architect's.

The asymmetry creates predictable hold-block churn on every "mirror" task: round-1 always reproduces a gap that was already closed on the prototype in round-N. The fix is not to keep re-discovering the same gaps in re-review; it is to teach implementers (and the architect's intake protocol) to read the prototype's full hold history as part of the spec.

This also matters because PEvO has many paired/inverse code paths (forward/backward walkers, summary/detail response shapers, single/list endpoint canon, encoder/decoder pairs in the future) and conventions will continue to evolve through hold-blocks. The cost of skipping the hold-history read is a guaranteed extra review round per mirror task.

## When to Apply

Apply this guidance whenever:

- A task description contains "mirror", "symmetric", "inverse", "parallel", "matching", "the equivalent of X for Y", or "do for X what we did for Y".
- A convention doc was applied to one code path and is now being applied to a paired path.
- Code being modified has a known paired/inverse counterpart elsewhere in the codebase.

**Generic recurrence patterns:** forward/backward walkers, encoder/decoder, serialize/deserialize, send/receive, push/pull, request/response shapers, cache-write/cache-read, post/get on the same resource, sync/async variants of the same operation.

**PEvO-specific recurrences (current and anticipated):**

- Forward chain walker (`resolveContinuationChain`) ↔ backward walker (`findCanonicalRoot`) in `backend/src/routes/papers.ts` (this case).
- Single-paper endpoint (`/api/papers/:author/:permlink`) ↔ list endpoint (`/api/papers`) response shape canon.
- Summary-path response shaping (`backend/src/routes/papers.ts:396`) ↔ detail-path head-meta override (`backend/src/routes/papers.ts:679-687`).
- Any future custody/consent gate that has a "grant" path and a "revoke" path.
- Any future review-flow gate that has an "accept" path and a "reject" path.

## Examples

**Negative example (prototype, round-1 incomplete).**

Forward walker `resolveContinuationChain`, round-1 of `backend-continuation-post-author-consent-gate`. Implementer added an AUTHOR consent check on each hop. Convention doc captured the rule as "author identity vouching." Architect approved round-1.

Round-2 re-review found the TYPE gap: consented co-author bob posts `pevo.type='review'` continuing alice's paper-v1; AUTHOR check passes; review surfaces as alice's paper body for ~30 min cache TTL. Round-2 hold added the TYPE identity check via `validPevoPaperWhere(source: 'all')` SQL filter and `isPevoAnyPaper` JS re-check. The strengthening landed in the hold block on the task file; the convention doc text was not updated to match.

**Negative example (mirror, round-1 reproduces the same gap).**

Backward walker `findCanonicalRoot`, round-1 of `backend-canonical-root-walker-author-gate`, commit `e2f7e1b`. Implementer read the convention doc (which still said "author identity") and the forward walker's current code. Mirrored AUTHOR check + 10-hop depth cap + per-request memo. Did not read the forward walker's round-2 hold block. Reproduced the TYPE gap exactly: bob posts `bob/spoof-review` with `pevo.type='review'` + `pevo.continues={alice, paper-v1}`; URL `/api/papers/bob/spoof-review` walks back through the AUTHOR-only gate (alice's authorized set includes bob → admits); walker returns alice/paper-v1 as canonical; bob's URL renders alice's paper content. Same threat class, symmetric direction. Round-2 hold filed 2026-05-05.

**Positive process (what should happen on the next mirror task).**

- Implementer brief includes: "Convention: `pevo-object-identity-is-author-vouching-not-metadata-claim`. Prototype task: `backend-continuation-post-author-consent-gate` — read all hold blocks (rounds 1-N) before implementing."
- Implementer enumerates from prototype: round-1 AUTHOR check, round-2 TYPE check (via `validPevoPaperWhere(source: 'all')` + `isPevoAnyPaper`), any round-3+ items.
- Symmetric implementation includes both AUTHOR and TYPE gates from day 1.
- Signal block on the symmetric task cites: "AUTHOR gate mirrored from prototype round-1; TYPE gate mirrored from prototype round-2 hold."
- Architect intake compares symmetric implementation against the prototype's full hold history. Round-1 lands clean. No churn.

**Process artifact for the architect re-review intake checklist:**

```
On any "mirror X to Y" task at re-review intake:
  1. Identify prototype task (the original X).
  2. Load prototype's full hold history (every "Architect re-review (date) — HELD PENDING FIXES:" block, all rounds).
  3. For each prototype hold item, verify symmetric implementation addresses the equivalent in its direction.
  4. Missing items become round-1 holds on the symmetric task, not deferred follow-ups.
```

## Related

- `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — the convention this learning extends. The TYPE-strengthening landed in round-2 of the forward-walker task; the convention doc text now needs a forward-reference to this learning so future readers see the per-walker-pair symmetry dimension.
- `agents/docs/solutions/architecture-patterns/pevo-inverted-predicate-collapse-encode-invariant-structurally-2026-05-05.md` — direct sibling pattern doc on the same task family. That doc argues for collapsing the predicate entirely via cumulative-union; this learning argues that if predicates are kept, they must be applied symmetrically across all walker directions. The two are companion alternatives, not contradictions.
- `agents/docs/solutions/conventions/enumerated-exemption-lists-are-drift-vectors-2026-04-28.md` — methodological parent. Replacing exempt-lists with structural audits doesn't close the symmetry gap if the audit surface is keyed to one walker's vocabulary; this learning sharpens the per-walker-pair dimension.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — meta-pattern cousin. The "every call site of the wrapper must propagate every error class at every syntactic shape" rule is the cross-product analog of "every walker must apply the predicate at every symmetric site."
- `agents/docs/solutions/conventions/route-level-error-class-coverage-after-helper-extraction-2026-04-29.md` — strong methodology cousin. The (route × subclass) cell matrix is the test-coverage analog of the (walker × predicate-site) matrix.
- `agents/docs/solutions/conventions/re-review-intake-supersession-check-2026-05-05.md` — temporal cluster from the same multi-author rounds; different failure mode (parallel commits decommission diff scope) but same intake-protocol layer.
- `agents/docs/tasks/pending/backend-continuation-post-author-consent-gate.md` — prototype (forward walker) with the round-2 hold that added the TYPE-identity strengthening.
- `agents/docs/tasks/pending/backend-canonical-root-walker-author-gate.md` — sibling (backward walker) where the gap recurred; round-2 hold filed 2026-05-05.

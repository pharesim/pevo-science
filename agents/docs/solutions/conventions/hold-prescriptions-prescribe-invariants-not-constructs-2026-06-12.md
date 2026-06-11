---
title: "Hold-block fix prescriptions prescribe invariants, not constructs — the prescribed construct is a hypothesis the implementer verifies"
date: 2026-06-12
category: conventions
module: agent-coordination
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - "Architect is authoring a hold-block fix item that names a specific SQL construct, data structure, or implementation pattern as the required solution"
  - "Implementer receives a hold-block prescription that specifies a concrete construct (e.g. CROSS JOIN LATERAL, a specific JOIN type, a particular loop form) and evaluates whether to apply it literally"
  - "Implementer deviates from the prescribed construct on semantic-equivalence grounds and documents the deviation with a site comment and signal-block note"
  - "Re-reviewer at round-N intake encounters a signal block flagging a deviation from the hold-block prescription and must decide whether to re-hold for prescription compliance or verify equivalence"
  - "A prescribed rewrite would eliminate NULL-preserving semantics (e.g. replacing a correlated scalar subquery with a JOIN that filters non-matching rows)"
related_components:
  - database
  - documentation
tags:
  - hold-block
  - architect-protocol
  - sql-semantics
  - semantic-equivalence
  - acceptance-invariant
  - cross-join-lateral
  - left-join-lateral
  - hafsql
  - re-review
---

# Hold-block fix prescriptions prescribe invariants, not constructs

## Context

PEvO's hold-fix cycle gives the architect prescriptive power: a hold block appended to a task file lists numbered fix items, the implementer lands them, and the architect re-reviews. Hold items routinely include concrete code — a SQL rewrite, an exact envelope, a specific construct — because concrete prescriptions are cheaper to implement than abstract complaints. That concreteness has a failure mode this entry names: **a hold-item prescription is written at review altitude, where the reviewer has read the code under critique but has not traced every downstream consumer of the rows, values, or types that code produces.** A prescription can therefore be locally plausible ("does the same work in one indexed scan") and globally wrong (changes the result set in a way only a downstream CTE cares about).

The incident: a hold (commit `b51960b2`) on the consented-authorship chain-walk correctly diagnosed a performance problem in the `chain_node_created` annotation CTE inside `consentChainCteBody` (`backend/src/hafsql.ts`) — three correlated subqueries against the comment-ops view per chain node, including a nested `MIN(block_num)` repeated inside the `MIN(id)` probe — and prescribed a specific replacement: "a `CROSS JOIN LATERAL (... ORDER BY o.block_num ASC, o.id ASC LIMIT 1)` is legal there and does the same work in one indexed scan per node. Rewrite." The performance diagnosis was right. The prescribed construct was wrong: correlated scalar subqueries over an empty op set return NULL and the chain-node row survives; `CROSS JOIN LATERAL` over an empty lateral result eliminates the row. The implementer (commit `64129eb2`) caught the divergence, landed `LEFT JOIN LATERAL ... ON TRUE` instead, documented why at the site, and flagged the deviation in the signal block. Re-review verified the deviation correct and the prescription wrong. This entry encodes the protocol that made that outcome the cheap path rather than a fight.

## Guidance

**The convention: architect hold-block fix prescriptions are hypotheses, not specs.** Three sub-rules, one per role.

### 1. Architects: state the acceptance invariant; mark the construct as a suggestion

**Rule:** a hold item's fix prescription must lead with the acceptance invariant — the property the fix must preserve and the property it must improve — and present any concrete construct as one candidate ("e.g."), not as the spec.

**Why:** the invariant is what the architect actually verified at review altitude (the performance problem is real; the replacement must be semantics-preserving). The construct is what the architect guessed without tracing consumers. Writing the construct as the spec inverts the epistemic weight: it presents the unverified part as binding and leaves the verified part implicit.

**The prescription-writing shape**, applied to the incident:

> Fix: the `chain_node_created` annotation runs three correlated probes per chain node. Collapse to one probe per node. **Invariant:** identical NULL-annotation semantics for nodes with no visible op row, identical `(block_num, id)` tie-break for nodes with ops, and row-preserving (every `chain_tree` row must survive annotation — `ranked_children` and the `canonical_chain` seed consume the full set). E.g. a `LEFT JOIN LATERAL (... ORDER BY o.block_num, o.id LIMIT 1) fo ON TRUE`; verify the join shape against the empty-op-set case before landing.

The invariant clause is what survives a wrong "e.g."; without it, the implementer has nothing to verify the construct *against* except the architect's authority.

### 2. Implementers: verify the prescribed construct against the replaced code's full semantics

**Rule:** treat a prescribed construct as a hypothesis. Before landing it, diff its semantics against the code it replaces across the **full input domain** — especially the empty-set / NULL case and the row-preserving vs row-eliminating distinction of join shapes. A verified deviation, recorded as a site comment anchored on stable symbols and flagged in the signal block, is the correct response to a wrong prescription. It is not insubordination; landing a known-wrong construct "because the hold said so" is the failure.

**The schematic divergence** (the trap class is general — any scalar-subquery to lateral-join rewrite):

```sql
-- BEFORE: correlated scalar subqueries. Row-PRESERVING.
-- Empty op set => MIN() over zero rows => NULL annotation, row survives.
SELECT t.*,
  (SELECT MIN(o.block_num) FROM ops o
    WHERE o.author = t.author AND o.permlink = t.permlink) AS created_block
FROM tree t;

-- PRESCRIBED: CROSS JOIN LATERAL. Row-ELIMINATING.
-- Empty lateral result => no joined row => t's row is GONE from the output.
SELECT t.*, fo.block_num AS created_block
FROM tree t
CROSS JOIN LATERAL (
  SELECT o.block_num FROM ops o
  WHERE o.author = t.author AND o.permlink = t.permlink
  ORDER BY o.block_num, o.id LIMIT 1
) fo;

-- LANDED: LEFT JOIN LATERAL ... ON TRUE. Row-preserving AND one probe.
-- Empty lateral result => fo.* = NULL, row survives. Same plan shape as CROSS
-- for non-empty sets; identical (block_num, id) selection to the MIN() pair.
LEFT JOIN LATERAL ( /* same lateral body */ ) fo ON TRUE
```

For non-empty op sets, `ORDER BY o.block_num ASC, o.id ASC LIMIT 1` selects the same first-op identity the correlated form computed (in production, three probes deriving the `(MIN(block_num), MIN(id) within that block)` pair; the schematic shows a single probe for brevity) — byte-equivalent. The forms diverge **only** on the empty set, which is exactly the case a review-altitude reading skips because it requires knowing whether downstream code is NULL-tolerant. Here it is, deliberately: `ranked_children` orders `created_block ASC NULLS LAST, created_id ASC NULLS LAST` (op-less nodes lose canonical-path ties deterministically rather than erroring), and `canonical_chain` seeds from `chain_node_created` at depth 0. Under `CROSS`, an op-less node does not lose ties — it ceases to exist, including the depth-0 seed case, dropping whole subtrees from the canonical walk.

**Deviation protocol** (the four steps from commit `64129eb2`):

1. **Verify** — prove the prescribed construct diverges (here: empty-lateral elimination vs NULL-preserving scalar subquery) and that the chosen alternative satisfies the invariant.
2. **Deviate** — land the verified construct, not the prescribed one.
3. **Site comment on stable symbols** — record the why at the deviation site, anchored on the downstream consumers that make the distinction load-bearing, not on the hold round or the architect's text. The landed comment in `chain_node_created` is the model: LEFT rather than CROSS so a node with no visible op row keeps its NULL annotation (`ranked_children` orders NULLS LAST), matching the correlated-subquery shape this replaces.
4. **Signal-block flag** — state the deviation explicitly so the re-reviewer audits it on purpose rather than discovering it as prescription non-compliance: "LEFT JOIN LATERAL ... ON TRUE rather than CROSS JOIN LATERAL so a node with no visible op row keeps its NULL annotation."

Skipping step 3 or 4 converts a correct deviation into a latent dispute: step 3 is the durable defense (it outlives the task file), step 4 is the immediate one (it routes re-review attention to the merits).

### 3. Re-reviewers: verify the deviation on its merits, never hold for prescription compliance

**Rule:** at re-review intake, a flagged deviation is a claim to be checked against the **invariant**, not against the hold text. "Does the landed form preserve the replaced code's semantics and fix the diagnosed problem?" is the question; "does it match what I wrote?" is not. Holding a correct deviation for non-compliance would force the implementer to land a known regression to satisfy process.

In the incident, re-review dispatched two independent session-model reviewers (correctness and adversarial lenses). Both independently proved the `LEFT` form selects the identical `(block_num, id)` pair as the `MIN()`-based original for every non-empty op set and yields `NULL/NULL` for the empty set — byte-equivalent — and both confirmed `CROSS` would have been a credit-affecting regression. The verdict: deviation correct, prescription wrong, hold-item intent (one probe per node) fully met. That is the complete disposition; no compliance question survives it.

## Why This Matters

**The silent failure path is green.** Had the implementer followed the prescription literally, every test would have passed: both synthetic test corpora seed an op row for every chain node, so the empty-lateral case never fires under test. The regression would have shipped as a "pure performance rewrite," and its production symptom — op-less nodes vanishing from `canonical_chain`, subtrees dropped from the walk, consented-author credit silently reallocated between accounts — would have been undetectable except by someone diffing credit attribution against the chain by hand. Wrong prescription + obedient implementer + structurally-green suite is a complete pipeline from review comment to silent data corruption, with no alarm at any stage.

**The archived hold block is a standing trap.** Hold blocks are never edited after the fact — the commit diff is the evidence, per the hold-cycle rules — so the archived task record retains the `CROSS JOIN LATERAL` prescription verbatim, forever reading like an instruction the implementer failed to follow. A future maintainer who finds the archive entry (or a future architect re-reading their own hold) could "fix the non-compliance" by reverting `LEFT ... ON TRUE` to `CROSS` — and the suite would stay green, because the test corpora cannot distinguish the forms. The site comment in `chain_node_created` is the only artifact standing between that reader and the regression. This is why deviation step 3 (site comment on stable symbols) is mandatory rather than polite: the hold text outlives its own refutation, so the refutation must live where the revert would happen. (A finding proposing a one-op-less-node corpus pin was user-triaged as dismiss: the diff changed form, not behavior — per the behavior-change-coverage-gap convention, only diff-introduced behavior is reportable. The site comment is the accepted durable defense.)

**Review-altitude prescriptions systematically miss consumer semantics.** This is not an individual lapse; it is structural. The reviewer reads the code being criticized — three redundant probes, obviously collapsible — and pattern-matches a replacement from general SQL knowledge. What the reviewer has *not* done is trace every consumer of the produced rows: that `ranked_children` deliberately orders `NULLS LAST`, that `canonical_chain` seeds from the annotated set at depth 0, that NULL annotations are a designed-in state rather than an accident. The implementer, who must touch all of it to land the change, is the first party positioned to see the divergence. The convention assigns verification to the role that has the information: the architect verifies the problem and the invariant; the implementer verifies the construct; the re-reviewer verifies the deviation. Treating the construct as binding assigns verification to the one role that structurally cannot perform it.

## When to Apply

- **Architect writing a hold item with a concrete fix construct** (a SQL rewrite, a join shape, a specific API of a library, an exact control-flow restructure): lead with the acceptance invariant — what must be preserved (NULL semantics, row cardinality, tie-break order, error envelope) and what must improve — and mark the construct "e.g.". If you cannot state the invariant, you have not verified enough to prescribe a construct at all; file the item as a diagnosis ("three probes per node; collapse to one") and leave the construct open. SQL holds specifically: any prescription that changes a scalar subquery to a join, or changes a join type, must state the row-preserving/row-eliminating requirement explicitly, because that is precisely the axis review-altitude reading skips.

- **Implementer receiving a hold item that prescribes a construct:** before landing, enumerate the input domain of the replaced code — empty set, NULL columns, duplicate keys, zero rows — and check the prescribed construct on each. For lateral-join rewrites, the checklist item is fixed: what happens when the lateral body returns zero rows, and is any downstream consumer NULL-aware (`NULLS LAST`/`NULLS FIRST` ordering, `COALESCE`, `IS NULL` branches are the tells)? If the construct diverges, deviate via the four-step protocol (verify, deviate, site comment on stable symbols, signal-block flag). Do not silently substitute (the re-reviewer will read it as unexplained non-compliance) and do not land the known-wrong form (process compliance is not an invariant).

- **Re-reviewer at intake on a task whose signal block flags a deviation:** route review attention to the deviation's merits — does the landed form satisfy the hold item's invariant and fix the diagnosed problem? Independent verification (two lenses proving equivalence here) is the gold standard for semantics-equivalence claims. If the deviation is verified correct, the item is closed and the prescription was wrong; record the verdict in the re-review disposition so the archive carries the refutation alongside the stale prescription. Never issue a hold for "did not implement the prescribed construct" when the landed construct provably meets the invariant.

## Examples

### The incident, compressed

**Prescription** (hold commit `b51960b2`): the `chain_node_created` CTE in `consentChainCteBody` runs three correlated subqueries against the comment-ops view per chain node — `MIN(block_num)`, then `MIN(id)` with the `MIN(block_num)` probe repeated inside it. "A `CROSS JOIN LATERAL (SELECT o.block_num, o.id ... ORDER BY o.block_num ASC, o.id ASC LIMIT 1)` is legal there and does the same work in one indexed scan per node. Rewrite." Performance diagnosis correct; construct wrong on the empty-op-set case.

**Deviation** (fix commit `64129eb2`): implementer traced the consumers — `ranked_children`'s `NULLS LAST` ordering and `canonical_chain`'s depth-0 seed both depend on op-less rows surviving annotation with NULL `created_block`/`created_id` — and landed `LEFT JOIN LATERAL (...) ON TRUE` instead. Site comment at the join, anchored on `ranked_children`/`NULLS LAST` (stable symbols, not the hold text). Signal block flagged it: "LEFT JOIN LATERAL ... ON TRUE rather than CROSS JOIN LATERAL so a node with no visible op row keeps its NULL annotation."

**Verification verdict** (re-review): two independent reviewers (correctness, adversarial) each proved the `LEFT` form is byte-equivalent to the `MIN()`-based original — identical `(block_num, id)` for every non-empty op set, `NULL/NULL` for empty — and that `CROSS` would have eliminated op-less nodes from the walk, dropping subtrees and reallocating consented-author credit. Deviation verified correct; hold-item intent (one probe per node) fully met; task proceeded to archive with the wrong prescription preserved verbatim in the hold block and the site comment as the durable counter-record.

**The counterfactual:** an implementer applying `CROSS JOIN LATERAL` as written ships a green suite (both test corpora seed an op row for every node) and a silent credit-corruption bug. A future reader of the archived hold block who "aligns the code with the prescription" reintroduces the same bug, again green — unless they hit the site comment first. The convention's three sub-rules each cut one link in that chain: the invariant-first prescription makes the empty-set requirement explicit at authorship; the implementer's full-semantics verification catches it at landing; the merits-based re-review ratifies the deviation instead of reverting it.

## Related

- [`hold-block-must-not-contradict-convention-docs-2026-04-22.md`](hold-block-must-not-contradict-convention-docs-2026-04-22.md) — complementary axis: that entry says hold-block specs must not contradict existing convention docs; this entry says hold prescriptions should be invariants, not constructs, so the implementer can satisfy the invariant via a different (semantically correct) construct without a compliance dispute.
- [`pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16.md`](pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16.md) — the incident's SQL neighbor: covers `CROSS JOIN LATERAL` hazards from the exception-safety angle (SRF crash on malformed input); this entry's incident exploits the adjacent hazard class (silent row elimination on an empty lateral result vs the NULL-preserving scalar subquery it replaced).
- [`hold-item-completion-structural-vs-behavioral-2026-05-12.md`](hold-item-completion-structural-vs-behavioral-2026-05-12.md) — parallel epistemics at the other end of the cycle: that entry governs how implementers verify hold-item *closure*; this entry governs how architects *write* hold prescriptions. Together they bound the hold cycle's epistemic discipline.
- [`architect-hold-block-risk-class-separation-2026-05-07.md`](architect-hold-block-risk-class-separation-2026-05-07.md) — same authoring moment, orthogonal axis: that entry governs how to *compose* hold blocks across risk classes; this entry governs the granularity of individual fix prescriptions.
- [`acceptance-criteria-forward-looking-pins-not-pre-post-differentials-2026-06-06.md`](acceptance-criteria-forward-looking-pins-not-pre-post-differentials-2026-06-06.md) — the same "specify invariants, not artifacts" principle applied to task acceptance criteria; this entry is its hold-prescription analog.

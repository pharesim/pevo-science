---
title: "Hold prescriptions expire with their premise: re-review must attack the prescribed shape, not just verify compliance"
date: 2026-09-01
category: conventions
module: hold-cycle
problem_type: convention
component: development_workflow
severity: high
root_cause: missing_workflow_step
resolution_type: workflow_improvement
applies_when:
  - "A round N-1 hold block prescribes a specific code shape and explicitly rejects an alternative, citing a failure mode as the reason for the rejection"
  - "The same round's fix adds a guard or check that removes the failure mode cited to justify that rejection"
  - "Round N re-review verifies only that the implementer complied with the prior round's prescription, rather than re-attacking the prescribed shape"
  - "Re-reading an archived or superseded hold block to decide whether its prescription still governs current code"
  - "Distinguishing a premise-retired hold prescription from a genuinely settled single-source-of-truth decision that must not be relitigated"
related_components:
  - authentication
  - redis
tags: [hold-block, re-review, architect-protocol, premise-invalidation, prescription-compliance, hold-cycle, adversarial-review, settled-vs-reopenable]
---

# Hold prescriptions expire with their premise: re-review must attack the prescribed shape, not just verify compliance

## Context

The consent-op burn ledger in `backend/src/lib/fresh-auth.ts` (`spentConsentOps`, drained by `drainSpentConsentOps`) went through a multi-round architect review that ended with the architect withdrawing its own prescription.

An earlier hold had prescribed the exact code shape for the drain's expiry arm: after a newly added `if (!client) continue;` guard (client = Redis handle gated on `isRedisAvailable()`), keep the dispatch-then-drop pair — issue `void client.del(...).catch(() => {})`, then `spentConsentOps.delete(token)` unconditionally. The hold stated this was "deliberately NOT the rejected chain-drop-onto-delete shape": chaining the drop onto the delete had been rejected in a prior round because, while no client is reachable, the delete can never be issued, so entries would leak for the whole of an outage. The chaining rejection originated even earlier than the hold that inherited it — it first surfaced in the implementation round's own design-critique pass, then survived a full architect review of that round unchallenged before being carried into the prescription (session history).

The implementer complied exactly. The following review round then found — three reviewers independently, validator-confirmed — that the prescribed shape itself loses a double-fault: a dispatched DEL that fails while the client looked ready (a `commandTimeout` against a connected-but-stalled server, or a socket death right after recovery flushing the retained DEL), composed with ioredis resending an unreplied issuing `SET` at recovery with a fresh full `EX`, leaves the canonical key alive with no ledger entry left to refuse it. A spent single-use auth proof becomes replayable — the exact class the ledger exists to close. The prescription was withdrawn and replaced with the live arm's confirmed-delete pattern: drop the entry only inside the delete's `.then()`; the `.catch` retains it for the next trigger.

That fix has since landed, and the drain went further than the fix alone: the expiry and live arms were collapsed into a single loop body whose only retirement path is inside the delete's `.then()`, the client gate became an early `return` when no client is reachable (same effect as the per-entry `continue`: nothing is dispatched, so everything is kept), and `spentConsentOps` became a `Set<string>` carrying no deadlines at all. The shapes quoted under Examples below are therefore historical. They are kept because the incident is unreadable without them, not because they describe the current tree; read `drainSpentConsentOps` in `backend/src/lib/fresh-auth.ts` for what is there now.

## Guidance

Two obligations, one for each side of the review cycle:

**1. Re-review must adversarially attack the prescribed shape itself.** A hold-block prescription is not settled spec at the next round — it is code the architect wrote without a compiler, a test suite, or a red team, and it arrives at re-review wearing the authority of the person who will judge it. Verifying that the implementer complied is necessary but nowhere near sufficient. In this incident, compliance was perfect; the prescription was the defect. Re-review a prescribed diff with the same hostility as an implementer-authored one: enumerate the failure modes the shape claims to handle, then look for the composition it misses. The sibling authoring rule — prescribe invariants, not constructs (see Related) — shrinks the surface for this failure but does not remove it: even an invariant-level prescription rests on a premise a coexisting fix can retire.

**2. A fix can invalidate the objection that shaped its own prescription.** The chain-drop-onto-delete shape was rejected on a real premise: with no guard, the drop would chain onto a delete that can never be issued during an outage, leaking entries while the client is null. But the very fix that carried the prescription added `if (!client) continue;` — which keeps entries during an outage by itself. Once that guard exists, chaining only ever affects the client-held case, where "a failed delete leaves the entry for the next trigger" is precisely the invariant the drain's own docblock claims. The rejection's premise was retired by the diff that inherited the rejection. When a guard added in one round removes the failure mode that justified rejecting an alternative in the previous round, the rejected alternative must be actively re-evaluated, not carried forward as settled.

**The tell:** a prescription phrased as "deliberately NOT the rejected X shape" whose recorded rejection rationale names a condition (here: "delete can never be issued while client is null") that the same diff eliminates (here: the null-client case never reaches the delete at all). When writing a hold that rejects an alternative, record the premise explicitly and in falsifiable terms — that is what makes its retirement detectable at the next round. When reading one, check whether the premise still holds against the diff in front of you.

**The settled-decision boundary.** This repo has a standing norm not to re-litigate genuinely settled calls (chain-is-SSoT, the singular signer). That norm is not in tension with this entry. A settled DECISION rests on values and goals that do not change with the code — no diff can retire "the chain is the source of truth." A PRESCRIPTION rests on a technical premise — a code path, a library behavior, a reachable state — that can be retired by the very fix that carries it. Only the latter reopens, and only when its named premise is gone.

## Why This Matters

A compliance-only re-review would have passed this round: green suite, hold block satisfied item by item, diff matching the prescribed shape token for token. What would have shipped underneath is a replayable spent single-use proof — a security defect in the exact mechanism built to prevent it, invisible to any check that treats the prescription as the oracle. The architect already maintains the sibling norm of independently re-enumerating committed diffs rather than trusting prose completion claims; this is the same norm pointed inward. The implementer's claim "I did what the hold said" and the architect's claim "what the hold said is correct" both need evidence, and the second claim gets less scrutiny by default precisely because the reviewer wrote it.

## When to Apply

- Reviewing any diff that implements a shape a prior hold prescribed. Attack the shape, not just the compliance. Budget the same adversarial passes a novel implementation would get.
- Writing a hold block that rejects an alternative. State the rejection's premise as a falsifiable condition ("X is wrong because while `client` is null the delete cannot issue"), not as a verdict ("X was rejected"). A bare verdict is inheritable forever; a premise self-expires.
- The diff under review adds a guard, gate, or precondition upstream of prescribed code. Re-derive every carried-forward rejection against the post-guard control flow before confirming the prescription.
- Distinguishing from the no-relitigation norm: reopen only prescriptions whose named technical premise the code has since removed. Value-level decisions stay settled.

## Examples

The worked example, against stable symbols in `drainSpentConsentOps`:

**Prescribed shape — the expiry arm as it stood during these rounds, since replaced:**

```ts
if (!client) continue;
void client.del(KEY_PREFIX + token).catch(() => {});
spentConsentOps.delete(token);
```

The drop is unconditional on the delete's outcome. If the DEL fails despite the client having looked ready (`commandTimeout` on a stalled-but-connected server; socket death immediately after recovery), the ledger entry is gone while ioredis may resend an unreplied issuing `SET` with a fresh full `EX` at recovery — orphaned canonical key, no entry refusing it, spent proof replayable.

**Prescribed fix — the live arm's confirmed-delete pattern, which the drain's single loop body now applies to every entry:**

```ts
void client
  .del(KEY_PREFIX + token)
  .then(() => {
    spentConsentOps.delete(token);
  })
  .catch(() => {
    // entry retained for the next trigger
  });
```

This is the shape the earlier hold had rejected — and the rejection was correct before `if (!client) continue;` existed, because chaining the drop onto an unissuable delete would leak entries all outage long. The guard retired that premise: entries were kept during an outage by the `continue`, and the chained drop governed only the client-held case, where retain-on-failure is the drain's documented invariant. (Today's drain returns early when no client is reachable, with the same effect.) The rejection outlived its reason by one round because it was inherited as settled instead of re-derived.

## Related

- `agents/docs/solutions/conventions/hold-prescriptions-prescribe-invariants-not-constructs-2026-06-12.md` — the authoring-side sibling: a prescribed CONSTRUCT wrong at the moment of writing, caught by the implementer's within-round verify-and-deviate protocol. This entry is the cross-round counterpart: a shape defensible at authorship whose justifying premise the fix itself retired, caught (or missed) at re-review.
- `agents/docs/solutions/conventions/cross-task-hold-block-staleness-2026-04-22.md` — staleness from parallel work landing between rounds; here the staling agent was the prescribed diff itself.
- `agents/docs/solutions/conventions/hold-block-must-not-contradict-convention-docs-2026-04-22.md` — hold blocks wrong at authorship against existing convention docs; this entry covers holds whose correctness expires mid-cycle.
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` — the nearest analog outside the hold family: a fix must audit its own effect on the text that governs it.
- `agents/docs/solutions/conventions/completeness-claim-tasks-need-independent-re-enumeration-2026-06-14.md` — the sibling skepticism norm: re-enumerate diffs instead of trusting prose claims; this entry applies the same skepticism to the architect's own prescriptions.
- `agents/docs/solutions/conventions/atomic-getdel-split-into-read-then-delete-reopens-replay-2026-08-25.md` — the domain neighbor documenting the burn-time compensating delete this worked example's drain arm parallels. It covers the burn, not the drain, so the confirmed-delete change did not contradict it; its ledger snippet has since drifted and been corrected on its own account, so check it against `backend/src/lib/fresh-auth.ts` rather than treating it as a second source on the ledger's shape.
- `agents/docs/solutions/conventions/final-state-assertions-cannot-discriminate-dispatch-from-confirmation-2026-09-01.md` — why no suite objected while the dispatch-then-drop shape stood: an assertion on the settled state converges with the correct code whenever Redis is healthy, so the prescription's defect was invisible to every green run. The test-side complement to this entry's review-side lesson, from the same round.

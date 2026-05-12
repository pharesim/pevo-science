---
module: hold-cycle
date: "2026-05-12"
problem_type: convention
component: development_workflow
severity: high
root_cause: missing_workflow_step
resolution_type: workflow_improvement
applies_when:
  - "An architect hold block bundles two or more items in the same round"
  - "One item adds a new typed affordance (discriminator, hook, callback, event payload)"
  - "A sibling item restructures, reorders, or deletes existing call-site topology"
  - "An implementer signal block uses 'backward-compatible' to justify not wiring a new affordance"
  - "Architect intake reviews a multi-round task returning to review/ after hold-fix cycle"
symptoms:
  - "Implementer marks a discriminator / return-type hold item closed; return value is never consumed at any live call site"
  - "Signal block describes a new affordance as 'backward-compatible discard' when the hold item demanded per-site behavioral wiring"
  - "/ce-code-review cross-corroboration (3+ personas, conf 90+) all flag the same file:line for an orphaned affordance"
tags:
  - "resolution-assessment"
  - "discriminator"
  - "cross-item-coordination"
  - "signal-block-discipline"
  - "hold-cycle"
  - "architect-protocol"
  - "behavioral-contract"
  - "ce-code-review"
---

# Structural vs behavioral contract in hold-item self-assessment: cross-item consumer-orphan and signal-block anti-patterns

## Context

PEvO's multi-round hold-fix cycle works like this: the architect
appends an `Architect re-review (<date>) — HELD PENDING FIXES:` block
listing the items the implementer must address; the implementer works
the items, writes a signal block claiming resolution, and `git mv`s
the task to `review/`; the architect runs `/ce-code-review` and
updates the verification table. The cycle repeats until all items are
genuinely closed.

A gap surfaces when hold items are co-bundled within a single round
and one item *adds a caller-facing affordance* (return discriminator,
event payload, hook, callback, sentinel value) while a sibling item
*restructures call-site topology* (reorders, inlines, or deletes
existing callers). The restructure can silently orphan the affordance
by removing its intended consumer as "dead code" — the type signature
is correct, the structural contract is met, and the TypeScript
compiler is satisfied, but the behavioral contract (the event,
observability signal, or per-call-site behavior the affordance was
introduced to enable) silently fails to exist in production.

From the implementer's side, the resolution-table entry looks closed.
The affordance landed; the hold item said "add a discriminator" and
the discriminator is there. From a runtime perspective the item is
half-landed: a helper now returns a status nobody reads.

This convention captures three verification disciplines that close
the gap between structural and behavioral resolution.

## Guidance

### 1. Structural contract vs behavioral contract in hold-item self-assessment

**Rule:** when a hold item's stated purpose is observability,
discrimination, alerting, or any per-call-site behavior, the
implementer's signal block must demonstrate that a live consumer
*adopts* the new return/type/event — not just that the helper,
type, or signature was extended.

**Why:** the hold item was filed because a behavioral capability was
absent (an event that never fires, a degraded path that had no
site-specific signal). Extending the helper's type system is necessary
but not sufficient. The resolution-table entry is closed when the
capability exists at runtime, not when the type compiles.

**How to apply:** when writing the signal block for an item whose
hold body contains language like "fix: return a status discriminator"
or "emit event X on condition Y", include a file:line reference to
the call site that switches on the return value and the test that
pins the event. If no such site exists — if the only living call site
discards the return value — do not mark the item closed.

### 2. Cross-hold-item interaction within a single round

**Rule:** when one hold item adds a typed return or new caller-facing
affordance AND a sibling hold item restructures call-site topology in
the same round, both the implementer and the architect must
explicitly verify that the affordance still has at least one live
consumer after the restructure lands.

**Why:** the restructure is correct in its own frame (item 7: hoist
idempotency probe before cap increment; delete now-dead hit-branch
decrement). The affordance is correct in its own frame (item 6: add
discriminator to `decrementBroadcastAttempts`). The interaction is
invisible from either frame alone — the implementer addresses items
in isolation; the compiler verifies each item against its own
contract; the cross-item consumer question falls in the gap.

**How to apply — implementer:** before writing the signal block for
any item that adds a caller-facing affordance, run a grep for all
call sites of the modified helper and verify at least one site in
the same round's diff (or in the unchanged code) consumes the new
return. If a sibling item in the same round's hold block touches the
same callers, treat that sibling as a candidate consumer-orphan risk
and verify explicitly.

```bash
# Example: find every call site of the modified helper
grep -rn "decrementBroadcastAttempts" backend/src/ --include="*.ts"
# For each hit: verify the return value is captured + switched on
# (not just awaited and discarded).
```

**How to apply — architect:** when drafting a hold block that pairs
an affordance-add item with a call-site-restructure item in the same
round, call out the consumer-orphan risk explicitly in the
affordance-add item's body. Either name the specific consumer site the
implementer must update, or split the affordance-add into a later
round after the restructure has landed and the surviving call-site
topology is clear.

### 3. "Backward-compatible discard" is a self-deception flag in signal blocks

**Rule:** when a signal block notices a caller ignores a new return
value and frames it as "non-destructive / backward-compatible," treat
that framing as a flag requiring double-checking before accepting the
item as closed.

**Why:** backward-compatibility is the correct framing when the new
return is purely additive — sites can opt in later, ignoring the
return is a legitimate deferral. It is wrong framing when the new
return was introduced specifically because the hold item demanded
per-site behavior. There, "ignored at the only live consumer" means
the hold item is half-landed, not backward-compatible.

**How to apply:** ask one question — "Was this return value
introduced because the hold item required per-site behavior from
callers?" If yes, "ignored at the call site" is a partial miss, not
a deferral. The signal block's verification evidence must show
consumption, not just compilation.

## Why This Matters

A structurally-passing-but-behaviorally-missing hold item gets
archived as "closed." The observability, discrimination, or event the
hold was filed to provide silently does not exist in production. A
future architect or operator may configure dashboards or alerts keyed
on the (absent) structured event — those alerts will never fire.
The same Redis-degradation scenario the hold was filed to surface
will go undetected on the first real occurrence.

The cost of the miss compounds: the architect must hold the task
again (another round-trip), the implementer must land a follow-up
commit, and the gap existed in the deployed code for the duration
between rounds. For observability-class holds specifically, the gap
is worse than if the hold had never been filed — an operator who
sees the docblock ("callers switch on `'enqueued_for_drain'` to emit
a site-specific event") may believe the event fires.

The `/ce-code-review` cross-reviewer corroboration is the current
catch mechanism. When 4 independent personas flag the same call site
with confidence 90-100 — "return value discarded at the sole live
call site" — the finding is strong. But the corroboration only fires
reliably when 2+ reviewers independently reach the same call site.
Making the implementer's self-assessment behavioral-contract-aware
closes the gap one round earlier and saves a full re-review cycle.

*(Auto memory `[claude]`: the architect MUST invoke `/ce-code-review`
on every review-section task — this is the surface where
cross-reviewer corroboration catches structural-vs-behavioral
mismatches.)*

## When to Apply

- **Architect drafting a hold item that adds a caller-facing
  affordance** (return discriminator, hook, callback, event payload,
  sentinel value): name at least one specific consumer site in the
  hold item's body that the implementer must update to consume the
  new value. "Add the discriminator" is incomplete; "add the
  discriminator AND update `routes/accreditation.ts:754` to capture
  and switch on the result" is complete.

- **Architect drafting a hold block that bundles an affordance-add
  item AND a call-site-restructure item in the same round**: call out
  the consumer-orphan risk explicitly, or split them across rounds —
  the affordance-add item in the round after the restructure has
  landed.

- **Implementer writing a signal block claiming resolution of an
  observability or discrimination hold item**: the block must cite a
  specific file:line consumer that switches on or emits the new value,
  and a test that pins it. "Discriminator + new event" is not a closed
  item if the event never fires from a live consumer.

- **Implementer performing the cross-item self-check**: for any item
  that adds a caller-facing affordance, grep the helper's call sites
  before writing the signal block. If a sibling item in the same
  round deleted or reordered callers, verify the affordance still has
  a live consumer in the post-restructure topology.

- **Architect at re-review intake** (`/ce-code-review` fan-out):
  treat the "return value discarded at sole call site" multi-reviewer
  cross-corroboration pattern as a flag for this class. Four
  independent personas reaching the same call site is a strong signal
  that a structural-vs-behavioral gap exists.

## Examples

### Worked example: `backend-broadcast-idempotency-cluster-followup`, round 3 to round 4

#### The hold items as co-bundled in round 3

Round-3 hold block included two interacting items:

**Item 6** — add a return-status discriminator to
`decrementBroadcastAttempts`:

> Fix: either return a status discriminator from
> `decrementBroadcastAttempts` (`'decremented' |
> 'enqueued_for_drain' | 'failed'`) that the hit-branch caller
> switches on to emit
> `event: 'accreditation.verify.idempotency_hit_decrement_degraded'`
> alongside the enqueue...

The stated purpose was per-call-site degraded-path observability.
Callers were to switch on `'enqueued_for_drain'` and emit a
site-specific structured event. See task file
`backend-broadcast-idempotency-cluster-followup.md` round-3 hold
block, item 6.

**Item 7** — restructure `/verify` to run the idempotency probe
before `incrementBroadcastAttempts`:

> [If cap-counter check runs before idempotency probe:] restructure
> to (a) idempotency probe (no state change), (b) if hit → 200
> (no cap consumed), (c) if miss → increment cap, broadcast.

Side effect: the hit-branch decrement — the consumer item 6 was
targeting — "became dead with the reorder" and was deleted. See
task file round-3 hold block, item 7.

#### What landed in commit `7b7f115`

- **Item 6 (structural contract):** `decrementBroadcastAttempts`
  signature changed from `Promise<void>` to
  `Promise<'decremented' | 'enqueued_for_drain' | 'failed'>`. Type
  `DecrementBroadcastAttemptsResult` exported and documented at
  `backend/src/routes/accreditation.ts:~153`. Docblock explicitly
  states: "callers add their site-specific event on top."
- **Item 7 (restructure):** reorder shipped. Hit-branch decrement
  deleted as dead code (correct in item 7's frame).
- **Missed (behavioral contract):** the *other* live call site
  (`backend/src/routes/accreditation.ts:754`, timeout-branch
  `await decrementBroadcastAttempts(token, attemptId)`) was not
  updated to consume the discriminator. Zero live consumers of the
  discriminator in production code after both items landed.

#### The signal block's self-deception framing

From the round-3 implementer signal block:

> Other caller (timeout-branch decrement at the broadcast catch)
> ignores the return value non-destructively. Test seams in
> `tests/routes/accreditation.test.ts` likewise ignore the return;
> surface change is backward-compatible.

The "backward-compatible" framing was wrong. The discriminator was
introduced specifically because hold item 6 required per-call-site
behavior — the docblock says so directly. "Ignored at the only live
call site" does not mean the change is backward-compatible; it means
the behavioral contract of the hold item is unmet.

The resolution table marked item 6 "closed (discriminator + new
event)." The discriminator landed; no event fires from any live
consumer.

#### How the architect caught it

`/ce-code-review` re-review fanned out 11 personas on round 3's
commit. Four independent personas reached `accreditation.ts:754`:

- Maintainability M-1: "return value discarded at sole call site
  (`accreditation.ts:754`)" — conf 100
- Reliability R-1: "degraded-path event never fires because the
  timeout call site ignores the result" — conf 100
- Kieran-typescript KT-1: "call site at line 754 silently discards
  `Promise<DecrementBroadcastAttemptsResult>`" — conf 90
- Adversarial A-1: "the stated observable per-site event does not
  fire from any production call path" — conf 100

Cross-reviewer corroboration across four independent lenses is the
strong signal: no single persona's lens makes the behavioral-contract
gap obvious, but four independent reviewers all converged on the same
file:line anchor.

#### Round-4 re-routing

The round-4 hold block (appended at re-review time) rerouted the
work: capture the result at the timeout branch, emit
`accreditation.verify.timeout_decrement_degraded` on
`'enqueued_for_drain'`, add a spec pinning the event, and resolve
or delete the `'failed'` arm of the discriminator. The shape of
the fix:

```ts
// backend/src/routes/accreditation.ts:~754 (round-4 fix)
const decrStatus = await decrementBroadcastAttempts(token, attemptId);
if (decrStatus === 'enqueued_for_drain') {
  logger.warn({
    event: 'accreditation.verify.timeout_decrement_degraded',
    username,
    attempt_id: attemptId,
    token_hash,
  }, 'broadcast timeout: decrement enqueued for drain (redis degraded)');
}
```

This is the behavioral contract item 6 was filed to provide: a
per-call-site structured event that a dashboard or alert can key
on, distinct from the helper-internal
`broadcast_decrement_redis_unavailable` warn that fires for broader
operator correlation.

#### Counter-example: legitimate backward-compatible discard

Suppose a future hold item reads: "Add `durationMs` to
`lookupCustodyBroadcastIdempotency`'s return shape so callers can
optionally emit latency metrics." This is a purely additive
affordance. Existing callers that don't yet emit latency metrics are
legitimately backward-compatible — the hold item's purpose is to
*enable* opt-in per-site reporting, not to mandate it. A signal
block that says "field added; no callers consume it yet; they may
opt in at their own pace" correctly marks the item closed. The
distinction: the hold item's stated purpose is enablement, not
per-site-behavior mandate. When the purpose is mandate, ignored =
unmet.

## Related

- [`correlated-options-discriminated-union-2026-04-28.md`](./correlated-options-discriminated-union-2026-04-28.md)
  — the type-level pattern for discriminated-union design. This
  convention adds the consumer-adoption verification layer that the
  design doc assumes but does not require.
- [`wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`](./wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md)
  — call-site adoption verification for wrapping primitives. Same
  "claim vs verification" principle: implementer listing sites in
  the signal block is a claim; grep is the evidence. This doc
  applies the principle to return-value consumption rather than
  call-site adoption of a new argument.
- [`route-level-error-class-coverage-after-helper-extraction-2026-04-29.md`](./route-level-error-class-coverage-after-helper-extraction-2026-04-29.md)
  — structural presence of a helper does not prove behavioral
  activation; same meta-principle applied to test coverage of
  helper delegation.
- [`load-bearing-greps-at-signal-block-write-time-2026-05-06.md`](./load-bearing-greps-at-signal-block-write-time-2026-05-06.md)
  — temporal anchor for implementer-side verification. The
  consumer-adoption check belongs at the same signal-block-write-time
  boundary as the load-bearing grep.
- [`implementer-self-verify-signal-block-sha-2026-05-04.md`](./implementer-self-verify-signal-block-sha-2026-05-04.md)
  — the broader signal-block discipline: write signal blocks that
  would survive a reviewer checking every claim. Behavioral-contract
  evidence (file:line consumer + pinning test) is the specific form
  that discipline takes for affordance-add hold items.

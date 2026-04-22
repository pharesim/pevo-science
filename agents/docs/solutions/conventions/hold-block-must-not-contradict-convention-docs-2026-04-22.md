---
title: Architect hold blocks must not contradict existing convention docs — grep `agents/docs/solutions/conventions/` before specifying new error-envelope semantics
date: 2026-04-22
category: conventions
module: agents/docs/tasks
problem_type: convention
component: architect_hold_block_authorship
severity: high
applies_when:
  - Authoring a hold block that specifies HTTP status codes, error envelope fields (`retriable`, `outcome`, `verify_before_retry`, `timeout_ms`), or any structured field contract
  - A hold block references a pattern (timeout handling, broadcast ambiguity, retry semantics, cache-key construction, normalization) that may already be covered by an existing convention doc
  - Coordinating a cross-task abstraction shape consumed by multiple in-flight tasks (e.g., backend emits a flag that UI consumes)
  - Writing a new convention doc — grep first to check for prior coverage on the same territory
tags:
  - agent-coordination
  - hold-block
  - architect-review
  - convention-drift
  - error-envelope
  - broadcast-timeout
  - retriable
  - workflow
---

## Rule

Before finalizing any hold block that specifies an error envelope, HTTP status code, structured-field contract, or other machine-readable shape, the architect MUST grep `agents/docs/solutions/conventions/` for existing coverage of the same pattern. If a convention doc governs the shape, the hold block MUST cite it and copy its prescribed envelope verbatim, with a citation. The hold block MUST NOT silently specify a shape that contradicts an existing convention.

If the convention doc is out of date relative to the hold, update the convention doc first (via `/ce-compound-refresh` or a direct edit), then reference the updated version.

## Why

`BE-ORCID-BROADCAST-ABORT-TIMEOUT` round-1 hold block specified:

```
504 BROADCAST_TIMEOUT → details: { retriable: true, timeout_ms: 30000 }
```

The pre-existing `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` convention mandated the opposite envelope for the same pattern:

```
504 BROADCAST_TIMEOUT → details: {
  retriable: false,
  outcome: 'uncertain',
  verify_before_retry: true,
  timeout_ms: number,
}
```

The convention's rationale is sound: a broadcast timeout is **ambiguous-outcome** — the op may or may not have landed on chain. `retriable: true` tells the caller "safe to retry," which is a lie when a retry can produce duplicate on-chain ops.

Backend implemented the hold-block spec (`retriable: true`) faithfully. Backend tests passed. The contradiction surfaced only at round-2 `/ce-code-review` via adversarial + learnings-researcher persona convergence.

Cost of the drift:
1. One full implement → review → hold → re-implement cycle wasted (~1 round-trip).
2. Cross-task contamination risk: `ui-orcid-callback-retriable-branch` was in `tasks/review/` consuming the wrong `retriable` flag. Had it archived before round-2 caught the contradiction, the UI would have shipped retry logic that always produces 400 (because the OAuth `state` is consumed pre-dispatch at `orcid.ts:~253`).
3. The `retriable` field semantic is load-bearing across the API — if different sites emit different values for the same condition, agent consumers cannot trust it. Every drift degrades the contract permanently.

Convention docs exist precisely to prevent this class of drift. But they only work if they are consulted **before** new specs are written, not discovered afterward by a review tool.

## When to Apply

- Authoring any hold-block section that specifies field values, flag semantics, HTTP status codes, headers, or response envelopes.
- Writing a new convention doc — grep first to check whether an existing doc already covers the territory.
- Coordinating a cross-task abstraction shape (e.g., a flag emitted by one backend task and consumed by a UI task or a second backend task). The hold block should explicitly reference sibling task files and the convention doc all three depend on.
- Re-review signal intake: if the `learnings-researcher` persona in `/ce-code-review` flags a convention doc during review, verify any hold block already on file is consistent. If it's not, the hold block was authored without the grep step.
- Before approving a task for archive: check whether the task's final commit diff matches the convention doc's prescribed shape on every field the convention covers.

## How to Apply

**Minimum grep patterns when authoring an error-envelope hold block:**

```bash
grep -rli 'retriable\|outcome\|verify_before_retry' agents/docs/solutions/conventions/
grep -rli '<error-code-name>\|<domain-keyword>' agents/docs/solutions/conventions/
grep -rli '504\|502\|timeout\|broadcast' agents/docs/solutions/conventions/  # or whichever HTTP codes / keywords are relevant
```

Any hit in `agents/docs/solutions/conventions/` means read that file before writing the spec. Any deviation must be justified in the hold block with explicit rationale: "this task deviates from `<doc>` because <reason>; update the convention in a follow-up pass."

**Minimum citation shape in the hold block itself:**

```markdown
Fix: apply the envelope from `agents/docs/solutions/conventions/<doc>.md` (section `<section name>`) verbatim:

```ts
sendError(res, 504, 'BROADCAST_TIMEOUT', '<contextual>', {
  retriable: false,
  outcome: 'uncertain',
  verify_before_retry: true,
  timeout_ms: err.timeoutMs,
});
```
```

The citation makes it discoverable during implementation, during re-review, and during any future audit. Future architects writing a hold for the same pattern will follow the citation chain and land consistent without repeating the convention lookup.

## Examples

**Before (incident pattern):**

Round-1 hold block on `BE-ORCID-BROADCAST-ABORT-TIMEOUT`:

> 2. **P1** — `BroadcastTimeoutError` is exported for discrimination but never caught by name at any of 8 call sites. [...] Fix at each catch: `if (err instanceof BroadcastTimeoutError) { sendError(res, 504, 'BROADCAST_TIMEOUT', '<contextual message>', { retriable: true, timeout_ms: err.timeoutMs }); } else { ... }`

No `agents/docs/solutions/conventions/` grep. `chain-write-timeout-ambiguous-outcome-2026-04-22.md` existed and prescribed `retriable: false`. Backend implemented `retriable: true`. Round-2 review caught it. Round-3 hold issued. UI task sat in `review/` consuming the wrong value until the contradiction was caught.

**After (correct pattern):**

Before drafting the hold block, architect runs:

```bash
grep -rli 'retriable\|BROADCAST_TIMEOUT\|ambiguous' agents/docs/solutions/conventions/
```

Finds `chain-write-timeout-ambiguous-outcome-2026-04-22.md`. Reads the A.2 envelope. Drafts the hold block as:

> Fix at each catch: apply the A.2 envelope from `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md`:
> ```ts
> if (err instanceof BroadcastTimeoutError) {
>   sendError(res, 504, 'BROADCAST_TIMEOUT', '<contextual>', {
>     retriable: false,
>     outcome: 'uncertain',
>     verify_before_retry: true,
>     timeout_ms: err.timeoutMs,
>   });
> } else { ... }
> ```

Backend implements the correct shape on first try. Round-2 review archives. Zero waste. UI task consumes the correct flag.

## Related

- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — the convention that was contradicted; the canonical spec for `BROADCAST_TIMEOUT` 504 envelopes.
- `agents/docs/solutions/conventions/cross-task-hold-block-staleness-2026-04-22.md` — complementary failure mode: a hold block correct at authorship can go *stale* before round-N+1 application when parallel work lands between rounds. This doc covers a hold block *wrong at authorship* by ignoring an existing convention; the staleness doc covers a hold block that was right when written but became wrong while waiting.
- `agents/docs/solutions/conventions/verify-library-claims-before-load-bearing-security-margins-2026-04-22.md` and the sibling `verify-resource-knob-math-...` — same meta-pattern (verify a load-bearing claim before baking it into hold-block specs) applied to third-party library behavior and resource-knob math respectively. Share the family "unverified specification propagates across artifacts unchecked."
- `agents/docs/solutions/conventions/backend-api-contracts-are-architect-owned-2026-04-21.md` — the boundary rule that makes this convention the architect's responsibility to enforce. Backend workers defer contract-shape decisions to architect; architect must therefore grep conventions before specifying.

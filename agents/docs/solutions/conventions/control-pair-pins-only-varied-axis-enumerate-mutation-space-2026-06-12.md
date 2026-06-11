---
title: "A discrimination control pair pins only the axis it varies: enumerate the comparison's mutation space"
date: 2026-06-12
category: conventions
module: backend/tests + auth middleware
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - Writing a test that claims to discriminate a specific comparison (this exact gate fires, not just "the feature works")
  - The protected comparison involves operator choice, precision/granularity, or a bound that could shift by a small constant
  - A suite has a clean present/absent or pass/fail control pair but no case in the boundary region separating the strict form from plausible softenings
  - Auditing an existing suite for coverage accuracy before archiving a task that introduced or modified the comparison
tags: [testing, mutation-soundness, discrimination, control-pair, comparison-operators, granularity, security-gate]
---

# A discrimination control pair pins only the axis it varies: enumerate the comparison's mutation space

## Context

`verifyHiveSignature` implements a same-second JWT revocation exemption: revoke when `payload.iat <= invalidatedAtSec && payload.reissuedAt !== invalidatedAtMs`, where `invalidatedAtSec = Math.floor(invalidatedAtMs / 1000)`. The exemption uses strict epoch-ms identity so the one legitimately reissued post-reset token survives while every other same-second token is revoked.

The two real-DB round-trip suites (`verifyHiveSignature-reissuedat-roundtrip.test.ts`, `verifyHiveSignature-reissuedat-orcid-roundtrip.test.ts`) each pin the gate with a deterministic control pair minted at the same integer second, differing only in the `reissuedAt` claim: WITH (`=== storedMs`) must survive, WITHOUT must be revoked. That pair is genuinely deterministic and kills the binary revert (delete the exemption and the WITH-control goes red). It still left the gate's precision unpinned: an architect-review validator simulated two plausible weakenings of the exemption — a seconds-grain comparison (`Math.floor(reissuedAt / 1000) === invalidatedAtSec`) and a `>=` substitution — against every assertion in all three suites covering the gate, and every assertion stayed green under both. The mocked hardening suite's stale-`reissuedAt` case sat at a different integer second, so no case anywhere presented a `reissuedAt` in the same integer second with a different millisecond — the only input class that separates strict `!==` from both weakenings.

## Guidance

A control pair that varies exactly one axis (claim present vs absent) proves exactly that axis. It does not prove the comparison implementing the check is precise. Every comparison has a mutation space — plausible weakenings differing in operator, granularity, or operand — and a suite pins the comparison only if some case sits on the discriminating side of each weakening's boundary.

Design procedure:

1. Write down the exact comparison being protected.
2. Enumerate its plausible weakenings. For a strict identity like `reissuedAt !== invalidatedAtMs`: operator swap (`>=` spares values at or above the threshold), granularity drop (seconds-grain spares same-second values with different milliseconds), operand shifts (off-by-one bounds).
3. For each weakening, construct the minimal input the strict form rejects and the weakened form accepts.
4. Check whether any existing case falls in that class; if not, the comparison is unpinned against that weakening even with a green control pair.
5. Prefer one input that kills several weakenings at once. Here `reissuedAt = INVALIDATED_AT_MS + 1` is same-second (kills seconds-grain) and greater-than (kills `>=`) — one control, two boundaries.
6. Home the discriminating case where its input is deterministic. A same-second-different-ms input is only reliably constructible against a fixed constant (the mocked hardening suite's `INVALIDATED_AT_MS`), not against a runtime-generated timestamp in a real-DB suite.

Also check for one-sided symmetry: the round-trip suites' decisive assertion (`decoded?.reissuedAt === storedMs`) pins the MINT side's millisecond precision; whether the VERIFY side compares at millisecond precision is a separate axis, and it is the one the weakenings attack.

## Why This Matters

Both simulated weakenings widen a security gate's revocation exemption while the entire test surface stays green — the failure ships silently, which is exactly the property the control pair was added to prevent on its own axis. The fix that closes it is one spec, but only if someone enumerates the mutation space; no amount of strengthening the present/absent pair reaches it.

Triage boundary (per the project's default-dismissal of preemptive test hardening): this class is an accuracy gap in EXISTING claimed-discrimination coverage — the suite already asserts that it discriminates the gate, so an unpinned weakening axis makes an existing claim incomplete. Adding controls for comparisons no suite claims to pin remains preemptive hardening and keeps its default-dismiss bar.

Relationship to the revert-probe rule ([[tests-must-fail-on-mutation-of-code-under-test-2026-04-22]]): the binary revert IS caught by a present/absent pair, so a revert probe gives a true all-clear for the wrong question. Weakenings are non-revert mutations; mutation-space enumeration extends the revert-verify discipline rather than duplicating it.

## When to Apply

- Designing or reviewing controls for any gate whose correctness depends on operator strictness or precision (epoch-ms vs seconds, bytes vs characters, `<` vs `<=`).
- At review intake for a task that added a discrimination pair: ask which weakenings of the comparison the suite would catch, and simulate the plausible ones case-by-case (the validator-simulation that found this gap is cheap and decisive).
- When choosing where a boundary case lives: prefer the fixed-constant suite over the real-path suite for sub-unit boundary inputs.

## Examples

The present/absent pair (necessary, not sufficient):

```ts
// WITH:    iat = invalidatedSec, reissuedAt = storedMs  -> 200
// WITHOUT: iat = invalidatedSec, no reissuedAt          -> 401 SESSION_INVALIDATED
// Both weakenings below pass this pair:
//   A: Math.floor(reissuedAt / 1000) === invalidatedAtSec   (seconds-grain)
//   B: reissuedAt >= invalidatedAtMs                        (operator swap)
```

The discriminating input, homed in the fixed-constant hardening suite (landed):

```ts
const INVALIDATED_AT_MS = 1_700_000_000_500; // mid-second constant
// reissuedAt = INVALIDATED_AT_MS + 1 -> must be 401
// same integer second  -> seconds-grain weakening would spare it
// greater than stored  -> >= weakening would spare it
// strict !== identity  -> correctly revokes it
```

The suite's full boundary walk: claim absent (revoked), exact identity (spared), different second (revoked), same second off by 1 ms (revoked). The last case is the one the pair alone cannot supply.

## Related

- [[tests-must-fail-on-mutation-of-code-under-test-2026-04-22]] — the revert-verify foundation; this doc covers the non-revert weakenings a passing revert probe does not reach.
- [[assertion-vacuity-from-upstream-bail-in-mocked-tests-2026-05-17]] — prescribes the positive-control pair as the vacuity fix; this doc is the next refinement: the pair itself pins only the axis it varies.
- [[mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15]] — "construction class determines mutation class"; a same-polarity presence/absence pair is a construction class blind to operator and granularity weakenings.
- [[hold-block-shape-coverage-must-walk-full-lattice-2026-05-14]] — the same enumeration-completeness meta-pattern applied to input-shape lattices; here applied to a comparison's operator/granularity/operand space.
- [[dedup-shared-constant-defeats-test-value-pin-2026-05-26]] — the operand axis in isolation; this doc generalizes across all three axes.
- [[defense-in-depth-canary-must-pin-each-layer-2026-05-07]] — each layer needs its own canary; each weakening boundary needs its own control.
- [[test-mock-carve-out-clause-c-2026-05-04]] — the carve-out framework justifying the boundary case's home in the mocked suite (fixed-constant determinism) with real-path companions covering the integrated path.

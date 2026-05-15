---
title: Parallel worker fan-out leaves behind helper-name divergence — sweep for structurally identical bodies, not just named extractions
date: 2026-05-15
category: conventions
module: agents
problem_type: convention
component: orchestration
severity: medium
applies_when:
  - Orchestrating a multi-worker `git worktree`-isolated fan-out where each worker touches a different file or test
  - Running a post-fan-out convergence sweep before archiving a multi-commit task
  - Reviewing a multi-commit test-coverage task that spawned parallel workers
  - Future contributor in a documented area adding "another `findEvent`-style helper" near a sibling that already has one
tags:
  - worker-fanout
  - orchestration
  - convention
  - test-helpers
  - convergence-sweep
related_components:
  - testing_framework
---

## Context

Parallel worker fan-out (architect spawning N `isolation: "worktree"` subagents to touch disjoint files) is the project's standard mechanism for parallelizing independent work. Workers run in isolated worktrees and cannot see each other's outputs. The parent orchestrator runs a convergence sweep after the workers commit, looking for inconsistencies introduced by the parallelism.

BE-LOG-SHAPE-CONVERGENCE-SIBLING-FILES round-2 (4 parallel workers touching `signup-verify.test.ts`, `settings.test.ts`, `orcid.test.ts`, `accreditation.test.ts`, `custody.test.ts` — commits `bac0615`, `ade1d20`, `21eb8b7`, `8200b85`) surfaced a failure mode the convergence sweep currently misses: each worker independently created a small helper to filter `logger.error.mock.calls` by `event` field. Result on main:

- `settings.test.ts:17-29` introduced a named helper `findEvent`.
- `signup-verify.test.ts` introduced a named helper `findEventCall` — identical body, different name.
- `orcid.test.ts`, `custody.test.ts`, `accreditation.test.ts` open-coded the same 4-line `mock.calls.find((args) => args[0]?.event === ...)` snippet ~28 times across specs (no named helper at all).

The parent's post-fan-out sweep (commit `bc7674e`) correctly caught a separate divergence — the `signRequestBound` worker had used inline `cryptoUtils.sha256(...)` because its base predated a shared-helper extraction — and migrated the affected spec. But the sweep missed `findEvent`/`findEventCall` entirely because the parent's mental model focused on "did the workers all import my freshly-extracted helper?" not "did the workers independently create structurally identical helpers I should consolidate?"

## Guidance

After every parallel worker fan-out, the convergence sweep MUST scan for two cases:

1. **Named extractions** the parent already tracks. Did each worker use the shared helper the parent expected? (The case `bc7674e` got right.)
2. **Structurally identical function bodies** the workers independently created. Did two workers each produce `function findEvent(...)` / `function findEventCall(...)` with the same body but different names? Did multiple workers open-code the same inline anonymous predicate (`.find((args) => args[0]?.event === ...)`) across specs?

Concrete sweep steps to run after the workers commit, before the parent commits the convergence pass:

```
# 1. List helpers added or modified by any worker, across all changed files in the fan-out range:
git diff --unified=0 <fan-out-base>..HEAD -- '<changed-files>' | rg -A 0 -e '^\+(?:function |const \w+ = \()' -e '^\+\s*(?:function |const \w+ = \()' | rg -v '^\+\+\+'

# 2. For each pair found in step 1, manually inspect bodies. If syntactically equivalent modulo naming, flag for consolidation.

# 3. Grep for inline anonymous patterns repeated across changed files (case-by-case; substitute the pattern shape the workers were likely to produce):
rg -n '\.mock\.calls\.find\(\(args\) => args\[0\]\?\.event' <changed-files>
rg -n '\.find\(\(c\) => c\[0\] ===' <changed-files>
# Any count >2 across the fan-out scope is an extract-candidate.
```

Consolidate before archiving: extract the common helper to `<role>/tests/support/<descriptive-name>.ts` (or the role's existing support directory) and migrate the workers' call sites to import it.

## Why This Matters

Without this scan, every fan-out leaves behind two compounding costs:

1. **Helper-name divergence.** A future contributor reading `settings.test.ts` adopts `findEvent`; the next person reading `signup-verify.test.ts` adopts `findEventCall`; a third reading `orcid.test.ts` open-codes inline. The set of names grows. Refactoring across files becomes harder. A future fan-out touching the same area inherits one of the divergent names by reading the nearest sibling, perpetuating the split.

2. **Open-code-pattern accumulation.** The 4-line `.find((args) => args[0]?.event === ...)` snippet, repeated 28 times across 3 test files, is ~110 lines of fungible code. A future change to the underlying pattern (e.g., switching from `mock.calls` arrays to a typed log-capture helper) must be applied at 28 sites.

The convergence-sweep mental model that focuses ONLY on "did the workers all use my new shared helper?" misses both costs because they emerge from helpers the workers CREATED independently, not from helpers the parent extracted. The sweep must broaden its scope.

## When to Apply

- After any `isolation: "worktree"` fan-out with ≥2 workers touching related code paths (tests in the same role, route files in the same domain, etc.).
- Before the parent agent commits the post-fan-out convergence pass and ends the round.
- When reviewing a multi-commit task where the commit log shows 3+ parallel worker commits at the same timestamp (a fan-out tell).
- During architect `/ce-code-review` of any fan-out task — surface helper-divergence findings as P2 maintainability items if the sweep was skipped.

Do NOT apply when:

- The fan-out is single-worker (no parallelism, no convergence problem).
- The workers touch genuinely independent code (e.g., one worker fixes a bug in `bridge.ts`, another touches an unrelated `claims.ts` route — no shared test infrastructure).
- The divergence is intentional (e.g., two helpers with similar signatures but genuinely distinct semantics — verify by reading bodies, not just signatures).

## Examples

### Worker outputs that should trigger consolidation

Worker A (settings.test.ts):
```ts
function findEvent(spy: { mock: { calls: unknown[][] } }, event: string) {
  return spy.mock.calls.find((args) => (args[0] as { event?: string })?.event === event);
}
```

Worker B (signup-verify.test.ts):
```ts
function findEventCall(spy: { mock: { calls: unknown[][] } }, event: string) {
  return spy.mock.calls.find((args) => (args[0] as { event?: string })?.event === event);
}
```

Convergence sweep action: extract to `backend/tests/support/log-shape-helper.ts` exporting `findLogEvent(spy, event)`; migrate both files to import it.

Worker C (orcid.test.ts), repeated across 7 specs:
```ts
const call = errorSpy.mock.calls.find((args) => args[0]?.event === 'orcid.callback.token_exchange_failed');
const call = errorSpy.mock.calls.find((args) => args[0]?.event === 'orcid.callback.failed');
// ... 5 more
```

Convergence sweep action: same `findLogEvent(spy, event)` helper, replace the 7 inline patterns with helper calls.

### Worker outputs that should NOT trigger consolidation

Worker A (orcid.test.ts):
```ts
function makeOrcidTokenExchangeStub(failureMode: 'network' | 'http500') { ... }
```

Worker B (custody.test.ts):
```ts
function makeCustodyBroadcastStub(rejectionShape: 'fresh_auth_proof_missing' | 'consensus_rejected') { ... }
```

Different signatures, different domains, different test infrastructure. No consolidation needed; the names accurately describe the distinct roles.

## Related

- `agents/docs/solutions/conventions/worktree-fanout-orphan-detection-2026-04-29.md` — detection check for the orthogonal failure mode (worker commits land on a branch that never merges back). This learning is the complementary case for content that DID merge but contains parallel-author artifacts.
- `agents/docs/tasks-archive.md` BE-LOG-SHAPE-CONVERGENCE-SIBLING-FILES (archive when round-3 lands) — concrete instance.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — adjacent grep-the-audit principle. The convergence sweep step 3 above (`rg -n '\.find\(\(args\) => args\[0\]\?\.event'`) is a specific application of "grep is the audit, not eyeballs."

---
title: "Defense-gated walker early-exit paths must return verified state, not loop state"
date: 2026-05-16
category: conventions
module: backend
problem_type: convention
component: authentication
severity: high
applies_when:
  - "Adding an early-exit branch (AbortController, wall-clock budget, cycle-detect, hop-cap, timeout) inside a defense-gated walker loop"
  - "Reviewing a walker whose loop variables are seeded from attacker-controllable metadata (e.g., pevo.continues pointers, parent-author fields)"
  - "Auditing canonical-root resolution, continuation-chain resolution, or any traversal that ends in an (author, permlink) returned to the route handler"
  - "Designing layer-pinning canaries for walker short-circuit paths"
related_components:
  - database
  - testing_framework
tags:
  - walker
  - early-exit
  - abort-controller
  - fail-closed
  - author-consent
  - phishing
  - canonical-root
  - mutation-kill
---

# Defense-gated walker early-exit paths must return verified state, not loop state

## Context

A walker that traverses a chain of `(author, permlink)` nodes with a per-iteration authorization gate has two distinct pieces of state at every iteration: **verified state** (what the gate has already accepted, plus the START coords given by the caller) and **loop state** (the next candidate the walker advanced to but has NOT yet gated). The gate's whole purpose is to refuse to surface loop state until verification passes.

The trap: any early-exit branch added later (abort signal, wall-clock budget, cycle-detect, hop-cap, timeout) that returns loop state instead of verified state silently surfaces an attacker-controlled value, because at iter-0 the loop state was seeded from attacker-controllable metadata (the `pevo.continues` pointer on the START post) before the gate ever ran.

The canonical-root walker `findCanonicalRoot` in `backend/src/routes/papers.ts` surfaced this concretely under `/ce-code-review` of `backend-haf-walker-wall-clock-budget` round-1 (commit `79078d7`, 2026-05-16). The wall-clock-budget commit added an `AbortController` check at the top of each iteration. The check fired BEFORE that iteration's `fetchHeadAuthorizedAuthors` gate. The implementer's instinct was to return `(currentAuthor, currentPermlink)`. At iter-0 those values came from `startRow.cont_author` / `startRow.cont_permlink` (`papers.ts:1607-1608`), which is the attacker-controlled `pevo.continues` pointer on the START post.

**Phishing repro:** attacker posts `attacker/spoof-paper` with `pevo.continues = {alice, real-paper}`. Under degraded HAF, the budget fires after the initial probe but before iter-0's auth-check. Walker returns `{alice, real-paper}` as canonical. Route handler sets `author='alice', permlink='real-paper'`. Alice's content surfaces under `/api/papers/attacker/spoof-paper` — the exact phishing pretext the gate exists to prevent.

The gate's own rejection branch at `papers.ts:1670` (`unauthorized_hop`) was already correctly fail-closed: it returns `(childAuthor, childPermlink)`. At iter-0, `childAuthor === author` and `childPermlink === permlink` are the route handler's own START params (set at `papers.ts:1605-1606`), so the URL safely shows the attacker's own content. The fix is to mirror that discipline on every other early-exit path. Cross-reviewer corroboration (correctness Opus + adversarial Opus, independent traces) is the structural-trap indicator: two reviewers walking early-exit return values against the gate invariant separately is the signal that the pattern generalizes beyond this one return statement.

## Guidance

Whenever you add or review an early-exit branch inside a defense-gated loop, name the two pieces of state explicitly and check which one each early-exit returns:

- **Verified state**: the last `(author, permlink)` the gate accepted, OR — on iter-0 before the gate has run — the START coords the caller supplied (which by definition match the URL the user typed and carry the user's own implied trust).
- **Loop state**: the next candidate the walker advanced to but has not yet gate-verified.

**Every early-exit branch must return verified state.** The gate's own rejection branch is the reference shape: it already fail-closes correctly because it KNOWS the gate is the boundary. Other short-circuits (abort, timeout, budget exhaustion, cycle-detect, hop-cap) must mirror its return values, not the loop's `current*` variables.

At iter-0, "verified state" is the START coords. This is the safest fail-closed value: the URL the user typed resolves to itself, never surfaces someone else's content, and never enables phishing.

Loop-state returns are the trap. They look correct ("return where we are right now") but they fail open: the walker effectively says "I bailed, but here, take this attacker-supplied pointer as the answer."

**The structurally stronger fix** (when feasible) is to encode the verified-vs-unverified distinction in the type or return shape so the bug becomes unrepresentable. See `architecture-patterns/pevo-inverted-predicate-collapse-encode-invariant-structurally-2026-05-05.md`. The convention here is the runtime-layer guard for cases where structural encoding isn't yet available.

## Why This Matters

This is a high-severity defect class because the surface area is "any walker with a gate" and the consequence is content-spoofing / phishing: the URL bar says one author, the rendered content belongs to another. The walker is supposed to be the boundary that prevents exactly this.

The trap is non-obvious for two reasons:

1. **The implementer's intuition is wrong by default.** When adding a budget/abort check at the top of a loop, "return current state" reads as the conservative choice. But "what we have" at iter-0 is attacker-controlled until the gate runs.
2. **The gate's correct fail-closed branch is right there in the same loop.** It returns `childAuthor` / `childPermlink`, not `currentAuthor` / `currentPermlink`. The asymmetry is invisible unless you walk the early-exit return values against the gate invariant deliberately. Round-1 review didn't catch it; round-1's `/ce-code-review` did, with two reviewers converging independently.

This convention sits in the family "an exceptional-exit branch (timer fire, abort, catch) silently violates the contract the success path satisfies." Siblings:
- `chain-write-timeout-ambiguous-outcome-2026-04-22.md` — timer fire is uncertain outcome, treat as discriminated state not default fall-through
- `fetch-abort-controller-bounds-headers-only-2026-05-06.md` — AbortController coverage scope narrower than reviewers assume
- `per-request-memo-catch-block-negative-cache-contract-2026-05-06.md` — catch-block memo write that doesn't complete the contract

Same meta-shape, different layer.

## When to Apply

- Adding an `AbortController`, wall-clock budget, hop-cap, timeout, or signal-from-caller check inside a defense-gated walker loop
- Adding cycle-detection (the cycle-terminus node may not have been gate-verified before the cycle check fires)
- Reviewing any walker whose loop variables are seeded from attacker-controllable metadata (`pevo.continues`, parent-author fields, any JSON-metadata-sourced pointer)
- Designing the canary suite for a new walker: add a spoof-START variant of the slow-HAF canary that asserts the abort path returns the START coords, not the `pevo.continues` target
- Auditing sibling code paths after fixing one instance: the cycle-detect short-circuit in `findCanonicalRoot` at `papers.ts:~1739` and the forward walker `resolveContinuationChain` both have parallel structure and the same trap shape

**Smell test.** For every early-exit branch inside a defense-gated loop, ask: *"If I trigger this branch at iter-0, does it return the attacker's `pevo.continues` target or the URL the user typed?"* If the former, the branch is failing open.

## Examples

**Anti-pattern: returns attacker-controlled loop state** (the round-1 defect in `backend/src/routes/papers.ts:findCanonicalRoot`, commit `79078d7`):

```ts
for (let i = 0; i < CANONICAL_ROOT_MAX_HOPS; i++) {
  if (signal?.aborted) {
    logger.warn({event: 'canonical_root_walker_wall_clock_exceeded', ...});
    return { author: currentAuthor, permlink: currentPermlink };  // BUG: at iter-0,
                                                                  // these came from
                                                                  // startRow.cont_author/permlink
                                                                  // (attacker-controlled)
  }
  const authorizedAuthors = await fetchHeadAuthorizedAuthors(...); // gate
  if (!authorizedAuthors.has(childAuthor)) {
    logger.warn({event: 'canonical_root_walker_unauthorized_hop', ...});
    return { author: childAuthor, permlink: childPermlink };       // correctly fail-closed:
                                                                   // returns child/START coords
  }
  // ... advance currentAuthor/currentPermlink to the verified child ...
}
```

The abort branch returns `(currentAuthor, currentPermlink)`. The unauthorized-hop branch returns `(childAuthor, childPermlink)`. The two branches' return shapes disagree, and only one of them is gate-safe.

**Fixed shape: mirror the gate's fail-closed branch**:

```ts
for (let i = 0; i < CANONICAL_ROOT_MAX_HOPS; i++) {
  if (signal?.aborted) {
    logger.warn({event: 'canonical_root_walker_wall_clock_exceeded', ...});
    return { author: childAuthor, permlink: childPermlink };  // fail-closed: at iter-0,
                                                              // these are the route handler's
                                                              // own START params, never the
                                                              // attacker's pevo.continues target
  }
  const authorizedAuthors = await fetchHeadAuthorizedAuthors(...);
  if (!authorizedAuthors.has(childAuthor)) {
    return { author: childAuthor, permlink: childPermlink };  // unchanged: already correct
  }
  // ... advance currentAuthor/currentPermlink ...
}
```

Both early-exit branches now return the same shape (the child/START coords) and the URL invariant holds: the user's URL bar always resolves to content the user is authorized to see at that URL (their own typed coords on iter-0, the last gate-verified node thereafter).

**Layer-pinning canary** (companion to the fix, added to `backend/tests/routes/canonical-root-walker.test.ts`):

```ts
it('abort path returns START coords, not the attacker-controlled pevo.continues target', async () => {
  // START post has pevo.continues pointing at an unrelated author's real paper.
  // Slow-HAF mock fires the abort signal after the initial probe but before
  // iter-0's fetchHeadAuthorizedAuthors gate runs.
  const startAuthor = 'attacker';
  const startPermlink = 'spoof-paper';
  // Mocked startRow has cont_author='alice', cont_permlink='real-paper'.

  const result = await findCanonicalRoot(startAuthor, startPermlink, { signal: abortedSignal });

  // Fail-closed: abort path must return the START coords, not the spoof target.
  expect(result).toEqual({ author: 'attacker', permlink: 'spoof-paper' });
  // Mutation-kill: revert to `(currentAuthor, currentPermlink)` -> this assertion
  // FAILS RED (alice's coords surface under attacker's URL).
});
```

The canary's mutation-kill row makes the convention a first-class protected invariant: any future refactor that flips the abort return back to loop state fails the canary.

## Related

- `agents/docs/solutions/conventions/symmetric-walker-convention-application-audit-prototype-holds-2026-05-05.md` — direct sibling on the same walker pair, complementary failure mode (gate-audit-history discipline vs return-discipline at exceptional exits). Even an implementer who fully audited the prototype's holds could write the same early-exit return bug, because the bug is in `return` placement, not gate composition.
- `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — parent ontological/threat-model doc whose phishing-pretext threat this convention's defect enabled. The new convention is the runtime-return-discipline corollary: even with author+type gates correctly composed, you must NOT emit candidate identity BEFORE the gates run.
- `agents/docs/solutions/architecture-patterns/pevo-inverted-predicate-collapse-encode-invariant-structurally-2026-05-05.md` — structural-alternative ladder. Encode the verified-vs-unverified distinction in the type or return shape so the bug becomes unrepresentable; this convention is the runtime-layer specialization when structural encoding isn't yet available.
- `agents/docs/solutions/conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` — sibling axis at the test layer (each defending layer needs its own canary). Provides the canary-design toolkit for the mutation-kill test this convention recommends.
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — sibling meta-pattern on timer/abort semantics being a discriminated state, not a default fall-through.
- `agents/docs/solutions/conventions/per-request-memo-catch-block-negative-cache-contract-2026-05-06.md` — same-file, same-task-family sibling on exceptional-exit-branch contract gaps.
- `agents/docs/solutions/conventions/fetch-abort-controller-bounds-headers-only-2026-05-06.md` — sibling on AbortController-semantics-misread cluster.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — load-bearing convention for the mutation-kill claim on the recommended canary.

**Origin:** `/ce-code-review` of commit `79078d7` (`backend-haf-walker-wall-clock-budget` round-1, 2026-05-16). Cross-reviewer corroboration: correctness (Opus) and adversarial (Opus) independently traced the defect. Fix landed as round-1 hold item 1 with companion canary requirement.

**Authoritative code locations:**
- `backend/src/routes/papers.ts:1605-1606` — `childAuthor`/`childPermlink` seeded from route handler params (verified-state at iter-0)
- `backend/src/routes/papers.ts:1607-1608` — `currentAuthor`/`currentPermlink` seeded from `startRow.cont_*` (attacker-controlled loop-state at iter-0)
- `backend/src/routes/papers.ts:1633` — the abort check
- `backend/src/routes/papers.ts:1644` — the buggy abort return (fixed in round-2 per hold item 1)
- `backend/src/routes/papers.ts:1651` — the per-iteration gate (`fetchHeadAuthorizedAuthors`)
- `backend/src/routes/papers.ts:1670` — the correctly-fail-closed `unauthorized_hop` reference branch

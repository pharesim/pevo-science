---
title: "An await is not a teardown boundary unless it yields to a macrotask: a pure microtask hop cannot host a subject scrub"
date: 2026-09-03
category: conventions
module: frontend/src/lib/fresh-auth.js + the consent-op orchestrators (settings-fresh-auth.js, authorship-consent.js)
problem_type: convention
component: frontend_stimulus
severity: high
root_cause: async_timing
resolution_type: workflow_improvement
applies_when:
  - Architect or reviewer intake triaging an async-race or teardown-window finding on the fresh-auth / consent-op guard surface, especially one two or more reviewer personas agree on
  - Deciding whether to file, promote, or HOLD a task claiming a guard.tornDown() re-check is missing between two awaited steps
  - Reviewing resolveProof-style branches in settings-fresh-auth.js, authorship-consent.js, or fresh-auth.js for guard coverage
  - A findings-merge step treats reviewer agreement as independent corroboration for an async-timing claim
  - Evaluating whether a chain of promise resolutions between a guard check and a side effect actually crosses a macrotask boundary
symptoms:
  - Two or more independent reviewer personas flag a missing guard.tornDown() re-check between an await and a side effect
  - The findings-merge step promotes the finding on reviewer agreement alone, without naming which macrotask boundary would let the scrub interleave
  - The flagged await is a pure promise-resolution chain with no real I/O between the guard check and the side effect
  - Reading the actual callee shows the guard check already sits immediately before the branch, with no await in between
  - A third reviewer persona or an independent validator refutes the finding, and only a manual source read settles it
related_components:
  - authentication
  - development_workflow
tags:
  - fresh-auth
  - teardown-guard
  - macrotask
  - microtask
  - async-timing
  - false-positive
  - review-triage
  - consent-op
---

# An await is not a teardown boundary unless it yields to a macrotask

## Context

During an architect review of a teardown fix, two independent reviewer personas (security and correctness) each reported, without seeing each other's work, that `resolveProof` in `settings-fresh-auth.js` and `authorship-consent.js` was missing a `guard.tornDown()` re-check between `await mintViaPassword(...)` and the `FRESH_AUTH_ORCID_FALLBACK` branch that calls `beginOrcidUnderGuard`. Their claim: a flight could resume from that await already stale, fall into `beginOrcidFreshAuthRedirect` anyway, write its own ORCID mode and return-path keys under that function's ownership rule, and orphan them because a stale flight never runs the code that would remove them.

The claim is false. `FRESH_AUTH_ORCID_FALLBACK` is returned from exactly one place, the catch block inside the shared `mintViaPasswordFactor`:

```js
// frontend/src/lib/fresh-auth.js, mintViaPasswordFactor's catch block
if (guard.tornDown()) return guard.cancel();     // the guard check
if (err?.code !== 'UNAUTHORIZED') throw err;     // synchronous branch, no await
// ...
if (assumed) return FRESH_AUTH_ORCID_FALLBACK;   // the sentinel
```

Nothing between the guard check and the sentinel is awaited. By the time `resolveProof` receives the sentinel and branches on it, the guard has already been consulted at the last synchronous instant it is possible to consult it. Adding a second check at the call site would re-read the same generation value with nothing in between that could have changed it.

The review pipeline made the false finding worse rather than catching it: the findings-merge step treated the two reviewers' agreement as independent corroboration and raised the finding's confidence because it was reported twice. It took a third persona refuting it, an independent validator agreeing with the refutation, and a manual source read to kill it.

Prior rounds of this same work never needed this argument, which is why it was never written down (session history). Across four earlier sessions on this surface, every await treated as a genuine teardown window was real I/O: the `startOrcid` round-trip, a password prompt, an HTTP retry leg. The working rule was "re-check after every await that does real I/O or waits on the user", and it produced correct answers because no one had yet proposed a guard at a microtask-only hop. This incident is the first time that happened, and nothing in the corpus was available to settle it.

## Guidance

Whether a teardown can land inside a given `await` depends on whether that await yields to a **macrotask**, not merely to a microtask.

The event loop fully drains all queued microtasks belonging to the currently-running task before it runs the next macrotask (a DOM event, a timer, a completed I/O callback). A promise that resolves through pure computation, with no network call, no timer, and no DOM event anywhere in the chain, does not hand control back to anything that could run a scrub. A chain of such awaits is a single atomic unit as far as macrotask-driven interleaving is concerned, even though it is written as several `await` statements.

Before filing, promoting, or holding a task on a "teardown can land in this await" finding:

1. Identify what the await is actually awaiting.
2. Ask whether resolving it requires a macrotask: a `fetch`, a timer or `AbortSignal.timeout`, a `postMessage`, a DOM event listener resolving a promise.
3. If yes, a real boundary exists and a re-check after it is load-bearing.
4. If no, the await is a promise-resolution hop and no window exists there. Drop the finding rather than add a guard.
5. When the finding spans several hops, trace the whole chain. One real macrotask anywhere makes the boundary real at that point, but a check placed after that hop already covers every purely synchronous hop downstream of it. A further check with nothing awaited in between is redundant, not protective.
6. Classify the invocation, not the line. A call site whose callee has a synchronous fast path (a warm memo, a cache hit, an early return) is a real boundary on the invocations that take the slow path and a microtask-only hop on the ones that do not. A check at such a site is still correct, because the cold path is real; what changes is that its presence is not evidence a window exists on every call through it.

This is a **logically prior** gate, not a referee between the two existing guard-placement entries in this corpus. `fresh-auth-guard-coverage-must-sweep-the-callee-graph` asks whether a callee awaits before an irreversible effect, an instrumentation-completeness question. `subject-divergence-guard-earns-its-place-only-where-the-flow-acts-unpinned` asks whether the step after the guard reads identity from a mutable ambient source or only from values pinned before the first await, a load-bearingness question. Both already presuppose the await is a genuine suspension point. Apply this test first; only for awaits that pass it do the other two questions become meaningful.

In this codebase's guard vocabulary:

- **Real boundaries, needing a re-check:** the re-auth modal prompt (a human-length wait), the password mint round-trip (a `fetch` through `authenticatedRequest`), and the ORCID start round-trip (`startOrcid`, whose request is wrapped in an `AbortSignal.timeout` in `api.js`). Each is already followed by a `guard.tornDown()` check.
- **Not boundaries:** `resolveProof`'s hop from `await mintViaPassword(...)` into the `FRESH_AUTH_ORCID_FALLBACK` comparison and the `beginOrcidUnderGuard` call. The guard was consulted inside the callee as recently as consulting allows.

Trust a guard's docblock as design intent, but check it against the code before generalizing. `mintViaPasswordFactor`'s docblock says:

> Every await below is also a teardown boundary. The prompt is a human-length pause and the mint is a round-trip, so the tab's subject can change under either one

That is true and complete for the awaits **inside that function**, all of which are real I/O. It says nothing about the act of calling the function from elsewhere. A reader who generalizes it into "every await near fresh-auth code is a teardown boundary" files exactly the finding this incident produced.

## Why This Matters

A false "missing teardown re-check" finding is expensive in three compounding ways.

It looks like security work, so it is hard to dismiss on sight. Auth and session-integrity findings default to being taken seriously, and that same seriousness means an unreachable one consumes review, discussion, and possibly implementation effort before anyone traces the control flow.

Reviewer agreement is not corroboration when the reviewers share a heuristic. "There is an await, therefore there is a window" is a shared blind spot, not two independent observations. Any merge step that raises confidence on multi-reviewer agreement will systematically over-trust this class of false positive unless something explicitly checks whether the awaits are I/O-rooted.

A guard added where no window exists is not neutral. It adds a branch that can never take its torn-down path, that future maintainers must reason about and keep in sync, and it normalizes "add a check whenever you see an await near guard code" as a substitute for tracing whether a boundary exists. That erodes the precision of the real checks by burying them among decorative ones.

The inverse failure is equally real: dismissing a reachable finding because it superficially resembles the unreachable pattern. The rule is not "awaits near guards are safe to ignore". It is "trace whether this specific await yields to a macrotask before deciding either way".

## When to Apply

- Whenever a review finding claims a race, a stale read, or a teardown interleaving whose proposed mechanism is "state can change during this await".
- When adding a new await inside an already-guarded stretch. Ask the same question before reflexively adding a `guard.tornDown()` check after it.
- The test generalizes past `subjectTeardownGuard`. Any generation-counter, cancellation-token, or "has the world moved on" guard is subject to the same event-loop mechanics.

## Examples

**The unreachable finding, dismissed.** Claimed hazard: a teardown lands between `await mintViaPassword(...)` returning and the `FRESH_AUTH_ORCID_FALLBACK` branch running, letting a stale flight start an ORCID redirect and orphan its sessionStorage keys. Unreachable because the sentinel is only ever returned immediately after that same catch block's own guard check, with one synchronous branch in between and no await. Resolution: dropped, not implemented.

**A boundary in the same function that is only sometimes genuine, for contrast.** A few lines earlier, `resolveProof` awaits the account status read and then checks the guard. On a cold resolution that read is a real network round-trip, so the check is load-bearing: a teardown genuinely can land there, and skipping it would let a stale flight act on a factor decision made for a subject that already left. But the shared factor resolver keeps a per-subject memo and returns synchronously when it is warm, and the consent-op orchestrator opens its guard immediately before this call with nothing awaited in between. So on a second critical action in the same session the whole stretch is a pure microtask hop, and that same check is inert for that invocation. The check still belongs there, because the cold path is real and the warm path costs nothing. What the example shows is that the classification is a property of the invocation, not of the line.

**Why every real scrub boundary here is macrotask-rooted.** `_scrubSubjectBoundState` in `auth.js` is fully synchronous, and every trigger that reaches it is a macrotask: a logout click handler calling `disconnect()`, the cross-tab `storage` event reaching `_handleStorageEvent`, and subject adoption running downstream of an awaited login fetch. Because the scrub is synchronous and every path to it is macrotask-rooted, the teardown mechanism can only ever interleave with in-flight guarded work at real I/O points, which is exactly the set of points the code already checks. A finding proposing a check anywhere else in this call graph proposes a check against a scrub that structurally cannot arrive there.

## Related

- `fresh-auth-guard-coverage-must-sweep-the-callee-graph-2026-09-01.md` — the completeness sweep this test refines. Its instruction to classify each callee by whether it awaits before a side effect is silently over-broad; this entry supplies the missing precondition.
- `subject-divergence-guard-earns-its-place-only-where-the-flow-acts-unpinned-2026-09-03.md` — orthogonal-axis sibling. It bounds guard coverage on the pinning question; this entry bounds it on the reachability question.
- `final-state-assertions-cannot-discriminate-dispatch-from-confirmation-2026-09-01.md` — the nearest prior articulation of the same epistemic move, that an interleaving claim is checkable against the event-loop model rather than a matter of taste. Backend and test-focused, and it never needs the macrotask distinction because it only ever reasons about zero-await gaps.
- `behavior-change-coverage-gap-not-preemptive-hardening-2026-06-10.md` — the adjacent triage norm for not holding on findings whose failure mode is not real. Scoped to absent test coverage rather than to an actively false reachability claim.

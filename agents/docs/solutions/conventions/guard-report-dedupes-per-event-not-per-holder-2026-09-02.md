---
title: "One event, one message: a report raised at a shared guard dedupes per event, not per holder, and its absence is invisible when every layer below is silent by design"
date: 2026-09-02
category: conventions
module: frontend/src/lib/fresh-auth.js + its consumers
problem_type: convention
component: frontend_stimulus
severity: high
root_cause: incomplete_enumeration
resolution_type: code_fix
related_components:
  - authentication
  - development_workflow
applies_when:
  - "Adding a user-visible message (toast, banner, inline error) inside a shared guard, sentinel, or unwind primitive that several concurrent flights each hold their own instance of"
  - "A single event (a subject teardown, a cancellation, a connection drop) abandons more than one in-flight operation and each abandoned operation unwinds through the same reporting helper"
  - "A teardown path that already shows its own message coexists with flights it abandoned that also report"
  - "Auditing a path where the user reports 'nothing happened' and every layer's silence is individually documented as deliberate"
  - "Deciding where a report belongs in a stack of shared vocabularies whose lower layers map an outcome to a null message on purpose"
symptoms:
  - "Two or more identical toasts stack for what the user experienced as one event"
  - "A specific, actionable message is immediately followed by a vaguer one describing the same cause"
  - "An action ends with no message at all, and each layer, read alone, is behaving exactly as its docblock says"
  - "A null row in an outcome-to-message table, a null describe-key, and a silent unwind boundary compose into zero messages with no site in the chain owning the gap"
  - "The natural fix (report inside the guard) is correct for one flight and wrong the moment two flights coalesce"
tags:
  - fresh-auth
  - teardown
  - deduplication
  - coalescing
  - silent-failure
  - generation-counter
  - user-facing-messaging
  - race-condition
---

# One event, one message: a report raised at a shared guard dedupes per event, not per holder

## Context

A light account's fresh-auth flows can be abandoned mid-flight by a subject change: an explicit logout, or a login as a different user in another tab arriving through the `storage` event. Both funnel into `_scrubSubjectBoundState`, which clears the proof caches and the password-factor memo and calls `abandonInFlightAcquisitions()`. That function bumps a module-level counter, `_acquireGeneration`, and nulls the in-flight slots.

`subjectTeardownGuard()` is the primitive every flight uses to notice: it snapshots the counter and returns `tornDown()` (the counter moved) and `cancel()` (report, then return the clean-cancel sentinel). The sibling entry on guard coverage covers where the guard must be *checked*. This entry is about the other half: which site, on each unwind path, owes the user a *message*, and how many times it says it.

Two defects on that half landed together, and the second is why the first was hard to see.

**The zero-message path.** A cross-tab subject change landing in the upload pre-flight's status read produced no message at all. The chain: the acquisition returned a bare clean-cancel sentinel at its post-factor-read boundary; `ensureSessionWindow` mapped that sentinel to a `cancelled` outcome; the shared outcome-to-toast table maps `cancelled` to `null`; `windowProof` saw `cancelled` with a torn-down guard and threw an already-reported upload code; and `describeUploadError` maps that code to `null`. Every layer was correct in isolation, every silence was a documented decision, and the user typed nothing, saw nothing, and watched the upload end.

That `cancelled` row's silence is deliberate and its warrant is on record: a user's own modal dismissal needs no narration. The bug class is machine-initiated abandons *borrowing* that row, which was flagged in an earlier round in exactly those terms, and folded into this work as the same defect as the guard-coverage finding rather than a separate one (session history).

**The N-message path.** The obvious fix is to report inside `guard.cancel()`, and that is where the report belongs, because it is the only site on that path that can speak. But guards are per flight and teardowns are per event. The acquisition slots are keyed on the redirect posture, so a page's own submit gate and the editor's inline-image upload can be in flight at once; they coalesce onto a single status read, and each holds its own guard. The upload path opens a third guard spanning its retries; the password mint opens a default one of its own. One generation bump abandons all of them, and a report per guard stacks identical messages describing a single event. Worse in the other direction: `handleSessionInconsistency` disconnects and shows the message the user actually needs ("sign in again"), and the flights that same disconnect abandoned then resumed and talked over it with vaguer copy.

## Guidance

**Deduplicate the report on the event, not on the holder.** Give the event an identity the report claims as it fires. Here the identity already existed: the teardown generation.

```js
// Before: correct for one flight, N messages for N coalesced flights.
cancel: () => {
  toastLocalized('auth', 'reauthCancelled', 'Your session changed, so the confirmation was cancelled.');
  return FRESH_AUTH_CANCELLED;
},

// After: the first flight to unwind under this generation speaks; the rest are silent.
cancel: () => {
  reportTeardownOnce();
  return FRESH_AUTH_CANCELLED;
},

function reportTeardownOnce() {
  if (_reportedTeardownGeneration === _acquireGeneration) return;
  claimTeardownReport();
  toastLocalized('auth', 'reauthCancelled', 'Your session changed, so the confirmation was cancelled.');
}
```

`_reportedTeardownGeneration` starts below every real generation so nothing is pre-suppressed, and `claimTeardownReport()` stamps it with the current counter. `reportTeardownOnce()` is also called by `tearDownSessionWithMessage`, the session-ending teardown, when it finds the store already disconnected, so both paths key on the same claim.

The comparison is against the **live** counter, not against the generation the unwinding flight captured. So the mark suppresses every flight that unwinds while that generation is current, whichever teardown abandoned it. The unit is the teardown *horizon*, not the individual teardown: a flight parked across two rapid subject changes unwinds silently once any party has claimed the newer generation, and the earlier change is folded into that one message rather than narrated on its own. That is deliberate and is the behaviour to preserve, not a rounding error in the dedup — the user has just been told their session changed, and a second message about the change before it would only stack. Past the horizon the next scrub bumps the counter beyond the mark and the first flight to unwind under it speaks again. The return value is unchanged either way, so no caller grows a branch.

The distinction matters when you reason about a flight that can outlive more than one event. An open prompt is dismissed by the first scrub, so it cannot span two; a request already in flight resumes only when its response lands, however many changes have passed by then, and that is the flight the horizon rule governs.

**Any path that narrates itself must claim the same identity before it speaks.** Otherwise the flights it abandoned are still unclaimed and will report on top of it.

```js
// Before: the disconnect abandons every in-flight acquisition, each of which
// then reports its own vaguer message after this one.
export function handleSessionInconsistency() {
  Alpine.store('auth')?.disconnect();
  toastLocalized('auth', 'sessionInconsistency', 'Session inconsistency detected. Please sign in again.');
}

// After: claim the teardown, then speak - but only when there was one to claim.
// handleSessionInconsistency, handleSessionRevoked and handleSessionExpired each
// call this with their own message key and fallback.
function tearDownSessionWithMessage(name, fallback) {
  const auth = Alpine.store('auth');
  if (auth) {
    if (!auth.isConnected) {
      reportTeardownOnce();
      return;
    }
    auth.disconnect();
    claimTeardownReport();
  }
  toastLocalized('auth', name, fallback);
}
```

A detection that finds the store already disconnected does not disconnect again or repeat its own message: it goes through `reportTeardownOnce()`, so it speaks only if the current teardown has not been narrated yet.

The ordering is load-bearing in both directions. The claim must come **after** the call that moves the counter, or it stamps the pre-teardown generation and suppresses nothing; and **before** the message, so the abandoned flights that resume later find the event already narrated. `disconnect()` is synchronous, so the disconnect and the claim are one uninterruptible block and the flights cannot interleave between them.

The claim also belongs **inside** the branch that actually disconnected. With no store there is no scrub, so no teardown happened on this path at all; stamping the live counter anyway would credit whatever teardown is current to a message about something else, and silence a flight that still owed the user a word. The message stays outside the branch, because the user is told either way. The general rule: claim the identity of a teardown you caused, never the identity of whatever teardown happens to be current.

**Before adding the report, name the one site that owes the message on each path.** Do not assume some layer downstream speaks. Walk the path outward and write down, per layer, what it shows: a real message, a documented silence, or a pass-through. If every entry is "documented silence", the missing report is at the innermost site that still knows *why* the operation ended, and that is where it belongs. In the acquisition that is exactly two boundaries: the post-factor-read check, and the stale return from the ORCID-start closure.

```js
// Before: both boundaries unwound silently into layers that are silent by design.
if (generation !== _acquireGeneration) return FRESH_AUTH_CANCELLED;
const orcidOrRefuse = () =>
  allowRedirect ? beginSessionAuthOrcidRedirect(() => generation !== _acquireGeneration)
                : FRESH_AUTH_REAUTH_REQUIRED;

// After: the two boundaries no other layer speaks for report through the guard.
if (guard.tornDown()) return guard.cancel();
const orcidOrRefuse = async () => {
  if (!allowRedirect) return FRESH_AUTH_REAUTH_REQUIRED;
  const started = await beginSessionAuthOrcidRedirect(guard.tornDown);
  return started === FRESH_AUTH_CANCELLED ? guard.cancel() : started;
};
```

**The converse is equally a decision: sites that must NOT report.** The prompt, mint, and post-mint boundaries in the same function still return the bare sentinel, because the password mint holds its own guard across exactly those awaits and has already spoken by the time control returns. `windowProof` consults `tornDown()` to pick the silent code but never calls `cancel()`, because the acquisition it just awaited already did. `retryOnce` in the upload layer *does* cancel, because its teardown check runs before any acquisition and nothing else has spoken yet. Write the reason down at each site: "silent because X already spoke" and "speaks because nothing below will" are different facts, and only the second survives a refactor of X.

**Why the guard, and not the vocabulary.** Widening the shared window-outcome vocabulary with a new "torn down" member was considered and deliberately rejected in an earlier round, on the grounds that widening it is a consumer audit rather than a new member (session history). That decision is what makes the guard the place where "has this already been reported?" is decided, which in turn is why the granularity of the flag on that guard is the whole question. A rejected vocabulary change relocates a responsibility; check what the relocation now has to carry.

## Why This Matters

A message-count bug has no exception, no failed assertion, and no wrong value in any variable. The only observer is a user, and both failure modes survive a green suite: zero messages reads as "the button did nothing", N messages reads as "the app is broken", and each layer's docblock defends its own behaviour.

**Duplicates do not merely add noise; past the cap they destroy the authoritative message.** The toast store keeps at most three and evicts oldest-first. A teardown that abandons four or more flights therefore evicts its own narration, and the specific, actionable "sign in again" is replaced by generic copy. That is the recorded rationale for "exactly one" rather than "at most one", and it was found the hard way on a multi-image drop where every queued file raised its own message (session history).

Layered deliberate silence is the other hazard. A null row in an outcome-to-message table, a null describe-key, and a bare-sentinel unwind are each a good decision; composed, they are a fail-silent path that no single review of any one layer will flag. The chain is only visible if you ask the whole-path question, and the whole-path question is what the layer-local decisions make feel already answered.

The two defects are joined, not adjacent. Because every downstream layer is silent by design, the report has nowhere to live but the shared primitive that all the flights hold. And a shared primitive is precisely the place where holders outnumber events: coalescing, posture-keyed slots, and nested guards all multiply holders while the cause stays singular. So the fix for the silence lands directly on the surface where the duplication bites. Anyone fixing "no message" at a guard should expect to be one step from "too many messages" and should check for other holders in the same breath.

This class has now been caught in four consecutive rounds on this one surface, each time as "one toast before, two after" against the previous commit (session history). That phrasing is the operative test: measure the count on the parent commit and on the change, for the same staged interleaving.

## When to Apply

- Adding any user-visible report inside a shared guard, sentinel factory, unwind helper, or error mapper that concurrent operations each hold their own instance of.
- Any primitive with a generation, epoch, or version counter where the counter bump is the event: the counter is already the deduplication key, and the report should claim it.
- Single-flight or coalescing code where one cause resolves many callers, including the backend query cache's inflight map. Coalescing multiplies holders by design.
- Any bug report shaped as "nothing happened" or "I got two toasts" on a path whose layers each document a deliberate silence.
- Reviewing a change that adds a member to a shared outcome vocabulary with a null message row: confirm some site upstream of the null row still owes the user a word on that path.
- Any teardown, abort, or disconnect helper that shows its own message and also invalidates other in-flight work.

## Examples

**The whole-path audit that finds the zero-message case.** For the upload pre-flight, written out layer by layer:

| layer | on a teardown-driven cancel | verdict |
| --- | --- | --- |
| acquisition boundary | returned the bare clean-cancel sentinel | silent, and nothing below speaks |
| `ensureSessionWindow` | a `cancelled` outcome | pass-through |
| the outcome-to-toast table | `null` | silent on purpose (a user's own dismissal) |
| `windowProof` | throws the already-reported upload code | silent on purpose |
| `describeUploadError` | `null` key | silent on purpose (page must not stack) |

Every row after the first is a decision that is right. The table is what makes the first row's silence visible as the defect: it is the only row whose silence nothing else compensates for.

**The duplication cases, as tests.** Both are behavioural, and both count messages rather than asserting one fired:

- `one teardown across two cross-posture flights still reports exactly once` parks a suppressed and a permissive acquisition on a single coalesced factor read, tears down, resolves the read, and asserts the toast store was called exactly once while both flights unwound.
- `a mismatch teardown is not talked over by the flights it abandoned` parks a page gate on its factor read, drives a `username_mismatch` through the broadcast surface so `handleSessionInconsistency` runs, and asserts exactly one message and that it is the mismatch copy, not the generic cancel copy.
- `a teardown inside the upload's own factor read reports exactly once` is the zero-message case's pin: it asserts the describe-key is null *and* that the count is one, so the assertion fails in both directions.
- `a flight parked across two subject changes folds into the newer change's one report` pins the horizon rule above. It parks an older flight on its mint round-trip, drives two sequential subject changes, and asserts one message total plus no late issuance cached. It is what distinguishes the live-counter comparison from a per-flight one: swapping in the flight's own captured generation reddens exactly this case.

Counting is the point. `toHaveBeenCalled()` passes under the duplication defect; `toHaveBeenCalledTimes(1)` fails under both defects, and pairing it with an assertion on *which* message fired is what kills the "talked over" mutant, whose count is also one before the claim is added but whose text is wrong.

**Probe discipline.** Six probes were run, each removing one target and expected to redden exactly its own test: the two acquisition reports, both torn-down-gated cache clears, the per-teardown claim in `cancel()` (now inside `reportTeardownOnce()`), and the claim in `handleSessionInconsistency` (now inside `tearDownSessionWithMessage`). A probe that reddens more than its own test means the tests are entangled; one that reddens nothing means the assertion cannot see the property it names.

## Related

- `agents/docs/solutions/conventions/fresh-auth-guard-coverage-must-sweep-the-callee-graph-2026-09-01.md`: the same primitive, the checking half. It covers where the guard must be consulted (transitively, through every callee reached after it opens, and across a shared helper's whole caller set) and says nothing about who reports. Read them as a pair: that entry answers "did this path notice the teardown", this one answers "who tells the user, and how many times".
- `agents/docs/solutions/conventions/outcome-vocabulary-widening-requires-a-consumer-audit-2026-08-31.md`: the nearest neighbour on the messaging side, and the mirror-image failure. There a consumer was *missing* a branch for a new vocabulary member; here every consumer had its branch and every branch was deliberately quiet. A consumer audit would have passed this path clean. Its rejection of a vocabulary widening is also what put the reporting decision on the guard in the first place.
- `agents/docs/solutions/conventions/single-flight-coalescing-amplifies-cache-invalidation-race-2026-05-20.md`: the backend statement of why holders outnumber events once coalescing exists, and the same generation-capture remedy applied to cache writes instead of to messages.
- `agents/docs/solutions/conventions/synchronous-flag-before-await-idempotency-guard-2026-05-16.md`: the same claim-before-the-first-await shape, applied to re-entry prevention rather than report dedup.
- `agents/docs/solutions/conventions/final-state-assertions-cannot-discriminate-dispatch-from-confirmation-2026-09-01.md`: the general form of the vantage-point problem these tests solve by counting calls rather than asserting an end state.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` and `agents/docs/solutions/conventions/mutation-probes-are-per-site-not-per-fix-2026-08-31.md`: the probe rules the six-probe run above follows.

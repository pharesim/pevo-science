---
title: "A probe spec must select an exit only the layer under test serves: on a shared path the downstream backstop absorbs the mutant"
date: 2026-09-24
last_updated: 2026-10-01
category: conventions
module: frontend/src/pages/edit.js + architect re-review intake
problem_type: convention
component: testing_framework
severity: high
root_cause: incomplete_enumeration
resolution_type: workflow_improvement
related_components:
  - development_workflow
  - frontend_stimulus
applies_when:
  - "A fix adds an EARLY instance of an effect (a clear, a cancel, a release) upstream of an existing LATE instance of the same effect, and a probe must show the early one is load-bearing"
  - "An architect hold prescribes a spec shape by describing a variant of an existing spec, and the existing spec reaches its assertion through the happy path both layers serve"
  - "Choosing which exit a discriminating spec should take: unmount mid-broadcast, a rejecting await, an early return, versus the fulfilled-and-still-mounted path"
  - "A mutation run reports that reverting BOTH layers leaves a pre-existing spec green, which is the measurement that the surviving spec was never discriminating"
  - "Architect re-review intake on a signal block that reports a deviation from the prescribed spec shape rather than a literal implementation of it"
symptoms:
  - "A newly written spec passes identically with and without the change it was written for, so there is no red bar to investigate"
  - "Reverting both redundant layers at once kills the new specs while a pre-existing spec on the same effect survives"
  - "The prescribed spec arms a debounce inside the broadcast mock and asserts at `step === 'success'`, the one path both the early and the late clear serve"
  - "A mutant against the late backstop's own timer cancel kills nothing, so the kept layer is itself unprobed"
  - "Two assertions inside one spec are pinned by different mutants, and vitest's stop-at-first-failure hides that no single mutant exercises both"
tags:
  - mutation-testing
  - discriminating-tests
  - defense-in-depth
  - vacuous-pin
  - coverage-verification
  - re-review-intake
  - hold-block
  - alpine
---

# A probe spec must select an exit only the layer under test serves

## Context

That a green mutant is a defect in the verification rather than evidence the condition
is unpinnable belongs to
[belt-and-braces-guard-absorbs-upstream-mutation-pins-2026-09-18.md](belt-and-braces-guard-absorbs-upstream-mutation-pins-2026-09-18.md).
This entry is the case that one does not cover: the two layers overlap on a *proper
subset* of exits, so neither deletion nor a wider rule is the remedy, and what moves
is the probe's input.

`handleSubmit` in `frontend/src/pages/edit.js` drops the form's localStorage draft
through `_clearDraft`. A fix added an EARLY `_clearDraft` in each of its two branch
arms, immediately after the `FRESH_AUTH_REDIRECT_PENDING` check and ahead of the
`_mounted` guard, because two exits sat between a landed broadcast and the existing
clear beside `step = 'success'`: an unmount during the broadcast takes the `_mounted`
return, and a rejecting `invalidatePaperCache` throws to the terminal catch. Either
one left an on-chain edit with its flushed draft still in storage, and the no-changes
check ends with `addressedReviews.length === 0`, so a restored tick alone admits a
no-op resubmit that re-declares `addresses_reviews`. The LATE clear stayed, for the
window the early one cannot see: the form is live across the `invalidatePaperCache`
await, so a keystroke there arms a debounce the early clear has already run past.

That two-clear layout is the one this entry's lesson was measured on, and it is no
longer the layout on main. Later fixes on the same method added a clear in the
terminal catch, run only when a `landed` marker says the broadcast resolved, and moved
the late clear from beside `step = 'success'` to directly after the invalidation
await, ahead of that arm's `_mounted` guard, which gave each arm three clears on its
paths: post-broadcast, post-invalidation, and the shared catch. The lesson is
unchanged. The exit table is not, and how it changed is the second half of the lesson.

Neither multi-clear layout is on main any more. ARCHITECTURE.md § 8 ("Landing is
terminal") replaced them with one removal at landing (`_markLanded`, inside the shared
`_finishLanded` tail) and a refusal in `_writeDraft`, so `_clearDraft`, the `landed`
marker and every later clear are gone. The tables below are kept as the worked example.
"The single-landing layout" under Examples records how the same question reads on the
current code.

The hold prescribed the discriminating spec as a variant of the existing
`the post-success clear cancels a save the debounce still has armed`: arm the debounce
inside the `broadcastOps` mock, reach `step === 'success'`, assert the draft is gone.
That shape was measured non-discriminating. On a fulfilled invalidation with the
component still mounted, execution reaches the late clear whether or not the early one
exists, so the spec is green on the mutant and green on the fix.

This class recurs here. Two prior rounds on this same method hit it: a spec that
passed vacuously because `_windowReady`'s unconditional flush had already cleared the
timer at the entry gate, fixed by arming the timer *after* that gate rather than by
weakening the assertion; and a mutant first read as a kill that had only removed one
operand of a coupled guard, leaving a throw that reached the same catch (session
history).

## Guidance

**Ask which inputs reach only the upstream layer, not whether the two layers can fail
on the same input.** The binary test is the right one when the downstream layer exists
only to catch the upstream layer's failures. When each layer has an exclusive domain,
enumerate the exits from the new site to the end of the function and disqualify every
path that reaches the downstream site, however naturally it exercises the new line.

On the two-clear layout, probing the early clear:

| exit after the landed broadcast | reaches the late clear? | usable as a probe path |
|---|---|---|
| the `_mounted` return | no | yes |
| `invalidatePaperCache` rejects, throws to the terminal catch | no | yes |
| fulfilled invalidation, still mounted, falls through to `step = 'success'` | yes | no |

On the current three-clear layout, probing the same post-broadcast clear:

| exit after the landed broadcast | a later clear runs? | usable as a probe path |
|---|---|---|
| the `_mounted` return directly after the broadcast | no | yes |
| `invalidatePaperCache` rejects, throws to the terminal catch | yes, the catch's clear behind `landed` | no |
| the invalidation resolves, mounted or not | yes, the post-invalidation clear ahead of its guard | no |

**The table belongs to the control flow, so re-derive it whenever a fix adds or moves
an instance of the effect.** The rejecting-invalidation exit was a valid probe path
until the catch gained its own clear. From that commit on, the spec taking that exit
stayed green with the continuation early clear deleted, and that clear had no pin at
all until an unmount-during-broadcast twin was written for the continuation arm. No
spec changed and none failed; a fix elsewhere in the method converted a discriminating
spec into an absorbed one.

**When both layers earn their place, move the probe, not the code.** Deleting the
later clear here would reopen the window across the invalidation await, where a
debounce can be armed or fire after the post-broadcast clear has already run. The symptom is shared with the neighbour entry; the remedy
inverts.

**The diagnostic: revert every instance of the effect at once and read which EXISTING
specs survive.** A survivor's input is one the downstream instance was answering for,
which names the shared path precisely. Reverting both early clears killed the two new
specs and left the prescribed-shape spec green; that survival is the measurement, and
it is cheaper than reasoning about control flow.

**Do not let a prescription's own framing settle a coverage question.** The hold called
the retained late clear an idempotent no-op, and reverting its timer cancel to a bare
`removeItem` does indeed kill nothing. By
[defense-in-depth-canary-must-pin-each-layer-2026-05-07.md](defense-in-depth-canary-must-pin-each-layer-2026-05-07.md)
that is an open gap, not a blessing: the layer was kept on a stated argument about a
window no spec entered, and it should be recorded as unpinned rather than as covered.
The window has specs now: one per arm unmounts across a resolving invalidation after
the save has fired, and each is the only kill for its arm's post-invalidation clear,
deleted or moved below the guard. The bare-`removeItem` form of that clear still
survives, because those specs let the save fire rather than leave it armed.

**A prescribed spec shape is a hypothesis about discrimination.** It is written against
a description of the fix, usually before the fix's final control flow exists, and
control flow is what decides discrimination. Measure the shape against its own site
before implementing it literally; if it does not red, deviate and say so in the signal
block. This is
[hold-prescriptions-prescribe-invariants-not-constructs-2026-06-12.md](hold-prescriptions-prescribe-invariants-not-constructs-2026-06-12.md)
applied to a test shape rather than a SQL construct, and the deviation protocol there
is the one to follow. Without it the loop is circular: the architect predicts a shape,
the implementer reports that the predicted shape passes, and both read a confirmation
that could not have come out any other way.

**Check that one mutant exercises the assertion you think it does.** Vitest stops at
the first failing assertion, so a spec asserting both `_draftTimer === null` and the
draft's absence is killed on the timer assertion by the early-clear revert and on the
absence assertion by a different mutant. The spec is fully pinned across the mutant
set and by no single member of it, which is the distinction
[mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md](mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md)
asks kill claims to carry.

## Why This Matters

The cost is not a failing test but a passing one that reads as proof. The signal block
carries a probe row, the row says the new site is covered, and the row is false. A
later refactor that moves the clear back behind the `_mounted` guard, or that wraps the
invalidation in a try/catch and so changes which exit the throw takes, leaves the suite
green. The defect it was meant to catch is one that already shipped: an edit lands on
chain, the draft survives, and a resubmit the user believes is a no-op re-declares
`addresses_reviews`. That is a chain write, not a retype.

The same green also corrupts the reviewer's model. It invites the conclusion that the
two clears are redundant and one should go, which on this control flow is wrong in both
directions.

## When to Apply

- An early cleanup, release or commit moved ahead of guards or awaits, with the
  original call kept as an idempotent backstop.
- A new fail-fast or early return added above an existing terminal handler that
  produces the same end state.
- A cache invalidation, timer cancel or resource free duplicated earlier in a sequence
  to cover an abort path.
- A hold prescription describing a new spec as "a variant of the existing spec at X"
  when the site being probed sits at a different point in the same control flow than X.

It applies with more force when the operation is idempotent, because idempotence is
what makes the duplicate safe to add and simultaneously makes its absence invisible on
the shared path. It does not apply when the two sites are on genuinely disjoint paths:
then no probe path reaches both, and any spec exercising the new site discriminates it.

## Examples

The two specs that shipped with the early clears each selected an exit the late clear
could not serve. The native
arm takes the `_mounted` return by tearing the component down inside the broadcast
mock, and reads the stored draft first so the assertion is not vacuous:

```js
    broadcastOps.mockImplementation(async () => {
      draftDuringBroadcast = localStorage.getItem(DRAFT_KEY);
      comp.destroy();
      return { tx_id: 'tx' };
    });

    await comp.handleSubmit();
    expect(JSON.parse(draftDuringBroadcast).addressedReviews).toEqual([addressed(REV_ONE)]);
    expect(localStorage.getItem(DRAFT_KEY)).toBe(null);
```

The continuation arm takes the throw, with the branch posture asserted rather than
assumed (per
[mutation-probes-are-per-site-not-per-fix-2026-08-31.md](mutation-probes-are-per-site-not-per-fix-2026-08-31.md),
since a fixture authenticating as the paper's own author silently selects the other
arm):

```js
      invalidatePaperCache.mockRejectedValue(new Error('invalidate unavailable'));
      expect(comp.isContinuation).toBe(true);
      await comp.handleSubmit();
      expect(comp.step).toBe('error');
      expect(comp._draftTimer).toBe(null);
      expect(localStorage.getItem(DRAFT_KEY)).toBe(null);
```

The `step === 'error'` assertion records that the user is shown a failure for an edit
that did land. That is a known behaviour the hold kept out of scope; the spec pins the
draft outcome on that path without endorsing the message.

Since the catch gained its clear, this second spec no longer discriminates the
continuation early clear. It is still a correct statement of the outcome on that exit.
The continuation arm's discriminating spec is now the twin of the first example:
co-author posture asserted through `isContinuation`, `destroy()` inside the broadcast
mock, draft key null afterwards.

### The measurement

Taken on the two-clear layout, at the fix that added the early clears. Fifteen mutants, one throwaway scratchpad copy per mutant built by `git archive` from
the committed fix, the shared multi-agent checkout never mutated, base copy confirmed
green before any mutant ran. The rows that establish the entry:

| mutant | dies |
|---|---|
| native early clear reverted to the true pre-fix shape | the unmount spec, alone |
| continuation early clear reverted to the true pre-fix shape | the rejecting-invalidation spec, alone |
| both early clears reverted at once | both new specs; the prescribed-shape spec SURVIVES |
| the late clear's `clearTimeout` dropped, leaving a bare `removeItem` | nothing |
| `_clearDraft`'s key parameter reverted to the `draftKey` getter | nothing |
| `_clearDraft`'s own `clearTimeout` dropped | the prescribed-shape spec, plus the rejecting-invalidation spec |
| `localStorage.removeItem` removed from `_clearDraft` | four specs, including both new ones |

The remaining eight of the fifteen re-ran the two earlier rounds' tables on this same
page rather than this round's sites: the draft field and its watcher, the restore call,
the reconciliation's intersection, the checklist binding and its predicate, the
enrichment load guard, and the co-author watcher. All eight still killed their named
specs, which is why they are cited as a regression sweep rather than reproduced row by
row here.

Row three is the diagnostic. Rows one and two are the per-arm discrimination: reverting
one arm's site kills that arm's spec and nothing else, in both directions.

Both non-kills are recorded rather than pruned. The late clear's is discussed above.
The key-parameter one killed nothing because no spec changed the router params
mid-submit. One now does, at the catch site: it shifts the params inside a rejecting
invalidation mock and seeds the other paper's draft, so a catch clear reading the
getter deletes the wrong draft and the spec fails. The same getter mutant at the
post-invalidation clears still survives.

Reverting the arm sites had to restore the `_mounted` guard's original position as well
as delete the added line, since the fix moved the guard inside the
`FRESH_AUTH_REDIRECT_PENDING` block. Deleting the line alone leaves a shape that never
shipped, per
[mutation-probe-must-reconstruct-the-pre-fix-shape-2026-09-23.md](mutation-probe-must-reconstruct-the-pre-fix-shape-2026-09-23.md).

### Re-measured on the three-clear layout

Twenty-six mutants, same method. The rows for the clear sites:

| mutant | dies |
|---|---|
| either arm's post-broadcast clear deleted, `landed` kept | that arm's unmount-during-broadcast spec, alone |
| either arm's post-invalidation clear deleted, or moved below its `_mounted` guard | that arm's resolving-invalidation unmount spec, alone |
| catch clear made unconditional | the pre-landing broadcast-failure spec, alone |
| catch clear moved below the catch's `_mounted` guard | the fired-then-unmounted catch spec, alone |
| catch clear reading the `draftKey` getter | the fired-then-unmounted catch spec, alone |
| catch clear removed | both rejecting re-arm specs, plus the fired-then-unmounted catch spec |
| continuation `landed` marker removed | the continuation re-arm spec, alone |
| native `landed` marker removed | the native re-arm spec, plus the fired-then-unmounted catch spec |

Every site is discriminated per arm and per exit, and each of those specs takes an
exit no other clear serves. Known survivors at the post-invalidation clears: a bare
`removeItem`, the `draftKey` getter, and a clear that runs only when unmounted.

### The single-landing layout

On the current code there is one removal, so there is no second clear left to absorb a
mutant at the removal site. The overlap moved to a different pair: `_markLanded`'s
debounce cancel and the barrier in `_writeDraft`. A save armed before the landing fires
into the barrier whether or not the cancel ran, so every storage assertion is green on
the cancel's deletion. This is the same shape as the two-clear case, and the remedy is
the same: move the probe. The specs that pin the cancel read the `_draftTimer` handle
(null once `handleSubmit` returns) or spy on `_writeDraft`'s call count. They do not
read storage. On the publish page that handle assertion is the only kill for the cancel.

The removal's later-visit risk inverted too. The multi-clear layouts needed a clear past
the invalidation await. Under the barrier such a clear is the defect, because it runs by
key after the component is gone and can delete a draft a later visit wrote. The spec that
pins its absence stages that later write after `destroy()` inside the invalidation mock.
Known survivor: a removal reinstated after the invalidation await but behind the
`_mounted` guard turns nothing red. Only another tab can reach it, which § 8 Limits
accepts.

## Related

- [belt-and-braces-guard-absorbs-upstream-mutation-pins-2026-09-18.md](belt-and-braces-guard-absorbs-upstream-mutation-pins-2026-09-18.md)
  owns the shared conclusion and the total-overlap case. The discriminating question
  between the two: is there an input the upstream layer is responsible for on which the
  downstream layer does not run? If no, that entry applies and the remedy is deletion.
  If yes, this one applies and the remedy is the probe's input. That entry's scope is
  detection logic whose only checker is its own canary; nothing here asks it to widen.
- [defense-in-depth-canary-must-pin-each-layer-2026-05-07.md](defense-in-depth-canary-must-pin-each-layer-2026-05-07.md)
  is the general prescription this satisfies. Its fix shapes all vary a mock on whether
  the upstream layer is intact; here nothing is bypassed and the discriminator is the
  choice of exit.
- [composite-mutation-probe-does-not-cover-its-constituent-branches-2026-09-06.md](composite-mutation-probe-does-not-cover-its-constituent-branches-2026-09-06.md)
  says to hold every other operand where the probe already puts it. When another site
  produces the same observable, that held constant is what absorbs the mutant, and the
  input has to move too.
- [mutation-probes-are-per-site-not-per-fix-2026-08-31.md](mutation-probes-are-per-site-not-per-fix-2026-08-31.md)
  is why the two arms needed separate specs. Its posture axes have no entry for which
  exit of a linear sequence a fixture takes, which is the axis that decided coverage here.
- [mutation-probe-must-reconstruct-the-pre-fix-shape-2026-09-23.md](mutation-probe-must-reconstruct-the-pre-fix-shape-2026-09-23.md)
  is the reason the arm reverts had to move the guard back.
- [hold-prescriptions-prescribe-invariants-not-constructs-2026-06-12.md](hold-prescriptions-prescribe-invariants-not-constructs-2026-06-12.md)
  owns the deviation protocol; this is that protocol applied to a prescribed test shape.
- [tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md](tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md)
  is the root convention the cluster refines.

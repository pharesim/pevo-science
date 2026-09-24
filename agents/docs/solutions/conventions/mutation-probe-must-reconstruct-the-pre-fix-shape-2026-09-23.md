---
title: "A mutation probe must reconstruct the pre-fix shape, not undo the single added line"
date: 2026-09-23
last_updated: 2026-09-24
category: conventions
module: frontend/src/pages/edit.js + architect re-review intake
problem_type: convention
component: testing_framework
severity: high
root_cause: incomplete_enumeration
resolution_type: workflow_improvement
related_components:
  - development_workflow
applies_when:
  - "A fix under mutation-probe verification both adds a guard or condition AND removes a now-redundant guard the addition made unreachable"
  - "A probe reverts a single added line without restoring the branch structure that line's addition made redundant"
  - "A probe comes back green on a fix believed load-bearing, and the next step under consideration is rewriting or weakening the assertion because it looks unpinned"
  - "The code under test has an outer catch, a default, or another fallback that can produce the same observable symptom through more than one route"
  - "Architect re-review intake on a signal block citing a single-line revert against a diff that changed more than one line of the same control-flow region"
tags:
  - mutation-testing
  - pre-fix-shape
  - composite-probe
  - revert-verify
  - coverage-verification
  - re-review-intake
  - under-specified-probe
---

# A mutation probe must reconstruct the pre-fix shape, not undo the single added line

## Context

`frontend/src/pages/edit.js`'s `loadPaperData` used to gate the load's failure path on `paperRes.status === 'rejected'` alone, then wrap the enrichment read in `if (enrichmentRes.status === 'fulfilled') { ... }` so a rejected enrichment degraded silently instead of failing the load. The fix that closed it made two edits to the same method, done together on purpose (the change is the one that introduced the spec named below, findable by `git log -S` on either edit):

1. widen the guard to `if (paperRes.status === 'rejected' || enrichmentRes.status === 'rejected')`, so a rejected enrichment now fails the load the same way a rejected paper fetch does;
2. remove the `if (enrichmentRes.status === 'fulfilled')` wrapper around the three lines that read `enrichmentRes.value.data`, since after (1) the only status that can still reach those lines is `fulfilled`.

The spec that pins this, `a rejected enrichment fails the load and leaves the saved ticks alone` in `frontend/tests/unit/pages-edit.test.js`, asserts `loadError` is set, `_initialLoadDone` stays `false`, and a saved draft's `addressedReviews` survives a debounced `_scheduleDraftSave()` afterward.

A probe that reverted only edit (1), dropping the guard's added clause and leaving the wrapper removed, stayed green: 87 of 87, exit 0. The wrapper's removal had been treated as tidy-up that the guard now covers, so only the guard's added clause looked worth mutating. Reading the run's stderr showed the actual mechanism: with the guard reverted to single-arm but the wrapper still gone, a rejected enrichment now reaches `enrichmentRes.value.data` directly, `enrichmentRes.value` is `undefined` on a rejected settle, the property read throws a `TypeError`, and `loadPaperData`'s own outer `catch` sets `this.loadError = this.$t('edit.loadError')` and returns before `_initialLoadDone = true` is reached. Every assertion in the spec still holds. The mutant is a real pre-fix-guard state, but it is not the pre-fix CODE: it fails through the `catch` block's exception path rather than through the explicit early return, and it reaches the observable outcome the spec checks for by a different route than the one the fix closed.

Reverting BOTH edits, the single-arm guard AND the `fulfilled` wrapper together, reproduces the actual pre-fix code. That mutant dies immediately: `expected null to be 'edit.loadError'`, because the pre-fix path falls all the way through to `_restoreDraft()` with `reviews` still empty, exactly the defect the commit describes.

A second, smaller instance from the same commit shows the mirror-image failure: a spec that passes against genuinely unfixed code because the arranged state is cancelled before the code under test runs. `edit.js`'s `_windowReady` calls `_flushDraftSave()` unconditionally, and `handleSubmit`'s entry sequence routes through `_windowReady`, so a debounce armed with `_scheduleDraftSave()` before `handleSubmit()` is called is already flushed and cleared by the time the broadcast runs, regardless of whether the post-success `_clearDraft()` fix (which cancels the debounce, not just `localStorage.removeItem`) is present. The reachable window for this defect is between that flush and the success transition, while the form is still interactive at `step === 'broadcasting'`. The spec `the post-success clear cancels a save the debounce still has armed` arms the timer from inside the `broadcastOps` mock implementation, i.e. mid-broadcast, which is the only point that survives `_windowReady`'s flush and can still reach the code the fix changed. That held for the fix this entry is about. A later fix added an earlier clear on each `handleSubmit` arm, past which this spec does not reach, so the sentence describes this spec's window and not the method's draft-clear coverage as a whole; see `discriminating-spec-must-select-an-exit-only-the-probed-layer-serves.md`.

No earlier session in the recorded history hit this particular trap: a scan of the prior week's sessions against this file and this rule found no case of a mutation probe going green and being misread as a coverage gap, so this is the first recorded instance rather than a recurrence (session history). The same scan did surface a sibling failure mode in the very same spec file, filed as its own pending task: the reactive-bindings spec's "second load" is short-circuited by `loadPaperData`'s `_loadInFlight` mutex, so the assertion passes while the load it claims to exercise never runs (session history). Both are the same family, a green result that is not measuring what its author believed, reached by different mechanisms.

## Guidance

Before trusting a mutation probe's verdict on a fix that both adds a check and removes now-redundant code guarded by that check, do the following:

1. **Identify every edit the fix made to the same decision, not just the one that looks like "the guard."** A fix that widens a condition and then deletes a wrapper the widened condition made unreachable is one change with two parts. Reverting either part alone produces a state the author never intended to exist; only reverting both reproduces code that ever actually shipped.
2. **Revert to the literal pre-fix diff hunk, not to "the opposite of the smallest visible edit."** Take the prior version wholesale with `git show <fix-commit>^:<path>`, or apply the `-` side of every hunk in `git show <fix-commit> -- <path>`, rather than hand-picking which line to flip back. If the mutation probe's revert would not compile-and-run as a coherent prior version of the function, it is not testing what shipped before the fix.
3. **When a single-part revert stays green, read the failure route before concluding the assertion is unpinned.** Check whether the surviving code path reaches the same observable outcome through a different mechanism, here an uncaught `TypeError` funneled through an unrelated outer `catch`, rather than through the code path the fix actually removed. A green run after a partial revert is evidence the OTHER part of the fix (or unrelated code, like a `catch` block) is doing the failing, not evidence the spec is weak.
4. **For debounce/flush/lifecycle fixes, arm the test's side effect at the point in the sequence that is actually reachable, not at the top of the test.** If another method in the same fix (or an unrelated pre-existing method) unconditionally flushes or cancels the state your test is trying to arm, arming it earlier than that flush tests nothing. Find the reachable window first, from the code, then place the arrangement there.

This is not a call to distrust every probe result. It is a call to check, specifically when a fix is add-and-delete over one condition, that the "revert" step reconstructed a real prior version of the code rather than a hybrid the fix never produced.

## Why This Matters

The failure direction here is the dangerous one because it does not look like a false claim of coverage; it looks like a false claim of a GAP. A green mutation run after a partial revert reads as "this assertion isn't actually pinned by anything, the spec needs a rewrite or a stronger assertion." That conclusion sends effort into hardening a spec that was already correct, while the actual problem, a probe that reverted a hybrid state instead of the real pre-fix code, goes unexamined. The spec in this instance needed no change at all; the mutant needed correcting.

It also produces a specific, recurring shape worth naming: an add-and-delete fix over one boolean condition, where the deleted half is a wrapper that became provably redundant given the added half. Reviewers and mutation probes alike tend to treat "removed dead code" as inert, worth deleting from the mutant but not worth restoring. That instinct is backwards for this exact shape, because the wrapper's removal is what makes the added condition load-bearing for the OTHER status value: without the wrapper gone, a rejected enrichment reaching the property read is impossible by construction, so the guard's second clause would be provably unneeded, and with the wrapper gone but the guard not widened, the same reach becomes a crash instead of a graceful failure. Both halves have to move together for either half to be tested meaningfully.

## When to Apply

Apply this check when:

- reviewing or writing a mutation probe for a fix whose diff touches more than one line of the same conditional or the same surrounding wrapper, especially an add-a-clause-and-delete-a-wrapper shape;
- a partial revert stays green and the natural next step is "the spec needs a new or stronger assertion". Read the surviving path's failure route first;
- the code under test has an outer `catch`, a default value, or any other fallback that can produce the same observable symptom (an error flag, a boolean staying false) through more than one route. A probe that only checks the observable symptom, not the route, cannot distinguish "failed the way the fix intends" from "failed by accident elsewhere";
- arranging test state (arming a timer, setting a flag, seeding storage) for code reachable only after some other method in the call sequence runs. Check whether that other method already clears, flushes, or overwrites the state before the code under test executes, and if so, arrange the state from inside the call sequence at the point that survives it, not before the sequence starts.

Do not extend this into re-deriving a fresh probe for every fix that touches two lines; the trigger is specifically an add-and-delete pair over the SAME condition, where one part is deletable only because the other part exists.

## Examples

Pre-fix code (the real shipped shape, reconstructed by reverting both hunks together):

```js
if (paperRes.status === 'rejected') {
  this.loadError = this.$t('edit.loadError');
  return;
}
this.paper = paperRes.value.data;
if (enrichmentRes.status === 'fulfilled') {
  const enrichment = enrichmentRes.value.data || {};
  this.reviews = enrichment.reviews || [];
  this.paper.authorship_claims = enrichment.authorship_claims || [];
}
```

Partial-revert mutant (guard reverted to single-arm, wrapper left removed; this shape never shipped):

```js
if (paperRes.status === 'rejected') {           // reverted
  this.loadError = this.$t('edit.loadError');
  return;
}
this.paper = paperRes.value.data;
const enrichment = enrichmentRes.value.data || {};  // wrapper still gone
this.reviews = enrichment.reviews || [];
this.paper.authorship_claims = enrichment.authorship_claims || [];
```

The partial-revert mutant stays green: on a rejected enrichment, `enrichmentRes.value` is `undefined`, the property read throws, and the outer `catch` sets the identical `loadError` and returns before `_initialLoadDone = true`, satisfying every assertion in the spec by accident. Only the fully-reconstructed pre-fix code, both hunks reverted together, reaches `_restoreDraft()` with an empty `reviews` array and fails the spec's first assertion as the commit message describes.

## Related

- `agents/docs/solutions/conventions/composite-mutation-probe-does-not-cover-its-constituent-branches-2026-09-06.md` establishes that reverting a whole mechanism does not prove each of its operands is individually covered, and prescribes finding the probe whose outcome flips when ONE operand alone is mutated. This entry is the necessary counterweight for the specific case where the fix is add-and-delete: following that entry's per-operand method literally, mutate the guard's added clause alone, produces exactly the false-gap conclusion documented above, because the single-operand mutant is not a reachable pre-fix shape; it fails closed by a different route (an unrelated `catch` block) that the same fix's OTHER half made possible. Before concluding an operand is unprobed by a green single-operand mutant, check whether that mutant is a real prior version of the code or a hybrid the fix never produced, and whether some other code path the fix touched is absorbing the failure.
- `agents/docs/solutions/conventions/mutation-probes-are-per-site-not-per-fix-2026-08-31.md` covers the orthogonal case of a fix landing at N parallel sites, where one probe is wrongly assumed to cover all of them. This entry is about reconstructing a single site's pre-fix shape correctly, not about site count. Four orthogonal axes now sit under the same conclusion that a green probe proves less than it looks like: breadth of sites, depth of branches, fidelity of the mutant's shape, and which exit the probe's input takes (`discriminating-spec-must-select-an-exit-only-the-probed-layer-serves.md`).
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` is the parent principle all three specialize. Its procedure, revert the line or commit the test is about and confirm the test fails, assumes the fix is one atomically revertible unit. This entry is the case where that assumption does not hold: a single site's fix can be a coupled pair of hunks, and reverting a hand-picked subset of them is not reverting the commit.
- `agents/docs/solutions/conventions/belt-and-braces-guard-absorbs-upstream-mutation-pins-2026-09-18.md` already states the conclusion this entry arrives at, that a mutant turning green is a defect in the verification rather than evidence the condition is unpinnable, and that only re-running the mutant against the absorber tells the two apart. That entry reaches it from a newly added downstream net in detection code masking neighbouring pins; the remedy there is removing the net and re-measuring. This entry reaches the same conclusion from an unrelated direction: nothing was added, the absorber is the function's own pre-existing outer `catch`, and the defect is that the mutant was never a real revision. The shared conclusion belongs to that entry. What this one adds is a second cause to check for when a probe goes unexpectedly green; `discriminating-spec-must-select-an-exit-only-the-probed-layer-serves.md` adds a third, where the absorber is real but reachable only on some inputs.

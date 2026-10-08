---
title: "An optional predicate's absent case is not its false case: presence-vs-truth mutations need a live-and-negative test"
date: 2026-09-02
category: conventions
module: frontend/src/lib/fresh-auth.js + its consumers
problem_type: convention
component: frontend_stimulus
severity: high
root_cause: incomplete_enumeration
resolution_type: test_fix
applies_when:
  - "Adding or reviewing a guard shaped like `if (predicate?.()) return;` where the predicate or callback parameter is OPTIONAL and gates a side effect (a cleanup, a navigation, a write)"
  - "Deciding which call shapes a suite must cover for a function taking an optional predicate: absent, live-and-true, live-and-false"
  - "A suite's only cases for a staleness or teardown guard either omit the predicate entirely or drive it only to the suppressing answer"
  - "Auditing whether a presence-vs-truth mutation (`param?.()` weakened to `param`) would survive the existing suite"
  - "A parameter arrived incrementally, so the cases written before it was threaded still call the function without it"
symptoms:
  - "Mutating `param?.()` to `param` (gating on presence rather than on the call's result) leaves the whole suite green"
  - "Every case exercising the guard either supplies no predicate at all or supplies one that only ever answers true"
  - "Production callers universally thread a live predicate; only test code exercises the no-predicate shape"
related_components:
  - authentication
  - testing_framework
  - development_workflow
tags:
  - fresh-auth
  - mutation-testing
  - optional-parameter
  - presence-vs-truth
  - guard
  - test-coverage
---

# An optional predicate's absent case is not its false case: presence-vs-truth mutations need a live-and-negative test

## Context

`beginOrcidFreshAuthRedirect` in `frontend/src/lib/fresh-auth.js` starts an ORCID round-trip and
owns cleanup of the two per-tab sessionStorage keys it writes before navigating (the mode marker
and the return path). It takes an optional `isStale` teardown predicate, re-checked after the
`startOrcid` await because that await is where a subject teardown can land mid-flight. A shared
local closure gates cleanup on it:

```js
const unwindFlowKeys = () => {
  if (isStale?.()) return;
  sessionStorage.removeItem(ORCID_MODE_KEY);
  clearReturnPath();
};
```

An adversarial pass mutated the guard to `if (isStale)`, which swaps the question from what the
predicate answers to whether one was supplied at all, since any live function reference is truthy.
The full frontend unit suite stayed green: 81 files, 1809 tests, zero failures, that being the
suite as it stood before the case below was added to it.

The blindness traces to which call shapes the suite held. In
`frontend/tests/unit/lib-fresh-auth-settings-orcid.test.js`, the three cases that pin the cleanup
(the non-allowlisted host, the unparseable URL, and the `startOrcid` rejection) all call the
starter with no second argument, as `beginSettingsActionOrcidFreshAuth('set_password')`. The
staleness case drives the predicate the other way, `() => true`, and asserts the opposite outcome.
Between them the suite covered `{absent}` and `{present, true}` and never constructed
`{present, false}`.

That third shape is the only one production produces. Every caller of this helper threads a live
predicate: `beginSessionAuthOrcidRedirect` passes `guard.tornDown` down from
`acquireSessionProof`, and `beginOrcidUnderGuard` does the same in both `settings-fresh-auth.js`
and `authorship-consent.js`. On any ordinary run, before a teardown, that predicate answers false.
The page-level ORCID flows (login, signup, recover, the settings link, accreditation) never reach
this helper at all; they write their own mode marker and call `startOrcid` directly. So the
parameter is optional for the unit seam, not for a second class of caller, and the mutation broke
exactly the input every real caller supplies on every ordinary run.

The optionality has a history worth knowing (session history): the predicate arrived in two steps,
landing on the session-window path first and being threaded into the consent-op starters as a
sequenced follow-up that deliberately reused the same parameter rather than inventing a second
mechanism. The direct-starter cases were written before the threading, so they kept calling the
helper the way it was first shaped. Nothing in that history records a decision to keep the
parameter optional; it stayed optional because nothing forced the question.

## Guidance

For an optional predicate or callback that gates a side effect, three call shapes are reachable,
and a suite needs the ones production has:

- **Absent** — the parameter is omitted and `param?.()` short-circuits to `undefined`.
- **Present, negative** — a real function answering the ordinary "do not suppress" value.
- **Present, positive** — a real function answering the suppressing value.

A suite built from only the first and third cannot separate `if (param?.())` from `if (param)`.
Both readings agree on the absent case, and the present-positive case never reaches the branch
where presence and truth diverge. The missing case is present-negative, and it should assert the
same side effect the absent case asserts, so that killing the mutation falls out of testing the
caller's real shape rather than from a bolted-on presence check.

The fix here was one case, a sibling of the existing rejection case varying only the predicate:

```js
it('a live predicate answering false still cleans up when startOrcid throws', async () => {
  mockStartOrcid.mockRejectedValue(new Error('network down'));
  await expect(beginSettingsActionOrcidFreshAuth('set_password', () => false))
    .rejects.toThrow('network down');
  expect(sessionStorage.getItem(MODE_KEY)).toBeNull();
  expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBeNull();
  expect(window.location.href).toBe('');
});
```

Green against the real guard, red under the mutation.

The general form: a probe that flips a guard's condition is not the probe that flips what the
condition reads. A suite can be fully armed against the first, because both visible outcomes
already have cases, and blind to the second, because the second changes which axis of the input
is consulted at all. Killing it takes a case that varies the axis the mutation touches (presence)
while holding the axis the existing cases already vary (the answer) at the value production
produces.

## Why This Matters

This one was caught by review before it shipped, and the fix landed with the change it reviewed
(commits `07c07fd1` and `39363364`). The honest statement of the cost is narrow. Had the weakened
guard shipped, cleanup would never have run for any production caller, because all of them pass a
live function: a start that rejects, an unparseable redirect URL, a disallowed redirect host, or a
navigation its `beforeNavigate` refuses would each leave the mode marker and the return path behind. That is precisely the orphan the
neighbouring cases exist to prevent, and its cost is a stale per-tab marker and a stale return
path, a wrong back-destination or a callback dispatching on an abandoned flow's mode. It is not an
authentication weakness: the OAuth state is verified and consumed server-side, and no proof is
issued on the strength of a client-held marker.

The reason to record it anyway is the shape of the blindness rather than the size of the bug. The
suite looked complete by outcome, with cleanup and no-cleanup both covered and both directions of
the predicate apparently exercised, while the one input shape every caller actually produces was
never built. Coverage counted by outcomes hides gaps that only show up when coverage is counted by
input shapes.

## When to Apply

- Writing or reviewing tests for any function taking an optional predicate, guard, or callback
  consulted as `param?.()` or `param && …` to gate a side effect.
- Before trusting a "we have both directions" claim for such a parameter: check separately whether
  any case omits it and whether any case supplies it answering the ordinary-path value. If the
  only live case answers the exceptional value, the ordinary shape is untested.
- When a parameter is optional for a unit seam while every real caller supplies it. The omitted
  shape then matches no caller, and cases built on it prove less than they appear to.
- On any adversarial or mutation pass over a `?.()`-shaped guard: treat flipping the branch and
  flipping what is read as two distinct probes.

## Related

- `agents/docs/solutions/conventions/fresh-auth-guard-coverage-must-sweep-the-callee-graph-2026-09-01.md`
  is the direct predecessor on this same guard: its sweep is what threads a predicate into every
  caller, which is precisely what leaves a suite's no-predicate cases matching no caller. Its
  checklist now carries a step for this entry's direction.
- `agents/docs/solutions/conventions/control-pair-pins-only-varied-axis-enumerate-mutation-space-2026-06-12.md`
  states the same shape of gap for a comparison rather than a callback: a control pair proves only
  the axis it varies.
- `agents/docs/solutions/conventions/hold-block-shape-coverage-must-walk-full-lattice-2026-05-14.md`
  is the sibling rule for shape-discriminating guards; the presence/answer axes here are one more
  dimension of the same lattice.

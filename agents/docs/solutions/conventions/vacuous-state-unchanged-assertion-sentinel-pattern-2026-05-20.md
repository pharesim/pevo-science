---
title: "Vacuous `state-X-unchanged` test assertions when X is reset on the happy path: seed post-prologue sentinels distinct from the regression-write value"
date: 2026-05-20
category: conventions
module: frontend/tests/unit
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Writing a test that asserts state X is unchanged after an early-return guard fires (destroy guard, mounted guard, identity guard, cancellation flag, etc.)"
  - "The function under test resets X to a default value at function entry, before reaching the early-return point"
  - "The asserted `unchanged` value equals X's default value (e.g., asserting `error === null` when the function opens with `this.error = null;`)"
  - "Pinning that an async-flow guard prevents post-yield state mutation against a regression where the guard fails and downstream branches run to completion"
tags:
  - testing
  - vacuous-assertion
  - sentinel-seeding
  - mutation-kill
  - early-return-guard
  - alpine
---

# Vacuous `state-X-unchanged` test assertions when X is reset on the happy path

## Context

A common test shape pins early-return guards (`if (!this._mounted) return;`, `if (cancelled) return;`, identity checks) by exercising the early-return scenario then asserting that downstream state was not mutated. The intuitive assertion shape — "after teardown, `comp.error === null` and `comp.errorIs503 === false`" — is structurally vacuous if the function under test resets those same fields to those same default values at function entry, before reaching the early-return point.

The trap surfaced concretely during the `_sleep` timer-guard adoption: the test `loadPaper destroy() during retriable-503 backoff` asserted `comp.error === null` and `comp.errorIs503 === false` after `comp.destroy()` mid-backoff. `loadPaper()` opens with `this.error = null; this.errorIs503 = false;` and only mutates them on the post-retry-budget error-display branch that mid-backoff teardown never reaches. The assertions pass whether the `_mounted` guard fires correctly or fails entirely — they are tautologically green, with zero discriminating power over the regression they were written to catch.

Only the call-count assertion `expect(fetchPaper).toHaveBeenCalledTimes(1)` was load-bearing: a guard failure would cause the retry loop to re-enter and bump the count to 2 or more. The two value assertions added no coverage.

## Guidance

Seed sentinel values that are (a) distinct from the field's default, and (b) distinct from any value the regression path would write to the field. Assert that the sentinels survive into the post-teardown state.

Two non-obvious sub-rules apply:

### Sequencing: seed post-prologue, not pre-call

If the function under test has a synchronous prologue that resets the fields you intend to seed, pre-call seeding gets overwritten and the assertions break on both the correct and regression paths. The fix is to seed AFTER the function call returns control to the test thread. For an `async` function whose first action is an `await`, control returns at that yield point — the prologue has finished, but the await is still pending. The test can seed sentinels at that exact window before advancing timers or driving the rejection.

```javascript
// Wrong — pre-call seeding overwritten by prologue
comp.error = 'sentinel';
const p = comp.loadPaper();   // prologue runs: this.error = null
await advanceTimers();
// ... assertions on comp.error === 'sentinel' fail even on correct path

// Right — post-call seeding survives because the await has yielded
const p = comp.loadPaper();   // prologue runs synchronously, then awaits fetchPaper
comp.error = 'sentinel-error';   // seed after prologue, before await resolves
comp.errorIs503 = 'sentinel-503';
await vi.advanceTimersByTimeAsync(500);
comp.destroy();
// ... assertions on comp.error === 'sentinel-error' now distinguish guard-fired from guard-failed
```

The sequencing relies on the JS single-threaded model: synchronous code in `loadPaper()` runs to the first `await` without interruption, then control returns to whoever called `loadPaper()` (the test). The test can then mutate state before the await's microtask resumes.

### Collision avoidance: sentinel value must differ from regression-write value

A sentinel that happens to equal what the regression path would write to the field is still vacuous. For a boolean field where the regression writes `true`, seeding `true` and asserting `true` after teardown leaves both paths indistinguishable. The robust fixes:

- **Pick a value the regression path provably cannot produce.** A string sentinel like `'sentinel-503'` for a boolean field works in TypeScript-loose JS — the regression writes `true` (boolean), the correct path leaves `'sentinel-503'` (string) untouched, and `expect(comp.field).toBe('sentinel-503')` discriminates.
- **Drop the field's assertion and rely on a different observable.** If the field's domain is small (`true`/`false`/`null`) and the regression write is in the domain, no sentinel works — use a call-count, a side-effect spy, or a different field whose collision-free sentinel works.

The c192833c implementation chose string sentinels for both `error` (regression writes a localized i18n key string distinct from `'sentinel-error'`) and `errorIs503` (regression writes boolean `true` distinct from string `'sentinel-503'`).

## Why This Matters

A vacuous assertion is worse than no assertion. It creates the appearance of guard coverage while providing none. When the guard actually breaks in a future refactor, the test stays green and the regression ships.

**Calibration against PEvO's preemptive-test-hardening dismissal rule.** PEvO defaults to dismissing test-quality findings whose failure modes are theoretical-only — see `feedback_dismiss_preemptive_test_hardening` in the user's auto-memory. This learning is the load-bearing counter-case. The distinction:

- *Preemptive hardening* (dismissable): "this test could theoretically fail under an unlikely mutation; add an extra assertion to be safe." The existing assertions have real discriminating power today.
- *Vacuous assertion* (not dismissable): the existing assertion has **zero discriminating power right now**, on the exact regression path it was written to catch. There is no theoretical gap to dismiss; the gap is concrete.

When triaging test-quality findings, ask: "does this assertion actually fail if the guard breaks?" If yes, the finding may be preemptive. If no, the finding is load-bearing and the assertion needs sentinel-seeding (or replacement with a call-count or side-effect spy that does discriminate).

## When to Apply

The trap fires whenever all of these hold:

1. The test asserts state X is unchanged after an early-return scenario.
2. The function under test sets X to a known default value somewhere on the happy path between test setup and the early-return point (most commonly at function entry).
3. The asserted "unchanged" value equals X's default (e.g., `expect(comp.error).toBeNull()` when the function opens with `this.error = null;`).

A useful heuristic at test-write time: when about to write `expect(comp.someField).toBe(defaultValue)` after an early-return scenario, ask "was `someField` ever set to a non-default value during this test? If the guard silently failed, would this assertion still pass?" If yes to the second question, seed a sentinel — or pick a different observable.

## Examples

### Vacuous (the pattern this learning surfaces)

```javascript
it('loadPaper destroy() during retriable-503 backoff: guard prevents state mutation', async () => {
  fetchPaper.mockRejectedValue(svcUnavailable());
  vi.useFakeTimers();
  const comp = createComponent();
  const p = comp.loadPaper();
  // loadPaper() prologue: this.error = null; this.errorIs503 = false;
  // Mid-backoff teardown never reaches the post-retry-budget error-display branch.
  // The state below is null/false either way.
  await vi.advanceTimersByTimeAsync(500);
  comp.destroy();
  await vi.advanceTimersByTimeAsync(20000);
  await p;
  expect(fetchPaper).toHaveBeenCalledTimes(1);   // LOAD-BEARING
  expect(comp.error).toBeNull();                  // VACUOUS — null either way
  expect(comp.errorIs503).toBe(false);            // VACUOUS — false either way
});
```

### Load-bearing (post-prologue, collision-free sentinels)

```javascript
it('loadPaper destroy() during retriable-503 backoff: guard prevents state mutation', async () => {
  fetchPaper.mockRejectedValue(svcUnavailable());
  vi.useFakeTimers();
  const comp = createComponent();

  const p = comp.loadPaper();
  // Synchronous prologue (this.error = null; this.errorIs503 = false) has run;
  // control is now at the first await. Seed sentinels here so they outlive the
  // prologue reset and only the regression path overwrites them.
  comp.error = 'sentinel-error';        // regression writes an i18n key (string, not 'sentinel-error')
  comp.errorIs503 = 'sentinel-503';     // regression writes boolean true (not string)

  await vi.advanceTimersByTimeAsync(500);
  comp.destroy();
  await vi.advanceTimersByTimeAsync(20000);
  await p;

  expect(fetchPaper).toHaveBeenCalledTimes(1);    // guard fired; no re-entry
  expect(comp.error).toBe('sentinel-error');       // guard fired; error-display branch did NOT run
  expect(comp.errorIs503).toBe('sentinel-503');    // ditto
});
```

### Sibling: when sentinels don't work, lean on call-count

In `handleCitationExport`'s destroy test, the `citeLoading` flag resets to `false` in an unconditional outer `finally` block. Both the correct path (guard fires, returns from inside `try`) and the regression path (guard fails, retries exhaust, loop completes) hit the `finally`. No sentinel for `citeLoading` can discriminate because both paths converge on `false`. The test relies entirely on `expect(fetchCitationExport).toHaveBeenCalledTimes(1)` as the load-bearing assertion; the `citeLoading === false` assertion serves a narrower purpose (pinning that the `finally` fires at all through the `_mounted` early-return path), which is a different invariant — useful, but not a `_mounted`-guard regression detector.

## Related

- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — the umbrella principle. Every assertion protecting a code property must fail when that property is reverted. This learning is one specific mechanism that violates the principle (default-reset on entry defeats the assertion).
- `agents/docs/solutions/test-failures/assertion-vacuity-from-upstream-bail-in-mocked-tests-2026-05-17.md` — sibling vacuous-pass mechanism (upstream bail in multi-stage mocked tests). Same family, different trigger.
- `agents/docs/solutions/conventions/test-marker-stub-vacuous-or-fallback-2026-05-15.md` — sibling vacuous-pass via truthy-stub defeating OR-fallback. Same meta-shape (assertion green whether guard fires or not), different mechanism.
- `agents/docs/solutions/conventions/concurrency-wire-shape-assertions-mutation-blind-under-microtask-fifo-2026-05-19.md` — sibling vacuous-pass via microtask FIFO ordering. Same family, async-scheduling mechanism.
- `agents/docs/solutions/conventions/mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` — fidelity sibling. Mutation-kill claims in documentation must match what the assertion actually catches.
- `agents/docs/solutions/conventions/alpine-persistent-instance-unconditional-ui-flag-reset-2026-05-20.md` — same-day learning on the same paper-detail.js surface; documents the production-side `finally`-reset invariant the `handleCitationExport` test pins.

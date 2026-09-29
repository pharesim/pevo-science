---
title: "Asserting on fire-and-forget scheduled work: poll an effect, and give the negative case one to poll"
date: 2026-09-23
category: conventions
module: frontend/tests/unit
problem_type: convention
component: testing_framework
severity: medium
root_cause: async_timing
resolution_type: test_fix
applies_when:
  - "Production code schedules async work fire-and-forget (`this.$nextTick(() => { this._method(); })`, an un-awaited `setTimeout` callback, or any call whose returned promise nobody holds) and a test needs to assert on that work's outcome"
  - "The scheduling callback has a block body (`() => { this._method(); }` rather than `() => this._method()`), so no return value ever reaches whatever scheduled it, however the scheduler itself is mocked"
  - "Writing a negative-case assertion (`not.toHaveBeenCalled()`, a field staying `null`) on work that a fire-and-forget path may or may not schedule, depending on branch"
  - "Tuning `vi.waitFor` call sites where the awaited state settles within a microtask or two, so the default 50ms poll interval measurably inflates suite runtime"
symptoms:
  - "`await comp.loadPaperData()` followed by `expect(mockCreateEditor).toHaveBeenCalledTimes(2)` reports 0 calls, because the load's own promise settles while the scheduled method is still suspended at its first await"
  - "Patching the scheduler mock to capture and await the callback's return value also reports 0 calls, because the callback has a block body and never returns the async call's promise"
  - "A negative assertion such as `not.toHaveBeenCalled()` passes the instant it is evaluated, before the deferred work's first await has had a turn, so a regression that started doing the work would sail through"
related_components:
  - frontend
  - development_workflow
tags:
  - vitest
  - vi-waitfor
  - fire-and-forget
  - next-tick
  - deferred-work
  - vacuous-assertion
  - mutation-kill
  - poll-interval
---

# Asserting on fire-and-forget scheduled work: poll an effect, and give the negative case one to poll

## Context

`agents/docs/solutions/test-failures/sync-nexttick-mock-unhandled-rejection-after-test-pass-missing-refs-2026-09-22.md`
covers the mechanism this entry builds on. `loadPaperData` in `frontend/src/pages/edit.js` ends a successful
load by scheduling a mount it never awaits:

```js
this.$nextTick(() => {
  this._mountEditors();
});
```

`_mountEditors` is `async`; its first `await` is `await import('../editor.js')`, after which it reads
`this.$refs.abstractEditor` / `this.$refs.bodyEditor` and calls `createEditor` for each ref that is present.
That entry answers what happens when this shape throws after the test has ended. This entry answers a narrower
question it did not need to: once a component schedules work this way, how do you write a unit assertion on the
outcome that actually discriminates a working mount from a broken one, in the positive case and the negative one?

The spec's shared harness, `createComponent()` in `frontend/tests/unit/pages-edit.test.js`, mocks `$nextTick` as
`vi.fn((fn) => fn && fn())`, a synchronous call-through, and defaults `comp.$refs = {}`. That default was chosen
for fidelity to Alpine's real `$refs` proxy, which is never `undefined` on a live component, and explicitly not as
a coverage mechanism, so nothing about it proves a mount happened (session history). The cases below live in
that spec's `a successful load mounts the editors` describe and landed test-only, with no `frontend/src/` change.

## Guidance

Three approaches were tried against the same load path, in this order. The first two are dead ends worth naming
precisely, because both look plausible until measured.

**1. Awaiting the caller's own promise proves nothing about the scheduled work.**

```js
await comp.loadPaperData();
expect(mockCreateEditor).toHaveBeenCalledTimes(2); // FAILS: 0 calls
```

The synchronous `$nextTick` mock does invoke the callback before `loadPaperData` returns, so `_mountEditors` has
started. It is suspended at its first `await`, the dynamic `editor.js` import, when `loadPaperData`'s own promise
settles. The import's continuation, which is where `createEditor` is called, has not run yet. Awaiting the caller
never waits for the callee, because nothing connects the two.

**2. Making the scheduler "awaitable" does not help when the callback has a block body.**

```js
// dead end: capture what the $nextTick callback returns, then await it
let scheduled;
comp.$nextTick = vi.fn((fn) => { scheduled = fn && fn(); });
await comp.loadPaperData();
await scheduled;                                    // awaits `undefined`
expect(mockCreateEditor).toHaveBeenCalledTimes(2);  // STILL FAILS: 0 calls
```

The callback `edit.js` passes to `$nextTick` is `() => { this._mountEditors(); }`, a block body whose only
statement is a bare expression rather than a `return`. The promise is created and discarded *inside that arrow*,
in production source, before `$nextTick` ever receives a value. No rewrite of the `$nextTick` mock can recover a
promise the callback never returned, and `await undefined` waits for nothing.

This dead end was walked into even though the discarded-promise mechanism was already written down, which is the
argument for documenting the technique separately from the mechanism: knowing in the abstract that a promise is
discarded does not stop you re-deriving *where* when the shape in front of you is "patch the scheduler" rather
than "read the callback source."

**3. Poll an effect of the deferred work instead of trying to await the work itself.**

```js
await comp.loadPaperData();
await vi.waitFor(() => expect(mockCreateEditor).toHaveBeenCalledTimes(2), { interval: 1 });
```

`vi.waitFor` needs no handle on the original promise. It re-invokes its callback until the callback stops throwing
or the timeout elapses. In vitest 2.1.9 it runs the check once synchronously and only then falls back to
`setInterval(checkCallback, interval)`, with `interval` defaulting to `50` and `timeout` to `1000`.

**4. A negative assertion on the same deferred work needs its own synthetic effect, or it passes for the wrong
reason.** After a load that runs with the harness's empty `$refs`,
`expect(mockCreateEditor).not.toHaveBeenCalled()` passes the instant it is evaluated, including before the dynamic
import has resolved. That is a vacuous pass: it would say nothing if a regression started creating editors,
because it never waits long enough to see it. Give the negative case something real to poll by wrapping the
scheduled method so its completion becomes observable:

```js
const scheduledMount = comp._mountEditors.bind(comp);
let mountSettled = false;
comp._mountEditors = async () => { await scheduledMount(); mountSettled = true; };

await comp.loadPaperData();
await vi.waitFor(() => expect(mountSettled).toBe(true), { interval: 1 });

expect(mockCreateEditor).not.toHaveBeenCalled();
```

The wrapper does double duty. Besides giving the absence-assertion something to wait on, it makes the case fail,
through the `vi.waitFor` timeout, when the load stops scheduling a mount at all. Note that it wraps rather than
replaces: the real method still runs, so the assertion still exercises production behavior.

**5. Tune `interval`, leave `timeout` alone.** They are separate knobs. `interval` is paid on the passing path
every time the check re-runs before the awaited state arrives; `timeout` only bounds how long a genuinely
never-settling case takes to fail. Here the synchronous first check always fails, because the awaited state is at
least a microtask away, so each call site paid close to a full 50ms. Three such call sites tripled one spec file
from roughly 80ms to roughly 243ms; `{ interval: 1 }` brought it back to roughly 87ms. Leaving `timeout` at its
default means the mutation kills below were unchanged by the tuning, which was re-measured rather than assumed.

## Why This Matters

Mutation evidence, measured in isolated scratchpad copies. Pass counts in this section are point-in-time
measurements from when the cases landed; the spec has grown since and its totals with it. Baseline before the
two new cases: 87 passed, exit 0.

- **Before**, three regressions each survived the whole spec file undetected, at 87 passed and exit 0: deleting the
  `$nextTick` scheduling block, populating the harness `$refs` default with real elements, and renaming the
  template's `x-ref="abstractEditor"`. Nothing in the file drove the load path far enough to notice any of them.
- **After** adding the positive and negative cases, at 89 passed and exit 0: deleting the `$nextTick` block kills
  both new cases (2 failed, exit 1), and populating the `$refs` default kills the negative case (1 failed, exit 1).
- The `x-ref` rename survived those two cases, because a unit spec that supplies `$refs` directly never reads the
  template. Closing it needed an assertion over the exported template string, which is a different kind of test,
  and the describe has since gained exactly that: a load-free case asserting `editPageTemplate` contains both
  `x-ref="abstractEditor"` and `x-ref="bodyEditor"`, so the rename is now killed by a template-string assertion
  rather than by the load-driven cases.
- The positive case also pins the dispatch mechanism with an exact count,
  `expect(comp.$nextTick).toHaveBeenCalledTimes(1)`: `loadPaperData` holds `edit.js`'s only `$nextTick` call site,
  so the count witnesses the load's single dispatch and distinguishes the `$nextTick` route from an inline call.
  What such a count cannot pin is the absence of a second dispatch path: an inline duplicate `_mountEditors()`
  added beside the `$nextTick` dispatch survives every case, because the `_editorsInitialized` latch absorbs the
  duplicate before any observable effect. Scope any comment above an exact-count assertion to the dispatches it
  witnesses, never to path absence.

That gap is the concrete cost of dead ends 1 and 2. Either one reports "0 calls" whether the mount is wired
correctly or deleted outright, so the assertion cannot discriminate a working mount from a broken one: it never
observes the deferred work at all. The negative case carries the mirrored risk in the other direction. Without the
settlement wrapper, `not.toHaveBeenCalled()` reports a pass whether the load correctly creates no editor or would
have created one given time to run.

## When to Apply

- Any test asserting on work a component schedules without awaiting it, whether that is
  `$nextTick(() => { asyncMethod(); })`, an un-awaited `setTimeout` callback, or any other call whose promise
  nobody holds, asserts on an *effect* of the work (a spy's call count, a field it sets) polled with `vi.waitFor`,
  never on the scheduling call's own return value.
- The rule applies symmetrically to positive and negative assertions against the same deferred call. A negative
  case needs its own synthetic effect, such as a settlement-flag wrapper around the scheduled method, whenever the
  branch under test produces no other observable side effect by design.
- Recurrence surface in this codebase: `frontend/src/pages/publish.js`'s `init()` schedules
  `this.$nextTick(() => { this._mountEditors(); });` the same way, and its `_mountEditors` reads the same two refs
  after its own `editor.js` import. Whether its spec has the same positive and negative coverage gap should be
  re-verified against that spec rather than assumed.
- Prefer a tight `{ interval: 1 }` on a new `vi.waitFor` added for a microtask-scale wait, and leave `timeout` at
  its default unless the awaited state genuinely needs longer than a second under a loaded machine.

## Examples

The full progression, condensed:

```js
// 1. Awaiting the caller proves nothing about deferred work. FAILS at 0 calls:
//    the synchronous $nextTick mock has started _mountEditors, but it is
//    suspended at `await import('../editor.js')` when this line runs.
await comp.loadPaperData();
expect(mockCreateEditor).toHaveBeenCalledTimes(2);

// 2. Capturing and awaiting the scheduler's return value does not help either.
//    STILL FAILS at 0 calls: edit.js's own `() => { this._mountEditors(); }`
//    has a block body and returns nothing to capture, however $nextTick is
//    mocked, so `scheduled` is undefined.
let scheduled;
comp.$nextTick = vi.fn((fn) => { scheduled = fn && fn(); });
await comp.loadPaperData();
await scheduled;
expect(mockCreateEditor).toHaveBeenCalledTimes(2);

// 3. Poll an effect of the work instead. WORKS.
await comp.loadPaperData();
await vi.waitFor(() => expect(mockCreateEditor).toHaveBeenCalledTimes(2), { interval: 1 });

// 4. Negative case: wrap the scheduled method so its completion is observable,
//    so the absence-assertion is not evaluated before the work could have run.
const scheduledMount = comp._mountEditors.bind(comp);
let mountSettled = false;
comp._mountEditors = async () => { await scheduledMount(); mountSettled = true; };

await comp.loadPaperData();
await vi.waitFor(() => expect(mountSettled).toBe(true), { interval: 1 });

expect(mockCreateEditor).not.toHaveBeenCalled();
```

## Related

- `agents/docs/solutions/test-failures/sync-nexttick-mock-unhandled-rejection-after-test-pass-missing-refs-2026-09-22.md`
  is the mechanism this entry assumes: a synchronously mocked `$nextTick` still runs a genuinely async callee, and
  its discarded promise is why neither dead end here can recover the work by patching the scheduler. It also
  records the coverage gap that the positive and negative cases here close, so its description of that gap as open
  follow-up is now stale.
- `agents/docs/solutions/test-failures/positive-surface-gate-before-alpine-absence-assertion-2026-06-10.md` is the
  same principle one layer up: an absence assertion is vacuous unless it is gated on a positive completion signal.
  That entry applies it to an Alpine `x-if` surface in an end-to-end spec; this one applies it to a mocked method
  in a unit spec.
- `agents/docs/solutions/conventions/vi-spyon-mockimplementation-bypasses-function-under-test-2026-05-12.md` is the
  precedent for wrapping rather than replacing, which is what keeps the settlement wrapper here from hollowing out
  the very behavior the case asserts on.
- `agents/docs/solutions/conventions/final-state-assertions-cannot-discriminate-dispatch-from-confirmation-2026-09-01.md`
  is the adjacent pitfall in the same family, on the backend side: a final-state assertion that cannot tell a
  dispatch from its confirmation. Same fire-and-forget root cause, different question.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` is the umbrella
  canon this entry instantiates. The before-and-after mutation results above are what that convention asks for.

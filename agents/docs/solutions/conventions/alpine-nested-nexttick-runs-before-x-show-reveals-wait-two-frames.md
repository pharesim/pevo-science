---
title: "To act on an element an Alpine x-show is about to reveal, wait two animation frames: a nested $nextTick runs before the reveal"
date: 2026-10-08
category: conventions
module: frontend/src/components
problem_type: convention
component: frontend_stimulus
severity: medium
root_cause: async_timing
resolution_type: code_fix
applies_when:
  - "Code scrolls, measures or focuses an element whose x-show it has just made true"
  - "A component announces something from init() with $dispatch and a listener sits on its own element"
  - "A unit test stubs scrollIntoView, focus or getBoundingClientRect to prove such code ran"
  - "A real-Alpine test suite defers work by animation frames across cases"
retire_when: "An Alpine upgrade changes releaseNextTicks or the x-show reveal; check frontend/node_modules/alpinejs/dist/module.esm.js after any alpinejs bump"
tags: [alpine, next-tick, x-show, request-animation-frame, scroll-into-view, dispatch, init, real-alpine, jsdom, async-timing]
---

# To act on an element an Alpine x-show is about to reveal, wait two animation frames: a nested $nextTick runs before the reveal

## Context

A comment composer that takes its text back after a full-page round-trip has to make itself visible: it opens the reply box it sits in, then scrolls to it. The reply box is an `x-show` on the parent comment tree's `replyOpen[id]`, so the composer dispatches an event from `init()` (`frontend/src/components/comment-composer.js`, `init`), a listener on the composer's own element (`x-on:comment-restored.self` in the reply composer markup of `frontend/src/components/threaded-comments.js`) sets `replyOpen[id] = true`, and the composer scrolls.

The first version dispatched in `this.$nextTick` and scrolled in a nested `this.$nextTick`. The unit tests passed, the real-Alpine whole-app test passed, and in Chromium the page never moved: the reply box opened with the text in it, below the fold, at scroll position 0.

Three facts about Alpine 3.15.11 (`frontend/node_modules/alpinejs/dist/module.esm.js`) explain it, and none is visible from the component code:

1. **A nested `$nextTick` runs in the same drain as its parent.** `nextTick` pushes the callback onto `tickStack`, and `releaseNextTicks` empties it with `while (tickStack.length) tickStack.shift()()`. A `$nextTick` queued from inside a `$nextTick` callback is pushed while that loop is still running, so it runs in that same loop, after its parent and anything already queued, before any microtask. In particular it runs before the scheduler's `flushJobs` microtask (`queueFlush` → `queueMicrotask(flushJobs)`), which is what applies the reactive change the parent made. "One more tick" is not one more render.
2. **`x-show` reveals in a frame of its own.** The directive's first evaluation shows or hides at once, but a later toggle does not: when the effect runs for a value that changed, `_x_toggleAndCascadeWithTransitions` shows the element through `clickAwayCompatibleShow = () => nextTick2(show)`, where `nextTick2` is `requestAnimationFrame` in a visible tab and `setTimeout` in a hidden one. So the element is still `display: none` after the reactive flush, until that frame. Scrolling, measuring or focusing it any earlier acts on a hidden element: `scrollIntoView` does nothing, `getBoundingClientRect` reports zeros.
3. **A `$dispatch` from `init()` is not heard by an `x-on` on the same element.** `directive("data", ...)` evaluates `reactiveData["init"]` synchronously while the `data` directive runs, and `directiveOrder` puts `data` before `on` (the `DEFAULT` slot), so the element's own listener is bound only after `init()` returns. A synchronous dispatch from `init()` reaches no one there; a dispatch in `$nextTick` is heard.

## Guidance

- Dispatch an event that a listener on the same element must hear from `$nextTick`, never synchronously from `init()`.
- To act on an element that an `x-show` you just made true will reveal, wait two animation frames after the reactive change. The first frame was requested before `x-show` queued its own, so only the second callback runs after the reveal:

  ```js
  this.$nextTick(() => {
    this.$dispatch('comment-restored');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this.$el.scrollIntoView?.({ block: 'center' });
    }));
  });
  ```

  A nested `$nextTick` fires while the element is still hidden, and nothing orders a `setTimeout(0)` after the reveal.
- In a test, prove the element was displayed **when** the action ran, not only that the action was called. A stub that records the call passes on the broken code. The real-Alpine test (`frontend/tests/unit/paper-detail-navigation-stash-real-alpine.test.js`) records `{ el, displayed: isDisplayed(this) }` from its `Element.prototype.scrollIntoView` stub and asserts `displayed: true`. A factory-level unit test with a mocked Alpine can pin the deferral instead: record `$nextTick` and `requestAnimationFrame` callbacks without running them, and assert that the scroll needs one tick and then two frames.
- A frame-deferred action outlives the case that started it. In a whole-app real-Alpine suite, drain two frames in `beforeEach` before resetting a recorder, or the previous case's late scroll lands in the next case's list.

## Why This Matters

The broken version passes every test that does not check visibility at call time, and the failure is silent in the browser: no error, no warning, just an action on an invisible element. The work the scroll was meant to show was there, so the feature looked done in every check short of a human scrolling a real page. Each of the three facts reads like a reasonable assumption ("a tick later the DOM is updated", "x-show is synchronous", "my own listener is bound by init"), which is why the code that relies on them reviews clean.

## When to Apply

- Any code that scrolls to, measures, or focuses an element after flipping the `x-show` that hides it, including through an event another component handles.
- Any `init()` that announces something with `$dispatch` for a listener on its own element.
- Tests that stub DOM side effects (`scrollIntoView`, `focus`, `getBoundingClientRect`) to prove such code ran.
- Not needed for an element that is already displayed.

## Examples

Before (scroll fires while the reply box is still `display: none`):

```js
init() {
  // ...restore...
  this.$nextTick(() => {
    this.$dispatch('comment-restored');
    this.$nextTick(() => this.$el.scrollIntoView?.({ block: 'center' }));
  });
},
```

After: the two-frame form in Guidance. In Chromium, the restored reply box went from staying below the fold at scroll position 0 to being scrolled to and centered in the viewport.

Test stub that tells the two apart:

```js
Element.prototype.scrollIntoView = function scrollIntoView() {
  scrolled.push({ el: this, displayed: isDisplayed(this) });
};
// ...
await vi.waitFor(() => expect(scrolled).toContainEqual({ el: target, displayed: true }));
```

## Related

- `agents/docs/solutions/conventions/waitfor-poll-required-for-nexttick-scheduled-effect-assertions.md`: polling for fire-and-forget `$nextTick` work in tests with a mocked Alpine; this entry is about what real Alpine has rendered when that work runs.
- `agents/docs/solutions/test-failures/sync-nexttick-mock-unhandled-rejection-after-test-pass-missing-refs-2026-09-22.md`: another way a synchronous `$nextTick` stub misrepresents real Alpine timing.
- `agents/docs/solutions/test-failures/positive-surface-gate-before-alpine-absence-assertion-2026-06-10.md`: synchronous mutations land in one reactive flush; this entry is the next layer, where the flush is still not the `x-show` reveal.
- `agents/docs/solutions/conventions/alpine-factory-exposure-vs-template-mutation-coverage-2026-04-28.md`: mounting real Alpine in jsdom; a `setTimeout(0)` settle is enough for `x-text`, not for code that acts after an `x-show` toggle.
- `agents/docs/solutions/conventions/final-state-assertions-cannot-discriminate-dispatch-from-confirmation-2026-09-01.md`: take the discriminating sample at the moment that separates correct from broken code, which the displayed-at-call-time recorder does for frame timing.
- `agents/docs/solutions/conventions/vitest-retry-fire-and-forget-side-effect-poisoning-2026-05-04.md`: deferred side effects from one case leaking into the next.

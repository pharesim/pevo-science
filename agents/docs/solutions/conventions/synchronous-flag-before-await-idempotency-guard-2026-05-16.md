---
title: "Synchronous-flag-before-await: idempotency guard for async functions must set its flag BEFORE the first `await`"
date: 2026-05-16
category: conventions
module: frontend/src/pages
problem_type: convention
component: frontend_stimulus
severity: high
applies_when:
  - "Writing an async function that should be idempotent against rapid re-entry (mount, init, retry click, lifecycle re-trigger)"
  - "Refactoring a function that mixes a lazy `await import(...)` with side-effecting `this.*` writes"
  - "Reviewing a guard pattern where the first thing the function does is `await` something (the guard placement is almost certainly wrong)"
  - "Pairing with a separate destroyed-during-init guard placed AFTER the await — the two guards stack and collapse different races"
tags:
  - concurrency
  - async
  - alpine
  - guard-flag
  - idempotency
  - race-condition
  - frontend
related_components:
  - testing_framework
---

# Synchronous-flag-before-await: idempotency guard for async functions must set its flag BEFORE the first `await`

When an async function gates a second concurrent invocation by checking and setting a guard flag, the **flag write must happen synchronously, before the first `await` boundary**. Setting the flag after the await leaves a re-entry window where two concurrent callers both pass the entry-check, both await, and both proceed to the side-effecting body — producing the exact failure the guard exists to prevent.

## Context

Surfaced in PEvO's `_mountEditors` lifecycle. The `frontend/src/pages/edit.js` and `frontend/src/pages/publish.js` editors lazy-load their Tiptap-based editor module via dynamic `import('../editor.js')`, then attach the resulting instances to `this._abstractEditor` / `this._bodyEditor`. Two distinct races needed to be closed:

1. **Teardown-during-init.** Component is destroyed between the `$nextTick(() => this._mountEditors())` schedule and the `await import(...)` resolve. Closed by a post-await guard: `if (!this._mounted) return;` after the import.

2. **Mount-during-mount.** In `edit.js`, `loadPaperData()` clears its `_loadInFlight` mutex in `finally` BEFORE `_mountEditors()` actually runs (deferred via `$nextTick`, then `await import(...)`). A Retry click landing between the mutex clear and the import resolve passes the `_loadInFlight` guard, fires a fresh fetch, and schedules a second `_mountEditors`. Both invocations eventually call `createEditor()` on the same `$refs`. Each call overwrites `this._abstractEditor` / `this._bodyEditor`, orphaning the prior instances with their attached event listeners and Tiptap document trees.

The teardown-during-init fix is a post-await guard. The mount-during-mount fix needs a guard that runs BEFORE the await — by the time `await import(...)` resolves, both concurrent callers have already passed any post-await check.

## Guidance

For any async function that should be idempotent against concurrent re-entry, place the guard flag write as the first synchronous statement after the entry-check, BEFORE the first `await`:

```js
async _mountEditors() {
  if (this._editorsInitialized) return;     // entry check
  this._editorsInitialized = true;          // ← SET BEFORE the await
  const { createEditor } = await import('../editor.js');
  if (!this._mounted) {
    this._editorsInitialized = false;       // reset on early-return path
    return;
  }
  this._abstractEditor = createEditor(this.$refs.abstractEditor, /* ... */);
  this._bodyEditor = createEditor(this.$refs.bodyEditor, /* ... */);
}
```

Three structural rules apply:

1. **Set the flag synchronously, before the first `await`.** Two concurrent calls dispatched in the same tick both reach `await` in JS without yielding to each other; only the synchronous prefix collapses them. Placing the assignment after the await leaves the same re-entry window the guard claims to close.

2. **Reset the flag on every early-return path.** The legitimate "guarded re-init" path (teardown-during-init → component is gone → no editors mounted) must clear the flag so a later legitimate remount (live-reload, navigation back, route re-entry) can succeed. Without the reset, the second mount attempt sees `_editorsInitialized === true` and exits immediately, leaving the page un-mounted.

3. **Reset the flag in `destroy()` (or the equivalent lifecycle teardown).** The component instance may be reused (Alpine's keyed `x-for` rebind, route re-entry). Without the destroy-time reset, the next instance starts with `_editorsInitialized === true` from the previous lifecycle and skips initialization.

## Why This Matters

The intuition for guard-flag placement is often "set the flag after the work is done, so we only mark complete when complete." That intuition is right for completion-tracking flags but wrong for idempotency guards. The flag is not "did this finish" — it's "is this already in flight". A guard set after the await answers "did some prior call finish first" which is a strictly weaker invariant: two calls dispatched in the same microtask batch both see the flag false at the entry-check, both await, both proceed.

The failure mode is silent and memory-leak-shaped, not crash-shaped: each concurrent invocation overwrites the previous's references on `this.*`, and the orphaned instances (DOM event listeners, Tiptap document trees, framework-internal subscriptions) hang around for the lifetime of the page session. A page that the user opens and closes repeatedly accumulates editor instances, listeners on `window`, and detached DOM nodes — observable as a slow but steady memory growth in `performance.memory.usedJSHeapSize`.

## When to Apply

- Any async function that mounts or initializes resources where double-mounting would leak (editors, observers, subscriptions, polling loops).
- Any retry-click handler or lifecycle hook that may be triggered re-entrantly before the prior call settled.
- Any function with both a destroyed-during-init guard AND a concurrent-re-entry concern. The two guards stack: synchronous-flag-before-await catches re-entry, post-await `_mounted` check catches teardown-during-init.

Do NOT apply when:
- The function is naturally single-shot (called once at component init and never again) — the flag is dead code.
- A library-provided mutex / promise singleton already serializes (e.g., `Promise.resolve(this._initPromise ??= doInit())` pattern).
- The await is for a side-effect-free operation whose duplication is genuinely harmless (rare; usually deceptively non-harmless).

## Examples

### Before — flag set AFTER await (broken)

```js
// BAD: guard set post-await
async _mountEditors() {
  if (this._editorsInitialized) return;
  const { createEditor } = await import('../editor.js');
  this._editorsInitialized = true;  // ← TOO LATE
  this._abstractEditor = createEditor(/* ... */);
  this._bodyEditor = createEditor(/* ... */);
}
```

Two synchronous calls in the same tick: both check `_editorsInitialized` (false), both await `import('../editor.js')` (the import is cached after first resolve, so the second call resolves immediately), both reach `this._editorsInitialized = true`, and both call `createEditor` twice. The first pair of editor instances is orphaned by the second pair's overwrite of `this._abstractEditor` / `this._bodyEditor`.

### After — flag set BEFORE await (collapses concurrent re-entry)

```js
async _mountEditors() {
  if (this._editorsInitialized) return;
  this._editorsInitialized = true;   // ← collapses second tick
  const { createEditor } = await import('../editor.js');
  if (!this._mounted) {
    this._editorsInitialized = false; // reset on early-return
    return;
  }
  this._abstractEditor = createEditor(/* ... */);
  this._bodyEditor = createEditor(/* ... */);
}
```

Second tick sees `_editorsInitialized === true` at the entry-check and returns immediately, before the await dispatches. Only one `createEditor` pair lands per mount cycle. Reset paths in the destroyed-guard early-return AND in `destroy()` ensure the flag clears when re-init becomes legitimate again.

### Mutation kill in tests

The unit-test pattern that pins this placement is to assert the flag's value after `_mountEditors()` returns under the destroyed-during-mount fixture:

```js
it('is a no-op when the component was destroyed before the import resolved', async () => {
  const comp = createComponent();
  comp.destroy();                                  // _mounted = false, _editorsInitialized = false
  comp.$refs = { abstractEditor: null, bodyEditor: null };
  await comp._mountEditors();
  expect(mockCreateEditor).not.toHaveBeenCalled();
  expect(comp._abstractEditor).toBe(null);
  expect(comp._bodyEditor).toBe(null);
  // Mutation-kill for `if (!this._mounted) { ...; return; }`: the reset
  // of _editorsInitialized to false is reachable ONLY via the mounted-guard
  // early-return branch (the synchronous prefix sets it to true; the
  // null-ref guards return BEFORE any reset). Removing the mounted-guard
  // block leaves _editorsInitialized true and this assertion fails.
  expect(comp._editorsInitialized).toBe(false);
});
```

The assertion `_editorsInitialized === false` is reachable on unmutated code only through the post-await early-return path (which DOES reset). The null-ref production guards (`if (abstractEl)`, `if (bodyEl)`) return BEFORE any reset, so a mutation that removes the post-await mounted-guard leaves the flag as `true` — assertion fails. That's the load-bearing structural invariant the synchronous-flag-before-await pattern produces.

## Cross-references

- `agents/docs/solutions/conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` — per-layer canary pinning; the two stacked guards in `_mountEditors` (synchronous prefix + post-await mounted check) are an instance of this convention's "pin each layer" rule.
- `agents/docs/solutions/conventions/mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` — the test-side companion. The unit-test mutation-kill claim in the example above is honest by this convention's standard: the assertion structurally requires the guard's reset, and the corpus (synthetic teardown) reliably exercises the branch.
- `frontend/src/pages/edit.js` (`_mountEditors`) and `frontend/src/pages/publish.js` (`_mountEditors`) — the canonical sites where this pattern is in production today.
- `frontend/tests/unit/pages-edit.test.js` and `frontend/tests/unit/pages-publish.test.js` — the unit tests that pin the placement via the destroyed-during-mount fixture.

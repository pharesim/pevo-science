// timer-guard.js — post-teardown guard for setTimeout callbacks in Alpine
// components.
//
// Problem: long-running broadcast flows (publish, edit, review, bridge, ORCID
// callback) arm `setTimeout(() => this.navigate(...), N)` after a successful
// Hive broadcast that typically takes 3-10s. If the user navigates away while
// the timer is pending, Alpine tears the component down, but the timer still
// fires and calls `navigate` on a destroyed component, triggering an
// unwanted route change.
//
// Usage (spread into an Alpine.data() state object):
//
//   Alpine.data('myPage', () => ({
//     ...createTimerGuard(),
//     // ... other state
//
//     destroy() {
//       this._teardownTimers();
//       // ... other teardown
//     },
//
//     async onSuccess() {
//       this._setTimer(() => this.navigate('/somewhere'), 1500);
//     },
//   }));
//
// Contract:
// - `_setTimer(fn, ms)` schedules `fn` and tracks the timer id. When the
//   timer fires, the id is removed from the pending set; if `_mounted` is
//   false, `fn` is skipped.
// - `_teardownTimers()` sets `_mounted = false` and clears every tracked
//   timer. Call it from `destroy()`. After teardown, any async continuation
//   that needs to guard itself can also check `this._mounted`.
// - The helper only guards `setTimeout`. Debounce timers bound to input
//   events (e.g. `_draftTimer`, `_orcidCheckTimer`) have a different hazard
//   shape (replaced on next keystroke) and stay outside this helper.
//
// The same helper now guards both `setTimeout(navigate)` call sites AND
// async-continuation catches (fetch/broadcast awaits) via `_mounted`: any
// post-await write to component state should be preceded by
// `if (!this._mounted) return;`. This makes `createTimerGuard()` the canonical
// teardown primitive for Alpine components with async work.
//
// USAGE: Call inside the per-mount Alpine.data factory
// (`Alpine.data(() => ({ ...createTimerGuard(), ... }))`), NOT at module
// scope. The returned object holds component-instance state
// (`_pendingTimers` Set, `_mounted` flag); hoisting a single return value
// shared across multiple components would corrupt teardown state.
//
// `_sleep(ms)` is the Promise-shaped sibling of `_setTimer`. It returns a
// `Promise<void>` that resolves either when the timer fires normally OR when
// `_teardownTimers()` runs first. Callers MUST follow each `await this._sleep(N)`
// with the same `if (!this._mounted) return;` (or analogous identity / state)
// guard they already use for fetch/broadcast awaits — `_sleep` resolves on
// teardown to drain the awaiting frame rather than leaving the promise
// dangling, but the caller is still responsible for not mutating component
// state after destroy. Resolve-on-teardown was chosen over reject because
// every existing await site in PEvO is already guarded by `_mounted` (or
// paper-identity) checks, so a reject path would require try/catch noise at
// every call site for no semantic gain.
export function createTimerGuard() {
  return {
    _mounted: true,
    _pendingTimers: new Set(),
    // Resolver fns for pending `_sleep` calls, so `_teardownTimers()` can
    // drain awaiting frames instead of leaving promises dangling forever.
    _pendingSleepResolvers: new Set(),

    _setTimer(fn, ms) {
      const id = setTimeout(() => {
        this._pendingTimers.delete(id);
        if (!this._mounted) return;
        fn();
      }, ms);
      this._pendingTimers.add(id);
      return id;
    },

    _sleep(ms) {
      return new Promise((resolve) => {
        const id = setTimeout(() => {
          this._pendingTimers.delete(id);
          this._pendingSleepResolvers.delete(resolve);
          resolve();
        }, ms);
        this._pendingTimers.add(id);
        this._pendingSleepResolvers.add(resolve);
      });
    },

    _teardownTimers() {
      this._mounted = false;
      for (const id of this._pendingTimers) clearTimeout(id);
      this._pendingTimers.clear();
      // Drain awaiting frames so `_sleep` promises don't dangle past destroy.
      // The caller's `if (!this._mounted) return;` guard short-circuits before
      // any state mutation runs.
      for (const resolve of this._pendingSleepResolvers) resolve();
      this._pendingSleepResolvers.clear();
    },
  };
}

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
export function createTimerGuard() {
  return {
    _mounted: true,
    _pendingTimers: new Set(),

    _setTimer(fn, ms) {
      const id = setTimeout(() => {
        this._pendingTimers.delete(id);
        if (!this._mounted) return;
        fn();
      }, ms);
      this._pendingTimers.add(id);
      return id;
    },

    _teardownTimers() {
      this._mounted = false;
      for (const id of this._pendingTimers) clearTimeout(id);
      this._pendingTimers.clear();
    },
  };
}

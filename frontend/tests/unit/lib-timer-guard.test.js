// Unit tests for frontend/src/lib/timer-guard.js, the post-teardown
// setTimeout guard shared by publish/edit/review/bridge/orcid-callback.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTimerGuard } from '../../src/lib/timer-guard.js';

describe('createTimerGuard', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function component() {
    // Simulate an Alpine component that spreads the guard into its state
    // object. `this` binding matters for _setTimer / _teardownTimers, so
    // we exercise it through an object literal rather than directly.
    return { ...createTimerGuard() };
  }

  it('initializes with _mounted = true and empty _pendingTimers', () => {
    const c = component();
    expect(c._mounted).toBe(true);
    expect(c._pendingTimers).toBeInstanceOf(Set);
    expect(c._pendingTimers.size).toBe(0);
  });

  it('_setTimer fires the callback when mounted', () => {
    const c = component();
    const fn = vi.fn();
    c._setTimer(fn, 100);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('_setTimer removes its id from _pendingTimers when it fires', () => {
    const c = component();
    c._setTimer(() => {}, 100);
    expect(c._pendingTimers.size).toBe(1);
    vi.advanceTimersByTime(100);
    expect(c._pendingTimers.size).toBe(0);
  });

  it('_teardownTimers clears all pending timers and sets _mounted = false', () => {
    const c = component();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    c._setTimer(fn1, 100);
    c._setTimer(fn2, 200);
    expect(c._pendingTimers.size).toBe(2);

    c._teardownTimers();
    expect(c._mounted).toBe(false);
    expect(c._pendingTimers.size).toBe(0);

    // Advancing past both delays must NOT invoke either callback.
    vi.advanceTimersByTime(500);
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });

  it('a timer armed before teardown that somehow survives clearTimeout is still gated by _mounted', () => {
    // Defense in depth: even if clearTimeout missed an id (it should not,
    // but belt-and-suspenders), the _mounted check inside the callback
    // prevents the user-provided fn from running.
    const c = component();
    const fn = vi.fn();
    c._setTimer(fn, 100);
    c._mounted = false; // Simulate teardown without clearing the timer set.
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
  });

  it('_setTimer returns the timer id (for callers that want to hold onto it)', () => {
    const c = component();
    const id = c._setTimer(() => {}, 100);
    expect(id).toBeDefined();
    expect(c._pendingTimers.has(id)).toBe(true);
  });

  it('factory returns isolated state per call (no shared module-level state)', () => {
    // Guards against a future refactor that hoists the returned object to
    // module scope. Arming + tearing down the first instance must not leak
    // into a freshly-created second instance.
    const c1 = component();
    const c2 = component();
    c1._setTimer(() => {}, 100);
    expect(c1._pendingTimers.size).toBe(1);
    c1._teardownTimers();
    expect(c1._mounted).toBe(false);
    expect(c2._mounted).toBe(true);
    expect(c2._pendingTimers.size).toBe(0);
    expect(c2._pendingTimers).not.toBe(c1._pendingTimers);
  });

  it('_teardownTimers is idempotent (safe to call twice)', () => {
    const c = component();
    c._setTimer(() => {}, 100);
    c._teardownTimers();
    expect(() => c._teardownTimers()).not.toThrow();
    expect(c._mounted).toBe(false);
    expect(c._pendingTimers.size).toBe(0);
  });

  describe('_sleep', () => {
    it('resolves when the timer fires normally', async () => {
      const c = component();
      const after = vi.fn();
      const p = c._sleep(100).then(after);
      expect(after).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      await p;
      expect(after).toHaveBeenCalledTimes(1);
    });

    it('removes its timer id from _pendingTimers when it fires', async () => {
      const c = component();
      const p = c._sleep(100);
      expect(c._pendingTimers.size).toBe(1);
      expect(c._pendingSleepResolvers.size).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      await p;
      expect(c._pendingTimers.size).toBe(0);
      expect(c._pendingSleepResolvers.size).toBe(0);
    });

    it('_teardownTimers resolves a pending sleep without firing its timer', async () => {
      const c = component();
      const after = vi.fn();
      const p = c._sleep(5000).then(() => { after(); });
      expect(after).not.toHaveBeenCalled();
      // Teardown before the timer would have fired: the promise resolves,
      // the awaiting frame runs, and the caller's `_mounted` guard takes
      // over from there.
      c._teardownTimers();
      await p;
      expect(after).toHaveBeenCalledTimes(1);
      expect(c._mounted).toBe(false);
      expect(c._pendingTimers.size).toBe(0);
      expect(c._pendingSleepResolvers.size).toBe(0);
    });

    it('the awaiting frame can short-circuit on !_mounted after teardown', async () => {
      // The contract: callers MUST guard post-await with `_mounted`. Pin it.
      const c = component();
      const mutated = vi.fn();
      const flow = (async () => {
        await c._sleep(5000);
        if (!c._mounted) return;
        mutated();
      })();
      c._teardownTimers();
      await flow;
      expect(mutated).not.toHaveBeenCalled();
    });

    it('multiple concurrent sleeps all resolve on teardown', async () => {
      const c = component();
      const resolved = [];
      const p1 = c._sleep(1000).then(() => resolved.push('a'));
      const p2 = c._sleep(2000).then(() => resolved.push('b'));
      const p3 = c._sleep(3000).then(() => resolved.push('c'));
      expect(c._pendingTimers.size).toBe(3);
      expect(c._pendingSleepResolvers.size).toBe(3);
      c._teardownTimers();
      await Promise.all([p1, p2, p3]);
      expect(resolved.length).toBe(3);
      expect(c._pendingSleepResolvers.size).toBe(0);
    });
  });
});

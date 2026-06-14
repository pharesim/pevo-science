// Unit tests for frontend/src/lib/orcid-redirect-guard.js, the bfcache-restore
// reset for a stuck ORCID-redirect loading flag.
//
// bfcache (back/forward cache) restore cannot be truly simulated in jsdom:
// pressing browser Back to a bfcache-restored page does not re-run Alpine
// init()/destroy() and dispatches a `pageshow` event with `persisted === true`.
// jsdom never sets `persisted`, so each test installs a controllable `window`
// stub that records listeners and lets us dispatch a synthetic pageshow event
// whose `persisted` property we set explicitly.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOrcidRedirectGuard } from '../../src/lib/orcid-redirect-guard.js';

// A minimal window stub that records pageshow listeners so a test can fire a
// synthetic event at the exact registered handler.
function makeWindowStub() {
  const listeners = new Map(); // event type -> Set of handlers
  return {
    listeners,
    addEventListener: vi.fn((type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    }),
    removeEventListener: vi.fn((type, fn) => {
      listeners.get(type)?.delete(fn);
    }),
    fire(type, event) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
    count(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

// A component-shaped object that spreads the guard, like an Alpine.data() state.
function component(flagName) {
  return { ...createOrcidRedirectGuard(flagName), orcidLoading: true, orcidLinking: true };
}

describe('createOrcidRedirectGuard', () => {
  let winStub;
  let sessionData;

  beforeEach(() => {
    winStub = makeWindowStub();
    vi.stubGlobal('window', winStub);
    sessionData = { pevo_orcid_mode: 'signup' };
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((k) => sessionData[k] ?? null),
      setItem: vi.fn((k, v) => { sessionData[k] = v; }),
      removeItem: vi.fn((k) => { delete sessionData[k]; }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers a single pageshow listener on install', () => {
    const c = component();
    c._installOrcidRedirectGuard();
    expect(winStub.count('pageshow')).toBe(1);
    expect(c._orcidRedirectGuardHandler).toBeTypeOf('function');
  });

  it('resets the named flag to false on a persisted pageshow (bfcache restore)', () => {
    const c = component('orcidLoading');
    c._installOrcidRedirectGuard();
    expect(c.orcidLoading).toBe(true);
    winStub.fire('pageshow', { persisted: true });
    expect(c.orcidLoading).toBe(false);
  });

  it('resets a custom flag name (orcidLinking) on a persisted pageshow', () => {
    const c = component('orcidLinking');
    c._installOrcidRedirectGuard();
    expect(c.orcidLinking).toBe(true);
    winStub.fire('pageshow', { persisted: true });
    expect(c.orcidLinking).toBe(false);
  });

  it('clears the pevo_orcid_mode marker on a persisted pageshow', () => {
    const c = component('orcidLoading');
    c._installOrcidRedirectGuard();
    winStub.fire('pageshow', { persisted: true });
    expect(sessionStorage.removeItem).toHaveBeenCalledWith('pevo_orcid_mode');
    expect(sessionData.pevo_orcid_mode).toBeUndefined();
  });

  it('does NOT reset the flag on a non-persisted pageshow (normal load)', () => {
    const c = component('orcidLoading');
    c._installOrcidRedirectGuard();
    c.orcidLoading = true;
    winStub.fire('pageshow', { persisted: false });
    expect(c.orcidLoading).toBe(true);
    expect(sessionStorage.removeItem).not.toHaveBeenCalled();
  });

  it('deregisters the prior listener before reassigning on a second install', () => {
    const c = component('orcidLoading');
    c._installOrcidRedirectGuard();
    const first = c._orcidRedirectGuardHandler;
    c._installOrcidRedirectGuard();
    // The first handler was removed, so only the second remains registered.
    expect(winStub.removeEventListener).toHaveBeenCalledWith('pageshow', first);
    expect(winStub.count('pageshow')).toBe(1);
  });

  it('removes the listener on teardown so a later pageshow does not reset', () => {
    const c = component('orcidLoading');
    c._installOrcidRedirectGuard();
    c._teardownOrcidRedirectGuard();
    expect(winStub.count('pageshow')).toBe(0);
    expect(c._orcidRedirectGuardHandler).toBeNull();
    // A pageshow after teardown must not flip the flag (handler is gone).
    c.orcidLoading = true;
    winStub.fire('pageshow', { persisted: true });
    expect(c.orcidLoading).toBe(true);
  });

  it('teardown is a no-op when never installed', () => {
    const c = component('orcidLoading');
    expect(() => c._teardownOrcidRedirectGuard()).not.toThrow();
    expect(c._orcidRedirectGuardHandler).toBeNull();
  });

  it('install is a no-op when window is unavailable', () => {
    vi.stubGlobal('window', undefined);
    const c = component('orcidLoading');
    expect(() => c._installOrcidRedirectGuard()).not.toThrow();
    expect(c._orcidRedirectGuardHandler).toBeNull();
  });
});

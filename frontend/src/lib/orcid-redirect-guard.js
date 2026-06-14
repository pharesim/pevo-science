// orcid-redirect-guard.js — clears a stuck ORCID-redirect loading flag when
// the page is restored from the back/forward cache (bfcache).
//
// Problem: each ORCID-redirect handler sets a reactive loading flag to `true`
// and then does `window.location.href = <orcid url>`. The flag is reset only
// inside the handler's `catch`, so the success path navigates away with the
// flag still `true`. When the user presses browser Back (e.g. they could not
// sign in at ORCID), the page is restored from bfcache: Alpine `init()` does
// NOT re-run and `destroy()` does NOT fire, so the flag stays `true` and the
// button stays `:disabled` on its "Redirecting to ORCID..." label until a hard
// reload. The `pageshow` event (with `event.persisted === true`) is the only
// browser signal that fires on a bfcache restore, so it is where we reset.
//
// Usage (spread into an Alpine.data() state object):
//
//   Alpine.data('myPage', () => ({
//     ...createOrcidRedirectGuard('orcidLoading'),
//     // ... other state
//
//     init() {
//       this._installOrcidRedirectGuard();
//       // ... other init
//     },
//
//     destroy() {
//       this._teardownOrcidRedirectGuard();
//       // ... other teardown
//     },
//   }));
//
// Contract:
// - `createOrcidRedirectGuard(flagName)` returns a mixin that resets
//   `this[flagName]` to `false` on bfcache restore. `flagName` defaults to
//   `'orcidLoading'`; settings.js passes `'orcidLinking'`.
// - `_installOrcidRedirectGuard()` registers the `pageshow` listener. It is
//   deregister-before-reassign safe: Alpine can re-instantiate a component
//   without an intervening `destroy()`, so a stale listener is removed before a
//   fresh one is bound (mirrors the beforeunload pattern in settings.js).
// - `_teardownOrcidRedirectGuard()` removes the listener. Call it from
//   `destroy()`. The listener is held as a method-reference field so add and
//   remove target the exact same function — anonymous lambdas would silently
//   leak across remount/unmount.
// - On a bfcache restore the redirect marker in sessionStorage is also cleared
//   so a subsequent redirect starts clean.
export function createOrcidRedirectGuard(flagName = 'orcidLoading') {
  return {
    _orcidRedirectGuardHandler: null,

    _installOrcidRedirectGuard() {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
      // Deregister-before-reassign: a re-instantiated component (x-data scope
      // change, route re-mount) without an intervening destroy() would
      // otherwise leak the first instance's closure bound to window.
      if (this._orcidRedirectGuardHandler && typeof window.removeEventListener === 'function') {
        window.removeEventListener('pageshow', this._orcidRedirectGuardHandler);
        this._orcidRedirectGuardHandler = null;
      }
      this._orcidRedirectGuardHandler = (event) => {
        // Only bfcache restores carry persisted === true. A normal load (where
        // init() already ran) leaves the flag at its default false.
        if (!event || !event.persisted) return;
        this[flagName] = false;
        if (typeof sessionStorage !== 'undefined') {
          try {
            sessionStorage.removeItem('pevo_orcid_mode');
          } catch { /* sessionStorage may be unavailable; flag reset is enough */ }
        }
      };
      window.addEventListener('pageshow', this._orcidRedirectGuardHandler);
    },

    _teardownOrcidRedirectGuard() {
      if (
        this._orcidRedirectGuardHandler &&
        typeof window !== 'undefined' &&
        typeof window.removeEventListener === 'function'
      ) {
        window.removeEventListener('pageshow', this._orcidRedirectGuardHandler);
        this._orcidRedirectGuardHandler = null;
      }
    },
  };
}

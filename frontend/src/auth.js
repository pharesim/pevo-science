import Alpine from 'alpinejs';
import { waitForKeychain } from './keychain.js';
import { fetchAccreditationStatus } from './api.js';
import { signRequest } from './sign-request.js';

const SESSION_KEY = 'pevo_session';

export function initAuth() {
  Alpine.store('auth', {
    username: null,
    isConnected: false,
    isKeychainInstalled: false,
    isLoading: true,
    isAccredited: false,
    accreditation: null,
    token: null,
    expiresAt: null,
    custody: null,

    _accreditationInterval: null,
    // Monotonically increasing; bumped on every _startAccreditationPolling()
    // call. An in-flight _checkAccreditation fetch captures the generation
    // it started in; if the value advances before the fetch resolves, the
    // continuation discards its result rather than clobbering whatever the
    // newer polling loop has since written to the store. _stopAccreditationPolling
    // cancels the setInterval but cannot abort an in-flight fetch, so a
    // rapid disconnect→login (or storage-event re-login as a different
    // user) without this guard lets the prior user's accreditation overwrite
    // the new user's session.
    _pollingGeneration: 0,

    init() {
      this._restoreSession();
      this.isLoading = false;

      waitForKeychain(3000).then((installed) => {
        this.isKeychainInstalled = installed;
      });

      this._startAccreditationPolling();

      // Sync login/logout across tabs
      this._boundStorageHandler = (e) => this._handleStorageEvent(e);
      window.addEventListener('storage', this._boundStorageHandler);

      // Clean up on page unload
      window.addEventListener('beforeunload', () => {
        this._stopAccreditationPolling();
        window.removeEventListener('storage', this._boundStorageHandler);
      });
    },

    async connect() {
      // Open sign-in modal — may resolve with username (Keychain path) or null (email path or cancel)
      const el = document.querySelector('[x-data="signInModal"]');
      const modal = el && Alpine.$data(el);
      if (!modal) throw new Error('Sign-in modal not found');
      const inputUsername = await modal.prompt();
      if (!inputUsername) return;

      const accreditationPromise = fetchAccreditationStatus(inputUsername).catch(() => null);

      const signed = await signRequest(inputUsername, 'POST', '/api/auth/session', {});
      const res = await fetch('/api/auth/session', {
        method: 'POST',
        headers: {
          ...signed.headers,
          'Content-Type': 'application/json',
        },
        body: signed.body,
      });

      if (res.ok) {
        const body = await res.json();
        const accRes = await accreditationPromise;
        this.loginFromResponse({
          token: body.data.token,
          expires_at: body.data.expires_at,
          username: inputUsername,
          custody: body.data.custody ?? 'self',
          is_accredited: accRes?.data?.is_accredited ?? false,
          accreditation: accRes?.data?.accreditation ?? null,
        });
      } else {
        throw new Error('Authentication failed');
      }
    },

    // Set auth state from a login/session/upgrade API response. Used by
    // every login-style call site (login, orcid callback, signup-verify
    // create + link, sign-in modal connect) and by the custody-upgrade
    // flow in settings.js.
    //
    // Field semantics:
    //
    // - `token` + `expires_at` rotate as an atomic pair. Both must be
    //   truthy for either to land on the store. The decoupled-guard form
    //   the upgrade flow used to ship allowed `{token: new, expires_at:
    //   undefined}` to persist a fresh token with stale expiry (UI thinks
    //   logged in, first API call returns 401) and the symmetric
    //   `{token: undefined, expires_at: new}` to wipe the live token.
    //   Atomic-pair enforcement closes both halves.
    //
    // - `username`, `is_accredited`, `accreditation` are preserve-on-
    //   undefined: the upgrade response carries only `{token, expires_at,
    //   custody}` and must not clobber the user's accreditation or
    //   username. Callers whose response shape omits `is_accredited` or
    //   `accreditation` (e.g., the bare password-login responses at
    //   `sign-in-modal.js#handleEmailLogin` and `signup.js#_resolveExistingAccount`)
    //   MUST pass explicit `false` / `null` overrides via spread, e.g.:
    //
    //     auth.loginFromResponse({ ...res.data, is_accredited: false, accreditation: null });
    //
    //   Otherwise the preserve-on-undefined branch keeps whatever the
    //   prior session wrote, leaking user-A's accreditation badge into
    //   user-B's session on cross-user re-login.
    //
    // - `custody` is preserve-on-undefined for the same reason: callers
    //   pass an explicit custody (login → 'light', upgrade → 'self',
    //   etc.); omitting it preserves the existing value.
    loginFromResponse(data) {
      if (data.token && data.expires_at) {
        this.token = data.token;
        this.expiresAt = data.expires_at;
      }
      if (data.username !== undefined) this.username = data.username;
      if (data.is_accredited !== undefined) this.isAccredited = data.is_accredited;
      if (data.accreditation !== undefined) this.accreditation = data.accreditation;
      if (data.custody !== undefined) this.custody = data.custody;
      this.isConnected = true;
      this._saveSession();
      this._startAccreditationPolling();
    },

    disconnect() {
      this.username = null;
      this.isConnected = false;
      this.isAccredited = false;
      this.accreditation = null;
      this.token = null;
      this.expiresAt = null;
      this.custody = null;
      this._stopAccreditationPolling();
      localStorage.removeItem(SESSION_KEY);
    },

    getSessionToken() {
      return this.token;
    },

    _restoreSession() {
      const saved = localStorage.getItem(SESSION_KEY);
      if (!saved) return;
      const { token, username, expiresAt, isAccredited, accreditation, custody } = JSON.parse(saved);
      if (token && username && new Date(expiresAt) > new Date()) {
        this.token = token;
        this.username = username;
        this.isConnected = true;
        this.isAccredited = isAccredited ?? false;
        this.accreditation = accreditation ?? null;
        this.custody = custody ?? 'self';
        this.expiresAt = expiresAt;
        return;
      }
      localStorage.removeItem(SESSION_KEY);
    },

    _handleStorageEvent(e) {
      if (e.key !== SESSION_KEY) return;
      if (e.newValue) {
        this._restoreSession();
        this._startAccreditationPolling();
      } else {
        this.disconnect();
      }
    },

    _saveSession() {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        token: this.token, 
        username: this.username, 
        expiresAt: this.expiresAt, 
        isAccredited: this.isAccredited,
        accreditation: this.accreditation, 
        custody: this.custody,
      }));
    },

    async _checkAccreditation(gen) {
      // Skip if the session isn't fully connected yet. Prevents requests to
      // /api/accreditations/null during page teardown or before a login has
      // populated the store.
      if (!this.username || !this.isConnected) return;
      try {
        const accRes = await fetchAccreditationStatus(this.username);
        // Stale-fetch guard: a newer _startAccreditationPolling() has bumped
        // _pollingGeneration. The polling loop that owned this gen is gone;
        // its in-flight result must not clobber whatever the new loop has
        // written to the store. Every call site passes the current
        // generation (polling loop, settings ORCID-return init,
        // orcid-callback _handleAccredit).
        if (gen !== this._pollingGeneration) return;
        // disconnect() may have run while the fetch was in flight; drop the
        // stale result rather than re-persisting a cleared session.
        if (!this.username || !this.isConnected) return;
        if (accRes?.data) {
          this.isAccredited = accRes.data.is_accredited;
          this.accreditation = accRes.data.accreditation;
          this._saveSession();
        }
      } catch (err) {
        console.warn('[auth] accreditation check failed:', err);
      }
    },

    _startAccreditationPolling() {
      this._stopAccreditationPolling();
      const myGen = ++this._pollingGeneration;
      this._checkAccreditation(myGen);
      this._accreditationInterval = setInterval(() => {
        if (!this.username || this.isAccredited) {
          this._stopAccreditationPolling();
          return;
        }
        this._checkAccreditation(myGen);
      }, 60000);
    },

    _stopAccreditationPolling() {
      if (this._accreditationInterval) {
        clearInterval(this._accreditationInterval);
        this._accreditationInterval = null;
      }
    },
  });
}

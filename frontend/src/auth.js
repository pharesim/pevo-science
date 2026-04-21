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
        this.token = body.data.token;
        this.expiresAt = body.data.expires_at;
        this.username = inputUsername;
        this.isConnected = true;
        this.custody = body.data.custody ?? 'self';

        const accRes = await accreditationPromise;
        if (accRes?.data) {
          this.isAccredited = accRes.data.is_accredited;
          this.accreditation = accRes.data.accreditation;
        } else {
          this.isAccredited = false;
          this.accreditation = null;
        }

        this._saveSession();
        this._startAccreditationPolling();
      } else {
        throw new Error('Authentication failed');
      }
    },

    // Set auth state from a login/session API response (used by sign-in modal email path)
    loginFromResponse(data) {
      this.token = data.token;
      this.username = data.username;
      this.isConnected = true;
      this.expiresAt = data.expires_at;
      this.isAccredited = data.is_accredited ?? false;
      this.accreditation = data.accreditation ?? null;
      this.custody = data.custody ?? 'self';
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

    async _checkAccreditation() {
      // Guard: skip if the session isn't fully connected yet. Prevents
      // requests to /api/accreditations/null during page teardown or before
      // a login has populated the store, and avoids unhandled rejections
      // that can bleed into the next Playwright test.
      if (!this.username || !this.isConnected) return;
      try {
        const accRes = await fetchAccreditationStatus(this.username);
        // disconnect() may have run while the fetch was in flight; drop the
        // stale result rather than re-persisting a cleared session.
        if (!this.username || !this.isConnected) return;
        if (accRes?.data) {
          this.isAccredited = accRes.data.is_accredited;
          this.accreditation = accRes.data.accreditation;
          this._saveSession();
        }
      } catch (err) {
        // Log but do not reject. Polling continues; the next tick retries.
        console.warn('[auth] accreditation check failed:', err);
      }
    },

    _startAccreditationPolling() {
      this._stopAccreditationPolling();
      this._checkAccreditation();
      this._accreditationInterval = setInterval(() => {
        if (!this.username || this.isAccredited) {
          this._stopAccreditationPolling();
          return;
        }
        this._checkAccreditation();
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

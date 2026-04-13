import Alpine from 'alpinejs';
import { isKeychainInstalled, waitForKeychain, signMessage } from './keychain.js';
import { fetchAccreditationStatus } from './api.js';

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

    // Internal: accreditation polling interval
    _accreditationInterval: null,

    init() {
      // Restore session from localStorage
      try {
        const saved = sessionStorage.getItem(SESSION_KEY);
        if (saved) {
          const { token, username, expiresAt, isAccredited, accreditation } = JSON.parse(saved);
          if (token && username && new Date(expiresAt) > new Date()) {
            this.token = token;
            this.username = username;
            this.isConnected = true;
            this.isAccredited = isAccredited ?? false;
            this.accreditation = accreditation ?? null;
          } else {
            sessionStorage.removeItem(SESSION_KEY);
          }
        }
      } catch {
        sessionStorage.removeItem(SESSION_KEY);
      }
      this.isLoading = false;

      // Detect Keychain in background
      waitForKeychain(3000).then((installed) => {
        this.isKeychainInstalled = installed;
      });

      // Start accreditation polling if connected but not yet accredited
      this._startAccreditationPolling();

      // Clean up polling on page unload
      window.addEventListener('beforeunload', () => this._stopAccreditationPolling());
    },

    async connect() {
      if (!isKeychainInstalled()) {
        throw new Error('Hive Keychain is not installed');
      }

      // Prompt for username via modal
      const el = document.querySelector('[x-data="usernameModal"]');
      const modal = el && Alpine.$data(el);
      if (!modal) throw new Error('Username modal not found');
      const inputUsername = await modal.prompt();
      if (!inputUsername) return;

      // Verify account ownership with a random challenge
      const challenge = `pevo-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const { signature } = await signMessage(inputUsername, challenge);

      // Exchange signature for session JWT
      const timestamp = new Date().toISOString();
      const res = await fetch('/api/auth/session', {
        method: 'POST',
        headers: {
          'X-Hive-Username': inputUsername,
          'X-Hive-Signature': signature,
          'X-Hive-Message': challenge,
          'X-Hive-Timestamp': timestamp,
        },
      });

      if (res.ok) {
        const body = await res.json();
        this.token = body.data.token;
        this.username = inputUsername;
        this.isConnected = true;
        this.isAccredited = false;
        this.accreditation = null;

        this._saveSession(body.data.token, inputUsername, body.data.expires_at, false, null);

        // Fetch accreditation in background
        this._checkAccreditation(inputUsername, body.data.token, body.data.expires_at);
        this._startAccreditationPolling();
      } else {
        throw new Error('Authentication failed');
      }
    },

    disconnect() {
      this.username = null;
      this.isConnected = false;
      this.isAccredited = false;
      this.accreditation = null;
      this.token = null;
      this._stopAccreditationPolling();
      try { sessionStorage.removeItem(SESSION_KEY); } catch { /* noop */ }
    },

    getSessionToken() {
      return this.token;
    },

    _saveSession(token, username, expiresAt, isAccredited, accreditation) {
      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({
          token, username, expiresAt, isAccredited, accreditation,
        }));
      } catch { /* storage full or blocked */ }
    },

    async _checkAccreditation(username, token, expiresAt) {
      try {
        const accRes = await fetchAccreditationStatus(username);
        if (accRes.data) {
          this.isAccredited = accRes.data.is_accredited;
          this.accreditation = accRes.data.accreditation;
          this._saveSession(
            token || this.token,
            username,
            expiresAt || undefined,
            this.isAccredited,
            this.accreditation
          );
        }
      } catch { /* non-critical */ }
    },

    _startAccreditationPolling() {
      this._stopAccreditationPolling();
      if (!this.username || this.isAccredited) return;
      this._accreditationInterval = setInterval(() => {
        if (!this.username || this.isAccredited) {
          this._stopAccreditationPolling();
          return;
        }
        this._checkAccreditation(this.username);
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

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
    custody: null,

    // Internal: accreditation polling interval
    _accreditationInterval: null,

    init() {
      // Restore session from localStorage
      try {
        const saved = sessionStorage.getItem(SESSION_KEY);
        if (saved) {
          const { token, username, expiresAt, isAccredited, accreditation, custody } = JSON.parse(saved);
          if (token && username && new Date(expiresAt) > new Date()) {
            this.token = token;
            this.username = username;
            this.isConnected = true;
            this.isAccredited = isAccredited ?? false;
            this.accreditation = accreditation ?? null;
            this.custody = custody ?? 'self';
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
        this.custody = body.data.custody ?? 'self';

        this._saveSession(body.data.token, inputUsername, body.data.expires_at, false, null, this.custody);

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
      this.custody = null;
      this._stopAccreditationPolling();
      try { sessionStorage.removeItem(SESSION_KEY); } catch { /* noop */ }
    },

    getSessionToken() {
      return this.token;
    },

    _saveSession(token, username, expiresAt, isAccredited, accreditation, custody) {
      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({
          token, username, expiresAt, isAccredited, accreditation,
          custody: custody ?? this.custody ?? 'self',
        }));
      } catch { /* storage full or blocked */ }
    },

    async _checkAccreditation(username, token, expiresAt) {
      try {
        const accRes = await fetchAccreditationStatus(username);
        if (accRes.data) {
          this.isAccredited = accRes.data.is_accredited;
          this.accreditation = accRes.data.accreditation;
          // Preserve existing session expiry if not explicitly provided
          let resolvedExpiry = expiresAt;
          if (!resolvedExpiry) {
            try {
              const saved = sessionStorage.getItem(SESSION_KEY);
              if (saved) resolvedExpiry = JSON.parse(saved).expiresAt;
            } catch { /* ignore */ }
          }
          this._saveSession(
            token || this.token,
            username,
            resolvedExpiry,
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
        this._checkAccreditation(this.username, this.token);
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

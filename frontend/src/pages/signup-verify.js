import Alpine from 'alpinejs';
import { verifyEmail, resumeSignup, confirmAccount, linkExistingAccount, checkUsernameAvailability } from '../api.js';
import { generateMnemonic, validateMnemonic, deriveAllKeys } from '../hive-keys.js';
import { signMessage, isKeychainInstalled } from '../keychain.js';

// Number of words the user must re-enter to confirm retention
const CONFIRM_WORD_COUNT = 3;

// Username format: 3-16 chars, lowercase a-z, 0-9, dots/hyphens not at start/end
const USERNAME_RE = /^[a-z][a-z0-9]*([.-][a-z0-9]+)*$/;
const MIN_USERNAME = 3;
const MAX_USERNAME = 16;

function pickRandomIndices(total, count) {
  const indices = [];
  while (indices.length < count) {
    const i = Math.floor(Math.random() * total);
    if (!indices.includes(i)) indices.push(i);
  }
  return indices.sort((a, b) => a - b);
}

function isValidUsername(u) {
  return u.length >= MIN_USERNAME && u.length <= MAX_USERNAME && USERNAME_RE.test(u);
}

export function initSignupVerifyPage() {
  Alpine.data('signupVerifyPage', () => ({
    // Phases: 'verifying' | 'choose' | 'create-seed' | 'create-confirm' | 'create-username' | 'create-submitting' | 'link-keychain' | 'done' | 'error'
    phase: 'verifying',
    error: null,

    // Mnemonic (generated client-side)
    mnemonic: null,
    seedWords: [],

    // Auth token returned by verify/resume — used to authenticate confirm/link
    authToken: null,
    email: '',

    // Create flow: username step
    username: '',
    usernameStatus: null, // null | 'checking' | 'available' | 'taken' | 'error'
    _usernameTimer: null,
    isSubmitting: false,

    // Link flow: Hive username
    hiveUsername: '',

    // Resume flow (shown on error phase)
    resumeEmail: '',
    resumePassword: '',
    isResuming: false,

    // Confirmation step
    confirmIndices: [],
    confirmInputs: {},

    get usernameFormatValid() {
      return isValidUsername(this.username);
    },

    get confirmCorrect() {
      return this.confirmIndices.every(
        (i) => this.confirmInputs[i]?.trim().toLowerCase() === this.seedWords[i]
      );
    },

    init() {
      const query = Alpine.store('router').query || {};

      // Resuming from login redirect — already have auth_token
      if (query.auth_token && query.email) {
        this.authToken = query.auth_token;
        this.email = query.email;
        this.phase = 'choose';
        return;
      }

      const emailToken = query.token;
      if (!emailToken) {
        this.phase = 'error';
        this.error = this.$t('seedPhrase.invalidLink');
        return;
      }
      this.verifyToken(emailToken);
    },

    async verifyToken(emailToken) {
      try {
        const res = await verifyEmail(emailToken);
        if (res.data.flow === 'choose') {
          this.authToken = res.data.auth_token;
          this.email = res.data.email;
          this.phase = 'choose';
        } else {
          this.phase = 'error';
          this.error = this.$t('seedPhrase.unexpectedResponse');
        }
      } catch (err) {
        this.phase = 'error';
        this.error = err.message;
      }
    },

    // ─── Choose phase ──────────────────────────────────────────

    chooseCreate() {
      this.mnemonic = generateMnemonic();
      this.seedWords = this.mnemonic.split(' ');
      this.phase = 'create-seed';
    },

    chooseLink() {
      this.phase = 'link-keychain';
    },

    // ─── Create flow: seed → confirm → username → submit ──────

    proceedToConfirm() {
      this.confirmIndices = pickRandomIndices(this.seedWords.length, CONFIRM_WORD_COUNT);
      this.confirmInputs = {};
      this.confirmIndices.forEach((i) => { this.confirmInputs[i] = ''; });
      this.phase = 'create-confirm';
    },

    proceedToUsername() {
      if (!this.confirmCorrect) return;
      this.phase = 'create-username';
    },

    watchUsername() {
      this.$watch('username', (val) => {
        clearTimeout(this._usernameTimer);
        if (!val) {
          this.usernameStatus = null;
          return;
        }
        const normalized = val.trim().toLowerCase();
        if (!isValidUsername(normalized)) {
          this.usernameStatus = normalized.length >= MIN_USERNAME ? 'invalid' : null;
          return;
        }
        this.usernameStatus = 'checking';
        this._usernameTimer = setTimeout(() => this._checkUsername(normalized), 400);
      });
    },

    async _checkUsername(val) {
      try {
        const res = await checkUsernameAvailability(val);
        if (this.username.trim().toLowerCase() === val) {
          this.usernameStatus = res.data?.available ? 'available' : 'taken';
        }
      } catch {
        if (this.username.trim().toLowerCase() === val) this.usernameStatus = 'error';
      }
    },

    async submitCreateAccount() {
      const normalizedUsername = this.username.trim().toLowerCase();
      if (!isValidUsername(normalizedUsername) || this.usernameStatus !== 'available' || this.isSubmitting) return;
      if (!this.authToken) {
        this.error = this.$t('seedPhrase.credentialsRequired');
        return;
      }

      this.isSubmitting = true;
      this.error = null;
      this.phase = 'create-submitting';

      try {
        // Derive all keys from mnemonic + username
        const allKeys = await deriveAllKeys(this.mnemonic, normalizedUsername);

        const keys = {
          owner_public: allKeys.owner.public,
          active_public: allKeys.active.public,
          posting_public: allKeys.posting.public,
          memo_public: allKeys.memo.public,
          posting_private: allKeys.posting.private,
          memo_private: allKeys.memo.private,
        };

        const res = await confirmAccount(this.authToken, normalizedUsername, keys);

        // Set auth state
        const auth = Alpine.store('auth');
        auth.token = res.data.token;
        auth.username = res.data.username;
        auth.isConnected = true;
        auth.isAccredited = true;
        auth.accreditation = res.data.accreditation ?? null;
        auth.custody = 'light';

        auth._saveSession(
          res.data.token,
          res.data.username,
          res.data.expires_at,
          true,
          res.data.accreditation ?? null,
          'light'
        );

        this.phase = 'done';
      } catch (err) {
        this.error = err.message;
        this.phase = 'create-username';
      } finally {
        this.isSubmitting = false;
      }
    },

    // ─── Link flow ─────────────────────────────────────────────

    async handleLinkAccount() {
      if (!this.hiveUsername || this.isSubmitting) return;
      if (!this.authToken) {
        this.error = this.$t('seedPhrase.credentialsRequired');
        return;
      }
      if (!isKeychainInstalled()) {
        this.error = this.$t('seedPhrase.keychainRequired');
        return;
      }

      this.isSubmitting = true;
      this.error = null;
      try {
        const username = this.hiveUsername.trim().toLowerCase();
        const message = `${this.email}:link`;
        const { signature } = await signMessage(username, message);
        const res = await linkExistingAccount(this.authToken, this.email, username, signature);

        const auth = Alpine.store('auth');
        auth.token = res.data.token;
        auth.username = res.data.username;
        auth.isConnected = true;
        auth.isAccredited = true;
        auth.accreditation = res.data.accreditation ?? null;
        auth.custody = 'self';

        auth._saveSession(
          res.data.token,
          res.data.username,
          res.data.expires_at,
          true,
          res.data.accreditation ?? null,
          'self'
        );

        this.phase = 'done';
      } catch (err) {
        this.error = err.message;
      } finally {
        this.isSubmitting = false;
      }
    },

    // ─── Resume flow ───────────────────────────────────────────

    async handleResume() {
      if (!this.resumeEmail || !this.resumePassword || this.isResuming) return;
      this.isResuming = true;
      this.error = null;

      try {
        const res = await resumeSignup(this.resumeEmail, this.resumePassword);
        if (res.data.flow === 'choose') {
          this.authToken = res.data.auth_token;
          this.email = res.data.email;
          this.phase = 'choose';
        } else {
          this.error = this.$t('seedPhrase.unexpectedResponse');
        }
      } catch (err) {
        this.error = err.message;
      } finally {
        this.isResuming = false;
      }
    },

    navigate(path) {
      Alpine.store('router').navigate(path);
    },
  }));
}

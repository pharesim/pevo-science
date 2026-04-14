import Alpine from 'alpinejs';
import { verifyEmail, resumeSignup, confirmSeedPhrase, linkExistingAccount } from '../api.js';

// Number of words the user must re-enter to confirm retention
const CONFIRM_WORD_COUNT = 3;

function pickRandomIndices(total, count) {
  const indices = [];
  while (indices.length < count) {
    const i = Math.floor(Math.random() * total);
    if (!indices.includes(i)) indices.push(i);
  }
  return indices.sort((a, b) => a - b);
}

export function initSignupVerifyPage() {
  Alpine.data('signupVerifyPage', () => ({
    // Phases: 'verifying' | 'seed' | 'confirm' | 'link-keychain' | 'creating' | 'done' | 'error'
    phase: 'verifying',
    error: null,

    // From email verification response
    token: null,
    seedPhrase: null,
    seedWords: [],
    isLinkFlow: false,

    // Resume flow (shown on error phase)
    resumeEmail: '',
    resumePassword: '',
    isResuming: false,

    // Confirmation step
    confirmIndices: [],
    confirmInputs: {},
    isConfirming: false,

    get confirmCorrect() {
      return this.confirmIndices.every(
        (i) => this.confirmInputs[i]?.trim().toLowerCase() === this.seedWords[i]
      );
    },

    init() {
      const params = new URLSearchParams(window.location.search);
      const emailToken = params.get('token');
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
        this.token = res.data.challenge || res.data.token;

        if (res.data.flow === 'link') {
          // LA24 link-existing flow: no seed phrase, redirect to Keychain signing
          this.isLinkFlow = true;
          this.phase = 'link-keychain';
          return;
        }

        // Normal flow: backend returns the seed phrase
        this.seedPhrase = res.data.seed_phrase;
        this.seedWords = this.seedPhrase.split(' ');
        this.phase = 'seed';
      } catch (err) {
        this.phase = 'error';
        this.error = err.message;
      }
    },

    proceedToConfirm() {
      this.confirmIndices = pickRandomIndices(this.seedWords.length, CONFIRM_WORD_COUNT);
      this.confirmInputs = {};
      this.confirmIndices.forEach((i) => { this.confirmInputs[i] = ''; });
      this.phase = 'confirm';
    },

    async submitConfirmation() {
      if (!this.confirmCorrect || this.isConfirming) return;
      this.isConfirming = true;
      this.error = null;

      try {
        // Send the confirmed words back to the backend
        const words = this.confirmIndices.map((i) => ({
          index: i,
          word: this.confirmInputs[i].trim().toLowerCase(),
        }));
        const res = await confirmSeedPhrase(this.token, words);

        // Backend creates the account and returns a session
        const auth = Alpine.store('auth');
        auth.token = res.data.token;
        auth.username = res.data.username;
        auth.isConnected = true;
        auth.isAccredited = true;
        auth.accreditation = res.data.accreditation ?? null;
        auth.custody = 'light';

        // Save session
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
        this.isConfirming = false;
      }
    },

    async handleLinkAccount() {
      // LA24: will trigger Keychain signature flow
      this.isConfirming = true;
      this.error = null;
      try {
        const res = await linkExistingAccount(this.token);
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
        this.isConfirming = false;
      }
    },

    async handleResume() {
      if (!this.resumeEmail || !this.resumePassword || this.isResuming) return;
      this.isResuming = true;
      this.error = null;

      try {
        const res = await resumeSignup(this.resumeEmail, this.resumePassword);
        this.token = res.data.challenge || res.data.token;

        if (res.data.flow === 'link') {
          this.isLinkFlow = true;
          this.phase = 'link-keychain';
          return;
        }

        this.seedPhrase = res.data.seed_phrase;
        this.seedWords = this.seedPhrase.split(' ');
        this.phase = 'seed';
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

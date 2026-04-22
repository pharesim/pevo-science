import Alpine from 'alpinejs';
import { loginWithPassword, resendVerification } from '../api.js';
import { createTimerGuard } from '../lib/timer-guard.js';

export function initSignInModal() {
  Alpine.data('signInModal', () => ({
    ...createTimerGuard(),
    open: false,
    mode: 'choose', // 'choose', 'email', 'keychain', 'unverified'
    // Keychain fields
    value: '',
    error: null,
    _resolve: null,
    // Email fields
    emailValue: '',
    passwordValue: '',
    emailError: null,
    emailLoading: false,
    // Resend verification
    isResending: false,
    resendSuccess: false,

    /**
     * Open the modal in chooser mode.
     * For Keychain path: returns a Promise that resolves with
     * the entered username or null if cancelled.
     */
    prompt() {
      return new Promise((resolve) => {
        this.value = '';
        this.error = null;
        this.emailValue = '';
        this.passwordValue = '';
        this.emailError = null;
        this.emailLoading = false;
        this.isResending = false;
        this.resendSuccess = false;
        this.mode = 'choose';
        this._resolve = resolve;
        this.open = true;
      });
    },

    // Keychain: confirm username
    confirm() {
      const trimmed = this.value.trim().toLowerCase();
      if (!trimmed) {
        this.error = this.$t('signIn.usernameEmpty');
        return;
      }
      this.open = false;
      if (this._resolve) {
        this._resolve(trimmed);
        this._resolve = null;
      }
    },

    cancel() {
      this.open = false;
      this.mode = 'choose';
      if (this._resolve) {
        this._resolve(null);
        this._resolve = null;
      }
    },

    // Email login
    async handleEmailLogin() {
      if (!this.emailValue.trim() || !this.passwordValue) {
        this.emailError = this.$t('signIn.fillAllFields');
        return;
      }
      this.emailLoading = true;
      this.emailError = null;
      try {
        const res = await loginWithPassword(this.emailValue.trim(), this.passwordValue);
        if (!this._mounted) return;
        const auth = Alpine.store('auth');
        auth.loginFromResponse(res.data);
        this.open = false;
        this.mode = 'choose';
        // Resolve the prompt promise with null so the Keychain connect() path doesn't proceed
        if (this._resolve) {
          this._resolve(null);
          this._resolve = null;
        }
      } catch (err) {
        if (!this._mounted) return;
        if (err.code === 'PENDING_SIGNUP' && err.data) {
          this.open = false;
          this.mode = 'choose';
          if (this._resolve) {
            this._resolve(null);
            this._resolve = null;
          }
          const params = new URLSearchParams({
            auth_token: err.data.auth_token,
            email: err.data.email,
          });
          Alpine.store('router').navigate(`/signup/verify?${params}`);
          return;
        }
        if (err.code === 'PENDING_UNVERIFIED') {
          this.mode = 'unverified';
          return;
        }
        // Sanitization pattern (shared with executeUpgrade()): generic
        // localized message to the DOM, raw err to console.warn for
        // diagnostics. Prevents accidental disclosure of key material,
        // tokens, or PII embedded in a backend error string.
        console.warn('[sign in email login]', err);
        this.emailError = this.$t('signIn.loginFailed');
      } finally {
        if (this._mounted) this.emailLoading = false;
      }
    },

    async handleResendVerification() {
      if (this.isResending) return;
      this.isResending = true;
      try {
        await resendVerification(this.emailValue.trim(), this.passwordValue);
        if (!this._mounted) return;
        this.resendSuccess = true;
      } catch (err) {
        if (!this._mounted) return;
        // Sanitization pattern (see handleEmailLogin).
        console.warn('[sign in resend verification]', err);
        this.emailError = this.$t('signIn.resendFailed');
      } finally {
        if (this._mounted) this.isResending = false;
      }
    },

    destroy() {
      // _teardownTimers flips _mounted so in-flight loginWithPassword /
      // resendVerification continuations bail before touching reactive state.
      this._teardownTimers();
    },

    handleKeydown(e) {
      if (e.key === 'Escape') this.cancel();
    },

    handleBackdropClick(e) {
      if (e.target === e.currentTarget) this.cancel();
    },
  }));
}

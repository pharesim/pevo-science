import Alpine from 'alpinejs';
import { loginWithPassword, resendVerification } from '../api.js';
import { createTimerGuard } from '../lib/timer-guard.js';
import { RESUME_MARKER } from '../pages/signup-verify.js';

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
        // Explicit overrides: the password-login response carries
        // {token, expires_at, username, custody} but NOT is_accredited /
        // accreditation. The helper preserves-on-undefined, so without
        // these overrides a cross-user re-login on a shared device leaks
        // user-A's accreditation badge / publish-write affordances into
        // user-B's session until the polling round-trip arrives.
        auth.loginFromResponse({ ...res.data, is_accredited: false, accreditation: null });
        this.open = false;
        this.mode = 'choose';
        // Resolve the prompt promise with null so the Keychain connect() path doesn't proceed
        if (this._resolve) {
          this._resolve(null);
          this._resolve = null;
        }
      } catch (err) {
        if (!this._mounted) return;
        if (err.code === 'PENDING_SIGNUP') {
          this.open = false;
          this.mode = 'choose';
          if (this._resolve) {
            this._resolve(null);
            this._resolve = null;
          }
          // The login 409 no longer carries an auth_token. Route to the resume
          // step where /resume-signup re-verifies the password, mints the
          // binding cookie, and returns a fresh auth_token in its response
          // body. Pass only a resume marker and the email hint in the URL.
          const params = new URLSearchParams({ resume: RESUME_MARKER });
          if (err.data?.email) params.set('email', err.data.email);
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

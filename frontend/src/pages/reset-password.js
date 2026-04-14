import Alpine from 'alpinejs';
import { requestPasswordReset, resetPassword } from '../api.js';

const MIN_PASSWORD = 10;

export function initResetPasswordPage() {
  Alpine.data('resetPasswordPage', () => ({
    // Mode: 'request' (enter email) or 'reset' (enter new password)
    mode: 'request',
    token: null,

    // Request form
    email: '',
    requestSubmitting: false,
    requestSent: false,
    requestError: null,

    // Reset form
    password: '',
    passwordConfirm: '',
    resetSubmitting: false,
    resetDone: false,
    resetError: null,

    get passwordValid() { return this.password.length >= MIN_PASSWORD && /[a-z]/.test(this.password) && /[A-Z]/.test(this.password) && /[0-9]/.test(this.password); },
    get passwordsMatch() { return this.password === this.passwordConfirm; },
    get canReset() { return this.passwordValid && this.passwordsMatch; },

    init() {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      if (token) {
        this.token = token;
        this.mode = 'reset';
      }
    },

    async handleRequestReset() {
      if (!this.email.trim() || this.requestSubmitting) return;
      this.requestSubmitting = true;
      this.requestError = null;

      try {
        await requestPasswordReset(this.email.trim());
        this.requestSent = true;
      } catch (err) {
        this.requestError = err.message;
      } finally {
        this.requestSubmitting = false;
      }
    },

    async handleReset() {
      if (!this.canReset || this.resetSubmitting) return;
      this.resetSubmitting = true;
      this.resetError = null;

      try {
        await resetPassword(this.token, this.password);
        this.resetDone = true;
      } catch (err) {
        this.resetError = err.message;
      } finally {
        this.resetSubmitting = false;
      }
    },

    navigate(path) {
      Alpine.store('router').navigate(path);
    },
  }));
}

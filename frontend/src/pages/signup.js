import Alpine from 'alpinejs';
import { submitSignup, loginWithPassword, resendVerification } from '../api.js';

const MIN_PASSWORD = 10;

export function initSignupPage() {
  Alpine.data('signupPage', () => ({
    email: '',
    fullName: '',
    institution: '',
    field: '',
    orcid: '',
    password: '',
    passwordConfirm: '',

    isSubmitting: false,
    submitted: false,
    error: null,
    isResending: false,
    resendSuccess: false,

    get isConnected() { return Alpine.store('auth').isConnected; },

    get passwordValid() {
      return this.password.length >= MIN_PASSWORD
        && /[a-z]/.test(this.password)
        && /[A-Z]/.test(this.password)
        && /[0-9]/.test(this.password);
    },

    get passwordsMatch() {
      return this.password === this.passwordConfirm;
    },

    get canSubmit() {
      return this.email && this.fullName && this.institution && this.field && this.passwordValid && this.passwordsMatch;
    },

    async handleSubmit() {
      if (!this.canSubmit || this.isSubmitting) return;
      this.isSubmitting = true;
      this.error = null;

      try {
        await submitSignup({
          email: this.email.trim(),
          password: this.password,
          full_name: this.fullName.trim(),
          institution: this.institution.trim(),
          field: this.field.trim(),
          orcid: this.orcid.trim() || undefined,
        });
        this.submitted = true;
      } catch (err) {
        if (err.code === 'DUPLICATE' && this.email && this.password) {
          await this._resolveExistingAccount();
        } else {
          this.error = err.message;
        }
      } finally {
        this.isSubmitting = false;
      }
    },

    async _resolveExistingAccount() {
      try {
        const res = await loginWithPassword(this.email.trim(), this.password);
        const auth = Alpine.store('auth');
        auth.loginFromResponse(res.data);
        Alpine.store('router').navigate('/papers');
      } catch (loginErr) {
        if (loginErr.code === 'PENDING_SIGNUP' && loginErr.data) {
          const params = new URLSearchParams({
            auth_token: loginErr.data.auth_token,
            email: loginErr.data.email,
          });
          Alpine.store('router').navigate(`/signup/verify?${params}`);
        } else {
          Alpine.store('router').navigate('/login');
        }
      }
    },

    async handleResendVerification() {
      if (this.isResending) return;
      this.isResending = true;
      try {
        await resendVerification(this.email.trim(), this.password);
        this.resendSuccess = true;
      } catch (err) {
        this.error = err.message;
      } finally {
        this.isResending = false;
      }
    },

    navigate(path) {
      Alpine.store('router').navigate(path);
    },
  }));
}

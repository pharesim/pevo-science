import Alpine from 'alpinejs';
import { submitSignup } from '../api.js';

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
        this.error = err.message;
      } finally {
        this.isSubmitting = false;
      }
    },

    navigate(path) {
      Alpine.store('router').navigate(path);
    },
  }));
}

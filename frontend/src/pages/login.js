import Alpine from 'alpinejs';
import { loginWithPassword } from '../api.js';

export function initLoginPage() {
  Alpine.data('loginPage', () => ({
    emailOrUsername: '',
    password: '',
    isSubmitting: false,
    error: null,

    get isConnected() { return Alpine.store('auth').isConnected; },

    get canSubmit() {
      return this.emailOrUsername.trim() && this.password;
    },

    async handleSubmit() {
      if (!this.canSubmit || this.isSubmitting) return;
      this.isSubmitting = true;
      this.error = null;

      try {
        const res = await loginWithPassword(
          this.emailOrUsername.trim(),
          this.password
        );

        const auth = Alpine.store('auth');
        auth.token = res.data.token;
        auth.username = res.data.username;
        auth.isConnected = true;
        auth.isAccredited = res.data.is_accredited ?? false;
        auth.accreditation = res.data.accreditation ?? null;
        auth.custody = res.data.custody ?? 'light';

        auth._saveSession(
          res.data.token,
          res.data.username,
          res.data.expires_at,
          auth.isAccredited,
          auth.accreditation,
          auth.custody
        );

        Alpine.store('router').navigate('/papers');
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

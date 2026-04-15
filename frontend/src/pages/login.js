import Alpine from 'alpinejs';
import { loginWithPassword, resendVerification } from '../api.js';

export function initLoginPage() {
  Alpine.data('loginPage', () => ({
    emailOrUsername: '',
    password: '',
    isSubmitting: false,
    error: null,

    // Pending signup states detected by login
    pendingState: null, // null | 'unverified' | 'expired'
    isResending: false,
    resendSuccess: false,

    init() {
      const query = Alpine.store('router').query || {};
      if (query.pending === 'unverified') {
        this.pendingState = 'unverified';
        this.error = this.$t('login.pendingUnverified');
      }
    },

    get isConnected() { return Alpine.store('auth').isConnected; },

    get canSubmit() {
      return this.emailOrUsername.trim() && this.password;
    },

    async handleSubmit() {
      if (!this.canSubmit || this.isSubmitting) return;
      this.isSubmitting = true;
      this.error = null;
      this.pendingState = null;
      this.resendSuccess = false;

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
        if (err.code === 'PENDING_SIGNUP' && err.data) {
          // Verified but incomplete — redirect to choose phase with auth_token
          const params = new URLSearchParams({
            auth_token: err.data.auth_token,
            email: err.data.email,
          });
          Alpine.store('router').navigate(`/signup/verify?${params}`);
          return;
        }
        if (err.code === 'PENDING_UNVERIFIED') {
          this.pendingState = 'unverified';
          this.error = err.message;
          return;
        }
        if (err.code === 'SIGNUP_EXPIRED') {
          this.pendingState = 'expired';
          this.error = err.message;
          return;
        }
        this.error = err.message;
      } finally {
        this.isSubmitting = false;
      }
    },

    async handleResendVerification() {
      if (this.isResending) return;
      this.isResending = true;
      try {
        await resendVerification(this.emailOrUsername.trim(), this.password);
        this.resendSuccess = true;
        this.error = null;
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

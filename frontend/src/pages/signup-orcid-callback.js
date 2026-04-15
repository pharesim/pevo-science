import Alpine from 'alpinejs';
import { completeSignupOrcid } from '../api.js';

export function initSignupOrcidCallbackPage() {
  Alpine.data('signupOrcidCallbackPage', () => ({
    status: 'verifying', // verifying | success | error
    errorMessage: '',

    navigate(path) { Alpine.store('router').navigate(path); },

    init() {
      const code = Alpine.store('router').query.code;
      const state = Alpine.store('router').query.state;

      if (!code || typeof code !== 'string' || code.length > 100 ||
          !state || typeof state !== 'string' || state.length > 256) {
        this.status = 'error';
        this.errorMessage = this.$t('signup.orcidMissingParams');
        return;
      }

      this._verify(code, state);
    },

    async _verify(code, state) {
      try {
        const res = await completeSignupOrcid(code, state);
        localStorage.setItem('pevo_signup_orcid_token', res.data.orcid_token);
        localStorage.setItem('pevo_signup_orcid_id', res.data.orcid_id);
        this.status = 'success';
        // Redirect back to signup form
        this.navigate('/signup');
      } catch (err) {
        this.status = 'error';
        if (err.code === 'VALIDATION_ERROR') {
          this.errorMessage = this.$t('signup.orcidInsufficientWorks');
        } else {
          this.errorMessage = err.message || this.$t('signup.orcidVerificationFailed');
        }
      }
    },
  }));
}

import Alpine from 'alpinejs';
import { completeSignupOrcid } from '../api.js';

const template = `
      <div x-data="signupOrcidCallbackPage" class="container-narrow py-8">
        <div class="max-w-md mx-auto text-center py-16">
          <!-- Verifying -->
          <div x-show="status === 'verifying'">
            <div class="animate-pulse text-ink-muted mb-4">
              <svg class="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </div>
            <p class="text-ink-muted" x-text="$t('signup.orcidVerifying')"></p>
          </div>
          <!-- Error -->
          <div x-show="status === 'error'">
            <div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <p class="text-red-700 text-sm" x-text="errorMessage"></p>
            </div>
            <a :href="$lp('/signup')" @click.prevent="navigate('/signup')" class="btn-secondary inline-block no-underline" x-text="$t('signup.backToSignup')"></a>
          </div>
        </div>
      </div>
`;

export { template as signupOrcidCallbackPageTemplate };

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

import Alpine from 'alpinejs';
import { completeOrcidVerification } from '../api.js';

const template = `
      <div x-data="accreditationOrcidCallbackPage" class="container-narrow py-8">
        <h1 class="text-3xl font-bold text-ink mb-4" x-text="$t('orcid.callbackTitle')"></h1>

        <template x-if="!isConnected">
          <div class="card">
            <p class="text-ink-muted mb-4" x-text="$t('orcid.connectToComplete')"></p>
            <button class="btn-primary" @click="Alpine.store('auth').connect()" x-text="$t('signIn.signInButton')"></button>
          </div>
        </template>

        <template x-if="status === 'verifying'">
          <div class="card">
            <p class="text-ink-muted" x-text="$t('orcid.verifyingOrcid')"></p>
          </div>
        </template>

        <template x-if="status === 'success'">
          <div class="card bg-pevo-green-light border border-pevo-green/30">
            <p class="text-sm font-medium text-pevo-green-dark mb-2" x-text="$t('orcid.verificationSuccess')"></p>
            <template x-if="orcidId">
              <p class="text-sm text-ink-muted"><span x-text="$t('orcid.orcidId')"></span>: <span x-text="orcidId"></span></p>
            </template>
            <a :href="$lp('/profile/' + username)" @click.prevent="navigate('/profile/' + username)" class="btn-primary inline-block mt-4 no-underline" x-text="$t('orcid.viewProfile')"></a>
          </div>
        </template>

        <template x-if="status === 'error'">
          <div class="card bg-pevo-crimson-light border border-pevo-crimson/30">
            <p class="text-sm font-medium text-pevo-crimson-dark mb-2" x-text="errorMessage"></p>
            <a :href="$lp('/accreditation')" @click.prevent="navigate('/accreditation')" class="btn-secondary inline-block mt-4 no-underline" x-text="$t('common.tryAgain')"></a>
          </div>
        </template>
      </div>
`;

export { template as accreditationOrcidCallbackPageTemplate };

export function initAccreditationOrcidCallbackPage() {
  Alpine.data('accreditationOrcidCallbackPage', () => ({
    status: 'pending', // pending | verifying | success | error
    errorMessage: '',
    orcidId: '',

    navigate(path) { Alpine.store('router').navigate(path); },
    get isConnected() { return Alpine.store('auth').isConnected; },
    get username() { return Alpine.store('auth').username; },

    init() {
      const code = Alpine.store('router').query.code;
      const state = Alpine.store('router').query.state;

      if (!code || typeof code !== 'string' || code.length > 100 ||
          !state || typeof state !== 'string' || state.length > 256) {
        this.status = 'error';
        this.errorMessage = this.$t('orcid.missingParams');
        return;
      }

      // Watch for connection before verifying
      this.$watch('isConnected', (connected) => {
        if (connected && this.status === 'pending') {
          this._verify(code, state);
        }
      });

      // If already connected, verify immediately
      if (this.isConnected && this.username) {
        this._verify(code, state);
      }
    },

    async _verify(code, state) {
      try {
        this.status = 'verifying';
        const res = await completeOrcidVerification(code, state);
        this.orcidId = res.data.orcid;

        // Check if this was a link flow from settings
        const returnTo = localStorage.getItem('pevo_orcid_return_to');
        localStorage.removeItem('pevo_orcid_return_to');
        if (returnTo === 'settings') {
          localStorage.setItem('pevo_orcid_link_complete', '1');
          Alpine.store('router').navigate('/settings');
          return;
        }

        this.status = 'success';
        Alpine.store('toast').show(this.$t('orcid.verificationSuccess'), 'success');
      } catch (err) {
        this.status = 'error';
        this.errorMessage = err.message || this.$t('orcid.verificationFailed');
      }
    },
  }));
}

import Alpine from 'alpinejs';
import { completeOrcidVerification } from '../api.js';

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
        this.status = 'success';
        Alpine.store('toast').show(this.$t('orcid.verificationSuccess'), 'success');
      } catch (err) {
        this.status = 'error';
        this.errorMessage = err.message || this.$t('orcid.verificationFailed');
      }
    },

    async handleConnect() {
      try {
        await Alpine.store('auth').connect();
      } catch { /* handled by watcher */ }
    },
  }));
}

import Alpine from 'alpinejs';
import { requestAccreditation, startOrcidVerification } from '../api.js';

export function initAccreditationPage() {
  Alpine.data('accreditationPage', () => ({
    fullName: '',
    institution: '',
    field: '',
    email: '',
    orcid: '',

    step: 'idle',
    resultMessage: '',
    errorMessage: '',
    orcidLoading: false,

    navigate(path) { Alpine.store('router').navigate(path); },
    get isConnected() { return Alpine.store('auth').isConnected; },
    get username() { return Alpine.store('auth').username; },
    get isSubmitting() { return this.step === 'submitting'; },

    async handleConnect() {
      try {
        await Alpine.store('auth').connect();
      } catch (err) {
        Alpine.store('toast').show(err.message || this.$t('common.connectionFailed'), 'error');
      }
    },

    async handleSubmit() {
      const username = this.username;
      if (!username || !this.isConnected) return;

      this.step = 'submitting';
      this.errorMessage = '';

      try {
        const res = await requestAccreditation({
          full_name: this.fullName,
          institution: this.institution,
          field: this.field,
          email: this.email,
          orcid: this.orcid || '',
        });

        this.step = 'success';
        this.resultMessage = res.data.message;
      } catch (err) {
        this.step = 'error';
        this.errorMessage = err.message || 'Accreditation request failed';
      }
    },

    async handleOrcidVerify() {
      if (!this.username || !this.isConnected) return;
      this.orcidLoading = true;
      this.errorMessage = '';
      try {
        const data = await startOrcidVerification();
        window.location.href = data.redirect_url;
      } catch (err) {
        Alpine.store('toast').show(err.message || 'ORCID verification failed', 'error');
        this.orcidLoading = false;
      }
    },
  }));
}

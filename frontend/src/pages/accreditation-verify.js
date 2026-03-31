import Alpine from 'alpinejs';
import { verifyAccreditation } from '../api.js';

export function initAccreditationVerifyPage() {
  Alpine.data('accreditationVerifyPage', () => ({
    state: 'loading', // loading | success | error
    resultUsername: '',
    errorMessage: '',

    navigate(path) { Alpine.store('router').navigate(path); },

    init() {
      const token = Alpine.store('router').query.token;
      if (!token) {
        this.state = 'error';
        this.errorMessage = this.$t('verify.noToken');
        return;
      }

      verifyAccreditation(token)
        .then((res) => {
          this.state = 'success';
          this.resultUsername = res.data.username;
        })
        .catch((err) => {
          this.state = 'error';
          this.errorMessage = err.message || this.$t('verify.verificationFailed');
        });
    },
  }));
}

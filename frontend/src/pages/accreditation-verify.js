import Alpine from 'alpinejs';
import { verifyAccreditation } from '../api.js';

const template = `
      <div x-data="accreditationVerifyPage" class="container-narrow py-16 text-center">
        <template x-if="state === 'loading'">
          <div>
            <h1 class="text-2xl font-bold text-ink mb-4" x-text="$t('verify.title')"></h1>
            <p class="text-ink-muted" x-text="$t('verify.pleaseWait')"></p>
          </div>
        </template>
        <template x-if="state === 'success'">
          <div>
            <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-pevo-green-light mb-6">
              <svg class="h-8 w-8 text-pevo-green" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" /></svg>
            </div>
            <h1 class="text-2xl font-bold text-ink mb-2" x-text="$t('verify.confirmedTitle')"></h1>
            <p class="text-ink-muted mb-6" x-text="$t('verify.confirmedMessage', { username: '@' + resultUsername })"></p>
            <div class="flex gap-3 justify-center">
              <a :href="$lp('/profile/' + resultUsername)" @click.prevent="navigate('/profile/' + resultUsername)" class="btn-primary no-underline" x-text="$t('verify.viewProfile')"></a>
              <a :href="$lp('/')" @click.prevent="navigate('/')" class="btn-secondary no-underline" x-text="$t('verify.browsePapers')"></a>
            </div>
          </div>
        </template>
        <template x-if="state === 'error'">
          <div>
            <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-pevo-crimson-light mb-6">
              <svg class="h-8 w-8 text-pevo-crimson" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
            </div>
            <h1 class="text-2xl font-bold text-ink mb-2" x-text="$t('verify.failedTitle')"></h1>
            <p class="text-ink-muted mb-6" x-text="errorMessage"></p>
            <a :href="$lp('/accreditation')" @click.prevent="navigate('/accreditation')" class="btn-primary no-underline" x-text="$t('verify.requestNew')"></a>
          </div>
        </template>
      </div>
`;

export { template as accreditationVerifyPageTemplate };

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
          // Sanitization pattern (see executeUpgrade() in settings.js).
          console.warn('[accreditation verify]', err);
          this.errorMessage = this.$t('verify.verificationFailed');
        });
    },
  }));
}

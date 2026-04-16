import Alpine from 'alpinejs';
import { requestAccreditation, startOrcidVerification } from '../api.js';
import { formatDate } from '../components/paper-card.js';

const template = `
      <div x-data="accreditationPage" class="container-narrow py-8">
        <h1 class="text-3xl font-bold text-ink mb-2" x-text="$t('accreditation.title')"></h1>
        <p class="text-ink-muted mb-8" x-text="$t('accreditation.description')"></p>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="card">
            <h2 class="text-section-title text-ink mb-3 font-serif" x-text="$t('accreditation.whyTitle')"></h2>
            <p class="text-sm text-ink-muted leading-relaxed" x-text="$t('accreditation.whyDescription')"></p>
          </div>
          <div class="card">
            <h2 class="text-section-title text-ink mb-3 font-serif" x-text="$t('accreditation.howTitle')"></h2>
            <ol class="text-sm text-ink-muted leading-relaxed space-y-2 list-decimal list-inside">
              <li x-text="$t('accreditation.step1')"></li>
              <li x-text="$t('accreditation.step2')"></li>
              <li x-text="$t('accreditation.step3')"></li>
              <li x-text="$t('accreditation.step4')"></li>
            </ol>
            <div class="mt-4 pt-3 border-t border-parchment-dark">
              <p class="text-sm text-ink-muted leading-relaxed">
                <strong class="text-ink" x-text="$t('accreditation.wotAlternative')"></strong>
                <span x-text="$t('accreditation.wotDescription', { count: 3, profileLink: $t('accreditation.profilePage') })"></span>
              </p>
            </div>
          </div>
        </div>

        <!-- Accredited user: status card -->
        <template x-if="isAccredited">
          <div class="card mt-6">
            <div class="bg-pevo-green-light border border-pevo-green/30 rounded-lg p-4 mb-6">
              <div class="flex items-center gap-2">
                <svg class="h-5 w-5 text-pevo-green-dark shrink-0" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" /></svg>
                <h2 class="text-section-title text-pevo-green-dark font-serif" x-text="$t('accreditation.statusTitle')"></h2>
              </div>
            </div>

            <dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div>
                <dt class="text-ink-muted font-medium" x-text="$t('accreditation.statusName')"></dt>
                <dd class="text-ink" x-text="accreditation.name"></dd>
              </div>
              <div>
                <dt class="text-ink-muted font-medium" x-text="$t('accreditation.statusInstitution')"></dt>
                <dd class="text-ink" x-text="accreditation.institution"></dd>
              </div>
              <div>
                <dt class="text-ink-muted font-medium" x-text="$t('accreditation.statusField')"></dt>
                <dd class="text-ink" x-text="accreditation.field"></dd>
              </div>
              <div>
                <dt class="text-ink-muted font-medium" x-text="$t('accreditation.statusMethod')"></dt>
                <dd class="text-ink" x-text="methodLabel(accreditation.method)"></dd>
              </div>
              <div>
                <dt class="text-ink-muted font-medium" x-text="$t('accreditation.statusSince')"></dt>
                <dd class="text-ink" x-text="formatDate(accreditation.timestamp)"></dd>
              </div>
            </dl>

            <div class="mt-6 pt-4 border-t border-parchment-dark">
              <h3 class="text-sm font-semibold text-ink mb-1" x-text="$t('accreditation.vouchTitle')"></h3>
              <p class="text-sm text-ink-muted mb-3" x-text="$t('accreditation.vouchDescription')"></p>
              <a :href="$lp('/researchers')" @click.prevent="navigate('/researchers')" class="btn-secondary text-sm" x-text="$t('accreditation.browseResearchers')"></a>
            </div>
          </div>
        </template>

        <!-- Not accredited: request form -->
        <template x-if="!isAccredited">
          <div class="card mt-6">
            <h2 class="text-section-title text-ink mb-4 font-serif" x-text="$t('accreditation.requestTitle')"></h2>

            <!-- Not connected -->
            <template x-if="!isConnected">
              <div class="bg-pevo-crimson-light border border-pevo-crimson/30 rounded-lg p-4 mb-6">
                <div class="flex items-start gap-3">
                  <svg class="h-5 w-5 text-pevo-crimson shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" /></svg>
                  <div>
                    <p class="font-medium text-ink text-sm" x-text="$t('signIn.signInToContinue')"></p>
                    <p class="text-xs text-ink-muted mt-1" x-text="$t('accreditation.walletHint')"></p>
                    <button class="btn-primary text-xs mt-2" @click="handleConnect()" x-text="$t('signIn.signInButton')"></button>
                  </div>
                </div>
              </div>
            </template>

            <!-- Success -->
            <template x-if="step === 'success'">
              <div class="bg-pevo-green-light border border-pevo-green/30 rounded-lg p-4 mb-6">
                <p class="text-sm font-medium text-pevo-green-dark" x-text="resultMessage"></p>
                <p class="text-xs text-pevo-green-dark/80 mt-1" x-text="$t('accreditation.checkEmail')"></p>
              </div>
            </template>

            <!-- Error -->
            <template x-if="step === 'error'">
              <div class="bg-pevo-crimson-light border border-pevo-crimson/30 rounded-lg p-4 mb-6">
                <p class="text-sm font-medium text-pevo-crimson-dark" x-text="errorMessage"></p>
                <button class="btn-secondary text-xs mt-2" @click="step = 'idle'" x-text="$t('accreditation.tryAgain')"></button>
              </div>
            </template>

            <form @submit.prevent="handleSubmit()" class="space-y-4">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label for="full-name" class="block text-sm font-medium text-ink mb-1" x-text="$t('accreditation.fullName')"></label>
                  <input id="full-name" type="text" class="select-control" :placeholder="$t('accreditation.namePlaceholder')" x-model="fullName" required />
                </div>
                <div>
                  <label for="institution" class="block text-sm font-medium text-ink mb-1" x-text="$t('accreditation.institution')"></label>
                  <input id="institution" type="text" class="select-control" :placeholder="$t('accreditation.institutionPlaceholder')" x-model="institution" required />
                </div>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label for="field" class="block text-sm font-medium text-ink mb-1" x-text="$t('accreditation.fieldOfResearch')"></label>
                  <input id="field" type="text" class="select-control" :placeholder="$t('accreditation.fieldPlaceholder')" x-model="field" required />
                </div>
                <div>
                  <label for="orcid-input" class="block text-sm font-medium text-ink mb-1" x-text="$t('accreditation.orcidOptional')"></label>
                  <input id="orcid-input" type="text" class="select-control" :placeholder="$t('accreditation.orcidPlaceholder')" x-model="orcid" />
                </div>
              </div>
              <div>
                <label for="email" class="block text-sm font-medium text-ink mb-1" x-text="$t('accreditation.email')"></label>
                <input id="email" type="email" class="select-control" :placeholder="$t('accreditation.emailPlaceholder')" x-model="email" required />
                <p class="text-xs text-ink-muted mt-1" x-text="$t('accreditation.emailHint')"></p>
              </div>
              <div class="pt-2 flex flex-col sm:flex-row gap-3">
                <button type="submit" class="btn-primary" :disabled="!isConnected || isSubmitting || step === 'success'"
                        x-text="!isConnected ? $t('signIn.signInToContinue') : isSubmitting ? $t('accreditation.submittingRequest') : $t('accreditation.submitButton')"></button>
                <span class="text-sm text-ink-muted self-center" x-text="$t('orcid.or')"></span>
                <button type="button" class="btn-secondary flex items-center gap-2" :disabled="!isConnected || orcidLoading || step === 'success'" @click="handleOrcidVerify()">
                  <svg class="h-4 w-4" viewBox="0 0 256 256" fill="none"><path d="M256 128C256 198.692 198.692 256 128 256C57.3076 256 0 198.692 0 128C0 57.3076 57.3076 0 128 0C198.692 0 256 57.3076 256 128Z" fill="#A6CE39"/><path d="M86.3 186.2H70.9V79.1H86.3V186.2ZM78.6 56.1C73.5 56.1 69.4 60.2 69.4 65.3C69.4 70.4 73.5 74.5 78.6 74.5C83.7 74.5 87.8 70.4 87.8 65.3C87.8 60.2 83.7 56.1 78.6 56.1ZM108.5 79.1H150.3C185 79.1 200.5 102.7 200.5 132.6C200.5 165.2 181.5 186.2 150.3 186.2H108.5V79.1ZM124 172.5H148.6C175.2 172.5 184.6 153.3 184.6 132.6C184.6 110.6 173.8 92.8 148.6 92.8H124V172.5Z" fill="white"/></svg>
                  <span x-text="orcidLoading ? $t('orcid.redirecting') : $t('orcid.verifyButton')"></span>
                </button>
              </div>
            </form>

            <p class="text-sm text-ink-muted mt-4">
              <span x-text="$t('accreditation.needHelp')"></span>
              <a :href="$lp('/contact?category=accreditation')" @click.prevent="navigate('/contact?category=accreditation')" class="text-pevo-teal hover:underline" x-text="$t('accreditation.contactUs')"></a>
            </p>
          </div>
        </template>
      </div>
`;

export { template as accreditationPageTemplate };

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
    get isAccredited() { return Alpine.store('auth').isAccredited; },
    get accreditation() { return Alpine.store('auth').accreditation; },
    get isSubmitting() { return this.step === 'submitting'; },

    formatDate,
    methodLabel(method) {
      if (method === 'email') return 'Email verification';
      if (method === 'orcid') return 'ORCID';
      if (method === 'wot') return 'Web of Trust';
      return method || '';
    },

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
        try {
          const target = new URL(data.redirect_url);
          if (!['orcid.org', 'sandbox.orcid.org'].includes(target.hostname)) {
            throw new Error('Unexpected redirect target');
          }
          window.location.href = data.redirect_url;
        } catch {
          throw new Error('Invalid ORCID redirect URL');
        }
      } catch (err) {
        Alpine.store('toast').show(err.message || 'ORCID verification failed', 'error');
        this.orcidLoading = false;
      }
    },
  }));
}

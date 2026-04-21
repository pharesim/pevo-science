import Alpine from 'alpinejs';
import { completeOrcid } from '../api.js';

const template = `
      <div x-data="orcidCallbackPage" class="container-narrow py-8">
        <div class="max-w-md mx-auto text-center py-16">
          <!-- Verifying -->
          <div x-show="status === 'verifying'">
            <div class="animate-pulse text-ink-muted mb-4">
              <svg class="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </div>
            <p class="text-ink-muted" x-text="$t('orcid.verifyingOrcid')"></p>
          </div>

          <!-- Login success (brief, auto-redirects) -->
          <div x-show="status === 'login-success'">
            <div class="text-pevo-green mb-4">
              <svg class="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            </div>
            <p class="text-ink-muted" x-text="$t('orcid.loginSuccess')"></p>
          </div>

          <!-- Accreditation success -->
          <div x-show="status === 'accredit-success'">
            <div class="text-pevo-green mb-4">
              <svg class="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            </div>
            <p class="text-ink font-medium mb-2" x-text="$t('orcid.verificationSuccess')"></p>
            <a :href="$lp('/profile/' + resultUsername)" @click.prevent="navigate('/profile/' + resultUsername)" class="btn-primary inline-block mt-4 no-underline" x-text="$t('orcid.viewProfile')"></a>
          </div>

          <!-- Error -->
          <div x-show="status === 'error'">
            <div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <p class="text-red-700 text-sm" x-text="errorMessage"></p>
            </div>
            <template x-if="errorAction === 'signup'">
              <a :href="$lp('/signup')" @click.prevent="navigate('/signup')" class="btn-primary inline-block no-underline" x-text="$t('common.signUp')"></a>
            </template>
            <template x-if="errorAction !== 'signup'">
              <a :href="$lp(backPath)" @click.prevent="navigate(backPath)" class="btn-secondary inline-block no-underline" x-text="$t('common.tryAgain')"></a>
            </template>
          </div>
        </div>
      </div>
`;

export { template as orcidCallbackPageTemplate };

export function initOrcidCallbackPage() {
  Alpine.data('orcidCallbackPage', () => ({
    status: 'verifying',
    errorMessage: '',
    errorAction: '', // 'signup' for NO_ACCOUNT, else empty
    resultUsername: '',
    backPath: '/',

    navigate(path) { Alpine.store('router').navigate(path); },

    init() {
      const code = Alpine.store('router').query.code;
      const state = Alpine.store('router').query.state;

      if (!code || typeof code !== 'string' || code.length > 100 ||
          !state || typeof state !== 'string' || state.length > 256) {
        this.status = 'error';
        this.errorMessage = this.$t('orcid.missingParams');
        return;
      }

      // Read mode from localStorage (set before redirect) for error routing.
      // Do NOT remove it here — if completeOrcid fails (e.g. 503) and the user
      // refreshes, we need the mode to still be present so the retry can
      // reach the correct endpoint with the correct auth. It's cleared after
      // completeOrcid resolves successfully inside _verify.
      const mode = localStorage.getItem('pevo_orcid_mode') || '';

      if (mode === 'signup' || mode === 'login') {
        this.backPath = mode === 'signup' ? '/signup' : '/login';
      } else if (mode === 'accredit') {
        this.backPath = '/accreditation';
      } else if (mode === 'link') {
        this.backPath = '/settings';
      }

      this._verify(code, state, mode);
    },

    async _verify(code, state, mode) {
      try {
        const res = await completeOrcid(code, state, mode);
        const data = res.data;

        // Only clear the stored mode after completeOrcid resolved successfully.
        // If this throws (e.g. 503), we leave it so a refresh can retry.
        localStorage.removeItem('pevo_orcid_mode');

        switch (data.mode) {
          case 'signup':
            this._handleSignup(data);
            break;
          case 'login':
            this._handleLogin(data);
            break;
          case 'accredit':
            this._handleAccredit(data);
            break;
          case 'link':
            this._handleLink(data);
            break;
          default:
            this.status = 'error';
            this.errorMessage = this.$t('orcid.verificationFailed');
        }
      } catch (err) {
        this.status = 'error';

        if (err.code === 'NO_ACCOUNT') {
          this.errorMessage = this.$t('orcid.noAccountFound');
          this.errorAction = 'signup';
          return;
        }

        if (err.code === 'VALIDATION_ERROR') {
          this.errorMessage = this.$t('signup.orcidInsufficientWorks');
        } else {
          this.errorMessage = err.message || this.$t('orcid.verificationFailed');
        }
      }
    },

    _handleSignup(data) {
      // Store verified ORCID nonce for the signup page
      localStorage.setItem('pevo_signup_orcid_token', data.orcid_token);
      localStorage.setItem('pevo_signup_orcid_id', data.orcid_id);
      if (data.name) {
        localStorage.setItem('pevo_signup_orcid_name', data.name);
      }

      // Return to the originating page (signup or recover)
      const returnTo = localStorage.getItem('pevo_orcid_return_to');
      localStorage.removeItem('pevo_orcid_return_to');
      this.navigate(returnTo === 'recover' ? '/recover' : '/signup');
    },

    _handleLogin(data) {
      this.status = 'login-success';

      const auth = Alpine.store('auth');
      auth.token = data.token;
      auth.username = data.username;
      auth.isConnected = true;
      auth.custody = data.custody || 'light';
      auth.expiresAt = data.expires_at;

      auth._saveSession();

      // Check accreditation status
      auth._checkAccreditation();

      Alpine.store('toast').show(this.$t('orcid.loginSuccess'), 'success');
      setTimeout(() => this.navigate('/papers'), 500);
    },

    _handleAccredit(data) {
      this.status = 'accredit-success';
      this.resultUsername = data.username;

      // Refresh accreditation data in auth store
      Alpine.store('auth')._checkAccreditation();
      Alpine.store('toast').show(this.$t('orcid.verificationSuccess'), 'success');
    },

    _handleLink(data) {
      // Signal settings page to show success
      localStorage.setItem('pevo_orcid_link_complete', '1');
      this.navigate('/settings');
    },
  }));
}

import Alpine from 'alpinejs';
import { requestPasswordReset, resetPassword } from '../api.js';

const MIN_PASSWORD = 10;

const template = `
      <div x-data="resetPasswordPage" class="container-narrow py-8">
        <div class="max-w-md mx-auto">

          <!-- REQUEST RESET (enter email) -->
          <template x-if="mode === 'request' && !requestSent">
            <div>
              <h1 class="text-3xl font-bold text-ink mb-2" x-text="$t('resetPassword.requestTitle')"></h1>
              <p class="text-ink-muted mb-6" x-text="$t('resetPassword.requestDescription')"></p>

              <div x-show="requestError" class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
                <p class="text-red-700 text-sm" x-text="requestError"></p>
              </div>

              <form @submit.prevent="handleRequestReset" class="space-y-5">
                <div>
                  <label class="block text-sm font-medium text-ink mb-1" x-text="$t('resetPassword.email')"></label>
                  <input type="email" x-model="email" required
                         class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                         :placeholder="$t('resetPassword.emailPlaceholder')">
                </div>
                <button type="submit" :disabled="!email.trim() || requestSubmitting"
                        class="w-full btn-primary py-2.5 disabled:opacity-50 disabled:cursor-not-allowed">
                  <span x-show="!requestSubmitting" x-text="$t('resetPassword.sendLink')"></span>
                  <span x-show="requestSubmitting" x-text="$t('resetPassword.sending')"></span>
                </button>
              </form>

              <p class="text-center text-sm text-ink-muted mt-6">
                <a :href="$lp('/login')" @click.prevent="navigate('/login')" class="text-pevo-teal hover:underline" x-text="$t('resetPassword.backToLogin')"></a>
              </p>
            </div>
          </template>

          <!-- REQUEST SENT (check email) -->
          <template x-if="mode === 'request' && requestSent">
            <div class="text-center py-16">
              <div class="w-16 h-16 bg-pevo-green/10 rounded-full flex items-center justify-center mx-auto mb-6">
                <svg class="w-8 h-8 text-pevo-green" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
              </div>
              <h2 class="text-2xl font-bold text-ink mb-2" x-text="$t('resetPassword.checkEmail')"></h2>
              <p class="text-ink-muted" x-text="$t('resetPassword.checkEmailDescription')"></p>
            </div>
          </template>

          <!-- SET NEW PASSWORD -->
          <template x-if="mode === 'reset' && !resetDone">
            <div>
              <h1 class="text-3xl font-bold text-ink mb-2" x-text="$t('resetPassword.resetTitle')"></h1>
              <p class="text-ink-muted mb-6" x-text="$t('resetPassword.resetDescription')"></p>

              <div x-show="resetError" class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
                <p class="text-red-700 text-sm" x-text="resetError"></p>
              </div>

              <form @submit.prevent="handleReset" class="space-y-5">
                <div>
                  <label class="block text-sm font-medium text-ink mb-1" x-text="$t('resetPassword.newPassword')"></label>
                  <input type="password" x-model="password" required minlength="10"
                         class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal">
                  <p class="text-xs text-ink-muted mt-1" x-text="$t('resetPassword.passwordHint')"></p>
                </div>
                <div>
                  <label class="block text-sm font-medium text-ink mb-1" x-text="$t('resetPassword.confirmPassword')"></label>
                  <input type="password" x-model="passwordConfirm" required
                         class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                         :class="passwordConfirm && !passwordsMatch ? 'border-pevo-crimson' : ''">
                  <p x-show="passwordConfirm && !passwordsMatch" class="text-xs text-pevo-crimson mt-1" x-text="$t('resetPassword.passwordMismatch')"></p>
                </div>
                <button type="submit" :disabled="!canReset || resetSubmitting"
                        class="w-full btn-primary py-2.5 disabled:opacity-50 disabled:cursor-not-allowed">
                  <span x-show="!resetSubmitting" x-text="$t('resetPassword.resetButton')"></span>
                  <span x-show="resetSubmitting" x-text="$t('resetPassword.resetting')"></span>
                </button>
              </form>
            </div>
          </template>

          <!-- RESET DONE -->
          <template x-if="mode === 'reset' && resetDone">
            <div class="text-center py-16">
              <div class="w-16 h-16 bg-pevo-green/10 rounded-full flex items-center justify-center mx-auto mb-6">
                <svg class="w-6 h-6 text-pevo-green" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
              </div>
              <h2 class="text-2xl font-bold text-ink mb-2" x-text="$t('resetPassword.doneTitle')"></h2>
              <p class="text-ink-muted mb-6" x-text="$t('resetPassword.doneDescription')"></p>
              <button @click="navigate('/login')" class="btn-primary" x-text="$t('resetPassword.goToLogin')"></button>
            </div>
          </template>

        </div>
      </div>
`;

export { template as resetPasswordPageTemplate };

export function initResetPasswordPage() {
  Alpine.data('resetPasswordPage', () => ({
    // Mode: 'request' (enter email) or 'reset' (enter new password)
    mode: 'request',
    token: null,

    // Request form
    email: '',
    requestSubmitting: false,
    requestSent: false,
    requestError: null,

    // Reset form
    password: '',
    passwordConfirm: '',
    resetSubmitting: false,
    resetDone: false,
    resetError: null,

    get passwordValid() { return this.password.length >= MIN_PASSWORD && /[a-z]/.test(this.password) && /[A-Z]/.test(this.password) && /[0-9]/.test(this.password); },
    get passwordsMatch() { return this.password === this.passwordConfirm; },
    get canReset() { return this.passwordValid && this.passwordsMatch; },

    init() {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      if (token) {
        this.token = token;
        this.mode = 'reset';
      }
    },

    async handleRequestReset() {
      if (!this.email.trim() || this.requestSubmitting) return;
      this.requestSubmitting = true;
      this.requestError = null;

      try {
        await requestPasswordReset(this.email.trim());
        this.requestSent = true;
      } catch (err) {
        this.requestError = err.message;
      } finally {
        this.requestSubmitting = false;
      }
    },

    async handleReset() {
      if (!this.canReset || this.resetSubmitting) return;
      this.resetSubmitting = true;
      this.resetError = null;

      try {
        await resetPassword(this.token, this.password);
        this.resetDone = true;
      } catch (err) {
        this.resetError = err.message;
      } finally {
        this.resetSubmitting = false;
      }
    },

    navigate(path) {
      Alpine.store('router').navigate(path);
    },
  }));
}

import Alpine from 'alpinejs';
import { verifyEmailToken } from '../api.js';

const template = `
      <div x-data="settingsVerifyEmailPage" class="container-narrow py-8">
        <div class="max-w-lg mx-auto text-center">

          <!-- Verifying -->
          <div x-show="phase === 'verifying'" class="py-16">
            <div class="animate-pulse">
              <div class="w-12 h-12 bg-parchment-dark rounded-full mx-auto mb-4"></div>
              <p class="text-ink-muted" x-text="$t('seedPhrase.verifying')"></p>
            </div>
          </div>

          <!-- Success -->
          <div x-show="phase === 'success'" class="py-16">
            <div class="w-16 h-16 bg-pevo-green/10 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg class="w-8 h-8 text-pevo-green" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            </div>
            <h2 class="text-2xl font-bold text-ink mb-2" x-text="$t('settings.emailVerified_success')"></h2>
            <button @click="navigate('/settings')" class="btn-primary mt-4" x-text="$t('settings.title')"></button>
          </div>

          <!-- Error -->
          <div x-show="phase === 'error'" class="py-16">
            <div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
              <p class="text-red-700 text-sm" x-text="error"></p>
            </div>
            <button @click="navigate('/settings')" class="btn-primary" x-text="$t('settings.title')"></button>
          </div>

        </div>
      </div>`;

export { template as settingsVerifyEmailPageTemplate };

export function initSettingsVerifyEmailPage() {
  Alpine.data('settingsVerifyEmailPage', () => ({
    phase: 'verifying',
    error: null,

    init() {
      const params = Alpine.store('router').params || {};
      const token = params.token;
      if (!token) {
        this.error = this.$t('settings.emailTokenExpired');
        this.phase = 'error';
        return;
      }
      this.verify(token);
    },

    async verify(token) {
      try {
        await verifyEmailToken(token);
        this.phase = 'success';
        Alpine.store('toast').show(this.$t('settings.emailVerified_success'), 'success');
      } catch (err) {
        // Sanitization pattern (see executeUpgrade() in settings.js).
        console.warn('[settings verify email]', err);
        this.error = this.$t('settings.emailTokenExpired');
        this.phase = 'error';
      }
    },

    navigate(path) {
      Alpine.store('router').navigate(path);
    },
  }));
}

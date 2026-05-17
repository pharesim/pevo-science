import Alpine from 'alpinejs';
import { recoverWithSeedPhrase, recoverWithOrcid, fetchAccreditationStatus, startOrcid } from '../api.js';
import { validateMnemonic, deriveAllKeys } from '../hive-keys.js';
import { isPasswordValid } from '../password-policy.js';

const template = `
      <div x-data="recoverPage" class="container-narrow py-8">
        <div class="max-w-md mx-auto">

          <!-- Recovery Form -->
          <template x-if="phase === 'form'">
            <div>
              <h1 class="text-3xl font-bold text-ink mb-2" x-text="$t('recover.title')"></h1>
              <p class="text-ink-muted mb-6" x-text="$t('recover.description')"></p>

              <!-- Error -->
              <div x-show="error" class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
                <p class="text-red-700 text-sm" x-text="error"></p>
              </div>

              <form @submit.prevent="handleSubmit" class="space-y-5">
                <!-- Username -->
                <div>
                  <label class="block text-sm font-medium text-ink mb-1" x-text="$t('recover.username')"></label>
                  <input type="text" x-model="username" required maxlength="16"
                         class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal lowercase"
                         :placeholder="$t('recover.usernamePlaceholder')"
                         @input="username = username.toLowerCase(); checkOrcidAvailability()">
                  <p class="text-xs text-ink-muted mt-1" x-text="$t('recover.usernameHint')"></p>
                </div>

                <!-- Method tabs -->
                <div class="flex gap-2">
                  <button type="button" @click="method = 'seed'"
                          class="px-4 py-2 text-sm rounded-lg border transition-colors"
                          :class="method === 'seed' ? 'bg-pevo-teal text-white border-pevo-teal' : 'bg-white text-ink border-parchment-dark hover:border-pevo-teal'"
                          x-text="$t('recover.methodSeed')"></button>
                  <button x-show="orcidAvailable" type="button" @click="method = 'orcid'"
                          data-testid="recover-method-orcid"
                          class="px-4 py-2 text-sm rounded-lg border transition-colors"
                          :class="method === 'orcid' ? 'bg-pevo-teal text-white border-pevo-teal' : 'bg-white text-ink border-parchment-dark hover:border-pevo-teal'"
                          x-text="$t('recover.methodOrcid')"></button>
                  <span x-show="orcidChecking" class="text-xs text-ink-muted self-center" x-text="$t('recover.checkingOrcid')"></span>
                </div>

                <!-- Seed phrase input -->
                <div x-show="method === 'seed'">
                  <label class="block text-sm font-medium text-ink mb-1" x-text="$t('recover.seedPhrase')"></label>
                  <textarea x-model="seedPhrase" rows="3"
                            class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                            :placeholder="$t('recover.seedPhrasePlaceholder')"
                            autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
                  <p class="text-xs text-ink-muted mt-1" x-text="$t('recover.seedPhraseHint')"></p>
                </div>

                <!-- ORCID verification -->
                <div x-show="method === 'orcid'">
                  <!-- Verified badge -->
                  <template x-if="orcidId">
                    <div class="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                      <svg class="w-4 h-4 text-pevo-green flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                      <span class="text-sm text-green-800" x-text="$t('recover.orcidVerified') + ': ' + orcidId"></span>
                    </div>
                  </template>
                  <!-- Verify button -->
                  <template x-if="!orcidId">
                    <button type="button" @click="handleOrcidVerify()" :disabled="orcidLoading || !username.trim()"
                            class="w-full btn-secondary py-2 text-sm flex items-center justify-center gap-2 disabled:opacity-50">
                      <span x-show="!orcidLoading" x-text="$t('recover.orcidVerifyButton')"></span>
                      <span x-show="orcidLoading" x-text="$t('recover.orcidVerifying')"></span>
                    </button>
                  </template>
                </div>

                <!-- New email -->
                <div>
                  <label class="block text-sm font-medium text-ink mb-1" x-text="$t('recover.newEmail')"></label>
                  <input type="email" x-model="newEmail" required
                         class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                         :placeholder="$t('recover.newEmailPlaceholder')">
                </div>

                <!-- New password (hidden on ORCID branch. ORCID-verified recovery skips password; user can set one later from Settings) -->
                <div x-show="method !== 'orcid'">
                  <label class="block text-sm font-medium text-ink mb-1" x-text="$t('recover.newPassword')"></label>
                  <input type="password" x-model="newPassword" :required="method !== 'orcid'" minlength="10"
                         class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal">
                  <p class="text-xs text-ink-muted mt-1" x-text="$t('recover.passwordHint')"></p>
                </div>

                <!-- Confirm password -->
                <div x-show="method !== 'orcid'">
                  <label class="block text-sm font-medium text-ink mb-1" x-text="$t('recover.newPasswordConfirm')"></label>
                  <input type="password" x-model="newPasswordConfirm" :required="method !== 'orcid'"
                         class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                         :class="newPasswordConfirm && !passwordsMatch ? 'border-pevo-crimson' : ''">
                  <p x-show="newPasswordConfirm && !passwordsMatch" class="text-xs text-pevo-crimson mt-1" x-text="$t('recover.passwordMismatch')"></p>
                </div>

                <!-- ORCID-branch hint replacing password fields -->
                <div x-show="method === 'orcid'" class="bg-parchment rounded-lg p-3 text-xs text-ink-muted" x-text="$t('recover.orcidNoPassword')"></div>

                <!-- Submit -->
                <button type="submit" :disabled="!(method === 'seed' ? canSubmitSeed : canSubmitOrcid) || isSubmitting"
                        class="w-full btn-primary py-2.5 disabled:opacity-50 disabled:cursor-not-allowed">
                  <span x-show="!isSubmitting" x-text="$t('recover.submit')"></span>
                  <span x-show="isSubmitting" x-text="$t('recover.submitting')"></span>
                </button>
              </form>

              <!-- Back to login -->
              <p class="text-center text-sm text-ink-muted mt-6">
                <a :href="$lp('/login')" @click.prevent="navigate('/login')" class="text-pevo-teal hover:underline" x-text="$t('recover.backToLogin')"></a>
              </p>
            </div>
          </template>

          <!-- Done -->
          <template x-if="phase === 'done'">
            <div class="text-center py-16">
              <div class="w-16 h-16 bg-pevo-green/10 rounded-full flex items-center justify-center mx-auto mb-6">
                <svg class="w-8 h-8 text-pevo-green" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
              </div>
              <h2 class="text-2xl font-bold text-ink mb-2" x-text="$t('recover.doneTitle')"></h2>
              <p class="text-ink-muted mb-6" x-text="$t('recover.doneDescription')"></p>
              <button @click="navigate('/login')" class="btn-primary" x-text="$t('recover.goToLogin')"></button>
            </div>
          </template>

        </div>
      </div>
`;

export { template as recoverPageTemplate };

export function initRecoverPage() {
  Alpine.data('recoverPage', () => ({
    phase: 'form', // 'form' | 'done'
    method: 'seed', // 'seed' | 'orcid'

    username: '',
    seedPhrase: '',
    newEmail: '',
    newPassword: '',
    newPasswordConfirm: '',

    error: null,
    isSubmitting: false,

    // ORCID state
    orcidAvailable: false,
    orcidChecking: false,
    orcidToken: '',
    orcidId: '',
    orcidLoading: false,
    _orcidCheckTimer: null,

    get passwordValid() {
      return isPasswordValid(this.newPassword);
    },

    get passwordsMatch() {
      return this.newPassword === this.newPasswordConfirm;
    },

    get canSubmitSeed() {
      return this.username.trim() && this.seedPhrase.trim() && this.newEmail.trim() && this.passwordValid && this.passwordsMatch;
    },

    get canSubmitOrcid() {
      // ORCID branch does not require a password. The recover call
      // submits null password and the backend preserves password_hash
      // as NULL. User can opt into password login later.
      return this.username.trim() && this.orcidToken && this.newEmail.trim();
    },

    init() {
      // Restore form state after ORCID OAuth redirect.
      // Password fields are deliberately NOT persisted or restored.
      // ORCID-verified recovery skips the password entirely.
      const draft = localStorage.getItem('pevo_recover_draft');
      if (draft) {
        try {
          const saved = JSON.parse(draft);
          this.username = saved.username || '';
          this.newEmail = saved.newEmail || '';
          this.method = 'orcid';
          this.orcidAvailable = true;
        } catch { /* ignore corrupt draft */ }
        localStorage.removeItem('pevo_recover_draft');
      }

      // Restore verified ORCID from signup callback (reused for recovery)
      const orcidToken = localStorage.getItem('pevo_signup_orcid_token');
      const orcidId = localStorage.getItem('pevo_signup_orcid_id');
      if (orcidToken && orcidId) {
        this.orcidToken = orcidToken;
        this.orcidId = orcidId;
        localStorage.removeItem('pevo_signup_orcid_token');
        localStorage.removeItem('pevo_signup_orcid_id');
      }
    },

    checkOrcidAvailability() {
      clearTimeout(this._orcidCheckTimer);
      const name = this.username.trim();
      if (name.length < 3) {
        this.orcidAvailable = false;
        this.orcidChecking = false;
        return;
      }
      this.orcidChecking = true;
      this._orcidCheckTimer = setTimeout(() => this._doOrcidCheck(name), 500);
    },

    async _doOrcidCheck(name) {
      try {
        const res = await fetchAccreditationStatus(name);
        if (this.username.trim() !== name) return;
        const method = res.data?.accreditation?.method;
        this.orcidAvailable = method === 'orcid';
      } catch {
        if (this.username.trim() === name) this.orcidAvailable = false;
      } finally {
        if (this.username.trim() === name) this.orcidChecking = false;
      }
    },

    async handleOrcidVerify() {
      if (this.orcidLoading || !this.username.trim()) return;
      this.orcidLoading = true;
      this.error = null;

      // Save form state before redirecting to ORCID.
      // Do NOT persist password fields across the round-trip.
      localStorage.setItem('pevo_recover_draft', JSON.stringify({
        username: this.username,
        newEmail: this.newEmail,
      }));

      // Signal to orcid-callback to return here. Both `pevo_orcid_mode` and
      // `pevo_orcid_return_to` live in sessionStorage to avoid cross-tab
      // interference; see fresh-auth.js mintNonConsentProof for the rationale.
      sessionStorage.setItem('pevo_orcid_return_to', 'recover');
      sessionStorage.setItem('pevo_orcid_mode', 'signup');

      try {
        const data = await startOrcid('signup');
        window.location.href = data.redirect_url;
      } catch (err) {
        this.orcidLoading = false;
        sessionStorage.removeItem('pevo_orcid_return_to');
        sessionStorage.removeItem('pevo_orcid_mode');
        // Sanitization pattern (see executeUpgrade() in settings.js).
        console.warn('[recover orcid start]', err);
        this.error = this.$t('recover.orcidStartFailed');
      }
    },

    async handleSubmit() {
      this.error = null;

      if (this.method === 'seed') {
        if (!this.canSubmitSeed || this.isSubmitting) return;
        this.isSubmitting = true;

        try {
          const trimmedPhrase = this.seedPhrase.trim();
          if (!validateMnemonic(trimmedPhrase)) {
            this.error = this.$t('recover.seedPhraseInvalid');
            return;
          }

          const name = this.username.trim();
          const keys = await deriveAllKeys(trimmedPhrase, name);
          await recoverWithSeedPhrase(name, keys.memo.private, this.newEmail.trim(), this.newPassword);
          this.phase = 'done';
        } catch (err) {
          // Sanitization pattern (see executeUpgrade() in settings.js).
          // The seed-phrase recovery path derives keys from the BIP39
          // mnemonic, so surfacing raw err.message risks leaking
          // key-adjacent material on a future error shape.
          console.warn('[recover seed]', err);
          this.error = this.$t('recover.seedRecoveryFailed');
        } finally {
          this.isSubmitting = false;
        }
      } else {
        if (!this.canSubmitOrcid || this.isSubmitting) return;
        this.isSubmitting = true;

        try {
          // Submit `newPassword: null`. The backend preserves
          // `password_hash = NULL` and returns success.
          await recoverWithOrcid(this.username.trim(), this.orcidToken, this.newEmail.trim(), null);
          this.phase = 'done';
        } catch (err) {
          // Sanitization pattern (see executeUpgrade() in settings.js).
          console.warn('[recover orcid]', err);
          this.error = this.$t('recover.orcidRecoveryFailed');
        } finally {
          this.isSubmitting = false;
        }
      }
    },

    navigate(path) {
      Alpine.store('router').navigate(path);
    },
  }));
}

import Alpine from 'alpinejs';
import { loginWithPassword, resendVerification } from '../api.js';

const template = `
      <div x-data="loginPage" class="container-narrow py-8">
        <!-- Already signed in -->
        <template x-if="isConnected">
          <div class="text-center py-16">
            <p class="text-ink-muted mb-4" x-text="$t('common.alreadySignedIn')"></p>
            <button @click="navigate('/papers')" class="btn-primary" x-text="$t('common.goToPapers')"></button>
          </div>
        </template>

        <!-- Login form -->
        <template x-if="!isConnected">
          <div class="max-w-md mx-auto">
            <h1 class="text-3xl font-bold text-ink mb-2" x-text="$t('login.title')"></h1>
            <p class="text-ink-muted mb-6" x-text="$t('login.subtitle')"></p>

            <!-- Error (generic) -->
            <div x-show="error && !pendingState" class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <p class="text-red-700 text-sm" x-text="error"></p>
            </div>

            <!-- Pending unverified: offer resend -->
            <div x-show="pendingState === 'unverified' && !resendSuccess" class="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
              <p class="text-amber-800 text-sm mb-3" x-text="$t('login.pendingUnverified')"></p>
              <button type="button" @click="handleResendVerification()" :disabled="isResending"
                      class="btn-primary text-sm py-1.5 px-4 disabled:opacity-50">
                <span x-show="!isResending" x-text="$t('login.resendVerification')"></span>
                <span x-show="isResending" x-text="$t('login.resending')"></span>
              </button>
            </div>

            <!-- Resend success -->
            <div x-show="resendSuccess" class="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
              <p class="text-green-700 text-sm" x-text="$t('login.verificationResent')"></p>
            </div>

            <!-- Signup expired: link to signup -->
            <div x-show="pendingState === 'expired'" class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <p class="text-red-700 text-sm mb-3" x-text="error"></p>
              <a :href="$lp('/signup')" @click.prevent="navigate('/signup')" class="text-pevo-teal hover:underline text-sm font-medium" x-text="$t('login.signUpAgain')"></a>
            </div>

            <form @submit.prevent="handleSubmit" class="space-y-5">
              <!-- Email or username -->
              <div>
                <label class="block text-sm font-medium text-ink mb-1" x-text="$t('login.emailOrUsername')"></label>
                <input type="text" x-model="emailOrUsername" required
                       class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                       :placeholder="$t('login.emailOrUsernamePlaceholder')">
              </div>

              <!-- Password -->
              <div>
                <label class="block text-sm font-medium text-ink mb-1" x-text="$t('login.password')"></label>
                <input type="password" x-model="password" required
                       class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal">
                <div class="text-right mt-1">
                  <a :href="$lp('/reset-password')" @click.prevent="navigate('/reset-password')"
                     class="text-xs text-pevo-teal hover:underline" x-text="$t('login.forgotPassword')"></a>
                </div>
              </div>

              <!-- Submit -->
              <button type="submit" :disabled="!canSubmit || isSubmitting"
                      class="w-full btn-primary py-2.5 disabled:opacity-50 disabled:cursor-not-allowed">
                <span x-show="!isSubmitting" x-text="$t('login.submit')"></span>
                <span x-show="isSubmitting" x-text="$t('login.submitting')"></span>
              </button>
            </form>

            <!-- Signup link -->
            <p class="text-center text-sm text-ink-muted mt-6">
              <span x-text="$t('common.noAccount')"></span>
              <a :href="$lp('/signup')" @click.prevent="navigate('/signup')" class="text-pevo-teal hover:underline" x-text="$t('common.signUp')"></a>
            </p>

            <!-- Keychain link -->
            <p class="text-center text-sm text-ink-muted mt-2">
              <span x-text="$t('common.hasKeychain')"></span>
              <a :href="$lp('/')" @click.prevent="navigate('/')" class="text-pevo-teal hover:underline" x-text="$t('common.connectKeychain')"></a>
            </p>
          </div>
        </template>
      </div>
`;

export { template as loginPageTemplate };

export function initLoginPage() {
  Alpine.data('loginPage', () => ({
    emailOrUsername: '',
    password: '',
    isSubmitting: false,
    error: null,

    // Pending signup states detected by login
    pendingState: null, // null | 'unverified' | 'expired'
    isResending: false,
    resendSuccess: false,

    get isConnected() { return Alpine.store('auth').isConnected; },

    get canSubmit() {
      return this.emailOrUsername.trim() && this.password;
    },

    async handleSubmit() {
      if (!this.canSubmit || this.isSubmitting) return;
      this.isSubmitting = true;
      this.error = null;
      this.pendingState = null;
      this.resendSuccess = false;

      try {
        const res = await loginWithPassword(
          this.emailOrUsername.trim(),
          this.password
        );

        const auth = Alpine.store('auth');
        auth.token = res.data.token;
        auth.username = res.data.username;
        auth.isConnected = true;
        auth.isAccredited = res.data.is_accredited ?? false;
        auth.accreditation = res.data.accreditation ?? null;
        auth.custody = res.data.custody ?? 'light';

        auth._saveSession(
          res.data.token,
          res.data.username,
          res.data.expires_at,
          auth.isAccredited,
          auth.accreditation,
          auth.custody
        );

        Alpine.store('router').navigate('/papers');
      } catch (err) {
        if (err.code === 'PENDING_SIGNUP' && err.data) {
          // Verified but incomplete — redirect to choose phase with auth_token
          const params = new URLSearchParams({
            auth_token: err.data.auth_token,
            email: err.data.email,
          });
          Alpine.store('router').navigate(`/signup/verify?${params}`);
          return;
        }
        if (err.code === 'PENDING_UNVERIFIED') {
          this.pendingState = 'unverified';
          this.error = err.message;
          return;
        }
        if (err.code === 'SIGNUP_EXPIRED') {
          this.pendingState = 'expired';
          this.error = err.message;
          return;
        }
        this.error = err.message;
      } finally {
        this.isSubmitting = false;
      }
    },

    async handleResendVerification() {
      if (this.isResending) return;
      this.isResending = true;
      try {
        await resendVerification(this.emailOrUsername.trim(), this.password);
        this.resendSuccess = true;
        this.error = null;
      } catch (err) {
        this.error = err.message;
      } finally {
        this.isResending = false;
      }
    },

    navigate(path) {
      Alpine.store('router').navigate(path);
    },
  }));
}

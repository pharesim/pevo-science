import Alpine from 'alpinejs';
import { submitSignup, loginWithPassword, resendVerification, startSignupOrcid } from '../api.js';

const MIN_PASSWORD = 10;

const template = `
      <div x-data="signupPage" class="container-narrow py-8">
        <!-- Already signed in -->
        <template x-if="isConnected">
          <div class="text-center py-16">
            <p class="text-ink-muted mb-4" x-text="$t('signup.alreadySignedIn')"></p>
            <button @click="navigate('/papers')" class="btn-primary" x-text="$t('signup.goToPapers')"></button>
          </div>
        </template>

        <!-- Signup form -->
        <template x-if="!isConnected && !submitted">
          <div class="max-w-md mx-auto">
            <h1 class="text-3xl font-bold text-ink mb-2" x-text="$t('signup.title')"></h1>
            <p class="text-ink-muted mb-6" x-text="$t('signup.subtitle')"></p>

            <!-- Error -->
            <div x-show="error" class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <p class="text-red-700 text-sm" x-text="error"></p>
            </div>

            <form @submit.prevent="handleSubmit" class="space-y-5">
              <!-- Email -->
              <div>
                <label class="block text-sm font-medium text-ink mb-1" x-text="$t('signup.email')"></label>
                <input type="email" x-model="email" required
                       class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                       :placeholder="$t('signup.emailPlaceholder')">
                <p class="text-xs text-ink-muted mt-1" x-text="$t('signup.emailHint')"></p>
              </div>

              <!-- Researcher info -->
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label class="block text-sm font-medium text-ink mb-1" x-text="$t('signup.fullName')"></label>
                  <input type="text" x-model="fullName" required
                         class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                         :placeholder="$t('signup.fullNamePlaceholder')">
                </div>
                <div>
                  <label class="block text-sm font-medium text-ink mb-1" x-text="$t('signup.institution')"></label>
                  <input type="text" x-model="institution" required
                         class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                         :placeholder="$t('signup.institutionPlaceholder')">
                </div>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label class="block text-sm font-medium text-ink mb-1" x-text="$t('signup.field')"></label>
                  <input type="text" x-model="field" required
                         class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                         :placeholder="$t('signup.fieldPlaceholder')">
                </div>
                <div>
                  <label class="block text-sm font-medium text-ink mb-1" x-text="$t('signup.orcidVerifyButton')"></label>
                  <!-- Verified ORCID badge -->
                  <template x-if="orcidId">
                    <div class="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                      <svg class="w-4 h-4 text-pevo-green flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                      <span class="text-sm text-green-800 truncate" x-text="orcidId"></span>
                      <button type="button" @click="clearOrcid()" class="ml-auto text-green-600 hover:text-green-800" aria-label="Clear ORCID">
                        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                      </button>
                    </div>
                  </template>
                  <!-- Verify button -->
                  <template x-if="!orcidId">
                    <button type="button" @click="handleOrcidVerify()" :disabled="orcidLoading"
                            class="w-full btn-secondary py-2 text-sm flex items-center justify-center gap-2 disabled:opacity-50">
                      <span x-show="!orcidLoading" x-text="$t('signup.orcidVerifyButton')"></span>
                      <span x-show="orcidLoading" x-text="$t('signup.orcidVerifying')"></span>
                    </button>
                  </template>
                </div>
              </div>

              <!-- Password -->
              <div>
                <label class="block text-sm font-medium text-ink mb-1" x-text="$t('signup.password')"></label>
                <input type="password" x-model="password" required minlength="10"
                       class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal">
                <p class="text-xs text-ink-muted mt-1" x-text="$t('signup.passwordHint')"></p>
              </div>

              <!-- Confirm Password -->
              <div>
                <label class="block text-sm font-medium text-ink mb-1" x-text="$t('signup.passwordConfirm')"></label>
                <input type="password" x-model="passwordConfirm" required
                       class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                       :class="passwordConfirm && !passwordsMatch ? 'border-pevo-crimson' : ''">
                <p x-show="passwordConfirm && !passwordsMatch" class="text-xs text-pevo-crimson mt-1" x-text="$t('signup.passwordMismatch')"></p>
              </div>

              <!-- Submit -->
              <button type="submit" :disabled="!canSubmit || isSubmitting"
                      class="w-full btn-primary py-2.5 disabled:opacity-50 disabled:cursor-not-allowed">
                <span x-show="!isSubmitting" x-text="$t('signup.submit')"></span>
                <span x-show="isSubmitting" x-text="$t('signup.submitting')"></span>
              </button>
            </form>

            <!-- Login link -->
            <p class="text-center text-sm text-ink-muted mt-6">
              <span x-text="$t('signup.hasAccount')"></span>
              <a :href="$lp('/login')" @click.prevent="navigate('/login')" class="text-pevo-teal hover:underline" x-text="$t('signup.signIn')"></a>
            </p>

            <!-- Keychain link -->
            <p class="text-center text-sm text-ink-muted mt-2">
              <span x-text="$t('signup.hasKeychain')"></span>
              <a :href="$lp('/')" @click.prevent="navigate('/')" class="text-pevo-teal hover:underline" x-text="$t('signup.connectKeychain')"></a>
            </p>
          </div>
        </template>

        <!-- Success / check email -->
        <template x-if="!isConnected && submitted">
          <div class="max-w-md mx-auto text-center py-16">
            <div class="w-16 h-16 bg-pevo-green/10 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg class="w-8 h-8 text-pevo-green" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
            </div>
            <h2 class="text-2xl font-bold text-ink mb-2" x-text="$t('signup.checkEmail')"></h2>
            <p class="text-ink-muted mb-6" x-text="$t('signup.checkEmailDescription')"></p>
            <div x-show="resendSuccess" class="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
              <p class="text-green-700 text-sm" x-text="$t('login.verificationResent')"></p>
            </div>
            <button x-show="!resendSuccess" type="button" @click="handleResendVerification()" :disabled="isResending"
                    class="text-sm text-pevo-teal hover:underline disabled:opacity-50">
              <span x-show="!isResending" x-text="$t('login.resendVerification')"></span>
              <span x-show="isResending" x-text="$t('login.resending')"></span>
            </button>
          </div>
        </template>
      </div>`;

export { template as signupPageTemplate };

export function initSignupPage() {
  Alpine.data('signupPage', () => ({
    email: '',
    fullName: '',
    institution: '',
    field: '',
    orcidToken: '',
    orcidId: '',
    password: '',
    passwordConfirm: '',

    isSubmitting: false,
    submitted: false,
    error: null,
    isResending: false,
    resendSuccess: false,
    orcidLoading: false,

    get isConnected() { return Alpine.store('auth').isConnected; },

    get passwordValid() {
      return this.password.length >= MIN_PASSWORD
        && /[a-z]/.test(this.password)
        && /[A-Z]/.test(this.password)
        && /[0-9]/.test(this.password);
    },

    get passwordsMatch() {
      return this.password === this.passwordConfirm;
    },

    get canSubmit() {
      return this.email && this.fullName && this.institution && this.field && this.passwordValid && this.passwordsMatch;
    },

    init() {
      // Restore form state after ORCID OAuth redirect
      const draft = localStorage.getItem('pevo_signup_draft');
      if (draft) {
        try {
          const saved = JSON.parse(draft);
          this.email = saved.email || '';
          this.fullName = saved.fullName || '';
          this.institution = saved.institution || '';
          this.field = saved.field || '';
          this.password = saved.password || '';
          this.passwordConfirm = saved.passwordConfirm || '';
        } catch { /* ignore corrupt data */ }
        localStorage.removeItem('pevo_signup_draft');
      }

      // Restore verified ORCID from callback
      const orcidToken = localStorage.getItem('pevo_signup_orcid_token');
      const orcidId = localStorage.getItem('pevo_signup_orcid_id');
      if (orcidToken && orcidId) {
        this.orcidToken = orcidToken;
        this.orcidId = orcidId;
        localStorage.removeItem('pevo_signup_orcid_token');
        localStorage.removeItem('pevo_signup_orcid_id');
      }
    },

    async handleOrcidVerify() {
      if (this.orcidLoading) return;
      this.orcidLoading = true;
      this.error = null;

      // Save form state before redirecting
      localStorage.setItem('pevo_signup_draft', JSON.stringify({
        email: this.email,
        fullName: this.fullName,
        institution: this.institution,
        field: this.field,
        password: this.password,
        passwordConfirm: this.passwordConfirm,
      }));

      try {
        const data = await startSignupOrcid();
        window.location.href = data.redirect_url;
      } catch (err) {
        this.orcidLoading = false;
        this.error = err.message;
      }
    },

    clearOrcid() {
      this.orcidToken = '';
      this.orcidId = '';
    },

    async handleSubmit() {
      if (!this.canSubmit || this.isSubmitting) return;
      this.isSubmitting = true;
      this.error = null;

      try {
        await submitSignup({
          email: this.email.trim(),
          password: this.password,
          full_name: this.fullName.trim(),
          institution: this.institution.trim(),
          field: this.field.trim(),
          orcid_token: this.orcidToken || undefined,
        });
        this.submitted = true;
      } catch (err) {
        if (err.code === 'DUPLICATE' && this.email && this.password) {
          await this._resolveExistingAccount();
        } else if (err.code === 'VALIDATION_ERROR' && !this.orcidToken) {
          this.error = this.$t('signup.orcidOrInstitutional');
        } else {
          this.error = err.message;
        }
      } finally {
        this.isSubmitting = false;
      }
    },

    async _resolveExistingAccount() {
      try {
        const res = await loginWithPassword(this.email.trim(), this.password);
        const auth = Alpine.store('auth');
        auth.loginFromResponse(res.data);
        Alpine.store('router').navigate('/papers');
      } catch (loginErr) {
        if (loginErr.code === 'PENDING_SIGNUP' && loginErr.data) {
          const params = new URLSearchParams({
            auth_token: loginErr.data.auth_token,
            email: loginErr.data.email,
          });
          Alpine.store('router').navigate(`/signup/verify?${params}`);
        } else {
          Alpine.store('router').navigate('/login');
        }
      }
    },

    async handleResendVerification() {
      if (this.isResending) return;
      this.isResending = true;
      try {
        await resendVerification(this.email.trim(), this.password);
        this.resendSuccess = true;
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

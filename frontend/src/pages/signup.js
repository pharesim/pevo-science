import Alpine from 'alpinejs';
import { submitSignup, loginWithPassword, resendVerification, startOrcid } from '../api.js';
import { isPasswordValid } from '../password-policy.js';
import { createTimerGuard } from '../lib/timer-guard.js';

const template = `
      <div x-data="signupPage" class="container-narrow py-8">
        <!-- Already signed in -->
        <template x-if="isConnected">
          <div class="text-center py-16">
            <p class="text-ink-muted mb-4" x-text="$t('common.alreadySignedIn')"></p>
            <button @click="navigate('/papers')" class="btn-primary" x-text="$t('common.goToPapers')"></button>
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
                      <button type="button" @click="clearOrcid()" class="ml-auto text-green-600 hover:text-green-800" :aria-label="$t('aria.clearOrcid')">
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

              <!-- Password (hidden on ORCID branch. ORCID-verified accounts skip password entirely; user can set one later from Settings) -->
              <div x-show="!orcidToken">
                <label class="block text-sm font-medium text-ink mb-1" x-text="$t('signup.password')"></label>
                <input type="password" x-model="password" :required="!orcidToken" minlength="10"
                       class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal">
                <p class="text-xs text-ink-muted mt-1" x-text="$t('signup.passwordHint')"></p>
              </div>

              <!-- Confirm Password -->
              <div x-show="!orcidToken">
                <label class="block text-sm font-medium text-ink mb-1" x-text="$t('signup.passwordConfirm')"></label>
                <input type="password" x-model="passwordConfirm" :required="!orcidToken"
                       class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                       :class="passwordConfirm && !passwordsMatch ? 'border-pevo-crimson' : ''">
                <p x-show="passwordConfirm && !passwordsMatch" class="text-xs text-pevo-crimson mt-1" x-text="$t('signup.passwordMismatch')"></p>
              </div>

              <!-- ORCID-branch hint replacing password fields -->
              <div x-show="orcidToken" class="bg-parchment rounded-lg p-3 text-xs text-ink-muted" x-text="$t('signup.orcidNoPassword')"></div>

              <!-- Submit -->
              <button type="submit" :disabled="!canSubmit || isSubmitting"
                      class="w-full btn-primary py-2.5 disabled:opacity-50 disabled:cursor-not-allowed">
                <span x-show="!isSubmitting" x-text="$t('signup.submit')"></span>
                <span x-show="isSubmitting" x-text="$t('signup.submitting')"></span>
              </button>
            </form>

            <!-- Divider -->
            <div class="flex items-center gap-3 my-6">
              <div class="flex-1 border-t border-parchment-dark"></div>
              <span class="text-sm text-ink-muted" x-text="$t('orcid.or')"></span>
              <div class="flex-1 border-t border-parchment-dark"></div>
            </div>

            <!-- Sign up with ORCID -->
            <button type="button" @click="handleOrcidSignup()" :disabled="orcidLoading"
                    class="w-full btn-secondary py-2.5 flex items-center justify-center gap-2 disabled:opacity-50">
              <svg class="h-5 w-5" viewBox="0 0 256 256" fill="none"><path d="M256 128C256 198.692 198.692 256 128 256C57.3076 256 0 198.692 0 128C0 57.3076 57.3076 0 128 0C198.692 0 256 57.3076 256 128Z" fill="#A6CE39"/><path d="M86.3 186.2H70.9V79.1H86.3V186.2ZM78.6 56.1C73.5 56.1 69.4 60.2 69.4 65.3C69.4 70.4 73.5 74.5 78.6 74.5C83.7 74.5 87.8 70.4 87.8 65.3C87.8 60.2 83.7 56.1 78.6 56.1ZM108.5 79.1H150.3C185 79.1 200.5 102.7 200.5 132.6C200.5 165.2 181.5 186.2 150.3 186.2H108.5V79.1ZM124 172.5H148.6C175.2 172.5 184.6 153.3 184.6 132.6C184.6 110.6 173.8 92.8 148.6 92.8H124V172.5Z" fill="white"/></svg>
              <span x-show="!orcidLoading" x-text="$t('signup.orcidSignup')"></span>
              <span x-show="orcidLoading" x-text="$t('orcid.redirecting')"></span>
            </button>

            <!-- Login link -->
            <p class="text-center text-sm text-ink-muted mt-6">
              <span x-text="$t('signup.hasAccount')"></span>
              <a :href="$lp('/login')" @click.prevent="navigate('/login')" class="text-pevo-teal hover:underline" x-text="$t('signup.signIn')"></a>
            </p>

            <!-- Keychain link -->
            <p class="text-center text-sm text-ink-muted mt-2">
              <span x-text="$t('common.hasKeychain')"></span>
              <a :href="$lp('/')" @click.prevent="navigate('/')" class="text-pevo-teal hover:underline" x-text="$t('common.connectKeychain')"></a>
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
            <button x-show="!resendSuccess && !orcidToken" type="button" @click="handleResendVerification()" :disabled="isResending"
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
    ...createTimerGuard(),
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
      return isPasswordValid(this.password);
    },

    get passwordsMatch() {
      return this.password === this.passwordConfirm;
    },

    get canSubmit() {
      const baseFields = this.email && this.fullName && this.institution && this.field;
      if (!baseFields) return false;
      // ORCID branch: password is optional. User can set one later in Settings.
      if (this.orcidToken) return true;
      // Non-ORCID branch: password still required
      return this.passwordValid && this.passwordsMatch;
    },

    init() {
      // Restore form state after ORCID OAuth redirect.
      // NOTE: password fields are deliberately NOT persisted or restored.
      // ORCID-verified signups skip the password entirely; the non-ORCID
      // branch requires the user to re-enter their password if they ever
      // did cross the ORCID round-trip (which the UI now prevents by
      // hiding the field on the ORCID branch anyway).
      const draft = localStorage.getItem('pevo_signup_draft');
      if (draft) {
        const saved = JSON.parse(draft);
        this.email = saved.email || '';
        this.fullName = saved.fullName || '';
        this.institution = saved.institution || '';
        this.field = saved.field || '';
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

    destroy() {
      // _teardownTimers flips _mounted so in-flight submitSignup /
      // loginWithPassword / startOrcid / resendVerification continuations
      // bail before touching reactive state.
      this._teardownTimers();
    },

    async handleOrcidVerify() {
      if (this.orcidLoading) return;
      this.orcidLoading = true;
      this.error = null;

      // Save form state before redirecting.
      // Do NOT persist password/passwordConfirm across the ORCID
      // round-trip. ORCID-verified signups send `password: null` and skip
      // the field entirely.
      localStorage.setItem('pevo_signup_draft', JSON.stringify({
        email: this.email,
        fullName: this.fullName,
        institution: this.institution,
        field: this.field,
      }));

      localStorage.setItem('pevo_orcid_mode', 'signup');

      try {
        const data = await startOrcid('signup');
        if (!this._mounted) return;
        window.location.href = data.redirect_url;
      } catch (err) {
        if (!this._mounted) return;
        this.orcidLoading = false;
        localStorage.removeItem('pevo_orcid_mode');
        // Sanitization pattern (see executeUpgrade() in settings.js).
        console.warn('[signup orcid verify]', err);
        this.error = this.$t('signup.orcidStartFailed');
      }
    },

    async handleOrcidSignup() {
      if (this.orcidLoading) return;
      this.orcidLoading = true;
      this.error = null;

      localStorage.setItem('pevo_orcid_mode', 'signup');

      try {
        const data = await startOrcid('signup');
        if (!this._mounted) return;
        window.location.href = data.redirect_url;
      } catch (err) {
        if (!this._mounted) return;
        this.orcidLoading = false;
        localStorage.removeItem('pevo_orcid_mode');
        // Sanitization pattern (see executeUpgrade() in settings.js).
        console.warn('[signup orcid start]', err);
        this.error = this.$t('signup.orcidStartFailed');
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
        // ORCID-verified signups submit `password: null`. The backend
        // creates the account with `password_hash = NULL`; the user can
        // opt into password login later from Settings.
        const isOrcid = Boolean(this.orcidToken);
        await submitSignup({
          email: this.email.trim(),
          password: isOrcid ? null : this.password,
          full_name: this.fullName.trim(),
          institution: this.institution.trim(),
          field: this.field.trim(),
          orcid_token: this.orcidToken || undefined,
        });
        if (!this._mounted) return;
        this.submitted = true;
      } catch (err) {
        if (!this._mounted) return;
        // DUPLICATE and VALIDATION_ERROR are semantic codes, safe to branch
        // on. All other failures take the generic-message + console.warn
        // sanitization path shared with executeUpgrade() in settings.js.
        // console.warn fires only on the generic fallback, not on expected
        // DUPLICATE / VALIDATION_ERROR submissions (avoids log noise).
        if (err.code === 'DUPLICATE' && this.email && this.password && !this.orcidToken) {
          await this._resolveExistingAccount();
        } else if (err.code === 'VALIDATION_ERROR' && !this.orcidToken) {
          this.error = this.$t('signup.orcidOrInstitutional');
        } else {
          console.warn('[signup submit]', err);
          this.error = this.$t('signup.submitFailed');
        }
      } finally {
        if (this._mounted) this.isSubmitting = false;
      }
    },

    async _resolveExistingAccount() {
      try {
        const res = await loginWithPassword(this.email.trim(), this.password);
        if (!this._mounted) return;
        const auth = Alpine.store('auth');
        // Explicit overrides: the password-login response carries
        // {token, expires_at, username, custody} but NOT is_accredited /
        // accreditation. The helper preserves-on-undefined, so without
        // these overrides a cross-user re-login leaks user-A's accreditation
        // into user-B's session until the polling round-trip arrives.
        auth.loginFromResponse({ ...res.data, is_accredited: false, accreditation: null });
        Alpine.store('router').navigate('/papers');
      } catch (loginErr) {
        if (!this._mounted) return;
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
      // ORCID branch has no password; don't POST an empty-password resend
      // even if the button hide is bypassed.
      if (this.isResending || this.orcidToken) return;
      this.isResending = true;
      try {
        await resendVerification(this.email.trim(), this.password);
        if (!this._mounted) return;
        this.resendSuccess = true;
      } catch (err) {
        if (!this._mounted) return;
        // Sanitization pattern (see executeUpgrade() in settings.js).
        console.warn('[signup resend verification]', err);
        this.error = this.$t('signup.resendFailed');
      } finally {
        if (this._mounted) this.isResending = false;
      }
    },

    navigate(path) {
      Alpine.store('router').navigate(path);
    },
  }));
}

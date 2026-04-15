import Alpine from 'alpinejs';
import { submitSignup, loginWithPassword, resendVerification, startSignupOrcid } from '../api.js';

const MIN_PASSWORD = 10;

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

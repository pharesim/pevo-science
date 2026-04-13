import Alpine from 'alpinejs';
import { checkUsernameAvailability, submitSignup } from '../api.js';

// Hive username rules: 3-16 chars, lowercase a-z/0-9/dots/hyphens,
// not at start/end, one separator between segments
const USERNAME_RE = /^[a-z][a-z0-9]*([.-][a-z0-9]+)*$/;
const MIN_USERNAME = 3;
const MAX_USERNAME = 16;
const MIN_PASSWORD = 10;

function isValidUsername(u) {
  return u.length >= MIN_USERNAME && u.length <= MAX_USERNAME && USERNAME_RE.test(u);
}

export function initSignupPage() {
  Alpine.data('signupPage', () => ({
    email: '',
    password: '',
    passwordConfirm: '',
    displayName: '',
    username: '',
    linkExisting: false,
    linkedUsername: '',

    usernameStatus: null, // null | 'checking' | 'available' | 'taken' | 'invalid'
    _usernameTimer: null,

    isSubmitting: false,
    submitted: false,
    error: null,

    get isConnected() { return Alpine.store('auth').isConnected; },

    get passwordValid() {
      return this.password.length >= MIN_PASSWORD;
    },

    get passwordsMatch() {
      return this.password === this.passwordConfirm;
    },

    get usernameFormatValid() {
      return isValidUsername(this.username);
    },

    get canSubmit() {
      if (!this.email || !this.passwordValid || !this.passwordsMatch || !this.displayName) return false;
      if (this.linkExisting) {
        return this.linkedUsername.length >= MIN_USERNAME;
      }
      return this.usernameStatus === 'available';
    },

    init() {
      this.$watch('username', (val) => {
        clearTimeout(this._usernameTimer);
        if (!val || !isValidUsername(val)) {
          this.usernameStatus = val ? 'invalid' : null;
          return;
        }
        this.usernameStatus = 'checking';
        this._usernameTimer = setTimeout(() => this.checkUsername(val), 400);
      });
    },

    async checkUsername(val) {
      try {
        const res = await checkUsernameAvailability(val);
        // Only update if the username hasn't changed while we were checking
        if (this.username === val) {
          this.usernameStatus = res.data?.available ? 'available' : 'taken';
        }
      } catch {
        if (this.username === val) this.usernameStatus = 'invalid';
      }
    },

    async handleSubmit() {
      if (!this.canSubmit || this.isSubmitting) return;
      this.isSubmitting = true;
      this.error = null;

      try {
        const payload = {
          email: this.email.trim(),
          password: this.password,
          display_name: this.displayName.trim(),
        };

        if (this.linkExisting) {
          payload.linked_username = this.linkedUsername.trim().toLowerCase();
        } else {
          payload.username = this.username.trim().toLowerCase();
        }

        await submitSignup(payload);
        this.submitted = true;
      } catch (err) {
        this.error = err.message;
      } finally {
        this.isSubmitting = false;
      }
    },

    navigate(path) {
      Alpine.store('router').navigate(path);
    },
  }));
}

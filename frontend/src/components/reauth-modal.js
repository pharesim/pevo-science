import Alpine from 'alpinejs';

/**
 * Promise-based password re-auth modal for light accounts.
 *
 * Usage: `const password = await Alpine.store('reauthModal').request()`.
 * Resolves with the entered password string, or `null` if the user cancels.
 * Modeled on the broadcast-confirm modal store (single in-flight request,
 * refuse-while-open). The caller decides what to do with the password; this
 * store only collects it and never persists it (cleared on submit/cancel).
 */
export function initReauthModal() {
  Alpine.store('reauthModal', {
    open: false,
    title: '',
    message: '',
    password: '',
    _resolve: null,

    request({ title, message } = {}) {
      // Refuse-while-open: a previous request() is still awaiting a decision.
      // Resolve the new caller to null rather than evicting the first waiter or
      // swapping the prompt text underneath it.
      if (this._resolve) return Promise.resolve(null);

      const i18n = Alpine.store('i18n')?.messages?.reauth;
      this.title = title || i18n?.title || 'Confirm your password';
      this.message = message || i18n?.message
        || 'Enter your account password to upload files securely.';
      this.password = '';
      this.open = true;

      return new Promise((resolve) => {
        this._resolve = resolve;
      });
    },

    submit() {
      // Capture before clearing so the resolved value is the entered password.
      const entered = this.password;
      this.open = false;
      this.password = '';
      if (this._resolve) this._resolve(entered);
      this._resolve = null;
    },

    cancel() {
      this.open = false;
      this.password = '';
      if (this._resolve) this._resolve(null);
      this._resolve = null;
    },
  });
}

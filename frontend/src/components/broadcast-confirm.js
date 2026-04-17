import Alpine from 'alpinejs';

/**
 * Reusable confirmation modal for light account broadcasts.
 * Usage: call Alpine.store('broadcastConfirm').request({ title, message, confirmLabel })
 * Returns a promise that resolves true (confirmed) or false (cancelled).
 */
export function initBroadcastConfirm() {
  Alpine.store('broadcastConfirm', {
    open: false,
    title: '',
    message: '',
    confirmLabel: '',
    _resolve: null,

    request({ title, message, confirmLabel }) {
      // Only show for light accounts
      const auth = Alpine.store('auth');
      if (auth.custody !== 'light') return Promise.resolve(true);

      this.title = title;
      this.message = message;
      this.confirmLabel = confirmLabel || Alpine.store('i18n').messages?.common?.confirm || 'Confirm';
      this.open = true;

      return new Promise((resolve) => {
        this._resolve = resolve;
      });
    },

    confirm() {
      this.open = false;
      if (this._resolve) this._resolve(true);
      this._resolve = null;
    },

    cancel() {
      this.open = false;
      if (this._resolve) this._resolve(false);
      this._resolve = null;
    },
  });
}

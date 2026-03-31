import Alpine from 'alpinejs';

export function initUsernameModal() {
  Alpine.data('usernameModal', () => ({
    open: false,
    value: '',
    error: null,
    _resolve: null,

    /**
     * Open the modal and return a Promise that resolves with
     * the entered username or null if cancelled.
     * Usage: const name = await this.$dispatch('username-prompt');
     * Or call directly: Alpine.store('usernameModal').prompt()
     */
    prompt() {
      return new Promise((resolve) => {
        this.value = '';
        this.error = null;
        this._resolve = resolve;
        this.open = true;
        this.$nextTick(() => {
          const input = this.$refs.usernameInput;
          if (input) input.focus();
        });
      });
    },

    confirm() {
      const trimmed = this.value.trim().toLowerCase();
      if (!trimmed) {
        this.error = 'Username cannot be empty.';
        return;
      }
      this.open = false;
      if (this._resolve) {
        this._resolve(trimmed);
        this._resolve = null;
      }
    },

    cancel() {
      this.open = false;
      if (this._resolve) {
        this._resolve(null);
        this._resolve = null;
      }
    },

    handleKeydown(e) {
      if (e.key === 'Escape') this.cancel();
    },

    handleInputKeydown(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.confirm();
      }
    },

    handleBackdropClick(e) {
      if (e.target === e.currentTarget) this.cancel();
    },
  }));
}

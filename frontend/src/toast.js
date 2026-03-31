import Alpine from 'alpinejs';

const MAX_TOASTS = 3;
const AUTO_DISMISS_MS = 5000;
const ANIMATION_MS = 300;
let nextId = 0;

export function initToast() {
  Alpine.store('toast', {
    items: [],

    show(message, type = 'info') {
      const id = nextId++;
      this.items.push({ id, message, type, removing: false });

      // Enforce max toasts
      while (this.items.length > MAX_TOASTS) {
        this.items.shift();
      }

      // Auto-dismiss
      setTimeout(() => {
        this.dismiss(id);
      }, AUTO_DISMISS_MS);
    },

    dismiss(id) {
      const item = this.items.find((t) => t.id === id);
      if (!item || item.removing) return;
      item.removing = true;
      setTimeout(() => {
        this.items = this.items.filter((t) => t.id !== id);
      }, ANIMATION_MS);
    },
  });
}

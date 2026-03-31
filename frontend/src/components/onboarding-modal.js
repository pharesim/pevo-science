import Alpine from 'alpinejs';

const DISMISSED_KEY = 'pevo_onboarding_dismissed';

export function initOnboardingModal() {
  Alpine.data('onboardingModal', () => ({
    open: false,

    init() {
      // Watch for auth connection — show modal on first connect if not dismissed
      this.$watch('$store.auth.isConnected', (connected) => {
        if (!connected) return;
        try {
          if (!localStorage.getItem(DISMISSED_KEY)) {
            this.open = true;
          }
        } catch {
          // localStorage unavailable
        }
      });
    },

    get isAccredited() {
      return this.$store.auth.isAccredited;
    },

    dismiss() {
      this.open = false;
      try {
        localStorage.setItem(DISMISSED_KEY, '1');
      } catch {
        // localStorage unavailable
      }
    },

    navigateAndDismiss(path) {
      this.dismiss();
      this.$store.router.navigate(path);
    },

    handleBackdropClick(e) {
      if (e.target === e.currentTarget) this.dismiss();
    },

    handleKeydown(e) {
      if (e.key === 'Escape') this.dismiss();
    },
  }));
}

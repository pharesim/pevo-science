import Alpine from 'alpinejs';

export function initFooter() {
  Alpine.data('footer', () => ({
    navigate(path) {
      this.$store.router.navigate(path);
    },
  }));
}

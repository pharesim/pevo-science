import Alpine from 'alpinejs';
import { SUPPORTED_LOCALES } from '../i18n.js';

export function initHeader() {
  Alpine.data('header', () => ({
    mobileMenuOpen: false,
    moreOpen: false,
    userMenuOpen: false,
    langOpen: false,

    get primaryLinks() {
      return [
        { path: '/papers', label: this.$t('nav.papers') },
        { path: '/search', label: this.$t('nav.search') },
        { path: '/researchers', label: this.$t('nav.researchers') },
      ];
    },

    get moreLinks() {
      return [
        { path: '/publish', label: this.$t('nav.publish') },
        { path: '/bridge', label: this.$t('bridge.navLabel') },
        { path: '/accreditation', label: this.$t('nav.accreditation') },
        { path: '/about', label: this.$t('nav.about') },
        { path: '/getting-started', label: this.$t('nav.gettingStarted') },
        { path: '/faq', label: this.$t('nav.faq') },
        { path: '/blog', label: this.$t('nav.blog') },
        { path: '/stats', label: this.$t('nav.stats') },
      ];
    },

    get allLinks() {
      return [...this.primaryLinks, ...this.moreLinks];
    },

    get locales() {
      return SUPPORTED_LOCALES;
    },

    get currentLocale() {
      return this.$store.i18n.locale;
    },

    localeName(locale) {
      return this.$t('locale.' + locale);
    },

    navigate(path) {
      this.$store.router.navigate(path);
      this.mobileMenuOpen = false;
      this.moreOpen = false;
    },

    async handleSignIn() {
      try {
        await this.$store.auth.connect();
      } catch (err) {
        console.warn('[header sign in]', err);
        this.$store.toast.show(this.$t('common.connectionFailed'), 'error');
      }
    },

    // Keep old name as alias for any remaining references
    async handleConnect() { return this.handleSignIn(); },

    handleDisconnect() {
      this.$store.auth.disconnect();
      this.$store.notifications.stop();
      this.mobileMenuOpen = false;
    },

    toggleUserMenu() {
      this.userMenuOpen = !this.userMenuOpen;
    },

    selectLocale(locale) {
      this.$store.i18n.setLocale(locale);
      this.langOpen = false;
    },

    formatNotification(event) {
      if (!event || !event.type) return '';
      if (event.type === 'new_vote') {
        const key = event.weight < 0 ? 'notifications.newDownvote' : 'notifications.newVote';
        return this.$t(key, {
          actor: event.actor || '',
          targetType: event.target_type || '',
        });
      }
      const typeMap = {
        new_review: 'notifications.newReview',
        new_citation: 'notifications.newCitation',
        new_vouch: 'notifications.newVouch',
        new_reply: 'notifications.newReply',
      };
      if (event.type === 'accreditation_update') {
        const key = event.action === 'revoke'
          ? 'notifications.accreditationRevoked'
          : 'notifications.accreditationGranted';
        return this.$t(key);
      }
      const key = typeMap[event.type];
      if (!key) return event.type;
      return this.$t(key, {
        actor: event.actor || '',
        title: event.paper_title || '',
        targetType: event.target_type || '',
        relationship: event.relationship || '',
      });
    },

  }));
}

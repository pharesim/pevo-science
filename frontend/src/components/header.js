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
        { path: '/', label: this.$t('nav.papers') },
        { path: '/search', label: this.$t('nav.search') },
        { path: '/researchers', label: this.$t('nav.researchers') },
      ];
    },

    get moreLinks() {
      const links = [
        { path: '/publish', label: this.$t('nav.publish') },
      ];
      if (this.$store.auth.isConnected) {
        links.push({ path: '/bridge', label: this.$t('bridge.navLabel') });
      }
      links.push(
        { path: '/accreditation', label: this.$t('nav.accreditation') },
        { path: '/stats', label: this.$t('nav.stats') },
        { path: '/getting-started', label: this.$t('nav.gettingStarted') },
        { path: '/faq', label: this.$t('nav.faq') },
        { path: '/about', label: this.$t('nav.about') },
      );
      return links;
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

    async handleConnect() {
      try {
        await this.$store.auth.connect();
      } catch (err) {
        const msg = err instanceof Error ? err.message : this.$t('common.connectionFailed');
        this.$store.toast.show(msg, 'error');
      }
    },

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
      const typeMap = {
        new_review: 'notifications.newReview',
        new_citation: 'notifications.newCitation',
        new_vote: 'notifications.newVote',
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
        title: event.title || '',
        targetType: event.targetType || '',
        relationship: event.relationship || '',
      });
    },

    closeMoreOnClickOutside(event) {
      if (this.moreOpen) this.moreOpen = false;
    },

    closeLangOnClickOutside(event) {
      if (this.langOpen) this.langOpen = false;
    },
  }));
}

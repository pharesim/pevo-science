import Alpine from 'alpinejs';
import { getDiscordUrl } from '../config.js';

export function initGettingStartedPage() {
  Alpine.data('gettingStartedPage', () => ({
    discordUrl: getDiscordUrl(),
    path: 'quick', // 'quick' or 'keychain'

    stepDescription(key) {
      const text = this.$t('gettingStarted.' + key + 'Description');
      if (key === 'kc2' && this.discordUrl) {
        return text.replace('Discord', `<a href="${this.discordUrl}" target="_blank" rel="noopener noreferrer" class="text-pevo-teal hover:underline">Discord</a>`);
      }
      return text;
    },

    get quickSteps() {
      return [
        { key: 'q1', link: { href: '/signup', external: false, labelKey: 'gettingStarted.q1Link' }, dotClass: 'bg-pevo-teal' },
        { key: 'q2', link: null, dotClass: 'bg-pevo-green' },
        { key: 'q3', link: { href: '/publish', external: false, labelKey: 'gettingStarted.q3Link' }, dotClass: 'bg-pevo-crimson' },
      ];
    },

    get keychainSteps() {
      return [
        { key: 'kc1', link: { href: 'https://hive-keychain.com/', external: true, labelKey: 'gettingStarted.kc1Link' }, dotClass: 'bg-pevo-teal' },
        { key: 'kc2', link: { href: 'https://signup.hive.io/', external: true, labelKey: 'gettingStarted.kc2Link' }, dotClass: 'bg-pevo-green' },
        { key: 'kc3', link: null, dotClass: 'bg-pevo-crimson' },
        { key: 'kc4', link: { href: '/accreditation', external: false, labelKey: 'gettingStarted.kc4Link' }, dotClass: 'bg-pevo-teal' },
        { key: 'kc5', link: { href: '/publish', external: false, labelKey: 'gettingStarted.kc5Link' }, dotClass: 'bg-pevo-green' },
      ];
    },

    get steps() {
      return this.path === 'quick' ? this.quickSteps : this.keychainSteps;
    },

    tips: ['tip1', 'tip2', 'tip3', 'tip4', 'tip5'],

    navigate(path) {
      this.$store.router.navigate(path);
    },
  }));
}

import Alpine from 'alpinejs';
import { getDiscordUrl } from '../config.js';

export function initGettingStartedPage() {
  Alpine.data('gettingStartedPage', () => ({
    discordUrl: getDiscordUrl(),
    steps: [
      { key: 'step1', link: { href: 'https://hive-keychain.com/', external: true, labelKey: 'gettingStarted.step1Link' }, dotClass: 'bg-pevo-teal' },
      { key: 'step2', link: { href: 'https://signup.hive.io/', external: true, labelKey: 'gettingStarted.step2Link' }, dotClass: 'bg-pevo-green' },
      { key: 'step3', link: null, dotClass: 'bg-pevo-crimson' },
      { key: 'step4', link: { href: '/accreditation', external: false, labelKey: 'gettingStarted.step4Link' }, dotClass: 'bg-pevo-teal' },
      { key: 'step5', link: { href: '/publish', external: false, labelKey: 'gettingStarted.step5Link' }, dotClass: 'bg-pevo-green' },
      { key: 'step6', link: { href: '/search', external: false, labelKey: 'gettingStarted.step6Link' }, dotClass: 'bg-pevo-crimson' },
      { key: 'step7', link: null, dotClass: 'bg-pevo-teal' },
    ],

    tips: ['tip1', 'tip2', 'tip3', 'tip4', 'tip5'],

    navigate(path) {
      this.$store.router.navigate(path);
    },
  }));
}

import Alpine from 'alpinejs';
import { getDiscordUrl } from '../config.js';

const template = `
      <div x-data="gettingStartedPage">
        <!-- Header -->
        <section class="relative bg-white border-b border-parchment-dark overflow-hidden">
          <div class="absolute inset-0 geo-pattern opacity-60"></div>
          <div class="container-narrow relative py-12 sm:py-16">
            <h1 class="text-3xl sm:text-4xl font-bold text-ink mb-3" x-text="$t('gettingStarted.title')"></h1>
            <p class="text-lg text-ink-muted max-w-2xl" x-text="$t('gettingStarted.description')"></p>
          </div>
        </section>

        <!-- Steps -->
        <div class="container-narrow py-10">
          <!-- Path switcher -->
          <div class="flex gap-3 mb-8">
            <button class="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                    :class="path === 'quick' ? 'bg-pevo-teal text-white' : 'bg-parchment-warm text-ink-muted hover:text-ink'"
                    @click="path = 'quick'" x-text="$t('gettingStarted.quickPath')"></button>
            <button class="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                    :class="path === 'keychain' ? 'bg-pevo-teal text-white' : 'bg-parchment-warm text-ink-muted hover:text-ink'"
                    @click="path = 'keychain'" x-text="$t('gettingStarted.keychainPath')"></button>
          </div>
          <p class="text-sm text-ink-muted mb-6" x-text="path === 'quick' ? $t('gettingStarted.quickPathDescription') : $t('gettingStarted.keychainPathDescription')"></p>

          <div class="space-y-8">
            <template x-for="s in steps" :key="s.key">
              <div class="card">
                <div class="flex items-start gap-4">
                  <div class="flex-shrink-0 w-3 h-3 rounded-full mt-1.5" :class="s.dotClass"></div>
                  <div class="flex-1">
                    <h2 class="text-lg font-semibold text-ink mb-2" x-text="$t('gettingStarted.' + s.key + 'Title')"></h2>
                    <p class="text-sm text-ink-muted leading-relaxed mb-3" x-html="stepDescription(s.key)"></p>
                    <template x-if="s.link && s.link.external">
                      <a :href="s.link.href" target="_blank" rel="noopener noreferrer"
                         class="btn-primary text-sm no-underline inline-block"
                         x-text="$t(s.link.labelKey)"></a>
                    </template>
                    <template x-if="s.link && !s.link.external">
                      <a :href="s.link.href" @click.prevent="navigate(s.link.href)"
                         class="btn-primary text-sm no-underline inline-block"
                         x-text="$t(s.link.labelKey)"></a>
                    </template>
                  </div>
                </div>
              </div>
            </template>
          </div>

          <!-- Tips -->
          <div class="mt-12">
            <h2 class="text-2xl font-bold text-ink mb-6" x-text="$t('gettingStarted.tipsTitle')"></h2>
            <div class="card">
              <ul class="space-y-3">
                <template x-for="tip in tips" :key="tip">
                  <li class="flex items-start gap-3 text-sm text-ink-muted">
                    <svg class="w-5 h-5 text-pevo-green flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
                    </svg>
                    <span x-text="$t('gettingStarted.' + tip)"></span>
                  </li>
                </template>
              </ul>
            </div>
          </div>
        </div>
      </div>
`;

export { template as gettingStartedPageTemplate };

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

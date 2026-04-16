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

        <!-- Comparison cards -->
        <div class="container-narrow py-10">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-12">
            <!-- Quick start card -->
            <div class="card cursor-pointer border-2 transition-colors"
                 :class="path === 'quick' ? 'border-pevo-teal' : 'border-transparent hover:border-parchment-dark'"
                 @click="path = 'quick'; $nextTick(() => $refs.steps.scrollIntoView({ behavior: 'smooth' }))">
              <div class="flex items-center gap-3 mb-4">
                <div class="w-12 h-12 rounded-full bg-pevo-teal/10 flex items-center justify-center flex-shrink-0">
                  <svg class="w-6 h-6 text-pevo-teal" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                  </svg>
                </div>
                <h2 class="text-xl font-bold text-ink" x-text="$t('gettingStarted.quickCardTitle')"></h2>
              </div>
              <p class="text-sm text-ink-muted mb-4" x-text="$t('gettingStarted.quickCardSummary')"></p>
              <ul class="space-y-2 mb-6">
                <template x-for="i in 4" :key="'qb'+i">
                  <li class="flex items-center gap-2 text-sm text-ink-muted">
                    <svg class="w-4 h-4 text-pevo-green flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                    <span x-text="$t('gettingStarted.quickCardBullet' + i)"></span>
                  </li>
                </template>
              </ul>
              <span class="btn-primary text-sm no-underline inline-block" x-text="$t('gettingStarted.quickCardCta') + ' →'"></span>
            </div>

            <!-- Full custody card -->
            <div class="card cursor-pointer border-2 transition-colors"
                 :class="path === 'keychain' ? 'border-pevo-teal' : 'border-transparent hover:border-parchment-dark'"
                 @click="path = 'keychain'; $nextTick(() => $refs.steps.scrollIntoView({ behavior: 'smooth' }))">
              <div class="flex items-center gap-3 mb-4">
                <div class="w-12 h-12 rounded-full bg-pevo-teal/10 flex items-center justify-center flex-shrink-0">
                  <svg class="w-6 h-6 text-pevo-teal" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
                  </svg>
                </div>
                <h2 class="text-xl font-bold text-ink" x-text="$t('gettingStarted.fullCustodyCardTitle')"></h2>
              </div>
              <p class="text-sm text-ink-muted mb-4" x-text="$t('gettingStarted.fullCustodyCardSummary')"></p>
              <ul class="space-y-2 mb-6">
                <template x-for="i in 4" :key="'fcb'+i">
                  <li class="flex items-center gap-2 text-sm text-ink-muted">
                    <svg class="w-4 h-4 text-pevo-green flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                    <span x-text="$t('gettingStarted.fullCustodyCardBullet' + i)"></span>
                  </li>
                </template>
              </ul>
              <span class="btn-primary text-sm no-underline inline-block" x-text="$t('gettingStarted.fullCustodyCardCta') + ' →'"></span>
            </div>
          </div>

          <!-- Steps -->
          <div x-ref="steps" id="steps">
            <!-- Path switcher tabs -->
            <div class="flex gap-3 mb-8">
              <button class="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                      :class="path === 'quick' ? 'bg-pevo-teal text-white' : 'bg-parchment-warm text-ink-muted hover:text-ink'"
                      @click="path = 'quick'" x-text="$t('gettingStarted.quickPath')"></button>
              <button class="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                      :class="path === 'keychain' ? 'bg-pevo-teal text-white' : 'bg-parchment-warm text-ink-muted hover:text-ink'"
                      @click="path = 'keychain'" x-text="$t('gettingStarted.fullCustodyPath')"></button>
            </div>

            <div class="space-y-6">
              <template x-for="s in steps" :key="s.key">
                <div class="card">
                  <div class="flex items-start gap-4">
                    <div class="flex-shrink-0 w-12 h-12 rounded-full flex items-center justify-center" :class="s.iconBg">
                      <svg class="w-8 h-8" :class="s.iconColor" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" :d="s.iconPath" />
                      </svg>
                    </div>
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

            <!-- Upgrade callout (quick start only) -->
            <template x-if="path === 'quick'">
              <div class="mt-8 p-6 rounded-xl bg-parchment-warm border border-parchment-dark">
                <h3 class="text-base font-semibold text-ink mb-2" x-text="$t('gettingStarted.upgradeCalloutTitle')"></h3>
                <p class="text-sm text-ink-muted leading-relaxed" x-text="$t('gettingStarted.upgradeCallout')"></p>
              </div>
            </template>
          </div>

          <!-- Capabilities -->
          <div class="mt-12">
            <h2 class="text-2xl font-bold text-ink mb-6" x-text="$t('gettingStarted.capabilitiesTitle')"></h2>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <template x-for="cap in capabilities" :key="cap.key">
                <div class="card">
                  <div class="flex items-start gap-4">
                    <div class="flex-shrink-0 w-12 h-12 rounded-full bg-parchment-warm flex items-center justify-center">
                      <svg class="w-6 h-6 text-pevo-teal" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" :d="cap.iconPath" />
                      </svg>
                    </div>
                    <div>
                      <h3 class="text-base font-semibold text-ink mb-1" x-text="$t('gettingStarted.' + cap.key + 'Title')"></h3>
                      <p class="text-sm text-ink-muted leading-relaxed" x-text="$t('gettingStarted.' + cap.key + 'Description')"></p>
                    </div>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>
`;

export { template as gettingStartedPageTemplate };

// SVG icon paths (Heroicons outline)
const ICONS = {
  envelope: 'M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75',
  shieldCheck: 'M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z',
  documentText: 'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z',
  puzzlePiece: 'M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 01-.657.643 48.39 48.39 0 01-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 01-.658.663v0c-.355 0-.676-.186-.959-.401a1.647 1.647 0 00-1.003-.349c-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.039 48.039 0 01-.642 5.056c1.518.19 3.058.309 4.616.354a.64.64 0 00.657-.643v0c0-.355-.186-.676-.401-.959a1.647 1.647 0 01-.349-1.003c0-1.035 1.008-1.875 2.25-1.875 1.243 0 2.25.84 2.25 1.875 0 .369-.128.713-.349 1.003-.215.283-.401.604-.401.959v0c0 .333.277.599.61.58a48.1 48.1 0 005.427-.63 48.05 48.05 0 00.582-4.717.532.532 0 00-.533-.57v0c-.355 0-.676.186-.959.401-.29.221-.634.349-1.003.349-1.035 0-1.875-1.007-1.875-2.25s.84-2.25 1.875-2.25c.37 0 .713.128 1.003.349.283.215.604.401.959.401v0a.656.656 0 00.658-.663 48.422 48.422 0 00-.37-5.36c-1.886.342-3.81.574-5.766.689a.578.578 0 01-.61-.58v0z',
  userPlus: 'M19 7.5v3m3-3h-3m-2.25-4.5a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z',
  arrowRightOnRect: 'M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9',
  badgeCheck: 'M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z',
  // Capability icons
  pencilSquare: 'M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10',
  chatBubble: 'M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155',
  chartBar: 'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z',
  magnifyingGlass: 'M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z',
};

export function initGettingStartedPage() {
  Alpine.data('gettingStartedPage', () => ({
    discordUrl: getDiscordUrl(),
    path: 'quick',

    stepDescription(key) {
      const text = this.$t('gettingStarted.' + key + 'Description');
      if (key === 'fc2' && this.discordUrl) {
        return text.replace('Discord', `<a href="${this.discordUrl}" target="_blank" rel="noopener noreferrer" class="text-pevo-teal hover:underline">Discord</a>`);
      }
      return text;
    },

    get quickSteps() {
      return [
        { key: 'q1', iconPath: ICONS.envelope, iconBg: 'bg-pevo-teal/10', iconColor: 'text-pevo-teal', link: { href: '/signup', external: false, labelKey: 'gettingStarted.q1Link' } },
        { key: 'q2', iconPath: ICONS.shieldCheck, iconBg: 'bg-pevo-green/10', iconColor: 'text-pevo-green', link: null },
        { key: 'q3', iconPath: ICONS.documentText, iconBg: 'bg-pevo-crimson/10', iconColor: 'text-pevo-crimson', link: { href: '/publish', external: false, labelKey: 'gettingStarted.q3Link' } },
      ];
    },

    get keychainSteps() {
      return [
        { key: 'fc1', iconPath: ICONS.puzzlePiece, iconBg: 'bg-pevo-teal/10', iconColor: 'text-pevo-teal', link: { href: 'https://hive-keychain.com/', external: true, labelKey: 'gettingStarted.fc1Link' } },
        { key: 'fc2', iconPath: ICONS.userPlus, iconBg: 'bg-pevo-green/10', iconColor: 'text-pevo-green', link: { href: 'https://signup.hive.io/', external: true, labelKey: 'gettingStarted.fc2Link' } },
        { key: 'fc3', iconPath: ICONS.arrowRightOnRect, iconBg: 'bg-pevo-crimson/10', iconColor: 'text-pevo-crimson', link: null },
        { key: 'fc4', iconPath: ICONS.badgeCheck, iconBg: 'bg-pevo-teal/10', iconColor: 'text-pevo-teal', link: { href: '/accreditation', external: false, labelKey: 'gettingStarted.fc4Link' } },
        { key: 'fc5', iconPath: ICONS.documentText, iconBg: 'bg-pevo-green/10', iconColor: 'text-pevo-green', link: { href: '/publish', external: false, labelKey: 'gettingStarted.fc5Link' } },
      ];
    },

    get steps() {
      return this.path === 'quick' ? this.quickSteps : this.keychainSteps;
    },

    capabilities: [
      { key: 'cap1', iconPath: ICONS.pencilSquare },
      { key: 'cap2', iconPath: ICONS.chatBubble },
      { key: 'cap3', iconPath: ICONS.chartBar },
      { key: 'cap4', iconPath: ICONS.magnifyingGlass },
    ],

    navigate(path) {
      this.$store.router.navigate(path);
    },
  }));
}

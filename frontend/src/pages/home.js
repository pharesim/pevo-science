import Alpine from 'alpinejs';
import { paperFeedTemplate } from '../components/paper-feed.js';

const template = `
      <div x-data="homePage">
        <!-- Landing section for unauthenticated users -->
        <template x-if="!$store.auth.isConnected">
          <div>
            <!-- Hero -->
            <section class="relative bg-white border-b border-parchment-dark overflow-hidden">
              <div class="absolute inset-0 geo-pattern opacity-60"></div>
              <div class="container-narrow relative py-12 sm:py-16">
                <div class="flex flex-col sm:flex-row items-center gap-8">
                  <div class="flex-1">
                    <!-- x-html intentional: heroTitle uses <highlight> for styled emphasis -->
                    <h1 class="text-4xl sm:text-5xl font-bold text-ink mb-4 leading-tight" x-html="$t('common.heroTitle')"></h1>
                    <p class="text-lg text-ink-muted mb-6 max-w-lg" x-text="$t('common.heroDescription')"></p>
                    <div class="flex flex-wrap gap-3">
                      <a :href="$lp('/papers')" @click.prevent="navigate('/papers')" class="btn-primary no-underline" x-text="$t('landing.browsePapers')"></a>
                      <a :href="$lp('/about')" @click.prevent="navigate('/about')" class="btn-secondary no-underline" x-text="$t('home.learnMore')"></a>
                    </div>
                  </div>
                  <div class="shrink-0 hidden md:block">
                    <img src="/images/pevo-logo.png" alt="PEvO" width="160" height="160" class="opacity-90" />
                  </div>
                </div>
              </div>
            </section>

            <!-- How it works -->
            <div class="container-narrow py-10">
              <h2 class="text-2xl font-bold text-ink mb-6 text-center" x-text="$t('landing.howItWorksTitle')"></h2>
              <p class="text-ink-muted text-center mb-8 max-w-2xl mx-auto" x-text="$t('landing.howItWorksDescription')"></p>
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-6">
                <div class="card text-center">
                  <div class="flex items-center justify-center w-10 h-10 rounded-full bg-pevo-green text-white text-lg font-bold mx-auto mb-3">1</div>
                  <h3 class="text-lg font-semibold text-ink mb-2" x-text="$t('landing.step1Title')"></h3>
                  <p class="text-sm text-ink-muted" x-text="$t('landing.step1Description')"></p>
                </div>
                <div class="card text-center">
                  <div class="flex items-center justify-center w-10 h-10 rounded-full bg-pevo-teal text-white text-lg font-bold mx-auto mb-3">2</div>
                  <h3 class="text-lg font-semibold text-ink mb-2" x-text="$t('landing.step2Title')"></h3>
                  <p class="text-sm text-ink-muted" x-text="$t('landing.step2Description')"></p>
                </div>
                <div class="card text-center">
                  <div class="flex items-center justify-center w-10 h-10 rounded-full bg-pevo-crimson text-white text-lg font-bold mx-auto mb-3">3</div>
                  <h3 class="text-lg font-semibold text-ink mb-2" x-text="$t('landing.step3Title')"></h3>
                  <p class="text-sm text-ink-muted" x-text="$t('landing.step3Description')"></p>
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- Authenticated: paper feed -->
        <template x-if="$store.auth.isConnected">
          <div>
            <!-- Hero -->
            <section class="relative bg-white border-b border-parchment-dark overflow-hidden">
              <div class="absolute inset-0 geo-pattern opacity-60"></div>
              <div class="container-narrow relative py-12 sm:py-16">
                <div class="flex flex-col sm:flex-row items-center gap-8">
                  <div class="flex-1">
                    <!-- x-html intentional: heroTitle uses <highlight> for styled emphasis -->
                    <h1 class="text-4xl sm:text-5xl font-bold text-ink mb-4 leading-tight" x-html="$t('common.heroTitle')"></h1>
                    <p class="text-lg text-ink-muted mb-6 max-w-lg" x-text="$t('common.heroDescription')"></p>
                    <div class="flex flex-wrap gap-3">
                      <a :href="$lp('/publish')" @click.prevent="navigate('/publish')" class="btn-primary no-underline" x-text="$t('home.publishPaper')"></a>
                      <a :href="$lp('/about')" @click.prevent="navigate('/about')" class="btn-secondary no-underline" x-text="$t('home.learnMore')"></a>
                    </div>
                  </div>
                  <div class="shrink-0 hidden md:block">
                    <img src="/images/pevo-logo.png" alt="PEvO" width="160" height="160" class="opacity-90" />
                  </div>
                </div>
              </div>
            </section>

            <!-- Paper Feed -->
            <div class="container-narrow py-8">
              <div class="mb-6">
                <h2 class="text-2xl font-bold text-ink mb-1" x-text="$t('home.feedTitle')"></h2>
                <p class="text-sm text-ink-muted" x-text="$t('home.feedDescription')"></p>
              </div>
              <div x-data="paperFeed">${paperFeedTemplate}</div>
            </div>
          </div>
        </template>
      </div>
`;

export { template as homePageTemplate };

export function initHomePage() {
  Alpine.data('homePage', () => ({
    navigate(path) {
      this.$store.router.navigate(path);
    },
  }));
}

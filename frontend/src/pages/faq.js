import Alpine from 'alpinejs';

const template = `
      <div x-data="faqPage">
        <!-- Header -->
        <section class="relative bg-white border-b border-parchment-dark overflow-hidden">
          <div class="absolute inset-0 geo-pattern opacity-60"></div>
          <div class="container-narrow relative py-12 sm:py-16">
            <h1 class="text-3xl sm:text-4xl font-bold text-ink mb-3" x-text="$t('faq.title')"></h1>
            <p class="text-lg text-ink-muted max-w-2xl" x-text="$t('faq.description')"></p>
          </div>
        </section>

        <!-- FAQ Items -->
        <div class="container-narrow py-10">
          <div class="space-y-3">
            <template x-for="(i, idx) in Array.from({length: 14}, (_, k) => k + 1)" :key="i">
              <div class="card p-0 overflow-hidden">
                <button class="w-full flex items-center justify-between p-5 text-left hover:bg-parchment transition-colors"
                        @click="toggle(idx)" :aria-expanded="openIndex === idx">
                  <span class="text-sm font-semibold text-ink pr-4" x-text="$t('faq.q' + i)"></span>
                  <svg class="w-5 h-5 text-ink-muted flex-shrink-0 transition-transform"
                       :class="openIndex === idx ? 'rotate-180' : ''"
                       fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </button>
                <div x-show="openIndex === idx" x-transition class="px-5 pb-5 border-t border-parchment-dark">
                  <p class="text-sm text-ink-muted leading-relaxed pt-4" x-text="$t('faq.a' + i)"></p>
                </div>
              </div>
            </template>
          </div>

          <!-- Contact CTA -->
          <div class="card p-6 text-center mt-8">
            <p class="text-lg font-semibold text-ink mb-2" x-text="$t('faq.ctaTitle')"></p>
            <p class="text-sm text-ink-muted mb-4" x-text="$t('faq.ctaDescription')"></p>
            <a :href="$lp('/contact')" @click.prevent="$store.router.navigate('/contact')"
               class="btn-primary inline-block no-underline" x-text="$t('faq.ctaButton')"></a>
          </div>
        </div>
      </div>
`;

export { template as faqPageTemplate };

export function initFaqPage() {
  Alpine.data('faqPage', () => ({
    openIndex: null,

    toggle(idx) {
      this.openIndex = this.openIndex === idx ? null : idx;
    },
  }));
}

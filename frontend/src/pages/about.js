import Alpine from 'alpinejs';

const template = `
  <div x-data="aboutPage" class="container-narrow py-8">
    <!-- Hero -->
    <div class="relative rounded-xl overflow-hidden mb-10">
      <picture>
        <source srcset="/images/hero-banner.webp" type="image/webp" />
        <img src="/images/hero-banner.png" alt="The Future of Scientific Publishing - pevo.science"
             class="w-full h-auto" loading="lazy" decoding="async" />
      </picture>
    </div>

    <div class="max-w-reading mx-auto">
      <h1 class="text-3xl font-bold text-ink mb-6" x-text="$t('about.title')"></h1>

      <div class="prose prose-ink space-y-8 text-ink-light text-[0.95rem] leading-relaxed">
        <section>
          <h2 class="text-section-title text-ink font-serif mt-0" x-text="$t('about.whatIsTitle')"></h2>
          <p x-html="$t('about.whatIsDescription')"></p>
        </section>

        <section>
          <h2 class="text-section-title text-ink font-serif" x-text="$t('about.whyTitle')"></h2>
          <p x-text="$t('about.whyDescription')"></p>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4 not-prose">
            <div class="rounded-lg bg-pevo-teal-light border border-pevo-teal/20 p-4">
              <p class="text-sm font-semibold text-pevo-teal mb-1" x-text="$t('about.noPaywalls')"></p>
              <p class="text-xs text-ink-muted" x-text="$t('about.noPaywallsDesc')"></p>
            </div>
            <div class="rounded-lg bg-pevo-green-light border border-pevo-green/20 p-4">
              <p class="text-sm font-semibold text-pevo-green-dark mb-1" x-text="$t('about.transparentReview')"></p>
              <p class="text-xs text-ink-muted" x-text="$t('about.transparentReviewDesc')"></p>
            </div>
            <div class="rounded-lg bg-pevo-crimson-light border border-pevo-crimson/20 p-4">
              <p class="text-sm font-semibold text-pevo-crimson mb-1" x-text="$t('about.noGatekeepers')"></p>
              <p class="text-xs text-ink-muted" x-text="$t('about.noGatekeepersDesc')"></p>
            </div>
            <div class="rounded-lg bg-parchment-warm border border-parchment-dark p-4">
              <p class="text-sm font-semibold text-ink mb-1" x-text="$t('about.immutableRecord')"></p>
              <p class="text-xs text-ink-muted" x-text="$t('about.immutableRecordDesc')"></p>
            </div>
          </div>
        </section>

        <!-- How it works infographic -->
        <section class="not-prose">
          <h2 class="text-section-title text-ink font-serif mb-4" x-text="$t('about.howItWorks')"></h2>
          <div class="rounded-xl overflow-hidden border border-parchment-dark">
            <picture>
              <source srcset="/images/infographic-publishing.webp" type="image/webp" />
              <img src="/images/infographic-publishing.jpg"
                   alt="PEvO publishing process"
                   class="w-full h-auto" loading="lazy" decoding="async" />
            </picture>
          </div>
          <p class="text-xs text-ink-muted mt-2 text-center" x-text="$t('about.howItWorksCaption')"></p>
        </section>

        <section>
          <h2 class="text-section-title text-ink font-serif" x-text="$t('about.processTitle')"></h2>
          <ul class="space-y-4 list-none pl-0">
            <li class="flex gap-3">
              <span class="flex items-center justify-center w-8 h-8 rounded-full bg-pevo-green text-white text-sm font-bold shrink-0">1</span>
              <div><strong class="text-ink" x-text="$t('about.step1Title')"></strong> <span x-text="$t('about.step1Desc')"></span></div>
            </li>
            <li class="flex gap-3">
              <span class="flex items-center justify-center w-8 h-8 rounded-full bg-pevo-teal text-white text-sm font-bold shrink-0">2</span>
              <div><strong class="text-ink" x-text="$t('about.step2Title')"></strong> <span x-text="$t('about.step2Desc')"></span></div>
            </li>
            <li class="flex gap-3">
              <span class="flex items-center justify-center w-8 h-8 rounded-full bg-pevo-crimson text-white text-sm font-bold shrink-0">3</span>
              <div><strong class="text-ink" x-text="$t('about.step3Title')"></strong> <span x-text="$t('about.step3Desc')"></span></div>
            </li>
          </ul>
        </section>

        <!-- Architecture infographic -->
        <section class="not-prose">
          <h2 class="text-section-title text-ink font-serif mb-4" x-text="$t('about.architectureTitle')"></h2>
          <div class="rounded-xl overflow-hidden border border-parchment-dark">
            <picture>
              <source srcset="/images/infographic-architecture.webp" type="image/webp" />
              <img src="/images/infographic-architecture.jpg"
                   alt="PEvO architecture"
                   class="w-full h-auto" loading="lazy" decoding="async" />
            </picture>
          </div>
          <p class="text-xs text-ink-muted mt-2 text-center" x-text="$t('about.architectureCaption')"></p>
        </section>

        <section>
          <h2 class="text-section-title text-ink font-serif" x-text="$t('about.accreditationTitle')"></h2>
          <p x-text="$t('about.accreditationDesc')"></p>
        </section>

        <section>
          <h2 class="text-section-title text-ink font-serif" x-text="$t('about.openSourceTitle')"></h2>
          <p x-text="$t('about.openSourceDesc')"></p>
        </section>

        <section class="not-prose" x-data="{
          platforms: ['pevo','arxiv','f1000','scienceopen','pubpeer','octopus','scihub','scinet','traditional'],
          headers: ['PEvO','cmpArxiv','cmpF1000','cmpScienceOpen','cmpPubPeer','cmpOctopus','cmpScihub','cmpScinet','cmpTraditional'],
          rows: [
            { key: 'cmpPublishing',   vals: ['yes','partial','no','partial','na','yes','na','na','no'] },
            { key: 'cmpRatings',      vals: ['yes','no','yes','partial','no','partial','na','na','partial'] },
            { key: 'cmpOpenSource',    vals: ['yes','no','no','no','no','yes','no','no','no'] },
            { key: 'cmpImmutable',     vals: ['yes','no','no','no','no','no','no','no','no'] },
            { key: 'cmpNonProfit',     vals: ['yes','yes','partial','no','yes','yes','yes','yes','no'] },
            { key: 'cmpTransparent',   vals: ['yes','no','yes','yes','yes','yes','na','na','no'] },
            { key: 'cmpVersioning',    vals: ['yes','yes','partial','partial','na','partial','na','na','partial'] },
            { key: 'cmpOrcid',         vals: ['partial','yes','yes','yes','no','yes','no','no','yes'] },
            { key: 'cmpAccreditation', vals: ['yes','na','partial','partial','no','no','na','na','partial'] },
            { key: 'cmpAnonymous',     vals: ['yes','na','partial','partial','yes','partial','na','yes','yes'] }
          ],
          tip(rowKey, platIdx) {
            const k = 'about.tip_' + rowKey.replace('cmp','') + '_' + this.platforms[platIdx];
            const t = $t(k);
            return t !== k ? t : '';
          },
          sym(v) { return v === 'yes' ? '\u2713' : v === 'partial' ? '\u2713' : v === 'no' ? '\u2717' : '\u2014'; },
          cls(v) { return v === 'yes' ? 'text-pevo-green' : v === 'partial' ? 'text-amber-500' : v === 'no' ? 'text-pevo-crimson' : 'text-ink-muted'; }
        }">
          <h2 class="text-section-title text-ink font-serif mb-4" x-text="$t('about.comparisonTitle')"></h2>
          <p class="text-sm text-ink-muted mb-4" x-text="$t('about.comparisonSubtitle')"></p>
          <div class="overflow-x-auto -mx-4 px-4">
            <table class="w-full text-sm border-collapse">
              <thead>
                <tr class="border-b border-parchment-dark">
                  <th class="text-left py-2 px-3 font-medium text-ink sticky left-0 bg-white z-10"></th>
                  <template x-for="(h, i) in headers" :key="h">
                    <th class="py-2 px-3 font-medium whitespace-nowrap"
                        :class="i === 0 ? 'text-ink bg-pevo-teal-light/30' : 'text-ink-muted'"
                        x-text="i === 0 ? h : $t('about.' + h)"></th>
                  </template>
                </tr>
              </thead>
              <tbody class="divide-y divide-parchment">
                <template x-for="row in rows" :key="row.key">
                  <tr>
                    <td class="py-2 px-3 font-medium text-ink sticky left-0 bg-white z-10" x-text="$t('about.' + row.key)"></td>
                    <template x-for="(v, i) in row.vals" :key="i">
                      <td class="py-2 px-3 text-center cursor-default" :class="i === 0 ? 'bg-pevo-teal-light/30' : ''"
                          :title="tip(row.key, i)">
                        <span :class="cls(v)" x-text="sym(v)"></span>
                      </td>
                    </template>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
          <p class="text-xs text-ink-muted mt-3" x-text="$t('about.comparisonFooter')"></p>
        </section>
      </div>
    </div>
  </div>
`;

export function initAboutPage() {
  Alpine.data('aboutPage', () => ({}));
}

export { template as aboutPageTemplate };

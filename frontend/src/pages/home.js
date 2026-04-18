import Alpine from 'alpinejs';
import { fetchPapers, fetchPaperBatchCounts, fetchDisciplines } from '../api.js';
import { truncateText, formatDate } from '../components/paper-card.js';

const ITEMS_PER_PAGE = 10;

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

              <!-- Filters -->
              <div class="flex flex-col sm:flex-row gap-3 sm:items-center mb-6">
                <div class="flex-1 sm:max-w-xs">
                  <label for="home-discipline" class="block text-xs font-medium text-ink-muted mb-1" x-text="$t('filters.discipline')"></label>
                  <select id="home-discipline" class="select-control capitalize" x-model="discipline" @change="onDisciplineChange()">
                    <option value="" x-text="$t('filters.allDisciplines')"></option>
                    <template x-for="d in disciplines" :key="d.name">
                      <option :value="d.name" x-text="\`\${d.name} (\${d.paper_count})\`" class="capitalize"></option>
                    </template>
                  </select>
                </div>
                <div class="w-full sm:w-40">
                  <label for="home-source" class="block text-xs font-medium text-ink-muted mb-1" x-text="$t('filters.source')"></label>
                  <select id="home-source" class="select-control" x-model="sourceFilter" @change="onSourceChange()">
                    <option value="" x-text="$t('filters.allSources')"></option>
                    <option value="native" x-text="$t('filters.nativePapers')"></option>
                    <option value="bridge" x-text="$t('filters.preprints')"></option>
                  </select>
                </div>
                <div class="w-full sm:w-48">
                  <label for="home-sort" class="block text-xs font-medium text-ink-muted mb-1" x-text="$t('filters.sortBy')"></label>
                  <select id="home-sort" class="select-control" x-model="sortBy" @change="onSortChange()">
                    <option value="date" x-text="$t('filters.mostRecent')"></option>
                    <option value="votes" x-text="$t('filters.mostVotes')"></option>
                    <option value="reputation" x-text="$t('filters.authorReputation')"></option>
                  </select>
                </div>
              </div>

              <!-- Loading skeleton -->
              <template x-if="loading">
                <div class="space-y-4">
                  <template x-for="i in 3" :key="i">
                    <div class="card animate-pulse">
                      <div class="h-4 bg-parchment-warm rounded w-24 mb-3"></div>
                      <div class="h-6 bg-parchment-warm rounded w-3/4 mb-2"></div>
                      <div class="h-4 bg-parchment-warm rounded w-1/2 mb-3"></div>
                      <div class="h-4 bg-parchment-warm rounded w-full mb-2"></div>
                      <div class="h-4 bg-parchment-warm rounded w-5/6"></div>
                    </div>
                  </template>
                </div>
              </template>

              <!-- Error -->
              <template x-if="!loading && error">
                <div class="card text-center py-12">
                  <p class="text-ink-muted mb-4" x-text="error"></p>
                  <button class="btn-primary" @click="loadPapers()" x-text="$t('common.retry')"></button>
                </div>
              </template>

              <!-- Empty state -->
              <template x-if="!loading && !error && papers.length === 0">
                <div class="card text-center py-12">
                  <p class="text-ink-muted" x-text="$t('home.noPapersFound')"></p>
                </div>
              </template>

              <!-- Paper cards -->
              <template x-if="!loading && !error && papers.length > 0">
                <div>
                  <div class="space-y-4">
                    <template x-for="paper in papers" :key="paper.author + '/' + paper.permlink">
                      <article class="card hover:shadow-sm transition-shadow">
                        <!-- Header: discipline + source badge + date -->
                        <div class="flex items-center justify-between text-xs text-ink-muted mb-3">
                          <div class="flex items-center gap-2">
                            <span class="badge-discipline capitalize" x-text="paper.discipline"></span>
                            <template x-if="paper.source_type && paper.source_type !== 'native'">
                              <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-pevo-teal-light text-pevo-teal-dark border border-pevo-teal/20"
                                    x-text="paper.source_type === 'arxiv' ? 'arXiv' : 'DOI'"></span>
                            </template>
                          </div>
                          <time :datetime="paper.created" x-text="formatDate(paper.created)"></time>
                        </div>

                        <!-- Title -->
                        <h3 class="text-paper-title leading-snug mb-2">
                          <a :href="$lp('/paper/' + paper.author + '/' + paper.permlink)"
                             @click.prevent="navigate('/paper/' + paper.author + '/' + paper.permlink)"
                             class="text-ink hover:text-pevo-teal no-underline" x-text="paper.title"></a>
                        </h3>

                        <!-- Authors -->
                        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 mb-3 text-sm text-ink-light">
                          <template x-for="(a, i) in paper.authors" :key="a.hive || a.name">
                            <span class="inline-flex items-center">
                              <template x-if="a.hive && (paper.accredited_authors || []).includes(a.hive)">
                                <span class="inline-flex items-center">
                                  <a :href="$lp('/profile/' + a.hive)" @click.prevent="navigate('/profile/' + a.hive)" class="no-underline hover:underline text-ink-light" x-text="a.name"></a>
                                  <svg class="ml-0.5 h-3 w-3 text-pevo-green" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" :title="$t('badge.accreditedTitle')">
                                    <path fill-rule="evenodd" d="M16.403 12.652a3 3 0 010-5.304 3 3 0 00-3.75-3.751 3 3 0 00-5.305 0 3 3 0 00-3.751 3.75 3 3 0 000 5.305 3 3 0 003.75 3.751 3 3 0 005.305 0 3 3 0 003.751-3.75zm-2.546-4.46a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" />
                                  </svg>
                                </span>
                              </template>
                              <template x-if="!a.hive || !(paper.accredited_authors || []).includes(a.hive)">
                                <span x-text="a.name"></span>
                              </template>
                              <span x-show="i < paper.authors.length - 1" class="mr-1">,</span>
                            </span>
                          </template>
                        </div>

                        <!-- Abstract preview -->
                        <p class="text-sm text-ink-muted leading-relaxed mb-4" x-text="truncateText(paper.abstract)"></p>

                        <!-- Keywords -->
                        <template x-if="paper.keywords && paper.keywords.length > 0">
                          <div class="flex flex-wrap gap-1.5 mb-4">
                            <template x-for="kw in paper.keywords" :key="kw">
                              <span class="text-xs px-2 py-0.5 rounded-full bg-parchment-warm text-ink-muted" x-text="kw"></span>
                            </template>
                          </div>
                        </template>

                        <!-- Metrics -->
                        <div class="flex items-center gap-5 text-xs text-ink-muted pt-3 border-t border-parchment-dark">
                          <span class="flex items-center gap-1" :title="$t('aria.reviews')">
                            <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zm-5 0H8v2h2V9z" clip-rule="evenodd" /></svg>
                            <span x-text="(paper.review_count ?? 0) + ' '"></span>
                          </span>
                          <template x-if="!paper.source_type || paper.source_type === 'native'">
                            <span class="flex items-center gap-1" :title="$t('aria.citations')">
                              <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.669 0 3.218.51 4.5 1.385A7.962 7.962 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V14a1 1 0 11-2 0V4.804z" /></svg>
                              <span x-text="paper.citation_count ?? 0"></span>
                            </span>
                          </template>
                          <template x-if="paper.ipfs_cid">
                            <span class="flex items-center gap-1 ml-auto rtl:ml-0 rtl:mr-auto" :title="$t('aria.pdf')">
                              <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clip-rule="evenodd" /></svg>
                              <span x-text="$t('paperCard.pdf')"></span>
                            </span>
                          </template>
                        </div>
                      </article>
                    </template>
                  </div>

                  <!-- Pagination -->
                  <template x-if="totalPages > 1">
                    <nav class="flex items-center justify-center gap-1 mt-8" :aria-label="$t('aria.pagination')">
                      <button class="btn-secondary px-3 py-1.5 text-sm" :disabled="currentPage === 1" @click="goToPage(currentPage - 1)" x-text="$t('pagination.previous')"></button>
                      <template x-for="(page, i) in paginationPages" :key="'p' + i">
                        <template x-if="page === '...'">
                          <span class="px-2 py-1 text-sm text-ink-muted">...</span>
                        </template>
                      </template>
                      <template x-for="(page, i) in paginationPages" :key="'n' + i">
                        <template x-if="page !== '...'">
                          <button class="px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
                                  :class="page === currentPage ? 'bg-pevo-teal text-white' : 'text-ink-light hover:bg-parchment-warm'"
                                  :aria-current="page === currentPage ? 'page' : false"
                                  @click="goToPage(page)" x-text="page"></button>
                        </template>
                      </template>
                      <button class="btn-secondary px-3 py-1.5 text-sm" :disabled="currentPage === totalPages" @click="goToPage(currentPage + 1)" x-text="$t('pagination.next')"></button>
                    </nav>
                  </template>
                </div>
              </template>
            </div>
          </div>
        </template>
      </div>
`;

export { template as homePageTemplate };

export function initHomePage() {
  Alpine.data('homePage', () => ({
    papers: [],
    disciplines: [],
    discipline: '',
    sortBy: 'date',
    sourceFilter: '',
    currentPage: 1,
    totalPages: 1,
    loading: true,
    error: null,

    // Expose helpers to template
    truncateText,
    formatDate,

    init() {
      this.loadDisciplines();
      this.loadPapers();
    },

    async loadDisciplines() {
      const res = await fetchDisciplines();
      this.disciplines = res.data || [];
    },

    async loadPapers() {
      this.loading = true;
      this.error = null;
      try {
        const params = {
          sort: this.sortBy,
          page: this.currentPage,
          limit: ITEMS_PER_PAGE,
        };
        if (this.discipline) params.discipline = this.discipline;
        if (this.sourceFilter) params.source = this.sourceFilter;

        const res = await fetchPapers(params);
        this.papers = res.data || [];
        if (res.meta) {
          this.totalPages = Math.ceil(res.meta.total / res.meta.limit) || 1;
        }
        this.loading = false;
        this.enrichPapers(this.papers);
      } catch {
        this.error = this.$t('home.errorLoading');
        this.papers = [];
        this.loading = false;
      }
    },

    async enrichPapers(papers) {
      if (!papers.length) return;
      const res = await fetchPaperBatchCounts(papers);
      if (res.data) {
        for (const paper of this.papers) {
          const key = `${paper.author}/${paper.permlink}`;
          const counts = res.data[key];
          if (counts) {
            paper.review_count = counts.review_count;
            paper.citation_count = counts.citation_count;
          }
        }
      }
    },

    onDisciplineChange() {
      this.currentPage = 1;
      this.loadPapers();
    },

    onSortChange() {
      this.currentPage = 1;
      this.loadPapers();
    },

    onSourceChange() {
      this.currentPage = 1;
      this.loadPapers();
    },

    goToPage(page) {
      if (page === '...' || page < 1 || page > this.totalPages) return;
      this.currentPage = page;
      this.loadPapers();
    },

    get paginationPages() {
      const total = this.totalPages;
      const current = this.currentPage;
      const result = [];
      if (total <= 7) {
        for (let i = 1; i <= total; i++) result.push(i);
      } else {
        result.push(1);
        if (current > 3) result.push('...');
        for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
          result.push(i);
        }
        if (current < total - 2) result.push('...');
        result.push(total);
      }
      return result;
    },

    navigate(path) {
      this.$store.router.navigate(path);
    },
  }));
}

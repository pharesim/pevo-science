import Alpine from 'alpinejs';
import { searchPapers, fetchDisciplines } from '../api.js';
import { formatDate } from '../components/paper-card.js';
import DOMPurify from 'dompurify';

const template = `
      <div x-data="searchPage" class="container-narrow py-8">
        <h1 class="text-3xl font-bold text-ink mb-2" x-text="$t('search.title')"></h1>
        <p class="text-ink-muted mb-6" x-text="$t('search.description')"></p>

        <!-- Search form -->
        <form @submit.prevent="handleSubmit()" role="search" class="mb-6">
          <div class="flex flex-col sm:flex-row gap-2">
            <label for="search-query" class="sr-only" x-text="$t('search.title')"></label>
            <input id="search-query" type="search" class="select-control flex-1 text-base" :placeholder="$t('search.placeholder')" x-model="query" />
            <button type="submit" class="btn-primary w-full sm:w-auto shrink-0" :disabled="loading"
                    x-text="loading ? $t('search.searching') : $t('search.searchButton')"></button>
          </div>

          <!-- Filters row -->
          <div class="flex flex-wrap gap-3 mt-3">
            <div>
              <label for="search-type" class="block text-xs font-medium text-ink-muted mb-1" x-text="$t('search.typeLabel')"></label>
              <select id="search-type" class="select-control text-sm" x-model="typeFilter">
                <option value="all" x-text="$t('search.typeAll')"></option>
                <option value="paper" x-text="$t('search.typePapers')"></option>
                <option value="review" x-text="$t('search.typeReviews')"></option>
              </select>
            </div>
            <div>
              <label for="search-source" class="block text-xs font-medium text-ink-muted mb-1" x-text="$t('filters.source')"></label>
              <select id="search-source" class="select-control text-sm" x-model="sourceFilter">
                <option value="" x-text="$t('filters.allSources')"></option>
                <option value="native" x-text="$t('filters.nativePapers')"></option>
                <option value="bridge" x-text="$t('filters.preprints')"></option>
              </select>
            </div>
            <div>
              <label for="search-discipline" class="block text-xs font-medium text-ink-muted mb-1" x-text="$t('filters.discipline')"></label>
              <select id="search-discipline" class="select-control text-sm capitalize" x-model="disciplineFilter">
                <option value="" x-text="$t('filters.allDisciplines')"></option>
                <template x-for="d in disciplines" :key="d.name">
                  <option :value="d.name" x-text="d.name" class="capitalize"></option>
                </template>
              </select>
            </div>
          </div>
        </form>

        <!-- Loading -->
        <template x-if="loading">
          <div class="space-y-4">
            <template x-for="i in 4" :key="i">
              <div class="card animate-pulse">
                <div class="h-4 bg-parchment-warm rounded w-24 mb-2"></div>
                <div class="h-5 bg-parchment-warm rounded w-2/3 mb-2"></div>
                <div class="h-4 bg-parchment-warm rounded w-full"></div>
              </div>
            </template>
          </div>
        </template>

        <!-- Error -->
        <template x-if="!loading && error">
          <div class="card text-center py-12">
            <p class="text-ink-muted" x-text="error"></p>
          </div>
        </template>

        <!-- Results -->
        <template x-if="!loading && !error && hasSearched">
          <div>
            <div class="text-sm text-ink-muted mb-4" x-text="$t('search.resultsFound', { count: results.length })"></div>

            <template x-if="results.length > 0">
              <div>
                <div class="space-y-4">
                  <template x-for="result in results" :key="result.author + '/' + result.permlink">
                    <article class="card hover:shadow-sm transition-shadow">
                      <div class="flex items-center gap-2 text-xs text-ink-muted mb-2">
                        <span class="badge-discipline capitalize" x-text="$t(result.type === 'review' ? 'search.typeReviews' : 'search.typePapers')"></span>
                        <time :datetime="result.created" x-text="formatDate(result.created)"></time>
                        <template x-if="result.is_accredited">
                          <span class="badge-accredited" :title="$t('badge.accreditedTitle')">
                            <svg class="mr-1 h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                              <path fill-rule="evenodd" d="M16.403 12.652a3 3 0 010-5.304 3 3 0 00-3.75-3.751 3 3 0 00-5.305 0 3 3 0 00-3.751 3.75 3 3 0 000 5.305 3 3 0 003.75 3.751 3 3 0 005.305 0 3 3 0 003.751-3.75zm-2.546-4.46a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" />
                            </svg>
                            <span x-text="$t('badge.accredited')"></span>
                          </span>
                        </template>
                      </div>
                      <!-- Paper result -->
                      <template x-if="result.type !== 'review'">
                        <div>
                          <h2 class="text-lg font-serif font-semibold mb-1">
                            <a :href="$lp('/paper/' + result.author + '/' + result.permlink)"
                               @click.prevent="navigate('/paper/' + result.author + '/' + result.permlink)"
                               class="text-ink hover:text-pevo-teal no-underline" x-text="result.title"></a>
                          </h2>
                          <p class="text-xs text-ink-muted mb-2" x-text="'@' + result.author"></p>
                        </div>
                      </template>
                      <!-- Review result -->
                      <template x-if="result.type === 'review'">
                        <div>
                          <h2 class="text-lg font-serif font-semibold mb-1">
                            <a :href="$lp('/paper/' + result.paper_author + '/' + result.paper_permlink + '#review-' + result.author.replace(/[\/.]/g, '-') + '-' + result.permlink.replace(/[\/.]/g, '-'))"
                               @click.prevent="navigate('/paper/' + result.paper_author + '/' + result.paper_permlink + '#review-' + result.author.replace(/[\/.]/g, '-') + '-' + result.permlink.replace(/[\/.]/g, '-'))"
                               class="text-ink hover:text-pevo-teal no-underline" x-text="$t('search.reviewOn', { author: result.paper_author, permlink: result.paper_permlink })"></a>
                          </h2>
                          <p class="text-xs text-ink-muted mb-2" x-text="$t('search.reviewBy', { author: result.author })"></p>
                        </div>
                      </template>
                      <div class="text-sm text-ink-light leading-relaxed [&_mark]:bg-yellow-200 [&_mark]:px-0.5 [&_mark]:rounded"
                           x-html="sanitizeSnippet(result.snippet)"></div>
                    </article>
                  </template>
                </div>

                <!-- Pagination -->
                <template x-if="totalPages > 1">
                  <nav class="flex items-center justify-center gap-1 mt-8" :aria-label="$t('aria.pagination')">
                    <button class="btn-secondary px-3 py-1.5 text-sm" :disabled="currentPage === 1" @click="goToPage(currentPage - 1)" x-text="$t('pagination.previous')"></button>
                    <template x-for="(page, i) in paginationPages" :key="'sp' + i">
                      <template x-if="page === '...'">
                        <span class="px-2 py-1 text-sm text-ink-muted">...</span>
                      </template>
                    </template>
                    <template x-for="(page, i) in paginationPages" :key="'sn' + i">
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

            <template x-if="results.length === 0">
              <div class="card text-center py-12">
                <p class="text-ink-muted" x-text="$t('search.noResults')"></p>
              </div>
            </template>
          </div>
        </template>

        <!-- Initial state -->
        <template x-if="!loading && !error && !hasSearched">
          <div class="card text-center py-12">
            <p class="text-ink-muted" x-text="$t('search.initialPrompt')"></p>
          </div>
        </template>
      </div>
`;

export { template as searchPageTemplate };

const ITEMS_PER_PAGE = 20;

export function initSearchPage() {
  Alpine.data('searchPage', () => ({
    query: '',
    typeFilter: 'all',
    sourceFilter: '',
    disciplineFilter: '',
    disciplines: [],
    results: [],
    currentPage: 1,
    totalPages: 1,
    loading: false,
    error: null,
    hasSearched: false,

    formatDate,

    init() {
      // Read query from URL hash params
      const q = this.$store.router.query?.q || '';
      if (q) {
        this.query = q;
        this.doSearch(q, 1);
      }
      this.loadDisciplines();
    },

    async loadDisciplines() {
      const res = await fetchDisciplines();
      this.disciplines = res.data || [];
    },

    async doSearch(q, page) {
      if (!q || !q.trim()) return;
      this.loading = true;
      this.error = null;
      this.hasSearched = true;
      try {
        const params = {
          q: q.trim(),
          page,
          limit: ITEMS_PER_PAGE,
        };
        if (this.typeFilter !== 'all') params.type = this.typeFilter;
        if (this.sourceFilter) params.source = this.sourceFilter;
        if (this.disciplineFilter) params.discipline = this.disciplineFilter;

        const res = await searchPapers(params);
        this.results = res.data || [];
        if (res.meta) {
          this.totalPages = Math.ceil(res.meta.total / res.meta.limit) || 1;
        }
      } catch {
        this.error = this.$t('search.searchFailed');
        this.results = [];
      } finally {
        this.loading = false;
      }
    },

    handleSubmit() {
      this.currentPage = 1;
      // Update URL so searches are bookmarkable and back/forward works
      const params = new URLSearchParams();
      if (this.query.trim()) params.set('q', this.query.trim());
      if (this.typeFilter !== 'all') params.set('type', this.typeFilter);
      if (this.sourceFilter) params.set('source', this.sourceFilter);
      if (this.disciplineFilter) params.set('discipline', this.disciplineFilter);
      const qs = params.toString();
      const locale = this.$store.i18n.locale;
      const newUrl = `/${locale}/search${qs ? '?' + qs : ''}`;
      window.history.pushState(null, '', newUrl);
      this.doSearch(this.query, 1);
    },

    goToPage(page) {
      if (page === '...' || page < 1 || page > this.totalPages) return;
      this.currentPage = page;
      this.doSearch(this.query, page);
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

    sanitizeSnippet(html) {
      return DOMPurify.sanitize(html || '', { ALLOWED_TAGS: ['mark', 'b', 'em'] });
    },

    navigate(path) {
      this.$store.router.navigate(path);
    },
  }));
}

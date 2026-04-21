import Alpine from 'alpinejs';
import { searchPapers, fetchDisciplines } from '../api.js';
import { formatDate } from '../components/paper-card.js';
import { paginationTemplate } from '../components/pagination.js';
import { totalPagesFromMeta } from '../lib/pagination.js';
import { localeStrippedPath } from '../lib/url-sync.js';
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

          <!-- Filter changes (type/source/discipline) intentionally do NOT
               auto-push the URL or re-run the search. Search is a user-initiated
               action; mid-compose filter tweaks would cause unwanted network
               churn and a jumpy result list. paper-feed uses the opposite
               pattern (auto-push on filter change) because it's a passive
               "what's here" feed, not a query. handleSubmit is the canonical
               point that commits filter state to the URL + API. -->
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
              <select id="search-discipline" class="select-control text-sm capitalize" x-model="disciplineFilter" :data-disciplines-status="disciplinesLoadFailed ? 'failed' : 'ok'">
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
                <div x-data="pagination((p) => goToPage(p))">${paginationTemplate}</div>
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

// URL sync is only active when the page mounts on /search. The pathname check
// (stripping an optional locale prefix) guards against popstate events firing
// after the user navigates away via the SPA router.
function pageOwnsUrl() {
  return localeStrippedPath(window.location.pathname) === '/search';
}

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
    disciplinesLoadFailed: false,
    _popstateHandler: null,

    formatDate,

    init() {
      this._syncFromUrl();
      if (this.query) this.doSearch(this.query, this.currentPage);
      this.loadDisciplines().catch((err) => {
        console.warn('[loadDisciplines]', err);
        this.disciplinesLoadFailed = true;
      });
      if (pageOwnsUrl()) {
        this._popstateHandler = () => {
          if (!pageOwnsUrl()) return;
          this._syncFromUrl();
          if (this.query) this.doSearch(this.query, this.currentPage);
        };
        window.addEventListener('popstate', this._popstateHandler);
      }
    },

    destroy() {
      if (this._popstateHandler) {
        window.removeEventListener('popstate', this._popstateHandler);
        this._popstateHandler = null;
      }
    },

    _syncFromUrl() {
      const params = new URLSearchParams(window.location.search);
      this.query = params.get('q') || '';
      const type = params.get('type');
      this.typeFilter = type === 'paper' || type === 'review' ? type : 'all';
      const source = params.get('source');
      this.sourceFilter = source === 'native' || source === 'bridge' ? source : '';
      // Canonicalize discipline to lowercase so the stored value matches
      // option values populated from loadDisciplines (also lowercased). Existing
      // URLs like `?discipline=Physics` continue to resolve. the API is case
      // insensitive; normalization is purely a frontend-coherence concern.
      const rawDiscipline = params.get('discipline') || '';
      this.disciplineFilter = rawDiscipline.toLowerCase();
      const page = parseInt(params.get('page') || '1', 10);
      this.currentPage = Number.isFinite(page) && page > 0 ? page : 1;
    },

    _pushUrl() {
      const params = new URLSearchParams();
      if (this.query.trim()) params.set('q', this.query.trim());
      if (this.typeFilter !== 'all') params.set('type', this.typeFilter);
      if (this.sourceFilter) params.set('source', this.sourceFilter);
      // Belt-and-suspenders: _syncFromUrl + loadDisciplines already lowercase
      // the source values, but lowercase again on write so any future code path
      // that assigns `this.disciplineFilter` directly still produces canonical URLs.
      if (this.disciplineFilter) params.set('discipline', this.disciplineFilter.toLowerCase());
      if (this.currentPage > 1) params.set('page', String(this.currentPage));
      const qs = params.toString();
      const newUrl = window.location.pathname + (qs ? '?' + qs : '');
      window.history.pushState(null, '', newUrl);
    },

    async loadDisciplines() {
      // Reset the failure flag before attempting the fetch so retries after a
      // transient failure can clear the `data-disciplines-status="failed"` DOM
      // signal on success. Today `loadDisciplines` is init-only, but any future
      // retry path (route revisit, visibility-change reload, user-triggered
      // retry) would otherwise see the flag stuck at true even after a
      // successful reload.
      this.disciplinesLoadFailed = false;
      const res = await fetchDisciplines();
      // Lowercase each discipline name so dropdown option values match the
      // canonical form used by `_syncFromUrl`/`_pushUrl`. Display is titlecased
      // via Tailwind `class="capitalize"` on the <option>; the underlying
      // stored value is lowercase.
      this.disciplines = (res.data || []).map((d) => ({
        ...d,
        name: typeof d.name === 'string' ? d.name.toLowerCase() : d.name,
      }));
    },

    async doSearch(q, page) {
      const trimmed = (q || '').trim();
      if (!trimmed) return;
      // Normalize stored state so the input field, URL, and API all reflect
      // the same trimmed form. Without this the input keeps leading/trailing
      // whitespace and `_pushUrl` produces `?q=+foo+` (space-encoded padding).
      if (this.query !== trimmed) this.query = trimmed;
      this.loading = true;
      this.error = null;
      this.hasSearched = true;
      try {
        const params = {
          q: trimmed,
          page,
          limit: ITEMS_PER_PAGE,
        };
        if (this.typeFilter !== 'all') params.type = this.typeFilter;
        if (this.sourceFilter) params.source = this.sourceFilter;
        if (this.disciplineFilter) params.discipline = this.disciplineFilter;

        const res = await searchPapers(params);
        this.results = res.data || [];
        this.totalPages = totalPagesFromMeta(res.meta);
      } catch {
        this.error = this.$t('search.searchFailed');
        this.results = [];
        this.totalPages = 1;
        this.currentPage = 1;
        this._pushUrl();
      } finally {
        this.loading = false;
      }
    },

    handleSubmit() {
      this.currentPage = 1;
      this._pushUrl();
      this.doSearch(this.query, 1);
    },

    goToPage(page) {
      if (page === '...' || page < 1 || page > this.totalPages) return;
      this.currentPage = page;
      this._pushUrl();
      this.doSearch(this.query, page);
    },

    sanitizeSnippet(html) {
      return DOMPurify.sanitize(html || '', { ALLOWED_TAGS: ['mark', 'b', 'em'] });
    },

    navigate(path) {
      this.$store.router.navigate(path);
    },
  }));
}

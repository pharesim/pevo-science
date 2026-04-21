import Alpine from 'alpinejs';
import { fetchPapers, fetchDisciplines } from '../api.js';
import { truncateText, formatDate, paperCardTemplate } from './paper-card.js';
import { paginationTemplate } from './pagination.js';
import { totalPagesFromMeta } from '../lib/pagination.js';

const ITEMS_PER_PAGE = 10;

export const paperFeedTemplate = `
          <!-- Filters -->
          <div class="flex flex-col sm:flex-row gap-3 sm:items-center mb-6">
            <div class="flex-1 sm:max-w-xs">
              <label for="paper-feed-discipline" class="block text-xs font-medium text-ink-muted mb-1" x-text="$t('filters.discipline')"></label>
              <select id="paper-feed-discipline" class="select-control capitalize" x-model="discipline" @change="onDisciplineChange()">
                <option value="" x-text="$t('filters.allDisciplines')"></option>
                <template x-for="d in disciplines" :key="d.name">
                  <option :value="d.name" x-text="\`\${d.name} (\${d.paper_count})\`" class="capitalize"></option>
                </template>
              </select>
            </div>
            <div class="w-full sm:w-40">
              <label for="paper-feed-source" class="block text-xs font-medium text-ink-muted mb-1" x-text="$t('filters.source')"></label>
              <select id="paper-feed-source" class="select-control" x-model="sourceFilter" @change="onSourceChange()">
                <option value="" x-text="$t('filters.allSources')"></option>
                <option value="native" x-text="$t('filters.nativePapers')"></option>
                <option value="bridge" x-text="$t('filters.preprints')"></option>
              </select>
            </div>
            <div class="w-full sm:w-48">
              <label for="paper-feed-sort" class="block text-xs font-medium text-ink-muted mb-1" x-text="$t('filters.sortBy')"></label>
              <select id="paper-feed-sort" class="select-control" x-model="sortBy" @change="onSortChange()">
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
                  ${paperCardTemplate}
                </template>
              </div>

              <!-- Pagination -->
              <div x-data="pagination((p) => goToPage(p))">${paginationTemplate}</div>
            </div>
          </template>
`;

// URL sync is only active when the feed mounts on /papers. On home the same
// component renders without rewriting the URL, so `?page=…` never leaks onto
// the landing page. Detected from the path (minus optional locale prefix) so
// this works regardless of Alpine store init order.
function feedOwnsUrl() {
  const path = window.location.pathname.replace(/^\/[a-z]{2,3}(?=\/|$)/, '') || '/';
  return path === '/papers';
}

export function initPaperFeed() {
  Alpine.data('paperFeed', () => ({
    papers: [],
    disciplines: [],
    discipline: '',
    sortBy: 'date',
    sourceFilter: '',
    currentPage: 1,
    totalPages: 1,
    loading: true,
    error: null,
    _popstateHandler: null,

    // Expose helpers to the paper-card template interpolated into this scope.
    truncateText,
    formatDate,

    init() {
      this._syncFromUrl();
      this.loadDisciplines().catch(() => {});
      this.loadPapers();
      if (feedOwnsUrl()) {
        this._popstateHandler = () => {
          this._syncFromUrl();
          this.loadPapers();
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
      if (!feedOwnsUrl()) return;
      const params = new URLSearchParams(window.location.search);
      const page = parseInt(params.get('page') || '1', 10);
      this.currentPage = Number.isFinite(page) && page > 0 ? page : 1;
      this.discipline = params.get('discipline') || '';
      const sort = params.get('sort');
      this.sortBy = sort === 'votes' || sort === 'reputation' ? sort : 'date';
      const source = params.get('source');
      this.sourceFilter = source === 'native' || source === 'bridge' ? source : '';
    },

    _pushUrl() {
      if (!feedOwnsUrl()) return;
      const params = new URLSearchParams();
      if (this.currentPage > 1) params.set('page', String(this.currentPage));
      if (this.discipline) params.set('discipline', this.discipline);
      if (this.sortBy !== 'date') params.set('sort', this.sortBy);
      if (this.sourceFilter) params.set('source', this.sourceFilter);
      const qs = params.toString();
      const newUrl = window.location.pathname + (qs ? '?' + qs : '');
      window.history.pushState(null, '', newUrl);
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
        this.totalPages = totalPagesFromMeta(res.meta);
        this.loading = false;
      } catch {
        this.error = this.$t('home.errorLoading');
        this.papers = [];
        this.totalPages = 1;
        this.currentPage = 1;
        this.loading = false;
        this._pushUrl();
      }
    },

    onDisciplineChange() {
      this.currentPage = 1;
      this._pushUrl();
      this.loadPapers();
    },

    onSortChange() {
      this.currentPage = 1;
      this._pushUrl();
      this.loadPapers();
    },

    onSourceChange() {
      this.currentPage = 1;
      this._pushUrl();
      this.loadPapers();
    },

    goToPage(page) {
      if (page === '...' || page < 1 || page > this.totalPages) return;
      this.currentPage = page;
      this._pushUrl();
      this.loadPapers();
    },

    navigate(path) {
      this.$store.router.navigate(path);
    },
  }));
}

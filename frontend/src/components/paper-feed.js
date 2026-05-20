import Alpine from 'alpinejs';
import { fetchPapers } from '../api.js';
import { truncateText, formatDate, paperCardTemplate } from './paper-card.js';
import { paginationTemplate } from './pagination.js';
import { totalPagesFromMeta } from '../lib/pagination.js';
import { localeStrippedPath } from '../lib/url-sync.js';
import { createDisciplineFilter } from '../lib/discipline-filter.js';
import { titleCaseDiscipline } from '../lib/discipline-display.js';
import { createTimerGuard } from '../lib/timer-guard.js';
import { canonicalOrcid, hasOrcidDiscrepancy } from '../lib/authors.js';

const ITEMS_PER_PAGE = 10;

export const paperFeedTemplate = `
          <!-- Filters -->
          <div class="flex flex-col sm:flex-row gap-3 sm:items-center mb-6">
            <div class="flex-1 sm:max-w-xs">
              <label for="paper-feed-discipline" class="block text-xs font-medium text-ink-muted mb-1" x-text="$t('filters.discipline')"></label>
              <select id="paper-feed-discipline" class="select-control" x-model="discipline" @change="onDisciplineChange()" :data-disciplines-status="disciplinesLoadFailed ? 'failed' : 'ok'">
                <option value="" x-text="$t('filters.allDisciplines')"></option>
                <template x-for="d in disciplines" :key="d.canon_name">
                  <option :value="d.canon_name" x-text="\`\${titleCaseDiscipline(d.display_name)} (\${d.paper_count})\`"></option>
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
function pageOwnsUrl() {
  return localeStrippedPath(window.location.pathname) === '/papers';
}

export function initPaperFeed() {
  Alpine.data('paperFeed', () => ({
    ...createTimerGuard(),
    ...createDisciplineFilter({ stateKey: 'discipline' }),
    papers: [],
    sortBy: 'date',
    sourceFilter: '',
    currentPage: 1,
    totalPages: 1,
    loading: true,
    error: null,
    _popstateHandler: null,
    // Monotonic generation counter: every loadPapers() bump makes previous
    // in-flight fetches stale. When the stale fetch resolves it checks
    // gen !== this._loadPapersGen and bails, so a slow first fetch cannot
    // overwrite a newer fetch's result or flip `loading` back to false
    // while a newer fetch is still pending.
    _loadPapersGen: 0,

    // Expose helpers to the paper-card template interpolated into this scope.
    truncateText,
    formatDate,
    titleCaseDiscipline,
    canonicalOrcid,
    hasOrcidDiscrepancy,

    async init() {
      this._syncFromUrl();
      // Await disciplines before the first paper fetch so the <select>'s
      // x-model binds against hydrated options on first render. Without
      // this, a URL-canonical discipline briefly shows "All disciplines"
      // until fetchDisciplines resolves. Subsequent refetches stay parallel.
      await this.loadDisciplines();
      // Bail if the component was destroyed during the disciplines fetch.
      // Without this guard, loadPapers() writes `this.loading = true` on a
      // destroyed scope and the popstate listener below leaks past destroy()
      // (destroy already cleared _popstateHandler, so the handler we register
      // here would never be removed).
      if (!this._mounted) return;
      this.loadPapers();
      if (pageOwnsUrl()) {
        this._popstateHandler = () => {
          if (!pageOwnsUrl()) return;
          this._syncFromUrl();
          this.loadPapers();
        };
        window.addEventListener('popstate', this._popstateHandler);
      }
    },

    destroy() {
      // _teardownTimers first: flips _mounted so in-flight loadPapers /
      // loadDisciplines continuations bail before touching reactive state.
      this._teardownTimers();
      if (this._popstateHandler) {
        window.removeEventListener('popstate', this._popstateHandler);
        this._popstateHandler = null;
      }
    },

    _syncFromUrl() {
      if (!pageOwnsUrl()) return;
      const params = new URLSearchParams(window.location.search);
      const page = parseInt(params.get('page') || '1', 10);
      this.currentPage = Number.isFinite(page) && page > 0 ? page : 1;
      this._syncDisciplineFromUrl(params);
      const sort = params.get('sort');
      this.sortBy = sort === 'votes' || sort === 'reputation' ? sort : 'date';
      const source = params.get('source');
      this.sourceFilter = source === 'native' || source === 'bridge' ? source : '';
    },

    _pushUrl() {
      if (!pageOwnsUrl()) return;
      const params = new URLSearchParams();
      if (this.currentPage > 1) params.set('page', String(this.currentPage));
      this._pushDisciplineToUrl(params);
      if (this.sortBy !== 'date') params.set('sort', this.sortBy);
      if (this.sourceFilter) params.set('source', this.sourceFilter);
      const qs = params.toString();
      const newUrl = window.location.pathname + (qs ? '?' + qs : '');
      window.history.pushState(null, '', newUrl);
    },

    async loadPapers() {
      const gen = ++this._loadPapersGen;
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
        if (!this._mounted || gen !== this._loadPapersGen) return;
        this.papers = res.data || [];
        this.totalPages = totalPagesFromMeta(res.meta);
      } catch {
        if (!this._mounted || gen !== this._loadPapersGen) return;
        this.error = this.$t('home.errorLoading');
        this.papers = [];
        this.totalPages = 1;
        this.currentPage = 1;
        this._pushUrl();
      } finally {
        // Only the winning generation flips loading off. A stale fetch that
        // finishes while a newer one is in-flight must NOT clear `loading`
        // (would render half-populated state while the real fetch is still
        // running). Mirrors the search.js doSearch pattern.
        if (this._mounted && gen === this._loadPapersGen) this.loading = false;
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

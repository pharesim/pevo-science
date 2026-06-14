import Alpine from 'alpinejs';
import { fetchAccreditations } from '../api.js';
import { formatDate } from '../components/paper-card.js';
import { paginationTemplate } from '../components/pagination.js';
import { totalPagesFromMeta } from '../lib/pagination.js';
import { localeStrippedPath } from '../lib/url-sync.js';
import { titleCaseDiscipline } from '../lib/discipline-display.js';
import { getAccreditedSince } from '../lib/accreditation-tenure.js';

const ITEMS_PER_PAGE = 12;

const template = `
      <div x-data="researchersPage" class="container-narrow py-8">
        <h1 class="text-3xl font-bold text-ink font-serif mb-2" x-text="$t('researchers.title')"></h1>
        <p class="text-ink-muted mb-6" x-text="$t('researchers.description')"></p>

        <!-- Filters -->
        <div class="card mb-6">
          <div class="flex flex-col sm:flex-row gap-4">
            <div class="flex-1">
              <label for="researchers-field" class="block text-sm font-medium text-ink-light mb-1" x-text="$t('researchers.fieldLabel')"></label>
              <input id="researchers-field" type="text" class="select-control" :placeholder="$t('researchers.fieldPlaceholder')"
                     x-model="fieldFilter" @input.debounce.500ms="onFieldChange()" />
            </div>
            <div class="flex-1">
              <label for="researchers-institution" class="block text-sm font-medium text-ink-light mb-1" x-text="$t('researchers.institutionLabel')"></label>
              <input id="researchers-institution" type="text" class="select-control" :placeholder="$t('researchers.institutionPlaceholder')"
                     x-model="institutionFilter" @input.debounce.500ms="onInstitutionChange()" />
            </div>
          </div>
        </div>

        <!-- Loading -->
        <template x-if="loading">
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <template x-for="i in 6" :key="i">
              <div class="card animate-pulse">
                <div class="h-5 bg-parchment-warm rounded w-32 mb-2"></div>
                <div class="h-4 bg-parchment-warm rounded w-24 mb-3"></div>
                <div class="h-4 bg-parchment-warm rounded w-full mb-1"></div>
                <div class="h-4 bg-parchment-warm rounded w-3/4"></div>
              </div>
            </template>
          </div>
        </template>

        <!-- Error -->
        <template x-if="!loading && error">
          <div class="card text-center py-12">
            <p class="text-ink-muted mb-4" x-text="error"></p>
            <button class="btn-primary" @click="loadResearchers()" x-text="$t('common.retry')"></button>
          </div>
        </template>

        <!-- Empty -->
        <template x-if="!loading && !error && researchers.length === 0">
          <div class="card text-center py-12">
            <p class="text-ink-muted" x-text="$t('researchers.noResearchers')"></p>
          </div>
        </template>

        <!-- Grid -->
        <template x-if="!loading && !error && researchers.length > 0">
          <div>
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <template x-for="r in researchers" :key="r.username">
                <div class="card">
                  <div class="mb-2">
                    <h2 class="text-lg font-bold text-ink font-serif" x-text="r.name"></h2>
                    <a :href="$lp('/profile/' + r.username)" @click.prevent="navigate('/profile/' + r.username)"
                       class="text-sm text-pevo-teal hover:underline" x-text="'@' + r.username"></a>
                  </div>
                  <div class="space-y-1 text-sm text-ink-light">
                    <p x-text="r.institution"></p>
                    <p x-text="titleCaseDiscipline(r.field)"></p>
                  </div>
                  <div class="mt-3 pt-3 border-t border-parchment-dark text-xs text-ink-muted">
                    <span x-text="methodLabel(r.method)"></span>
                    <span class="mx-1">&middot;</span>
                    <!-- Tenure reads the earliest-accredit anchor (accredited_since)
                         via the shared accessor so a metadata re-broadcast does not
                         reset the directory card's date. -->
                    <span x-text="formatDate(getAccreditedSince(r))"></span>
                  </div>
                </div>
              </template>
            </div>

            <!-- Pagination -->
            <div x-data="pagination((p) => goToPage(p))">${paginationTemplate}</div>
          </div>
        </template>
      </div>
`;

export { template as researchersPageTemplate };

// URL sync is only active when the page mounts on /researchers. The pathname
// check (stripping an optional locale prefix) guards against popstate events
// firing after the user navigates away via the SPA router.
function pageOwnsUrl() {
  return localeStrippedPath(window.location.pathname) === '/researchers';
}

export function initResearchersPage() {
  Alpine.data('researchersPage', () => ({
    researchers: [],
    fieldFilter: '',
    institutionFilter: '',
    currentPage: 1,
    totalPages: 1,
    loading: true,
    error: null,
    _popstateHandler: null,

    formatDate,
    titleCaseDiscipline,
    getAccreditedSince,

    init() {
      this._syncFromUrl();
      this.loadResearchers();
      if (pageOwnsUrl()) {
        this._popstateHandler = () => {
          if (!pageOwnsUrl()) return;
          this._syncFromUrl();
          this.loadResearchers();
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
      if (!pageOwnsUrl()) return;
      const params = new URLSearchParams(window.location.search);
      const page = parseInt(params.get('page') || '1', 10);
      this.currentPage = Number.isFinite(page) && page > 0 ? page : 1;
      this.fieldFilter = params.get('field') || '';
      this.institutionFilter = params.get('institution') || '';
    },

    _pushUrl() {
      const params = new URLSearchParams();
      if (this.currentPage > 1) params.set('page', String(this.currentPage));
      if (this.fieldFilter) params.set('field', this.fieldFilter);
      if (this.institutionFilter) params.set('institution', this.institutionFilter);
      const qs = params.toString();
      const newUrl = window.location.pathname + (qs ? '?' + qs : '');
      window.history.pushState(null, '', newUrl);
    },

    async loadResearchers() {
      this.loading = true;
      this.error = null;
      try {
        const params = {
          page: this.currentPage,
          limit: ITEMS_PER_PAGE,
        };
        if (this.fieldFilter) params.field = this.fieldFilter;
        if (this.institutionFilter) params.institution = this.institutionFilter;

        const res = await fetchAccreditations(params);
        this.researchers = res.data || [];
        this.totalPages = totalPagesFromMeta(res.meta);
      } catch (err) {
        console.warn('[researchers load]', err);
        this.error = this.$t('researchers.loadFailed');
        this.researchers = [];
        this.totalPages = 1;
        this.currentPage = 1;
        this._pushUrl();
      } finally {
        this.loading = false;
      }
    },

    onFieldChange() {
      this.currentPage = 1;
      this._pushUrl();
      this.loadResearchers();
    },

    onInstitutionChange() {
      this.currentPage = 1;
      this._pushUrl();
      this.loadResearchers();
    },

    goToPage(page) {
      if (page === '...' || page < 1 || page > this.totalPages) return;
      this.currentPage = page;
      this._pushUrl();
      this.loadResearchers();
    },

    methodLabel(method) {
      const map = {
        email: this.$t('researchers.emailVerification'),
        orcid: this.$t('researchers.orcid'),
        dao_vote: this.$t('researchers.daoVote'),
        wot: this.$t('researchers.webOfTrust'),
        web_of_trust: this.$t('researchers.webOfTrust'),
        pgp: this.$t('researchers.pgpVerification'),
        personal: this.$t('researchers.personalVerification'),
      };
      return map[method] || method;
    },

    navigate(path) {
      this.$store.router.navigate(path);
    },
  }));
}

import Alpine from 'alpinejs';
import { fetchAccreditations } from '../api.js';
import { formatDate } from '../components/paper-card.js';

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
                    <p class="capitalize" x-text="r.field"></p>
                  </div>
                  <div class="mt-3 pt-3 border-t border-parchment-dark text-xs text-ink-muted">
                    <span x-text="methodLabel(r.method)"></span>
                    <span class="mx-1">&middot;</span>
                    <span x-text="formatDate(r.timestamp)"></span>
                  </div>
                </div>
              </template>
            </div>

            <!-- Pagination -->
            <template x-if="totalPages > 1">
              <nav class="flex items-center justify-center gap-1 mt-8" :aria-label="$t('aria.pagination')">
                <button class="btn-secondary px-3 py-1.5 text-sm" :disabled="currentPage === 1" @click="goToPage(currentPage - 1)" x-text="$t('pagination.previous')"></button>
                <template x-for="(page, i) in paginationPages" :key="'rp' + i">
                  <template x-if="page === '...'">
                    <span class="px-2 py-1 text-sm text-ink-muted">...</span>
                  </template>
                </template>
                <template x-for="(page, i) in paginationPages" :key="'rn' + i">
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
`;

export { template as researchersPageTemplate };

export function initResearchersPage() {
  Alpine.data('researchersPage', () => ({
    researchers: [],
    fieldFilter: '',
    institutionFilter: '',
    currentPage: 1,
    totalPages: 1,
    loading: true,
    error: null,

    formatDate,

    init() {
      this.loadResearchers();
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
        if (res.meta) {
          this.totalPages = Math.ceil(res.meta.total / res.meta.limit) || 1;
        }
      } catch (err) {
        this.error = err?.message || this.$t('researchers.loadFailed');
      } finally {
        this.loading = false;
      }
    },

    onFieldChange() {
      this.currentPage = 1;
      this.loadResearchers();
    },

    onInstitutionChange() {
      this.currentPage = 1;
      this.loadResearchers();
    },

    goToPage(page) {
      if (page === '...' || page < 1 || page > this.totalPages) return;
      this.currentPage = page;
      this.loadResearchers();
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

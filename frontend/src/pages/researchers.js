import Alpine from 'alpinejs';
import { fetchAccreditations, fetchDisciplines } from '../api.js';
import { formatDate } from '../components/paper-card.js';

const ITEMS_PER_PAGE = 12;

export function initResearchersPage() {
  Alpine.data('researchersPage', () => ({
    researchers: [],
    disciplines: [],
    fieldFilter: '',
    institutionFilter: '',
    currentPage: 1,
    totalPages: 1,
    loading: true,
    error: null,

    formatDate,

    init() {
      this.loadDisciplines();
      this.loadResearchers();
    },

    async loadDisciplines() {
      try {
        const res = await fetchDisciplines();
        this.disciplines = (res.data || []).map(d => d.name);
      } catch {
        // Non-critical
      }
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

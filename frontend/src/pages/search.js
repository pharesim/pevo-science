import Alpine from 'alpinejs';
import { searchPapers, fetchDisciplines } from '../api.js';
import { formatDate } from '../components/paper-card.js';
import DOMPurify from 'dompurify';

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
      try {
        const res = await fetchDisciplines();
        this.disciplines = res.data || [];
      } catch {
        // Non-critical
      }
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

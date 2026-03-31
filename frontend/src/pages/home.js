import Alpine from 'alpinejs';
import { fetchPapers, fetchPaperBatchCounts, fetchDisciplines } from '../api.js';
import { truncateText, formatDate } from '../components/paper-card.js';

const ITEMS_PER_PAGE = 10;

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
      try {
        const res = await fetchDisciplines();
        this.disciplines = res.data || [];
      } catch {
        // Non-critical
      }
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
      try {
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
      } catch {
        // Non-critical: cards show 0 as fallback
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

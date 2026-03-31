import Alpine from 'alpinejs';

export function initPagination() {
  Alpine.data('pagination', (totalPages, currentPage, onPageChange) => ({
    totalPages,
    currentPage,
    onPageChange,

    get pages() {
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

    goTo(page) {
      if (page === '...' || page === this.currentPage) return;
      if (typeof this.onPageChange === 'function') {
        this.onPageChange(page);
      }
    },

    prev() {
      if (this.currentPage > 1) this.goTo(this.currentPage - 1);
    },

    next() {
      if (this.currentPage < this.totalPages) this.goTo(this.currentPage + 1);
    },
  }));
}

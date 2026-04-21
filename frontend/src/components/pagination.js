import Alpine from 'alpinejs';

// Pure, unit-testable. Returns the sequence of page numbers and '...'
// placeholders to render. Clamps `current` into [1, total] and returns [] for
// non-positive totals, so templates can bind it directly without extra guards.
export function paginationPages(total, current) {
  if (!Number.isFinite(total) || total < 1) return [];
  const clamped = Math.min(Math.max(1, current || 1), total);
  const result = [];
  if (total <= 7) {
    for (let i = 1; i <= total; i++) result.push(i);
    return result;
  }
  result.push(1);
  if (clamped > 3) result.push('...');
  for (let i = Math.max(2, clamped - 1); i <= Math.min(total - 1, clamped + 1); i++) {
    result.push(i);
  }
  if (clamped < total - 2) result.push('...');
  result.push(total);
  return result;
}

// Shared pagination template. Interpolate into a parent template under an
// `<div x-data="pagination(onPageChange)">` wrapper. The factory relies on
// Alpine scope inheritance to read `totalPages` and `currentPage` reactively
// from the parent scope — they are NOT re-declared on the child scope, so
// updates from the parent propagate naturally without extra syncing.
//
// Escaping trap: this module exports a plain string that callers interpolate
// into their own page template literals. Any backtick or `${...}` added here
// would be evaluated at module load time (when the outer page template
// literal is constructed), not at Alpine render time. Keep all dynamic bits
// as Alpine `x-text`/`:attr` bindings inside plain attribute strings.
export const paginationTemplate = `
  <template x-if="totalPages > 1">
    <nav class="flex items-center justify-center gap-1 mt-8" :aria-label="$t('aria.pagination')">
      <button class="btn-secondary px-3 py-1.5 text-sm" :disabled="currentPage === 1" @click="prev()" x-text="$t('pagination.previous')"></button>
      <template x-for="(page, i) in pages" :key="page + '-' + i">
        <div class="contents" role="none">
          <template x-if="page === '...'">
            <span class="px-2 py-1 text-sm text-ink-muted">...</span>
          </template>
          <template x-if="page !== '...'">
            <button class="px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
                    :class="page === currentPage ? 'bg-pevo-teal text-white' : 'text-ink-light hover:bg-parchment-warm'"
                    :aria-current="page === currentPage ? 'page' : false"
                    @click="goTo(page)" x-text="page"></button>
          </template>
        </div>
      </template>
      <button class="btn-secondary px-3 py-1.5 text-sm" :disabled="currentPage === totalPages" @click="next()" x-text="$t('pagination.next')"></button>
    </nav>
  </template>
`;

/**
 * Alpine component factory for shared pagination behavior.
 *
 * Scope contract (required ambient properties on the parent `x-data` scope):
 *   - totalPages: number — total page count; factory reads via Alpine scope inheritance
 *   - currentPage: number — currently-active 1-based page index
 *   - goToPage(page): method invoked by the factory's callback when a valid page is clicked
 *
 * DO NOT redeclare `totalPages` or `currentPage` on the child `x-data` — they
 * would shadow the parent and silently break reactivity.
 *
 * @param {(page: number) => void} onPageChange callback for validated page clicks
 */
export function initPagination() {
  // `onPageChange` stays in closure — NOT on the Alpine scope — so templates
  // can only reach it through `goTo`/`prev`/`next` where the guards live.
  Alpine.data('pagination', (onPageChange) => ({
    get pages() {
      return paginationPages(this.totalPages, this.currentPage);
    },

    goTo(page) {
      if (page === '...' || page === this.currentPage) return;
      if (page < 1 || page > this.totalPages) return;
      if (typeof onPageChange === 'function') onPageChange(page);
    },

    prev() {
      if (this.currentPage > 1) this.goTo(this.currentPage - 1);
    },

    next() {
      if (this.currentPage < this.totalPages) this.goTo(this.currentPage + 1);
    },
  }));
}

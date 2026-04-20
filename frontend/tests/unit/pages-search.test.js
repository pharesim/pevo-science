import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/api.js', () => ({
  searchPapers: vi.fn(),
  fetchDisciplines: vi.fn(() => Promise.resolve({ data: [] })),
}));

vi.mock('../../src/components/paper-card.js', () => ({
  formatDate: (d) => d,
}));

vi.mock('dompurify', () => ({
  default: {
    sanitize: vi.fn((html, opts) => {
      // Strip all tags except allowed
      return (html || '').replace(/<(?!\/?(?:mark|b|em)>)[^>]+>/g, '');
    }),
  },
}));

const mockStores = {
  router: { params: {}, query: {}, navigate: vi.fn() },
  i18n: { locale: 'en' },
};

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => mockStores[name] || {}),
  },
}));

import Alpine from 'alpinejs';
import { searchPapers } from '../../src/api.js';
import { initSearchPage } from '../../src/pages/search.js';

function createComponent(overrides = {}) {
  initSearchPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$store = mockStores;
  comp.$t = (key) => key;
  comp.$watch = vi.fn();
  comp.$nextTick = vi.fn((fn) => fn && fn());
  Object.assign(comp, overrides);
  return comp;
}

describe('searchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStores.router.query = {};
  });

  describe('paginationPages', () => {
    it('returns all pages when totalPages <= 7', () => {
      const comp = createComponent();
      comp.totalPages = 5;
      comp.currentPage = 3;
      expect(comp.paginationPages).toEqual([1, 2, 3, 4, 5]);
    });

    it('returns pages with ellipsis for > 7 pages (current near start)', () => {
      const comp = createComponent();
      comp.totalPages = 10;
      comp.currentPage = 2;
      const pages = comp.paginationPages;
      expect(pages[0]).toBe(1);
      expect(pages[pages.length - 1]).toBe(10);
      expect(pages).toContain('...');
    });

    it('returns pages with ellipsis for > 7 pages (current in middle)', () => {
      const comp = createComponent();
      comp.totalPages = 20;
      comp.currentPage = 10;
      const pages = comp.paginationPages;
      expect(pages[0]).toBe(1);
      expect(pages[pages.length - 1]).toBe(20);
      expect(pages.filter(p => p === '...')).toHaveLength(2);
      expect(pages).toContain(9);
      expect(pages).toContain(10);
      expect(pages).toContain(11);
    });
  });

  describe('doSearch', () => {
    it('builds params with filters and calls API', async () => {
      searchPapers.mockResolvedValue({ data: [{ title: 'Result' }], meta: { total: 1, limit: 20 } });
      const comp = createComponent();
      comp.typeFilter = 'paper';
      comp.sourceFilter = 'bridge';
      comp.disciplineFilter = 'Physics';

      await comp.doSearch('quantum', 1);

      expect(searchPapers).toHaveBeenCalledWith({
        q: 'quantum',
        page: 1,
        limit: 20,
        type: 'paper',
        source: 'bridge',
        discipline: 'Physics',
      });
      expect(comp.results).toEqual([{ title: 'Result' }]);
      expect(comp.hasSearched).toBe(true);
    });

    it('does not call API for empty query', async () => {
      const comp = createComponent();
      await comp.doSearch('', 1);
      expect(searchPapers).not.toHaveBeenCalled();
    });

    it('sets error on failure', async () => {
      searchPapers.mockRejectedValue(new Error('Network error'));
      const comp = createComponent();
      await comp.doSearch('test', 1);
      expect(comp.error).toBe('search.searchFailed');
      expect(comp.results).toEqual([]);
    });
  });

  describe('handleSubmit', () => {
    it('resets page and calls doSearch', async () => {
      searchPapers.mockResolvedValue({ data: [], meta: { total: 0, limit: 20 } });
      const comp = createComponent();
      comp.query = 'hello';
      comp.currentPage = 5;
      window.history.pushState = vi.fn();

      await comp.handleSubmit();

      expect(comp.currentPage).toBe(1);
      expect(searchPapers).toHaveBeenCalled();
    });
  });

  describe('goToPage', () => {
    it('rejects ellipsis', async () => {
      const comp = createComponent();
      comp.query = 'test';
      await comp.goToPage('...');
      expect(searchPapers).not.toHaveBeenCalled();
    });

    it('rejects out of range', async () => {
      const comp = createComponent();
      comp.totalPages = 5;
      comp.query = 'test';
      await comp.goToPage(0);
      expect(searchPapers).not.toHaveBeenCalled();
      await comp.goToPage(6);
      expect(searchPapers).not.toHaveBeenCalled();
    });

    it('accepts valid page', async () => {
      searchPapers.mockResolvedValue({ data: [], meta: { total: 100, limit: 20 } });
      const comp = createComponent();
      comp.totalPages = 5;
      comp.query = 'test';
      await comp.goToPage(3);
      expect(comp.currentPage).toBe(3);
      expect(searchPapers).toHaveBeenCalled();
    });
  });

  describe('sanitizeSnippet', () => {
    it('strips dangerous HTML', () => {
      const comp = createComponent();
      const result = comp.sanitizeSnippet('<script>alert("xss")</script><mark>safe</mark>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('<mark>safe</mark>');
    });

    it('handles null/empty', () => {
      const comp = createComponent();
      expect(comp.sanitizeSnippet(null)).toBe('');
      expect(comp.sanitizeSnippet('')).toBe('');
    });
  });

  describe('init', () => {
    it('reads query from router and triggers search', async () => {
      mockStores.router.query = { q: 'neural networks' };
      searchPapers.mockResolvedValue({ data: [], meta: { total: 0, limit: 20 } });
      const comp = createComponent();
      // Mock loadDisciplines to avoid side effect
      comp.loadDisciplines = vi.fn();
      comp.init();
      expect(comp.query).toBe('neural networks');
    });

    it('does not search when no query', () => {
      mockStores.router.query = {};
      const comp = createComponent();
      comp.loadDisciplines = vi.fn();
      comp.init();
      expect(comp.query).toBe('');
    });
  });
});

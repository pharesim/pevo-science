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

    it('resets totalPages and currentPage on failure so retry starts fresh', async () => {
      searchPapers.mockRejectedValue(new Error('Network error'));
      const comp = createComponent();
      comp.totalPages = 5;
      comp.currentPage = 4;
      await comp.doSearch('test', 4);
      expect(comp.totalPages).toBe(1);
      expect(comp.currentPage).toBe(1);
    });

    it('pushes a clean URL after failure on /search so ?page= stops reflecting stale state', async () => {
      window.history.replaceState(null, '', '/en/search?q=test&page=4');
      searchPapers.mockRejectedValue(new Error('Network error'));
      const comp = createComponent();
      comp.query = 'test';
      comp.currentPage = 4;
      const push = vi.spyOn(window.history, 'pushState');
      await comp.doSearch('test', 4);
      expect(push).toHaveBeenCalled();
      const url = push.mock.calls[push.mock.calls.length - 1][2];
      expect(url).not.toContain('page=');
      // Query still reflected; only page + results were reset.
      expect(url).toContain('q=test');
    });

    it('resets totalPages to 1 when response omits meta (empty result after filter change)', async () => {
      searchPapers.mockResolvedValue({ data: [] });
      const comp = createComponent();
      comp.totalPages = 7;
      await comp.doSearch('test', 1);
      expect(comp.totalPages).toBe(1);
    });

    it('clamps totalPages to 1 when meta.limit is 0 (Infinity guard)', async () => {
      searchPapers.mockResolvedValue({ data: [{ title: 'R' }], meta: { total: 42, limit: 0 } });
      const comp = createComponent();
      await comp.doSearch('test', 1);
      expect(comp.totalPages).toBe(1);
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
    // Input guards live in the shared pagination factory. goToPage is only
    // reached via that factory's callback with pre-validated values.
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
    it('reads query from URL and triggers search', () => {
      window.history.replaceState(null, '', '/en/search?q=neural+networks');
      searchPapers.mockResolvedValue({ data: [], meta: { total: 0, limit: 20 } });
      const comp = createComponent();
      comp.loadDisciplines = vi.fn(() => Promise.resolve());
      comp.init();
      expect(comp.query).toBe('neural networks');
    });

    it('does not search when URL has no query', () => {
      window.history.replaceState(null, '', '/en/search');
      const comp = createComponent();
      comp.loadDisciplines = vi.fn(() => Promise.resolve());
      comp.init();
      expect(comp.query).toBe('');
      expect(searchPapers).not.toHaveBeenCalled();
    });

    it('seeds filter state and currentPage from URL on first mount', () => {
      window.history.replaceState(
        null,
        '',
        '/en/search?q=cosmology&type=review&source=bridge&discipline=physics&page=4',
      );
      searchPapers.mockResolvedValue({ data: [], meta: { total: 0, limit: 20 } });
      const comp = createComponent();
      comp.loadDisciplines = vi.fn(() => Promise.resolve());
      comp.init();
      expect(comp.query).toBe('cosmology');
      expect(comp.typeFilter).toBe('review');
      expect(comp.sourceFilter).toBe('bridge');
      expect(comp.disciplineFilter).toBe('physics');
      expect(comp.currentPage).toBe(4);
    });
  });

  describe('URL sync', () => {
    it('handleSubmit pushes filter state + resets page to 1', () => {
      searchPapers.mockResolvedValue({ data: [], meta: { total: 0, limit: 20 } });
      window.history.replaceState(null, '', '/en/search');
      const comp = createComponent();
      comp.query = 'quantum';
      comp.typeFilter = 'paper';
      comp.sourceFilter = 'native';
      comp.disciplineFilter = 'physics';
      comp.currentPage = 5;
      const push = vi.spyOn(window.history, 'pushState');
      comp.handleSubmit();
      expect(push).toHaveBeenCalled();
      const url = push.mock.calls[push.mock.calls.length - 1][2];
      expect(url).toContain('q=quantum');
      expect(url).toContain('type=paper');
      expect(url).toContain('source=native');
      expect(url).toContain('discipline=physics');
      expect(url).not.toContain('page=');
    });

    it('goToPage pushes page param', () => {
      searchPapers.mockResolvedValue({ data: [], meta: { total: 100, limit: 20 } });
      window.history.replaceState(null, '', '/en/search?q=test');
      const comp = createComponent();
      comp.query = 'test';
      comp.totalPages = 5;
      const push = vi.spyOn(window.history, 'pushState');
      comp.goToPage(3);
      expect(push).toHaveBeenCalled();
      const url = push.mock.calls[push.mock.calls.length - 1][2];
      expect(url).toContain('page=3');
    });
  });
});

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
      // Causal chain: URL push reflects the reset currentPage=1.
      expect(comp.currentPage).toBe(1);
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

    it('trims the query in state, URL, and API when input has leading/trailing whitespace', async () => {
      searchPapers.mockResolvedValue({ data: [], meta: { total: 0, limit: 20 } });
      const comp = createComponent();
      comp.query = '  quantum  ';
      const push = vi.spyOn(window.history, 'pushState');

      await comp.doSearch('  quantum  ', 1);

      // API sees trimmed
      expect(searchPapers).toHaveBeenCalledWith(expect.objectContaining({ q: 'quantum' }));
      // Component state sees trimmed
      expect(comp.query).toBe('quantum');
      // URL push (via handleSubmit-style path or catch-block push) would see trimmed;
      // exercise it by forcing a failure so _pushUrl fires.
      searchPapers.mockRejectedValueOnce(new Error('net'));
      comp.query = '  quantum  ';
      await comp.doSearch('  quantum  ', 1);
      expect(comp.query).toBe('quantum');
      const url = push.mock.calls[push.mock.calls.length - 1][2];
      expect(url).not.toMatch(/\+quantum\+/);
      expect(url).toContain('q=quantum');
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

    it('_pushUrl with currentPage=1 and no filters/query produces a bare path (no query string)', () => {
      window.history.replaceState(null, '', '/en/search?q=stale&page=4');
      const comp = createComponent();
      comp.query = '';
      comp.typeFilter = 'all';
      comp.sourceFilter = '';
      comp.disciplineFilter = '';
      comp.currentPage = 1;
      const push = vi.spyOn(window.history, 'pushState');
      comp._pushUrl();
      expect(push).toHaveBeenCalled();
      const url = push.mock.calls[push.mock.calls.length - 1][2];
      expect(url).not.toContain('?');
      expect(url).toBe(window.location.pathname);
    });
  });

  describe('discipline case normalization', () => {
    // Canonical form is lowercase. URLs with `?discipline=Physics` still
    // resolve (API is case insensitive), but the stored value and pushed
    // URL are always lowercase so the dropdown option values (also
    // lowercased from the API response) match and the select visibly
    // reflects the current filter.
    it('_syncFromUrl lowercases ?discipline= on read (uppercase URL becomes lowercase state)', () => {
      window.history.replaceState(null, '', '/en/search?q=x&discipline=PHYSICS');
      const comp = createComponent();
      comp._syncFromUrl();
      expect(comp.disciplineFilter).toBe('physics');
    });

    it('_syncFromUrl lowercases mixed-case ?discipline= param', () => {
      window.history.replaceState(null, '', '/en/search?q=x&discipline=Biology');
      const comp = createComponent();
      comp._syncFromUrl();
      expect(comp.disciplineFilter).toBe('biology');
    });

    it('_pushUrl writes ?discipline= lowercased regardless of starting case', () => {
      window.history.replaceState(null, '', '/en/search');
      const comp = createComponent();
      comp.query = 'x';
      // Simulate code path that assigns uppercase directly, bypassing syncFromUrl.
      comp.disciplineFilter = 'CHEMISTRY';
      const push = vi.spyOn(window.history, 'pushState');
      comp._pushUrl();
      const url = push.mock.calls[push.mock.calls.length - 1][2];
      expect(url).toContain('discipline=chemistry');
      expect(url).not.toContain('discipline=CHEMISTRY');
    });

    it('loadDisciplines lowercases each API-returned discipline name', async () => {
      const { fetchDisciplines } = await import('../../src/api.js');
      fetchDisciplines.mockResolvedValueOnce({
        data: [{ name: 'Physics' }, { name: 'Biology' }],
      });
      const comp = createComponent();
      await comp.loadDisciplines();
      expect(comp.disciplines).toEqual([{ name: 'physics' }, { name: 'biology' }]);
    });

    it('loadDisciplines preserves non-name fields when lowercasing', async () => {
      const { fetchDisciplines } = await import('../../src/api.js');
      fetchDisciplines.mockResolvedValueOnce({
        data: [{ name: 'Mathematics', paper_count: 12, extra: 'keep' }],
      });
      const comp = createComponent();
      await comp.loadDisciplines();
      expect(comp.disciplines[0]).toEqual({
        name: 'mathematics',
        paper_count: 12,
        extra: 'keep',
      });
    });

    it('end-to-end: uppercase URL through state through push produces lowercase URL', () => {
      window.history.replaceState(null, '', '/en/search?q=x&discipline=PHYSICS');
      const comp = createComponent();
      comp._syncFromUrl();
      expect(comp.disciplineFilter).toBe('physics');
      const push = vi.spyOn(window.history, 'pushState');
      comp._pushUrl();
      const url = push.mock.calls[push.mock.calls.length - 1][2];
      expect(url).toContain('discipline=physics');
      expect(url).not.toContain('PHYSICS');
    });
  });

  describe('popstate lifecycle', () => {
    it('does not register popstate when mounted off /search', () => {
      window.history.replaceState(null, '', '/en/home');
      const add = vi.spyOn(window, 'addEventListener');
      const comp = createComponent();
      comp.loadDisciplines = vi.fn(() => Promise.resolve());
      comp.init();
      const popstateCalls = add.mock.calls.filter((c) => c[0] === 'popstate');
      expect(popstateCalls).toHaveLength(0);
    });

    it('popstate handler is inert when pathname has drifted off /search mid-mount', async () => {
      window.history.replaceState(null, '', '/en/search?q=quantum');
      searchPapers.mockResolvedValue({ data: [], meta: { total: 0, limit: 20 } });
      const comp = createComponent();
      comp.loadDisciplines = vi.fn(() => Promise.resolve());
      comp.init();
      await Promise.resolve();
      searchPapers.mockClear();

      // SPA router has navigated away before popstate fires.
      window.history.replaceState(null, '', '/en/home');
      window.dispatchEvent(new PopStateEvent('popstate'));

      expect(searchPapers).not.toHaveBeenCalled();

      comp.destroy();
    });

    it('destroy removes the popstate listener', () => {
      window.history.replaceState(null, '', '/en/search');
      const remove = vi.spyOn(window, 'removeEventListener');
      const comp = createComponent();
      comp.loadDisciplines = vi.fn(() => Promise.resolve());
      comp.init();
      const handler = comp._popstateHandler;
      expect(handler).toBeTypeOf('function');
      comp.destroy();
      const popstateCalls = remove.mock.calls.filter((c) => c[0] === 'popstate');
      expect(popstateCalls.length).toBeGreaterThan(0);
      expect(popstateCalls.some((c) => c[1] === handler)).toBe(true);
      expect(comp._popstateHandler).toBeNull();
    });

    it('popstate re-reads URL and calls searchPapers on navigation within /search', async () => {
      window.history.replaceState(null, '', '/en/search?q=initial');
      searchPapers.mockResolvedValue({ data: [], meta: { total: 0, limit: 20 } });
      const comp = createComponent();
      comp.loadDisciplines = vi.fn(() => Promise.resolve());
      comp.init();
      await Promise.resolve();
      searchPapers.mockClear();
      const push = vi.spyOn(window.history, 'pushState');

      window.history.replaceState(null, '', '/en/search?q=quantum&page=2');
      window.dispatchEvent(new PopStateEvent('popstate'));

      expect(comp.query).toBe('quantum');
      expect(comp.currentPage).toBe(2);
      expect(searchPapers).toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();

      comp.destroy();
    });
  });

  describe('init resilience', () => {
    it('completes when loadDisciplines rejects (no unhandled rejection)', async () => {
      window.history.replaceState(null, '', '/en/search');
      const { fetchDisciplines } = await import('../../src/api.js');
      fetchDisciplines.mockRejectedValueOnce(new Error('disciplines down'));
      const comp = createComponent();
      expect(() => comp.init()).not.toThrow();
      // Flush microtasks so the rejected promise settles without escaping.
      await Promise.resolve();
      await Promise.resolve();
      comp.destroy();
    });

    it('flips disciplinesLoadFailed and warns once when loadDisciplines rejects', async () => {
      window.history.replaceState(null, '', '/en/search');
      const { fetchDisciplines } = await import('../../src/api.js');
      const err = new Error('disciplines down');
      fetchDisciplines.mockRejectedValueOnce(err);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      expect(comp.disciplinesLoadFailed).toBe(false);
      comp.init();
      // Flush microtasks so the rejected promise settles.
      await Promise.resolve();
      await Promise.resolve();
      expect(comp.disciplinesLoadFailed).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith('[loadDisciplines]', err);
      warnSpy.mockRestore();
      comp.destroy();
    });

    it('resets disciplinesLoadFailed to false when a subsequent loadDisciplines succeeds', async () => {
      // Seed a stuck-true flag, simulate a later retry whose fetch resolves, and
      // assert the flag is cleared. Guards against the reset-on-retry trap noted
      // in FE-LOADDISCIPLINES-OBSERVABILITY architect re-review.
      const { fetchDisciplines } = await import('../../src/api.js');
      fetchDisciplines.mockResolvedValueOnce({
        data: [{ name: 'physics', paper_count: 1 }],
      });
      const comp = createComponent();
      comp.disciplinesLoadFailed = true;
      await comp.loadDisciplines();
      expect(comp.disciplinesLoadFailed).toBe(false);
    });
  });
});

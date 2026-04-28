import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetchPapers = vi.fn();
const mockFetchDisciplines = vi.fn();

vi.mock('../../src/api.js', () => ({
  fetchPapers: (...args) => mockFetchPapers(...args),
  fetchDisciplines: (...args) => mockFetchDisciplines(...args),
}));

vi.mock('../../src/components/paper-card.js', () => ({
  truncateText: (text) => (text && text.length > 200 ? text.slice(0, 200) + '...' : text || ''),
  formatDate: (d) => d || '',
  paperCardTemplate: '',
}));

vi.mock('../../src/components/pagination.js', () => ({
  paginationTemplate: '',
}));

const mockRouterStore = { navigate: vi.fn() };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'router') return mockRouterStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initPaperFeed } from '../../src/components/paper-feed.js';
import { titleCaseDiscipline } from '../../src/lib/discipline-display.js';

function createComponent() {
  initPaperFeed();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  comp.$store = { router: mockRouterStore };
  return comp;
}

describe('paperFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchPapers.mockResolvedValue({ data: [], meta: { total: 0, limit: 10 } });
    mockFetchDisciplines.mockResolvedValue({ data: [] });
  });

  // Factory-exposure regression guard: the dropdown OPTION at
  // paper-feed.js:21 calls `titleCaseDiscipline(d.display_name)`. Without
  // the factory-level binding, x-text fires a silent ReferenceError at
  // runtime and the dropdown options render blank.
  describe('factory exposes titleCaseDiscipline', () => {
    it('factory().titleCaseDiscipline is identity-equal to the imported helper', () => {
      const comp = createComponent();
      expect(comp.titleCaseDiscipline).toBe(titleCaseDiscipline);
    });
  });

  describe('goToPage', () => {
    // Input guards (ellipsis, out-of-range) live in the shared pagination
    // factory (components-pagination.test.js). goToPage is only invoked via
    // that factory's callback with values that have already passed the guards.
    it('updates currentPage and calls loadPapers for valid page', () => {
      const comp = createComponent();
      comp.totalPages = 5;
      comp.currentPage = 1;
      mockFetchPapers.mockResolvedValue({ data: [{ title: 'P1' }], meta: { total: 50, limit: 10 } });
      comp.goToPage(3);
      expect(comp.currentPage).toBe(3);
      expect(mockFetchPapers).toHaveBeenCalled();
    });
  });

  describe('loadPapers', () => {
    it('sets papers and totalPages from response', async () => {
      const comp = createComponent();
      mockFetchPapers.mockResolvedValue({
        data: [{ title: 'Paper 1' }],
        meta: { total: 25, limit: 10 },
      });
      await comp.loadPapers();
      expect(comp.papers).toEqual([{ title: 'Paper 1' }]);
      expect(comp.totalPages).toBe(3);
      expect(comp.loading).toBe(false);
      expect(comp.error).toBeNull();
    });

    it('sets error and clears papers on fetch failure', async () => {
      const comp = createComponent();
      comp.papers = [{ title: 'stale' }];
      mockFetchPapers.mockRejectedValue(new Error('Network error'));
      await comp.loadPapers();
      expect(comp.error).toBe('home.errorLoading');
      expect(comp.papers).toEqual([]);
      expect(comp.loading).toBe(false);
    });

    it('clamps totalPages to 1 when meta.limit is 0 (Infinity guard)', async () => {
      const comp = createComponent();
      mockFetchPapers.mockResolvedValue({
        data: [{ title: 'P' }],
        meta: { total: 42, limit: 0 },
      });
      await comp.loadPapers();
      expect(comp.totalPages).toBe(1);
    });

    it('resets totalPages to 1 when response omits meta (empty result after filter change)', async () => {
      const comp = createComponent();
      comp.totalPages = 7;
      mockFetchPapers.mockResolvedValue({ data: [] });
      await comp.loadPapers();
      expect(comp.totalPages).toBe(1);
    });

    it('resets totalPages and currentPage to 1 on fetch failure so retry starts fresh', async () => {
      const comp = createComponent();
      comp.totalPages = 5;
      comp.currentPage = 4;
      mockFetchPapers.mockRejectedValue(new Error('Network error'));
      await comp.loadPapers();
      expect(comp.totalPages).toBe(1);
      expect(comp.currentPage).toBe(1);
    });

    it('pushes a clean URL after fetch failure on /papers so ?page= stops reflecting stale state', async () => {
      window.history.replaceState(null, '', '/en/papers?page=4&discipline=physics');
      const comp = createComponent();
      comp.currentPage = 4;
      comp.discipline = 'physics';
      mockFetchPapers.mockRejectedValue(new Error('Network error'));
      const push = vi.spyOn(window.history, 'pushState');
      await comp.loadPapers();
      expect(push).toHaveBeenCalled();
      const url = push.mock.calls[push.mock.calls.length - 1][2];
      expect(url).not.toContain('page=');
      // Causal chain: pushed URL reflects currentPage===1 (not the pre-failure 4).
      expect(comp.currentPage).toBe(1);
      // Filter state is still reflected (reset only clears page + results).
      expect(url).toContain('discipline=physics');
    });

    it('passes discipline and source filters when set', async () => {
      const comp = createComponent();
      comp.discipline = 'physics';
      comp.sourceFilter = 'bridge';
      comp.sortBy = 'votes';
      mockFetchPapers.mockResolvedValue({ data: [], meta: { total: 0, limit: 10 } });
      await comp.loadPapers();
      expect(mockFetchPapers).toHaveBeenCalledWith({
        sort: 'votes',
        page: 1,
        limit: 10,
        discipline: 'physics',
        source: 'bridge',
      });
    });
  });

  describe('URL sync (active only on /papers)', () => {
    beforeEach(() => {
      window.history.replaceState(null, '', '/en/papers');
    });

    it('init seeds currentPage, discipline, sort, source from URL', () => {
      window.history.replaceState(null, '', '/en/papers?page=3&discipline=physics&sort=votes&source=native');
      const comp = createComponent();
      comp.init();
      expect(comp.currentPage).toBe(3);
      expect(comp.discipline).toBe('physics');
      expect(comp.sortBy).toBe('votes');
      expect(comp.sourceFilter).toBe('native');
    });

    it('goToPage pushes ?page=N and preserves filters', () => {
      const comp = createComponent();
      comp.totalPages = 5;
      comp.discipline = 'biology';
      const push = vi.spyOn(window.history, 'pushState');
      comp.goToPage(2);
      const url = push.mock.calls[push.mock.calls.length - 1][2];
      expect(url).toContain('page=2');
      expect(url).toContain('discipline=biology');
    });

    it('filter change clears ?page= (resets to 1 → not serialized)', () => {
      const comp = createComponent();
      comp.totalPages = 5;
      comp.currentPage = 4;
      comp.discipline = 'chemistry';
      const push = vi.spyOn(window.history, 'pushState');
      comp.onDisciplineChange();
      const url = push.mock.calls[push.mock.calls.length - 1][2];
      expect(url).toContain('discipline=chemistry');
      expect(url).not.toContain('page=');
    });

    it('is inert when not on /papers (e.g. home reuses paperFeed)', () => {
      window.history.replaceState(null, '', '/en/');
      const comp = createComponent();
      comp.totalPages = 5;
      const push = vi.spyOn(window.history, 'pushState');
      comp.goToPage(3);
      expect(push).not.toHaveBeenCalled();
    });

    it('_pushUrl with currentPage=1 and no filters produces a bare path (no query string)', () => {
      window.history.replaceState(null, '', '/en/papers?page=4&discipline=physics');
      const comp = createComponent();
      comp.currentPage = 1;
      comp.discipline = '';
      comp.sortBy = 'date';
      comp.sourceFilter = '';
      const push = vi.spyOn(window.history, 'pushState');
      comp._pushUrl();
      expect(push).toHaveBeenCalled();
      const url = push.mock.calls[push.mock.calls.length - 1][2];
      expect(url).not.toContain('?');
      expect(url).toBe(window.location.pathname);
    });
  });

  describe('popstate lifecycle', () => {
    it('does not register popstate when mounted off /papers', () => {
      window.history.replaceState(null, '', '/en/home');
      const add = vi.spyOn(window, 'addEventListener');
      const comp = createComponent();
      comp.init();
      const popstateCalls = add.mock.calls.filter((c) => c[0] === 'popstate');
      expect(popstateCalls).toHaveLength(0);
    });

    it('popstate handler is inert when pathname has drifted off /papers mid-mount', async () => {
      window.history.replaceState(null, '', '/en/papers');
      const comp = createComponent();
      await comp.init();
      mockFetchPapers.mockClear();

      // SPA router has navigated away before popstate fires.
      window.history.replaceState(null, '', '/en/home');
      window.dispatchEvent(new PopStateEvent('popstate'));

      expect(mockFetchPapers).not.toHaveBeenCalled();

      comp.destroy();
    });

    it('destroy removes the popstate listener', async () => {
      window.history.replaceState(null, '', '/en/papers');
      const remove = vi.spyOn(window, 'removeEventListener');
      const comp = createComponent();
      // init() is async (awaits loadDisciplines before registering popstate);
      // await it so the handler is wired before we assert.
      await comp.init();
      const handler = comp._popstateHandler;
      expect(handler).toBeTypeOf('function');
      comp.destroy();
      const popstateCalls = remove.mock.calls.filter((c) => c[0] === 'popstate');
      expect(popstateCalls.length).toBeGreaterThan(0);
      expect(popstateCalls.some((c) => c[1] === handler)).toBe(true);
      expect(comp._popstateHandler).toBeNull();
    });

    it('popstate re-reads URL and calls loadPapers on navigation within /papers', async () => {
      window.history.replaceState(null, '', '/en/papers');
      const comp = createComponent();
      await comp.init();
      mockFetchPapers.mockClear();
      const push = vi.spyOn(window.history, 'pushState');

      window.history.replaceState(null, '', '/en/papers?page=3&discipline=biology');
      window.dispatchEvent(new PopStateEvent('popstate'));

      expect(comp.currentPage).toBe(3);
      expect(comp.discipline).toBe('biology');
      expect(mockFetchPapers).toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();

      comp.destroy();
    });
  });

  describe('init resilience', () => {
    it('completes when loadDisciplines rejects (no unhandled rejection)', async () => {
      window.history.replaceState(null, '', '/en/papers');
      mockFetchDisciplines.mockRejectedValue(new Error('disciplines down'));
      const comp = createComponent();
      expect(() => comp.init()).not.toThrow();
      // Flush microtasks so the rejected promise settles without escaping.
      await Promise.resolve();
      await Promise.resolve();
      // Papers load still fires independently of the disciplines failure.
      expect(mockFetchPapers).toHaveBeenCalled();
      comp.destroy();
    });

    it('flips disciplinesLoadFailed and warns once when loadDisciplines rejects', async () => {
      window.history.replaceState(null, '', '/en/papers');
      const err = new Error('disciplines down');
      mockFetchDisciplines.mockRejectedValue(err);
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
      mockFetchDisciplines.mockResolvedValue({
        data: [{ canon_name: 'physics', display_name: 'physics', paper_count: 1 }],
      });
      const comp = createComponent();
      comp.disciplinesLoadFailed = true;
      await comp.loadDisciplines();
      expect(comp.disciplinesLoadFailed).toBe(false);
    });
  });

  describe('discipline case normalization', () => {
    // Canonical form is lowercase. URLs with `?discipline=Physics` still
    // resolve (API is case insensitive), but the stored value and the URL
    // the page pushes are always lowercase so the dropdown option values
    // (which come from `canon_name`, server-canonicalized lowercase) match
    // and the select visibly reflects the current filter.
    it('_syncFromUrl lowercases ?discipline= on read (uppercase URL becomes lowercase state)', () => {
      window.history.replaceState(null, '', '/en/papers?discipline=PHYSICS');
      const comp = createComponent();
      comp._syncFromUrl();
      expect(comp.discipline).toBe('physics');
    });

    it('_syncFromUrl lowercases mixed-case ?discipline= param', () => {
      window.history.replaceState(null, '', '/en/papers?discipline=Biology');
      const comp = createComponent();
      comp._syncFromUrl();
      expect(comp.discipline).toBe('biology');
    });

    it('_pushUrl writes ?discipline= lowercased regardless of starting case', () => {
      window.history.replaceState(null, '', '/en/papers');
      const comp = createComponent();
      // Simulate code path that assigns uppercase directly, bypassing syncFromUrl.
      comp.discipline = 'CHEMISTRY';
      const push = vi.spyOn(window.history, 'pushState');
      comp._pushUrl();
      const url = push.mock.calls[push.mock.calls.length - 1][2];
      expect(url).toContain('discipline=chemistry');
      expect(url).not.toContain('discipline=CHEMISTRY');
    });

    it('loadDisciplines stores backend canon_name/display_name rows verbatim', async () => {
      // Backend dedupes and lowercases server-side per BE-DISCIPLINE-CANONICALIZE;
      // the frontend no longer does its own lowercasing. canon_name is the URL
      // value, display_name is the rendered label.
      mockFetchDisciplines.mockResolvedValue({
        data: [
          { canon_name: 'physics', display_name: 'Physics', paper_count: 5 },
          { canon_name: 'biology', display_name: 'Biology', paper_count: 3 },
        ],
      });
      const comp = createComponent();
      await comp.loadDisciplines();
      expect(comp.disciplines).toEqual([
        { canon_name: 'physics', display_name: 'Physics', paper_count: 5 },
        { canon_name: 'biology', display_name: 'Biology', paper_count: 3 },
      ]);
    });

    it('end-to-end: uppercase URL through state through push produces lowercase URL', () => {
      window.history.replaceState(null, '', '/en/papers?discipline=PHYSICS');
      const comp = createComponent();
      comp._syncFromUrl();
      expect(comp.discipline).toBe('physics');
      const push = vi.spyOn(window.history, 'pushState');
      comp._pushUrl();
      const url = push.mock.calls[push.mock.calls.length - 1][2];
      expect(url).toContain('discipline=physics');
      expect(url).not.toContain('PHYSICS');
    });
  });

  describe('filter handlers', () => {
    it('onDisciplineChange resets currentPage to 1 and reloads', () => {
      const comp = createComponent();
      comp.currentPage = 3;
      comp.onDisciplineChange();
      expect(comp.currentPage).toBe(1);
      expect(mockFetchPapers).toHaveBeenCalled();
    });

    it('onSortChange resets currentPage to 1 and reloads', () => {
      const comp = createComponent();
      comp.currentPage = 4;
      comp.onSortChange();
      expect(comp.currentPage).toBe(1);
      expect(mockFetchPapers).toHaveBeenCalled();
    });

    it('onSourceChange resets currentPage to 1 and reloads', () => {
      const comp = createComponent();
      comp.currentPage = 2;
      comp.onSourceChange();
      expect(comp.currentPage).toBe(1);
      expect(mockFetchPapers).toHaveBeenCalled();
    });
  });

  // UI-ASYNC-CONTINUATION-TEARDOWN-GUARD-SWEEP: post-destroy() async
  // continuations must not write to component state. A fetch that resolves
  // (or rejects) after Alpine tears the component down would otherwise
  // mutate a destroyed reactive scope.
  describe('teardown', () => {
    it('loadPapers catch does not write error/papers after destroy()', async () => {
      let rejectFn;
      mockFetchPapers.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
      const comp = createComponent();
      comp.error = null;
      comp.papers = [{ title: 'stale' }];
      const pending = comp.loadPapers();
      comp.destroy();
      rejectFn(new Error('after teardown'));
      await pending;
      expect(comp.error).toBeNull();
      // papers array untouched
      expect(comp.papers).toEqual([{ title: 'stale' }]);
    });

    it('loadPapers happy path does not write papers after destroy()', async () => {
      let resolveFn;
      mockFetchPapers.mockImplementationOnce(() => new Promise((resolve) => { resolveFn = resolve; }));
      const comp = createComponent();
      comp.papers = [];
      const pending = comp.loadPapers();
      comp.destroy();
      resolveFn({ data: [{ title: 'late' }], meta: { total: 1, limit: 10 } });
      await pending;
      expect(comp.papers).toEqual([]);
    });

    it('loadDisciplines catch does not flip disciplinesLoadFailed after destroy()', async () => {
      let rejectFn;
      mockFetchDisciplines.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      expect(comp.disciplinesLoadFailed).toBe(false);
      const pending = comp.loadDisciplines();
      comp.destroy();
      rejectFn(new Error('late failure'));
      await pending;
      expect(comp.disciplinesLoadFailed).toBe(false);
      warnSpy.mockRestore();
    });
  });

  // UI-TEARDOWN-GUARD-SWEEP-EXTENSION: concurrent-fetch generation counter.
  // loadPapers() bumps `_loadPapersGen` on entry; any in-flight fetch whose
  // generation no longer matches bails. Without this, a slow first fetch
  // resolving after a newer fetch would overwrite `papers` with stale data,
  // or its `finally` would flip `loading` off while a newer fetch is still
  // running.
  describe('loadPapers generation counter (concurrent fetches)', () => {
    it('stale fetch resolving after a newer fetch does not overwrite papers', async () => {
      let resolveFirst;
      let resolveSecond;
      mockFetchPapers
        .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
        .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));
      const comp = createComponent();
      comp.papers = [];

      const firstPending = comp.loadPapers();
      const secondPending = comp.loadPapers();

      // Resolve the newer fetch first — its data should win.
      resolveSecond({ data: [{ title: 'fresh' }], meta: { total: 1, limit: 10 } });
      await secondPending;
      expect(comp.papers).toEqual([{ title: 'fresh' }]);

      // Stale fetch resolves later; must NOT overwrite 'fresh'.
      resolveFirst({ data: [{ title: 'stale' }], meta: { total: 1, limit: 10 } });
      await firstPending;
      expect(comp.papers).toEqual([{ title: 'fresh' }]);
    });

    it('finally does NOT flip loading to false when a newer fetch is still pending', async () => {
      let resolveFirst;
      let resolveSecond;
      mockFetchPapers
        .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
        .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));
      const comp = createComponent();

      const firstPending = comp.loadPapers();
      const secondPending = comp.loadPapers();
      expect(comp.loading).toBe(true);

      // Resolve the stale fetch first. Its finally must not clear loading,
      // because the newer fetch is still in-flight.
      resolveFirst({ data: [{ title: 'stale' }], meta: { total: 1, limit: 10 } });
      await firstPending;
      expect(comp.loading).toBe(true);

      // Winning fetch resolves → loading clears.
      resolveSecond({ data: [{ title: 'fresh' }], meta: { total: 1, limit: 10 } });
      await secondPending;
      expect(comp.loading).toBe(false);
    });

    it('stale fetch rejection after a newer success does not surface error', async () => {
      let rejectFirst;
      let resolveSecond;
      mockFetchPapers
        .mockImplementationOnce(() => new Promise((_, rej) => { rejectFirst = rej; }))
        .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));
      const comp = createComponent();

      const firstPending = comp.loadPapers();
      const secondPending = comp.loadPapers();

      resolveSecond({ data: [{ title: 'fresh' }], meta: { total: 1, limit: 10 } });
      await secondPending;
      expect(comp.error).toBeNull();
      expect(comp.papers).toEqual([{ title: 'fresh' }]);

      rejectFirst(new Error('late-stale-error'));
      await firstPending;
      // Stale error must NOT replace the fresh papers or flip error on.
      expect(comp.error).toBeNull();
      expect(comp.papers).toEqual([{ title: 'fresh' }]);
    });
  });
});

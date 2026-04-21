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
});

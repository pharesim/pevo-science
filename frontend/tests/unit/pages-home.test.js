import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchPapers = vi.fn();
const mockFetchDisciplines = vi.fn();

vi.mock('../../src/api.js', () => ({
  fetchPapers: (...args) => mockFetchPapers(...args),
  fetchDisciplines: (...args) => mockFetchDisciplines(...args),
}));

vi.mock('../../src/components/paper-card.js', () => ({
  truncateText: (text) => (text && text.length > 200 ? text.slice(0, 200) + '...' : text || ''),
  formatDate: (d) => d || '',
}));

const mockAuthStore = { isConnected: true };
const mockRouterStore = { navigate: vi.fn() };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'auth') return mockAuthStore;
      if (name === 'router') return mockRouterStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initHomePage } from '../../src/pages/home.js';

function createComponent() {
  initHomePage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  comp.$store = { auth: mockAuthStore, router: mockRouterStore };
  return comp;
}

describe('homePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchPapers.mockResolvedValue({ data: [], meta: { total: 0, limit: 10 } });
    mockFetchDisciplines.mockResolvedValue({ data: [] });
  });

  describe('paginationPages', () => {
    it('returns full range when totalPages <= 7', () => {
      const comp = createComponent();
      comp.totalPages = 5;
      comp.currentPage = 3;
      expect(comp.paginationPages).toEqual([1, 2, 3, 4, 5]);
    });

    it('returns [1,2,3,4,5,6,7] for exactly 7 pages', () => {
      const comp = createComponent();
      comp.totalPages = 7;
      comp.currentPage = 4;
      expect(comp.paginationPages).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it('adds ellipsis when totalPages > 7 and current is near start', () => {
      const comp = createComponent();
      comp.totalPages = 10;
      comp.currentPage = 2;
      // Should be: [1, 2, 3, '...', 10]
      expect(comp.paginationPages).toContain('...');
      expect(comp.paginationPages[0]).toBe(1);
      expect(comp.paginationPages[comp.paginationPages.length - 1]).toBe(10);
    });

    it('adds ellipsis on both sides when current is in middle', () => {
      const comp = createComponent();
      comp.totalPages = 10;
      comp.currentPage = 5;
      // Should be: [1, '...', 4, 5, 6, '...', 10]
      const pages = comp.paginationPages;
      expect(pages[0]).toBe(1);
      expect(pages[1]).toBe('...');
      expect(pages).toContain(5);
      expect(pages[pages.length - 2]).toBe('...');
      expect(pages[pages.length - 1]).toBe(10);
    });

    it('adds ellipsis only on left when current is near end', () => {
      const comp = createComponent();
      comp.totalPages = 10;
      comp.currentPage = 9;
      const pages = comp.paginationPages;
      expect(pages[0]).toBe(1);
      expect(pages[1]).toBe('...');
      expect(pages[pages.length - 1]).toBe(10);
      // No trailing ellipsis
      expect(pages.filter((p) => p === '...').length).toBe(1);
    });
  });

  describe('goToPage', () => {
    it('does nothing for ellipsis', () => {
      const comp = createComponent();
      comp.currentPage = 3;
      comp.totalPages = 10;
      comp.goToPage('...');
      expect(comp.currentPage).toBe(3);
    });

    it('does nothing for page < 1', () => {
      const comp = createComponent();
      comp.currentPage = 1;
      comp.totalPages = 5;
      comp.goToPage(0);
      expect(comp.currentPage).toBe(1);
    });

    it('does nothing for page > totalPages', () => {
      const comp = createComponent();
      comp.currentPage = 5;
      comp.totalPages = 5;
      comp.goToPage(6);
      expect(comp.currentPage).toBe(5);
    });

    it('updates currentPage and calls loadPapers for valid page', async () => {
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

    it('sets error on fetch failure', async () => {
      const comp = createComponent();
      mockFetchPapers.mockRejectedValue(new Error('Network error'));
      await comp.loadPapers();
      expect(comp.error).toBe('home.errorLoading');
      expect(comp.papers).toEqual([]);
      expect(comp.loading).toBe(false);
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

  describe('onDisciplineChange', () => {
    it('resets currentPage to 1 and reloads', () => {
      const comp = createComponent();
      comp.currentPage = 3;
      comp.onDisciplineChange();
      expect(comp.currentPage).toBe(1);
      expect(mockFetchPapers).toHaveBeenCalled();
    });
  });
});

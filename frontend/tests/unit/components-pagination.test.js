import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn(() => ({})),
  },
}));

import Alpine from 'alpinejs';
import { initPagination, paginationPages } from '../../src/components/pagination.js';

// Build the factory's data object and stitch in parent-scope values
// (totalPages / currentPage) that the factory reads via Alpine scope inheritance
// at runtime. In unit tests there is no parent scope, so we inject them onto
// the returned object before invoking methods.
function buildScope({ totalPages, currentPage, onPageChange }) {
  initPagination();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory(onPageChange);
  comp.totalPages = totalPages;
  comp.currentPage = currentPage;
  return comp;
}

describe('paginationPages (pure)', () => {
  it('returns [] when total is zero, negative, or non-finite', () => {
    expect(paginationPages(0, 1)).toEqual([]);
    expect(paginationPages(-1, 1)).toEqual([]);
    expect(paginationPages(NaN, 1)).toEqual([]);
    expect(paginationPages(undefined, 1)).toEqual([]);
  });

  it('returns the full range for total <= 7 (no ellipses)', () => {
    expect(paginationPages(1, 1)).toEqual([1]);
    expect(paginationPages(5, 3)).toEqual([1, 2, 3, 4, 5]);
    expect(paginationPages(7, 4)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('shows a single right ellipsis when current is near the start', () => {
    expect(paginationPages(10, 1)).toEqual([1, 2, '...', 10]);
    expect(paginationPages(10, 2)).toEqual([1, 2, 3, '...', 10]);
    expect(paginationPages(10, 3)).toEqual([1, 2, 3, 4, '...', 10]);
  });

  it('handles total=8, current=1 — first value that enters the ellipsis path', () => {
    // total <= 7 returns the full range; total === 8 is the smallest value
    // that produces an ellipsis, so this is a boundary worth pinning.
    expect(paginationPages(8, 1)).toEqual([1, 2, '...', 8]);
  });

  it('shows a single left ellipsis when current is near the end', () => {
    expect(paginationPages(10, 8)).toEqual([1, '...', 7, 8, 9, 10]);
    expect(paginationPages(10, 9)).toEqual([1, '...', 8, 9, 10]);
    expect(paginationPages(10, 10)).toEqual([1, '...', 9, 10]);
  });

  it('handles total=10, current=7 — last value producing a right ellipsis', () => {
    // Right ellipsis appears while clamped < total - 2. For total=10 that
    // boundary is clamped=7 (still shows right ellipsis); clamped=8 stops.
    expect(paginationPages(10, 7)).toEqual([1, '...', 6, 7, 8, '...', 10]);
  });

  it('shows both ellipses when current is in the middle', () => {
    expect(paginationPages(20, 10)).toEqual([1, '...', 9, 10, 11, '...', 20]);
    expect(paginationPages(100, 50)).toEqual([1, '...', 49, 50, 51, '...', 100]);
  });

  it('clamps currentPage above totalPages to totalPages', () => {
    // current > total is treated as if we were on the last page
    expect(paginationPages(10, 99)).toEqual(paginationPages(10, 10));
  });

  it('clamps currentPage below 1 to 1', () => {
    // current < 1 is treated as if we were on page 1
    expect(paginationPages(10, 0)).toEqual(paginationPages(10, 1));
    expect(paginationPages(10, -5)).toEqual(paginationPages(10, 1));
  });
});

describe('pagination factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('pages getter', () => {
    it('delegates to paginationPages using parent-scope totalPages/currentPage', () => {
      const comp = buildScope({ totalPages: 20, currentPage: 10, onPageChange: vi.fn() });
      expect(comp.pages).toEqual([1, '...', 9, 10, 11, '...', 20]);
    });
  });

  describe('goTo', () => {
    it('calls onPageChange with the requested page', () => {
      const cb = vi.fn();
      const comp = buildScope({ totalPages: 10, currentPage: 1, onPageChange: cb });
      comp.goTo(5);
      expect(cb).toHaveBeenCalledWith(5);
    });

    it('ignores ellipsis placeholder', () => {
      const cb = vi.fn();
      const comp = buildScope({ totalPages: 10, currentPage: 5, onPageChange: cb });
      comp.goTo('...');
      expect(cb).not.toHaveBeenCalled();
    });

    it('ignores clicks on the current page', () => {
      const cb = vi.fn();
      const comp = buildScope({ totalPages: 10, currentPage: 5, onPageChange: cb });
      comp.goTo(5);
      expect(cb).not.toHaveBeenCalled();
    });

    it('rejects out-of-range pages (< 1 or > totalPages)', () => {
      const cb = vi.fn();
      const comp = buildScope({ totalPages: 10, currentPage: 5, onPageChange: cb });
      comp.goTo(0);
      comp.goTo(-1);
      comp.goTo(11);
      comp.goTo(999);
      expect(cb).not.toHaveBeenCalled();
    });

    it('is a silent no-op when onPageChange is undefined', () => {
      const comp = buildScope({ totalPages: 10, currentPage: 1, onPageChange: undefined });
      expect(() => comp.goTo(5)).not.toThrow();
    });

    it('is a silent no-op when onPageChange is not a function', () => {
      const comp = buildScope({ totalPages: 10, currentPage: 1, onPageChange: 'not-a-fn' });
      expect(() => comp.goTo(5)).not.toThrow();
    });
  });

  describe('prev / next', () => {
    it('prev decrements currentPage', () => {
      const cb = vi.fn();
      const comp = buildScope({ totalPages: 10, currentPage: 5, onPageChange: cb });
      comp.prev();
      expect(cb).toHaveBeenCalledWith(4);
    });

    it('prev is a no-op on page 1', () => {
      const cb = vi.fn();
      const comp = buildScope({ totalPages: 10, currentPage: 1, onPageChange: cb });
      comp.prev();
      expect(cb).not.toHaveBeenCalled();
    });

    it('next increments currentPage', () => {
      const cb = vi.fn();
      const comp = buildScope({ totalPages: 10, currentPage: 5, onPageChange: cb });
      comp.next();
      expect(cb).toHaveBeenCalledWith(6);
    });

    it('next is a no-op on the last page', () => {
      const cb = vi.fn();
      const comp = buildScope({ totalPages: 10, currentPage: 10, onPageChange: cb });
      comp.next();
      expect(cb).not.toHaveBeenCalled();
    });
  });
});

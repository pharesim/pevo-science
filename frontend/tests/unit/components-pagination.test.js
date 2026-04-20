import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAlpine = {
  data: vi.fn(),
  store: vi.fn(() => ({})),
};
globalThis.Alpine = mockAlpine;

import { initPagination } from '../../src/components/pagination.js';

function createComponent(totalPages, currentPage, onPageChange) {
  initPagination();
  const factory = mockAlpine.data.mock.calls[mockAlpine.data.mock.calls.length - 1][1];
  const comp = factory(totalPages, currentPage, onPageChange);
  return comp;
}

describe('pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('pages getter', () => {
    it('returns full range for totalPages <= 7', () => {
      const comp = createComponent(5, 3, vi.fn());
      expect(comp.pages).toEqual([1, 2, 3, 4, 5]);
    });

    it('returns [1..7] for exactly 7 pages', () => {
      const comp = createComponent(7, 4, vi.fn());
      expect(comp.pages).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it('shows ellipsis near start when current is near end', () => {
      const comp = createComponent(20, 18, vi.fn());
      expect(comp.pages[0]).toBe(1);
      expect(comp.pages[1]).toBe('...');
      expect(comp.pages).toContain(17);
      expect(comp.pages).toContain(18);
      expect(comp.pages).toContain(19);
      expect(comp.pages[comp.pages.length - 1]).toBe(20);
    });

    it('shows ellipsis near end when current is near start', () => {
      const comp = createComponent(20, 2, vi.fn());
      expect(comp.pages[0]).toBe(1);
      expect(comp.pages).toContain(2);
      expect(comp.pages).toContain(3);
      expect(comp.pages).toContain('...');
      expect(comp.pages[comp.pages.length - 1]).toBe(20);
    });

    it('shows both ellipses when current is in the middle', () => {
      const comp = createComponent(20, 10, vi.fn());
      expect(comp.pages[0]).toBe(1);
      expect(comp.pages[1]).toBe('...');
      expect(comp.pages).toContain(9);
      expect(comp.pages).toContain(10);
      expect(comp.pages).toContain(11);
      expect(comp.pages[comp.pages.length - 2]).toBe('...');
      expect(comp.pages[comp.pages.length - 1]).toBe(20);
    });
  });

  describe('goTo', () => {
    it('calls onPageChange with the page number', () => {
      const cb = vi.fn();
      const comp = createComponent(10, 1, cb);
      comp.goTo(5);
      expect(cb).toHaveBeenCalledWith(5);
    });

    it('ignores ellipsis clicks', () => {
      const cb = vi.fn();
      const comp = createComponent(10, 5, cb);
      comp.goTo('...');
      expect(cb).not.toHaveBeenCalled();
    });

    it('ignores clicks on the current page', () => {
      const cb = vi.fn();
      const comp = createComponent(10, 5, cb);
      comp.goTo(5);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('prev / next', () => {
    it('prev decrements current page', () => {
      const cb = vi.fn();
      const comp = createComponent(10, 5, cb);
      comp.prev();
      expect(cb).toHaveBeenCalledWith(4);
    });

    it('prev does nothing on page 1', () => {
      const cb = vi.fn();
      const comp = createComponent(10, 1, cb);
      comp.prev();
      expect(cb).not.toHaveBeenCalled();
    });

    it('next increments current page', () => {
      const cb = vi.fn();
      const comp = createComponent(10, 5, cb);
      comp.next();
      expect(cb).toHaveBeenCalledWith(6);
    });

    it('next does nothing on last page', () => {
      const cb = vi.fn();
      const comp = createComponent(10, 10, cb);
      comp.next();
      expect(cb).not.toHaveBeenCalled();
    });
  });
});

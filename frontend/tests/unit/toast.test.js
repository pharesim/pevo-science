import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let store;
vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name, def) => {
      if (def) store = def;
      return store;
    }),
  },
}));

import { initToast } from '../../src/toast.js';

describe('toast store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store = null;
    initToast();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('show', () => {
    it('adds an item with correct fields', () => {
      store.show('Hello', 'success');
      expect(store.items).toHaveLength(1);
      expect(store.items[0]).toMatchObject({ message: 'Hello', type: 'success', removing: false });
    });

    it('defaults type to info', () => {
      store.show('Msg');
      expect(store.items[0].type).toBe('info');
    });

    it('assigns unique incrementing ids', () => {
      store.show('A');
      store.show('B');
      expect(store.items[1].id).toBeGreaterThan(store.items[0].id);
    });

    it('enforces MAX_TOASTS cap (3)', () => {
      store.show('A');
      store.show('B');
      store.show('C');
      store.show('D');
      expect(store.items).toHaveLength(3);
      // oldest removed
      expect(store.items[0].message).toBe('B');
    });

    it('auto-dismisses after 5000ms', () => {
      store.show('Auto');
      const id = store.items[0].id;
      vi.advanceTimersByTime(5000);
      // Item should be in removing state
      const item = store.items.find((t) => t.id === id);
      expect(item.removing).toBe(true);
      // After animation delay it disappears
      vi.advanceTimersByTime(300);
      expect(store.items.find((t) => t.id === id)).toBeUndefined();
    });
  });

  describe('dismiss', () => {
    it('sets removing flag then removes after animation delay', () => {
      store.show('X');
      const id = store.items[0].id;
      store.dismiss(id);
      expect(store.items[0].removing).toBe(true);
      expect(store.items).toHaveLength(1);
      vi.advanceTimersByTime(300);
      expect(store.items).toHaveLength(0);
    });

    it('does nothing for non-existent id', () => {
      store.show('X');
      store.dismiss(9999);
      expect(store.items).toHaveLength(1);
      expect(store.items[0].removing).toBe(false);
    });

    it('does nothing if already removing', () => {
      store.show('X');
      const id = store.items[0].id;
      store.dismiss(id);
      expect(store.items[0].removing).toBe(true);
      // second dismiss should be a no-op
      store.dismiss(id);
      // still only one pending removal timer
      vi.advanceTimersByTime(300);
      expect(store.items).toHaveLength(0);
    });
  });
});

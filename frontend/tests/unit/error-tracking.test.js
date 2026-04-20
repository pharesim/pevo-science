import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockToastStore = { show: vi.fn() };

vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name) => {
      if (name === 'toast') return mockToastStore;
      return null;
    }),
  },
}));

import { initErrorTracking } from '../../src/error-tracking.js';

describe('error-tracking', () => {
  let errorListeners;

  beforeEach(() => {
    mockToastStore.show.mockClear();
    errorListeners = [];

    vi.spyOn(window, 'addEventListener').mockImplementation((event, handler) => {
      if (event === 'error') errorListeners.push(handler);
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('showErrorToast resilience', () => {
    it('does not throw when toast store is unavailable', async () => {
      const { default: Alpine } = await import('alpinejs');
      Alpine.store.mockReturnValueOnce(null);
      await initErrorTracking();
      // Should not throw
      expect(() => errorListeners[0]({ error: new Error('x'), message: 'x' })).not.toThrow();
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/api.js', () => ({
  fetchPlatformStats: vi.fn(),
}));

const mockStores = {
  router: { params: {}, navigate: vi.fn() },
};

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => mockStores[name] || {}),
  },
}));

import Alpine from 'alpinejs';
import { fetchPlatformStats } from '../../src/api.js';
import { initStatsPage } from '../../src/pages/stats.js';

function createComponent(overrides = {}) {
  initStatsPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$store = mockStores;
  comp.$t = (key) => key;
  comp.$watch = vi.fn();
  comp.$nextTick = vi.fn((fn) => fn && fn());
  Object.assign(comp, overrides);
  return comp;
}

describe('statsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('statCards', () => {
    it('returns empty array when no stats', () => {
      const comp = createComponent();
      comp.stats = null;
      expect(comp.statCards).toEqual([]);
    });

    it('returns array of card objects when stats present', () => {
      const comp = createComponent();
      comp.stats = { total_papers: 42 };
      const cards = comp.statCards;
      expect(cards.length).toBe(7);
      expect(cards[0].key).toBe('total_papers');
      expect(cards[0].label).toBe('stats.totalPapers');
    });
  });

  describe('statValue', () => {
    it('formats numbers with locale', () => {
      const comp = createComponent();
      comp.stats = { total_papers: 1234 };
      const result = comp.statValue('total_papers');
      // toLocaleString output varies by locale, just check it's a string representation
      expect(result).toContain('1');
      expect(result).toContain('234');
    });
  });

  describe('loadStats', () => {
    it('sets stats from API response', async () => {
      fetchPlatformStats.mockResolvedValue({ data: { total_papers: 100, total_reviews: 50 } });
      const comp = createComponent();
      await comp.loadStats();
      expect(comp.stats).toEqual({ total_papers: 100, total_reviews: 50 });
      expect(comp.loading).toBe(false);
      expect(comp.error).toBe(null);
    });

    it('sets error on failure', async () => {
      fetchPlatformStats.mockRejectedValue(new Error('Server down'));
      const comp = createComponent();
      await comp.loadStats();
      expect(comp.error).toBe('Server down');
      expect(comp.loading).toBe(false);
      expect(comp.stats).toBe(null);
    });
  });
});

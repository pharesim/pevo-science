import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/api.js', () => ({
  fetchProfile: vi.fn(),
  fetchProfilePapers: vi.fn(),
  fetchProfileReviews: vi.fn(),
}));

vi.mock('../../src/components/paper-card.js', () => ({
  truncateText: (t) => t,
  formatDate: (d) => d,
}));

const mockStores = {
  router: { params: { username: 'alice' }, navigate: vi.fn() },
  auth: { username: 'bob' },
};

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => mockStores[name] || {}),
  },
}));

import Alpine from 'alpinejs';
import { fetchProfileReviews } from '../../src/api.js';
import { initProfilePage } from '../../src/pages/profile.js';

function createComponent(overrides = {}) {
  initProfilePage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$store = mockStores;
  comp.$t = (key) => key;
  comp.$watch = vi.fn();
  comp.$nextTick = vi.fn((fn) => fn && fn());
  Object.assign(comp, overrides);
  return comp;
}

describe('profilePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('breakdownEntries', () => {
    it('filters deprecated keys', () => {
      const comp = createComponent();
      comp.profile = {
        reputation: {
          breakdown: {
            publications: 10,
            reviews: 5,
            paper_votes: 3,
            review_votes: 2,
            account_age: 1,
            citations: 8,
          },
        },
      };
      const entries = comp.breakdownEntries;
      const keys = entries.map(([k]) => k);
      expect(keys).toContain('publications');
      expect(keys).toContain('reviews');
      expect(keys).toContain('citations');
      expect(keys).not.toContain('paper_votes');
      expect(keys).not.toContain('review_votes');
      expect(keys).not.toContain('account_age');
    });

    it('returns empty array when no breakdown', () => {
      const comp = createComponent();
      comp.profile = {};
      expect(comp.breakdownEntries).toEqual([]);
    });
  });

  describe('breakdownPct', () => {
    it('calculates percentage based on max value', () => {
      const comp = createComponent();
      comp.profile = {
        reputation: {
          breakdown: { publications: 10, reviews: 5 },
        },
      };
      // maxBreakdownValue = 10
      expect(comp.breakdownPct(10)).toBe(100);
      expect(comp.breakdownPct(5)).toBe(50);
    });

    it('handles zero max gracefully', () => {
      const comp = createComponent();
      comp.profile = {
        reputation: {
          breakdown: {},
        },
      };
      // maxBreakdownValue = Math.max(...[], 1) = 1
      expect(comp.breakdownPct(0)).toBe(0);
    });
  });

  describe('switchTab', () => {
    it('triggers review load on first switch to reviews', () => {
      fetchProfileReviews.mockResolvedValue({ data: [] });
      const comp = createComponent();
      comp.activeTab = 'publications';
      comp.reviewsLoaded = false;
      comp.switchTab('reviews');
      expect(comp.activeTab).toBe('reviews');
      expect(fetchProfileReviews).toHaveBeenCalled();
    });

    it('does not reload reviews if already loaded', () => {
      const comp = createComponent();
      comp.activeTab = 'publications';
      comp.reviewsLoaded = true;
      comp.switchTab('reviews');
      expect(fetchProfileReviews).not.toHaveBeenCalled();
    });
  });
});

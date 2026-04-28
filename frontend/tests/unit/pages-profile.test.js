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
import { fetchProfile, fetchProfilePapers, fetchProfileReviews } from '../../src/api.js';
import { initProfilePage } from '../../src/pages/profile.js';
import { titleCaseDiscipline } from '../../src/lib/discipline-display.js';

// Sentinel the DOM-bound field / toast must NOT contain.
const LEAK_SENTINEL = 'deadbeef-leak-sentinel';

function leakyError() {
  return new Error(`server leak: ${LEAK_SENTINEL} pg=table_not_found`);
}

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

  // Factory-exposure regression guard: three discipline render sites in the
  // profile template (`accreditation.field` x2, `paper.discipline` x1) call
  // `titleCaseDiscipline(...)` and would fire silent ReferenceErrors at
  // runtime if the helper isn't on the Alpine data factory.
  describe('factory exposes titleCaseDiscipline', () => {
    it('factory().titleCaseDiscipline is identity-equal to the imported helper', () => {
      const comp = createComponent();
      expect(comp.titleCaseDiscipline).toBe(titleCaseDiscipline);
    });
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

  // UI-ERR-MESSAGE-SANITIZE-PAPER-DETAIL-SURVIVORS: the profile.loadProfile
  // catch block was sanitized in commit 0ee5bfe to bind a generic localized
  // key instead of err?.message. Mirrors the pages-paper-detail.test.js
  // pattern: generic i18n key bound to this.error, raw err reaches
  // console.warn, leak sentinel does NOT surface in the DOM-bound field.
  describe('loadProfile error sanitization', () => {
    let warnSpy;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('generic key bound, raw err to warn, no leak in this.error', async () => {
      const err = leakyError();
      fetchProfile.mockRejectedValue(err);
      fetchProfilePapers.mockRejectedValue(err);
      const comp = createComponent();
      await comp.loadProfile();
      expect(comp.error).toBe('profile.loadFailed');
      expect(comp.error).not.toContain(LEAK_SENTINEL);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(err);
    });
  });
});

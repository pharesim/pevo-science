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

  describe('loadProfile 503 retry affordance', () => {
    function serviceUnavailableErr() {
      return Object.assign(new Error('Service Unavailable'), {
        code: 'SERVICE_UNAVAILABLE',
        details: { retriable: true },
      });
    }

    it('flags papersRetriable when fetchProfilePapers throws 503 retriable', async () => {
      fetchProfile.mockResolvedValue({ data: { username: 'alice' } });
      fetchProfilePapers.mockRejectedValue(serviceUnavailableErr());
      const comp = createComponent();
      await comp.loadProfile();
      expect(comp.papersRetriable).toBe(true);
      expect(comp.userPapers).toEqual([]);
      // The profile-level error path is NOT triggered; the discriminating
      // catch on the papers sub-fetch absorbs the 503 and surfaces it via
      // the retry banner instead.
      expect(comp.error).toBeNull();
    });

    it('does not flag papersRetriable for plain network/error failures', async () => {
      fetchProfile.mockResolvedValue({ data: { username: 'alice' } });
      fetchProfilePapers.mockRejectedValue(new Error('Network'));
      const comp = createComponent();
      await comp.loadProfile();
      expect(comp.papersRetriable).toBe(false);
      expect(comp.userPapers).toEqual([]);
    });

    it('clears papersRetriable on a successful retry', async () => {
      fetchProfile.mockResolvedValue({ data: { username: 'alice' } });
      fetchProfilePapers
        .mockRejectedValueOnce(serviceUnavailableErr())
        .mockResolvedValueOnce({ data: [{ author: 'alice', permlink: 'p1' }] });
      const comp = createComponent();
      await comp.loadProfile();
      expect(comp.papersRetriable).toBe(true);
      await comp.loadProfile();
      expect(comp.papersRetriable).toBe(false);
      expect(comp.userPapers).toHaveLength(1);
    });

    // A stale 503 from a prior profile's in-flight papers fetch must not
    // land papersRetriable=true on the current component after the page-
    // mount reuses the same Alpine x-data instance for a new username.
    // The sub-fetch catch captures locally; the post-Promise.all stale-call
    // guard skips the mutation when the username changed mid-flight.
    it('does not set papersRetriable when username changes between fetch start and 503 rejection', async () => {
      fetchProfile.mockResolvedValue({ data: { username: 'alice' } });
      fetchProfilePapers.mockImplementation(() => {
        // Mutate the param mid-flight to simulate a navigation to a new
        // profile after this fetch was dispatched.
        mockStores.router.params.username = 'carol';
        return Promise.reject(serviceUnavailableErr());
      });
      const comp = createComponent();
      await comp.loadProfile();
      expect(comp.papersRetriable).toBe(false);
      // restore for other tests
      mockStores.router.params.username = 'alice';
    });
  });

  describe('loadReviews 503 retry affordance', () => {
    function serviceUnavailableErr() {
      return Object.assign(new Error('Service Unavailable'), {
        code: 'SERVICE_UNAVAILABLE',
        details: { retriable: true },
      });
    }

    it('flags reviewsRetriable when fetchProfileReviews throws 503 retriable', async () => {
      fetchProfileReviews.mockRejectedValue(serviceUnavailableErr());
      const comp = createComponent();
      await comp.loadReviews();
      expect(comp.reviewsRetriable).toBe(true);
      expect(comp.userReviews).toEqual([]);
      expect(comp.reviewsLoaded).toBe(true);
    });

    it('does not flag reviewsRetriable for plain failures', async () => {
      fetchProfileReviews.mockRejectedValue(new Error('Network'));
      const comp = createComponent();
      await comp.loadReviews();
      expect(comp.reviewsRetriable).toBe(false);
    });

    it('clears reviewsRetriable on a successful retry', async () => {
      fetchProfileReviews
        .mockRejectedValueOnce(serviceUnavailableErr())
        .mockResolvedValueOnce({ data: [{ author: 'alice', permlink: 'r1', paper: { title: 't' } }] });
      const comp = createComponent();
      await comp.loadReviews();
      expect(comp.reviewsRetriable).toBe(true);
      await comp.loadReviews();
      expect(comp.reviewsRetriable).toBe(false);
      expect(comp.userReviews).toHaveLength(1);
    });

    // Synchronous-flag-before-await: a second loadReviews() invoked while
    // the first is still in-flight must not dispatch a second fetch.
    // Without the guard, two concurrent fetches race and the loser's catch
    // arm can clobber the winner's data + reset reviewsRetriable.
    it('drops a concurrent loadReviews() while one is in-flight', async () => {
      let resolveFirst;
      fetchProfileReviews.mockImplementationOnce(
        () => new Promise((resolve) => { resolveFirst = resolve; }),
      );
      const comp = createComponent();
      const first = comp.loadReviews();
      // Second invocation while first is awaiting — must be dropped before
      // any second fetch is dispatched.
      const second = comp.loadReviews();
      expect(fetchProfileReviews).toHaveBeenCalledTimes(1);
      resolveFirst({ data: [{ author: 'alice', permlink: 'r1', paper: { title: 't' } }] });
      await Promise.all([first, second]);
      expect(comp.userReviews).toHaveLength(1);
      expect(comp.reviewsRetriable).toBe(false);
    });

    // Explicit clear on the success path so a successful retry returns to a
    // clean state without depending on the next call's top-of-function reset.
    it('clears reviewsRetriable explicitly on the success path', async () => {
      fetchProfileReviews.mockResolvedValue({ data: [{ author: 'alice', permlink: 'r1', paper: { title: 't' } }] });
      const comp = createComponent();
      // Simulate a stale flag from a prior failed load.
      comp.reviewsRetriable = true;
      await comp.loadReviews();
      expect(comp.reviewsRetriable).toBe(false);
      expect(comp.userReviews).toHaveLength(1);
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

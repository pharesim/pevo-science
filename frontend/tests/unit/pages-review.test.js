import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/api.js', () => ({
  fetchPaper: vi.fn(),
  submitAnonymousReview: vi.fn(),
}));

vi.mock('../../src/signer.js', () => ({
  broadcastOps: vi.fn(),
}));

vi.mock('../../src/crypto.js', () => ({
  slugify: vi.fn((s) => s.toLowerCase().replace(/\s+/g, '-')),
}));

vi.mock('../../src/config.js', () => ({
  getAppTag: () => 'pevotest',
  getAppId: () => 'pevotest/1.0',
  getMaxUploadSize: () => 50 * 1024 * 1024,
  getMaxUploadSizeMB: () => 50,
}));

const mockStores = {
  router: { params: { author: 'alice', permlink: 'paper-1' }, navigate: vi.fn() },
  auth: { isConnected: true, isAccredited: true, username: 'bob' },
  toast: { show: vi.fn() },
  broadcastConfirm: { request: vi.fn(() => Promise.resolve(true)) },
};

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => mockStores[name] || {}),
  },
}));

import Alpine from 'alpinejs';
import { initReviewPage } from '../../src/pages/review.js';

function createComponent(overrides = {}) {
  initReviewPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$store = mockStores;
  comp.$t = (key) => key;
  comp.$watch = vi.fn();
  comp.$nextTick = vi.fn((fn) => fn && fn());
  Object.assign(comp, overrides);
  return comp;
}

describe('reviewPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStores.auth.username = 'bob';
    mockStores.router.params = { author: 'alice', permlink: 'paper-1' };
  });

  describe('isOwnPaper', () => {
    it('returns true when username matches paper author', () => {
      mockStores.auth.username = 'alice';
      const comp = createComponent();
      expect(comp.isOwnPaper).toBe(true);
    });

    it('returns true when username is co-author', () => {
      mockStores.auth.username = 'bob';
      const comp = createComponent();
      comp.paper = { authors: [{ hive: 'alice' }, { hive: 'bob' }] };
      expect(comp.isOwnPaper).toBe(true);
    });

    it('returns false when not author or co-author', () => {
      mockStores.auth.username = 'carol';
      const comp = createComponent();
      comp.paper = { authors: [{ hive: 'alice' }] };
      expect(comp.isOwnPaper).toBe(false);
    });

    it('returns false when no username', () => {
      mockStores.auth.username = '';
      const comp = createComponent();
      expect(comp.isOwnPaper).toBe(false);
    });
  });

  describe('paperTitle', () => {
    it('returns paper title when available', () => {
      const comp = createComponent();
      comp.paper = { title: 'My Paper Title' };
      expect(comp.paperTitle).toBe('My Paper Title');
    });

    it('falls back to author/permlink', () => {
      const comp = createComponent();
      comp.paper = null;
      expect(comp.paperTitle).toBe('alice/paper-1');
    });
  });

  describe('allRated', () => {
    it('returns true when all ratings > 0', () => {
      const comp = createComponent();
      comp.ratings = { methodology: 4, novelty: 3, clarity: 5, significance: 2 };
      expect(comp.allRated).toBe(true);
    });

    it('returns false when some ratings = 0', () => {
      const comp = createComponent();
      comp.ratings = { methodology: 4, novelty: 0, clarity: 5, significance: 2 };
      expect(comp.allRated).toBe(false);
    });

    it('returns false when all ratings = 0', () => {
      const comp = createComponent();
      comp.ratings = { methodology: 0, novelty: 0, clarity: 0, significance: 0 };
      expect(comp.allRated).toBe(false);
    });
  });

  describe('isSubmitting', () => {
    it.each([
      ['idle', false],
      ['success', false],
      ['error', false],
      ['submitting', true],
    ])('step=%s -> isSubmitting=%s', (step, expected) => {
      const comp = createComponent();
      comp.step = step;
      expect(comp.isSubmitting).toBe(expected);
    });
  });

  describe('stepMessage', () => {
    it('returns empty for idle', () => {
      const comp = createComponent();
      comp.step = 'idle';
      expect(comp.stepMessage).toBe('');
    });

    it('returns submitting message (non-anonymous)', () => {
      const comp = createComponent();
      comp.step = 'submitting';
      comp.isAnonymous = false;
      expect(comp.stepMessage).toBe('review.stepSubmitting');
    });

    it('returns submitting message (anonymous)', () => {
      const comp = createComponent();
      comp.step = 'submitting';
      comp.isAnonymous = true;
      expect(comp.stepMessage).toBe('review.stepSubmittingAnon');
    });

    it('returns success message', () => {
      const comp = createComponent();
      comp.step = 'success';
      expect(comp.stepMessage).toBe('review.stepSuccess');
    });

    it('returns error message', () => {
      const comp = createComponent();
      comp.step = 'error';
      comp.errorMessage = 'Something went wrong';
      expect(comp.stepMessage).toBe('Something went wrong');
    });
  });

  describe('stepClass', () => {
    it.each([
      ['success', 'pevo-green'],
      ['error', 'pevo-crimson'],
      ['submitting', 'pevo-teal'],
    ])('step=%s -> contains %s', (step, cls) => {
      const comp = createComponent();
      comp.step = step;
      expect(comp.stepClass).toContain(cls);
    });
  });

  // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: broadcast failure
  // surfaces a generic localized message; raw err reaches console.warn.
  describe('handleSubmit sanitization', () => {
    it('sanitizes broadcast failure: generic message to DOM, raw err to console.warn', async () => {
      const { broadcastOps } = await import('../../src/signer.js');
      const leaky = new Error('network boom hex=deadbeefcafebabe');
      broadcastOps.mockRejectedValueOnce(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockStores.auth.isConnected = true;
      mockStores.auth.username = 'bob';
      const comp = createComponent({
        ratings: { novelty: 4, methodology: 4, clarity: 4, significance: 4 },
        reviewBody: 'Looks good.',
        isAnonymous: false,
        paper: { title: 'Paper' },
      });
      // Force allRated-style readiness if it's a getter. Tests below bypass
      // via direct property assignment to focus on the catch path.
      Object.defineProperty(comp, 'allRated', { value: true, configurable: true });

      await comp.handleSubmit();

      expect(comp.step).toBe('error');
      expect(comp.errorMessage).toBe('review.submissionFailed');
      expect(comp.errorMessage).not.toContain('deadbeef');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });

    // UI-SETTIMEOUT-NAVIGATE-TEARDOWN-GUARD-SWEEP: the 1.5s post-success
    // redirect must be cancelable. If the user navigates away during the
    // wait, destroy() clears the pending timer and navigate MUST NOT fire.
    it('destroy() cancels the post-success redirect timer (no navigate after teardown)', async () => {
      vi.useFakeTimers();
      const { broadcastOps } = await import('../../src/signer.js');
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      mockStores.auth.isConnected = true;
      mockStores.auth.username = 'bob';
      const comp = createComponent({
        ratings: { novelty: 4, methodology: 4, clarity: 4, significance: 4 },
        reviewBody: 'Looks good.',
        isAnonymous: false,
        paper: { title: 'Paper' },
      });
      Object.defineProperty(comp, 'allRated', { value: true, configurable: true });

      await comp.handleSubmit();
      expect(comp.step).toBe('success');
      expect(mockStores.router.navigate).not.toHaveBeenCalled();

      comp.destroy();
      vi.advanceTimersByTime(3000);
      expect(mockStores.router.navigate).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});

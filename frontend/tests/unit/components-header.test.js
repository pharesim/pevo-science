import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/i18n.js', () => ({
  SUPPORTED_LOCALES: ['en', 'fr', 'de'],
}));

const mockAuthStore = { isConnected: false, username: '', disconnect: vi.fn() };
const mockRouterStore = { navigate: vi.fn() };
const mockToastStore = { show: vi.fn() };
const mockNotificationsStore = { stop: vi.fn() };
const mockI18nStore = { locale: 'en', setLocale: vi.fn() };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'auth') return mockAuthStore;
      if (name === 'router') return mockRouterStore;
      if (name === 'toast') return mockToastStore;
      if (name === 'notifications') return mockNotificationsStore;
      if (name === 'i18n') return mockI18nStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initHeader } from '../../src/components/header.js';

function createComponent() {
  initHeader();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key, params) => params ? `${key}:${JSON.stringify(params)}` : key;
  comp.$store = {
    auth: mockAuthStore,
    router: mockRouterStore,
    toast: mockToastStore,
    notifications: mockNotificationsStore,
    i18n: mockI18nStore,
  };
  return comp;
}

describe('header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.isConnected = false;
  });

  describe('link getters', () => {
    it('primaryLinks includes papers, search, researchers', () => {
      const comp = createComponent();
      const paths = comp.primaryLinks.map((l) => l.path);
      expect(paths).toEqual(['/papers', '/search', '/researchers']);
    });

    it('moreLinks includes publish and other secondary pages', () => {
      const comp = createComponent();
      const paths = comp.moreLinks.map((l) => l.path);
      expect(paths).toContain('/publish');
      expect(paths).toContain('/blog');
      expect(paths).toContain('/stats');
    });

    it('allLinks is the union of primary and more', () => {
      const comp = createComponent();
      expect(comp.allLinks.length).toBe(comp.primaryLinks.length + comp.moreLinks.length);
    });
  });

  describe('formatNotification', () => {
    it('returns empty string for null/missing event', () => {
      const comp = createComponent();
      expect(comp.formatNotification(null)).toBe('');
      expect(comp.formatNotification({})).toBe('');
    });

    // Backend NewVoteEvent emits the noun as snake_case `target_type` (paper|review)
    // and the notifications store ingests events verbatim, so formatNotification must
    // read the snake_case wire field. These feed the real wire shape; reading a
    // camelCase alias would drop the noun and render "endorsed your " (empty noun).
    it('formats new_vote (paper) with positive weight and renders the noun', () => {
      const comp = createComponent();
      const result = comp.formatNotification({ type: 'new_vote', weight: 100, actor: 'bob', target_type: 'paper' });
      expect(result).toContain('notifications.newVote');
      expect(result).toContain('paper');
    });

    it('formats new_vote (review) with negative weight as downvote and renders the noun', () => {
      const comp = createComponent();
      const result = comp.formatNotification({ type: 'new_vote', weight: -100, actor: 'bob', target_type: 'review' });
      expect(result).toContain('notifications.newDownvote');
      expect(result).toContain('review');
    });

    // new_review / new_citation interpolate the paper title from the snake_case
    // wire field `paper_title` (NewReviewEvent / NewCitationEvent). Feeding the
    // real wire shape catches a wrong-field-name alias that would render an
    // empty title.
    it('formats new_review and renders the paper title', () => {
      const comp = createComponent();
      const result = comp.formatNotification({ type: 'new_review', actor: 'bob', paper_title: 'Plasticity' });
      expect(result).toContain('notifications.newReview');
      expect(result).toContain('Plasticity');
    });

    it('formats new_citation and renders the paper title', () => {
      const comp = createComponent();
      const result = comp.formatNotification({ type: 'new_citation', actor: 'bob', paper_title: 'Plasticity' });
      expect(result).toContain('notifications.newCitation');
      expect(result).toContain('Plasticity');
    });

    // Authorship-claim events (ClaimPendingEvent / ClaimApprovedEvent /
    // ClaimRevokedEvent) reach formatNotification in their real snake_case wire
    // shape. Without a typeMap entry they fell through `return event.type` and
    // rendered the raw token (e.g. "claim_pending"); these feed the wire shape
    // and assert a localized key renders with no raw `claim_` token leaking.
    it('formats claim_pending with the claimer actor and no raw token', () => {
      const comp = createComponent();
      const result = comp.formatNotification({ type: 'claim_pending', actor: 'bob', paper_author: 'alice', paper_permlink: 'my-paper' });
      expect(result).toContain('notifications.claimPending');
      expect(result).toContain('bob');
      expect(result).not.toContain('claim_');
    });

    it('formats claim_approved impersonally with no raw token', () => {
      const comp = createComponent();
      const result = comp.formatNotification({ type: 'claim_approved', paper_author: 'alice', paper_permlink: 'my-paper' });
      expect(result).toContain('notifications.claimApproved');
      expect(result).not.toContain('claim_');
    });

    it('formats claim_revoked impersonally with no raw token', () => {
      const comp = createComponent();
      const result = comp.formatNotification({ type: 'claim_revoked', paper_author: 'alice', paper_permlink: 'my-paper' });
      expect(result).toContain('notifications.claimRevoked');
      expect(result).not.toContain('claim_');
    });

    it('formats accreditation_update grant', () => {
      const comp = createComponent();
      const result = comp.formatNotification({ type: 'accreditation_update', action: 'grant' });
      expect(result).toBe('notifications.accreditationGranted');
    });

    it('formats accreditation_update revoke', () => {
      const comp = createComponent();
      const result = comp.formatNotification({ type: 'accreditation_update', action: 'revoke' });
      expect(result).toBe('notifications.accreditationRevoked');
    });

    it('returns event type for unknown types', () => {
      const comp = createComponent();
      const result = comp.formatNotification({ type: 'unknown_type' });
      expect(result).toBe('unknown_type');
    });
  });

  describe('handleSignIn sanitize invariant', () => {
    it('shows i18n key in toast (never raw err.message) and warns with the real err', async () => {
      const leaky = new Error('keychain-rejected-sentinel');
      mockAuthStore.connect = vi.fn().mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      await comp.handleSignIn();
      expect(mockToastStore.show).toHaveBeenCalledWith('common.connectionFailed', 'error');
      expect(mockToastStore.show.mock.calls[0][0]).not.toContain('sentinel');
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
    });
  });
});

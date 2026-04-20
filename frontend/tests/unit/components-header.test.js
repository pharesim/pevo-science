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

    it('formats new_vote with positive weight', () => {
      const comp = createComponent();
      const result = comp.formatNotification({ type: 'new_vote', weight: 100, actor: 'bob', targetType: 'paper' });
      expect(result).toContain('notifications.newVote');
    });

    it('formats new_vote with negative weight as downvote', () => {
      const comp = createComponent();
      const result = comp.formatNotification({ type: 'new_vote', weight: -100, actor: 'bob', targetType: 'paper' });
      expect(result).toContain('notifications.newDownvote');
    });

    it('formats new_review', () => {
      const comp = createComponent();
      const result = comp.formatNotification({ type: 'new_review', actor: 'bob', title: 'Paper' });
      expect(result).toContain('notifications.newReview');
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
});

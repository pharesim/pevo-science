import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockVerifyEmailToken = vi.fn();

vi.mock('../../src/api.js', () => ({
  verifyEmailToken: (...args) => mockVerifyEmailToken(...args),
}));

const mockRouterStore = { navigate: vi.fn(), params: {} };
const mockToastStore = { show: vi.fn() };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'router') return mockRouterStore;
      if (name === 'toast') return mockToastStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initSettingsVerifyEmailPage } from '../../src/pages/settings-verify-email.js';

function createComponent(params = {}) {
  mockRouterStore.params = params;
  initSettingsVerifyEmailPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  return comp;
}

describe('settingsVerifyEmailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('init', () => {
    it('goes to error phase when no token', () => {
      const comp = createComponent({});
      comp.init();
      expect(comp.phase).toBe('error');
      expect(comp.error).toBe('settings.emailTokenExpired');
    });

    it('calls verify when token present', () => {
      mockVerifyEmailToken.mockResolvedValue({});
      const comp = createComponent({ token: 'abc' });
      comp.init();
      expect(mockVerifyEmailToken).toHaveBeenCalledWith('abc');
    });
  });

  describe('verify', () => {
    it('sets success phase and shows toast', async () => {
      mockVerifyEmailToken.mockResolvedValue({});
      const comp = createComponent({});

      await comp.verify('tok123');

      expect(comp.phase).toBe('success');
      expect(mockToastStore.show).toHaveBeenCalled();
    });

    // Error sanitization: failure surfaces a generic localized message;
    // raw err reaches console.warn only (never the DOM).
    it('sanitizes failure: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('token expired hex=deadbeefcafebabe');
      mockVerifyEmailToken.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent({});

      await comp.verify('bad-tok');

      expect(comp.phase).toBe('error');
      expect(comp.error).toBe('settings.emailTokenExpired');
      expect(comp.error).not.toContain('deadbeef');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });

    it('error path with no message still shows the generic i18n key', async () => {
      mockVerifyEmailToken.mockRejectedValue({});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent({});

      await comp.verify('bad-tok');

      expect(comp.phase).toBe('error');
      expect(comp.error).toBe('settings.emailTokenExpired');
      warnSpy.mockRestore();
    });
  });
});

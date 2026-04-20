import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRequestPasswordReset = vi.fn();
const mockResetPassword = vi.fn();

vi.mock('../../src/api.js', () => ({
  requestPasswordReset: (...args) => mockRequestPasswordReset(...args),
  resetPassword: (...args) => mockResetPassword(...args),
}));

const mockRouterStore = { navigate: vi.fn() };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'router') return mockRouterStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initResetPasswordPage } from '../../src/pages/reset-password.js';

function createComponent() {
  initResetPasswordPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  return comp;
}

describe('resetPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('passwordValid', () => {
    it('requires 10+ chars with mixed case and digit', () => {
      const comp = createComponent();
      comp.password = 'Abcdefgh1x';
      expect(comp.passwordValid).toBe(true);
    });

    it('rejects short password', () => {
      const comp = createComponent();
      comp.password = 'Ab1';
      expect(comp.passwordValid).toBe(false);
    });
  });

  describe('canReset', () => {
    it('requires valid password and matching confirm', () => {
      const comp = createComponent();
      comp.password = 'Abcdefgh1x';
      comp.passwordConfirm = 'Abcdefgh1x';
      expect(comp.canReset).toBe(true);
    });

    it('false when passwords differ', () => {
      const comp = createComponent();
      comp.password = 'Abcdefgh1x';
      comp.passwordConfirm = 'Different1z';
      expect(comp.canReset).toBe(false);
    });
  });

  describe('init', () => {
    it('detects token from URL and switches to reset mode', () => {
      vi.stubGlobal('window', {
        ...globalThis.window,
        location: { search: '?token=abc123' },
      });
      const comp = createComponent();
      comp.init();
      expect(comp.mode).toBe('reset');
      expect(comp.token).toBe('abc123');
    });

    it('stays in request mode when no token', () => {
      vi.stubGlobal('window', {
        ...globalThis.window,
        location: { search: '' },
      });
      const comp = createComponent();
      comp.init();
      expect(comp.mode).toBe('request');
    });
  });

  describe('handleRequestReset', () => {
    it('calls requestPasswordReset and sets requestSent', async () => {
      mockRequestPasswordReset.mockResolvedValue({});
      const comp = createComponent();
      comp.email = ' user@x.com ';

      await comp.handleRequestReset();

      expect(mockRequestPasswordReset).toHaveBeenCalledWith('user@x.com');
      expect(comp.requestSent).toBe(true);
    });

    it('does nothing with empty email', async () => {
      const comp = createComponent();
      comp.email = '  ';
      await comp.handleRequestReset();
      expect(mockRequestPasswordReset).not.toHaveBeenCalled();
    });

    it('sets error on failure', async () => {
      mockRequestPasswordReset.mockRejectedValue(new Error('not found'));
      const comp = createComponent();
      comp.email = 'x@x.com';

      await comp.handleRequestReset();

      expect(comp.requestError).toBe('not found');
      expect(comp.requestSubmitting).toBe(false);
    });
  });

  describe('handleReset', () => {
    it('calls resetPassword and sets resetDone', async () => {
      mockResetPassword.mockResolvedValue({});
      const comp = createComponent();
      comp.token = 'tok';
      comp.password = 'Abcdefgh1x';
      comp.passwordConfirm = 'Abcdefgh1x';

      await comp.handleReset();

      expect(mockResetPassword).toHaveBeenCalledWith('tok', 'Abcdefgh1x');
      expect(comp.resetDone).toBe(true);
    });

    it('does nothing if canReset is false', async () => {
      const comp = createComponent();
      comp.password = 'short';
      comp.passwordConfirm = 'short';
      await comp.handleReset();
      expect(mockResetPassword).not.toHaveBeenCalled();
    });

    it('sets error on failure', async () => {
      mockResetPassword.mockRejectedValue(new Error('expired'));
      const comp = createComponent();
      comp.token = 'tok';
      comp.password = 'Abcdefgh1x';
      comp.passwordConfirm = 'Abcdefgh1x';

      await comp.handleReset();

      expect(comp.resetError).toBe('expired');
      expect(comp.resetSubmitting).toBe(false);
    });
  });
});

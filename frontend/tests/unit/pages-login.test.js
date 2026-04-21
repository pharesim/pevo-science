import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockLoginWithPassword = vi.fn();
const mockResendVerification = vi.fn();
const mockStartOrcid = vi.fn();

vi.mock('../../src/api.js', () => ({
  loginWithPassword: (...args) => mockLoginWithPassword(...args),
  resendVerification: (...args) => mockResendVerification(...args),
  startOrcid: (...args) => mockStartOrcid(...args),
}));

const mockAuthStore = {
  isConnected: false,
  token: null,
  username: null,
  isAccredited: false,
  accreditation: null,
  custody: 'light',
  _saveSession: vi.fn(),
};
const mockRouterStore = { navigate: vi.fn() };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'auth') return mockAuthStore;
      if (name === 'router') return mockRouterStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initLoginPage } from '../../src/pages/login.js';

function createComponent() {
  initLoginPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  return comp;
}

describe('loginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.isConnected = false;
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('canSubmit', () => {
    it('returns falsy when fields are empty', () => {
      const comp = createComponent();
      expect(comp.canSubmit).toBeFalsy();
    });

    it('returns falsy with only whitespace emailOrUsername', () => {
      const comp = createComponent();
      comp.emailOrUsername = '   ';
      comp.password = 'pass';
      expect(comp.canSubmit).toBeFalsy();
    });

    it('returns truthy with both fields filled', () => {
      const comp = createComponent();
      comp.emailOrUsername = 'user@x.com';
      comp.password = 'pass';
      expect(comp.canSubmit).toBeTruthy();
    });
  });

  describe('handleSubmit', () => {
    it('calls loginWithPassword and sets auth state on success', async () => {
      mockLoginWithPassword.mockResolvedValue({
        data: {
          token: 'jwt123',
          username: 'alice',
          is_accredited: true,
          accreditation: { orcid: '0000-0001' },
          custody: 'self',
          expires_at: '2099-01-01',
        },
      });
      const comp = createComponent();
      comp.emailOrUsername = ' alice@x.com ';
      comp.password = 'Secret1234';

      await comp.handleSubmit();

      expect(mockLoginWithPassword).toHaveBeenCalledWith('alice@x.com', 'Secret1234');
      expect(mockAuthStore.token).toBe('jwt123');
      expect(mockAuthStore.username).toBe('alice');
      expect(mockAuthStore.isConnected).toBe(true);
      expect(mockAuthStore.isAccredited).toBe(true);
      expect(mockAuthStore.custody).toBe('self');
      // expiresAt MUST be set on the store BEFORE _saveSession() is called.
      // Otherwise _restoreSession rejects the persisted entry and the user is
      // silently logged out on reload.
      expect(mockAuthStore.expiresAt).toBe('2099-01-01');
      // _saveSession now reads from instance state (no positional args).
      expect(mockAuthStore._saveSession).toHaveBeenCalledWith();
      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/papers');
    });

    it('does nothing if canSubmit is false', async () => {
      const comp = createComponent();
      comp.emailOrUsername = '';
      await comp.handleSubmit();
      expect(mockLoginWithPassword).not.toHaveBeenCalled();
    });

    it('does nothing if already submitting', async () => {
      const comp = createComponent();
      comp.emailOrUsername = 'x';
      comp.password = 'y';
      comp.isSubmitting = true;
      await comp.handleSubmit();
      expect(mockLoginWithPassword).not.toHaveBeenCalled();
    });

    it('redirects on PENDING_SIGNUP error', async () => {
      mockLoginWithPassword.mockRejectedValue({
        code: 'PENDING_SIGNUP',
        data: { auth_token: 'tok', email: 'e@x.com' },
        message: 'pending',
      });
      const comp = createComponent();
      comp.emailOrUsername = 'e@x.com';
      comp.password = 'pass';

      await comp.handleSubmit();

      expect(mockRouterStore.navigate).toHaveBeenCalledWith(
        expect.stringContaining('/signup/verify?')
      );
    });

    it('sets pendingState to unverified on PENDING_UNVERIFIED', async () => {
      mockLoginWithPassword.mockRejectedValue({
        code: 'PENDING_UNVERIFIED',
        message: 'not verified',
      });
      const comp = createComponent();
      comp.emailOrUsername = 'e@x.com';
      comp.password = 'pass';

      await comp.handleSubmit();

      expect(comp.pendingState).toBe('unverified');
      expect(comp.error).toBe('not verified');
    });

    it('sets pendingState to expired on SIGNUP_EXPIRED', async () => {
      mockLoginWithPassword.mockRejectedValue({
        code: 'SIGNUP_EXPIRED',
        message: 'expired',
      });
      const comp = createComponent();
      comp.emailOrUsername = 'e@x.com';
      comp.password = 'pass';

      await comp.handleSubmit();

      expect(comp.pendingState).toBe('expired');
    });

    it('sets generic error for unknown codes', async () => {
      mockLoginWithPassword.mockRejectedValue({
        code: 'UNKNOWN',
        message: 'bad creds',
      });
      const comp = createComponent();
      comp.emailOrUsername = 'e@x.com';
      comp.password = 'pass';

      await comp.handleSubmit();

      expect(comp.error).toBe('bad creds');
      expect(comp.pendingState).toBeNull();
    });
  });

  describe('handleResendVerification', () => {
    it('calls resendVerification and sets success', async () => {
      mockResendVerification.mockResolvedValue({});
      const comp = createComponent();
      comp.emailOrUsername = ' user@x.com ';
      comp.password = 'pass';

      await comp.handleResendVerification();

      expect(mockResendVerification).toHaveBeenCalledWith('user@x.com', 'pass');
      expect(comp.resendSuccess).toBe(true);
      expect(comp.error).toBeNull();
    });

    it('sets error on failure', async () => {
      mockResendVerification.mockRejectedValue(new Error('oops'));
      const comp = createComponent();
      comp.emailOrUsername = 'x@x.com';
      comp.password = 'p';

      await comp.handleResendVerification();

      expect(comp.error).toBe('oops');
      expect(comp.isResending).toBe(false);
    });

    it('does nothing if already resending', async () => {
      const comp = createComponent();
      comp.isResending = true;
      await comp.handleResendVerification();
      expect(mockResendVerification).not.toHaveBeenCalled();
    });
  });

  describe('handleOrcidLogin', () => {
    it('sets orcid mode and redirects', async () => {
      mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth' });
      const comp = createComponent();

      await comp.handleOrcidLogin();

      expect(localStorage.setItem).toHaveBeenCalledWith('pevo_orcid_mode', 'login');
      expect(mockStartOrcid).toHaveBeenCalledWith('login');
    });

    it('does nothing if already loading', async () => {
      const comp = createComponent();
      comp.orcidLoading = true;
      await comp.handleOrcidLogin();
      expect(mockStartOrcid).not.toHaveBeenCalled();
    });

    it('clears orcid mode on error', async () => {
      mockStartOrcid.mockRejectedValue(new Error('fail'));
      const comp = createComponent();

      await comp.handleOrcidLogin();

      expect(comp.error).toBe('fail');
      expect(comp.orcidLoading).toBe(false);
      expect(localStorage.removeItem).toHaveBeenCalledWith('pevo_orcid_mode');
    });
  });
});

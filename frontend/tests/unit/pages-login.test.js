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

    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND hold item #1: the
    // PENDING_UNVERIFIED branch binds the localized login.pendingUnverified
    // key to the DOM field and routes raw err (including any server-text
    // sentinel) to console.warn. Guards against reverting to `err.message`.
    it('sanitizes PENDING_UNVERIFIED: sets pendingState=unverified, generic key to DOM, raw err to console.warn', async () => {
      const leaky = Object.assign(new Error('not verified hex=deadbeefcafebabe'), {
        code: 'PENDING_UNVERIFIED',
      });
      mockLoginWithPassword.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.emailOrUsername = 'e@x.com';
      comp.password = 'pass';

      await comp.handleSubmit();

      expect(comp.pendingState).toBe('unverified');
      expect(comp.error).toBe('login.pendingUnverified');
      expect(comp.error).not.toContain('deadbeef');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });

    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND hold item #1: the
    // SIGNUP_EXPIRED branch binds the localized login.signupExpired key to
    // the DOM field and routes raw err to console.warn. The pendingState
    // === 'expired' view renders `error` inline (see login.js template),
    // so sanitization here matters even though it's a known-code branch.
    it('sanitizes SIGNUP_EXPIRED: sets pendingState=expired, generic key to DOM, raw err to console.warn', async () => {
      const leaky = Object.assign(new Error('expired hex=deadbeefcafebabe'), {
        code: 'SIGNUP_EXPIRED',
      });
      mockLoginWithPassword.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.emailOrUsername = 'e@x.com';
      comp.password = 'pass';

      await comp.handleSubmit();

      expect(comp.pendingState).toBe('expired');
      expect(comp.error).toBe('login.signupExpired');
      expect(comp.error).not.toContain('deadbeef');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });

    it('surfaces login.invalidCredentials for UNAUTHORIZED, not raw err.message', async () => {
      const err = Object.assign(new Error('Invalid credentials'), { code: 'UNAUTHORIZED' });
      mockLoginWithPassword.mockRejectedValue(err);
      const comp = createComponent();
      comp.emailOrUsername = 'e@x.com';
      comp.password = 'wrong';

      await comp.handleSubmit();

      expect(comp.error).toBe('login.invalidCredentials');
      expect(comp.pendingState).toBeNull();
    });

    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: unknown-code failures
    // must surface a generic localized message and route raw err to
    // console.warn. PENDING_UNVERIFIED and SIGNUP_EXPIRED now follow the
    // same invariant on dedicated i18n keys (see tests above).
    it('sanitizes unknown-code error: generic message to DOM, raw err to console.warn', async () => {
      const leaky = Object.assign(new Error('bad creds hex=deadbeefcafebabe'), { code: 'UNKNOWN' });
      mockLoginWithPassword.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.emailOrUsername = 'e@x.com';
      comp.password = 'pass';

      await comp.handleSubmit();

      expect(comp.error).toBe('login.loginFailed');
      expect(comp.error).not.toContain('deadbeef');
      expect(comp.pendingState).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
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

    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: failure surfaces a
    // generic localized message; raw err reaches console.warn.
    it('sanitizes failure: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('oops hex=deadbeefcafebabe');
      mockResendVerification.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.emailOrUsername = 'x@x.com';
      comp.password = 'p';

      await comp.handleResendVerification();

      expect(comp.error).toBe('login.resendFailed');
      expect(comp.error).not.toContain('deadbeef');
      expect(comp.isResending).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
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

    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: failure surfaces a
    // generic localized message; raw err reaches console.warn.
    it('sanitizes failure: clears orcid mode, generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('fail hex=deadbeefcafebabe');
      mockStartOrcid.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();

      await comp.handleOrcidLogin();

      expect(comp.error).toBe('login.orcidStartFailed');
      expect(comp.error).not.toContain('deadbeef');
      expect(comp.orcidLoading).toBe(false);
      expect(localStorage.removeItem).toHaveBeenCalledWith('pevo_orcid_mode');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });
  });

  // UI-TEARDOWN-GUARD-SWEEP-EXTENSION: post-destroy() async continuations
  // must not write to component state. A login that resolves/rejects after
  // Alpine tears the page down would otherwise flip auth store + error state
  // on a destroyed scope.
  describe('teardown', () => {
    it('handleSubmit catch does not set error/pendingState after destroy()', async () => {
      let rejectFn;
      mockLoginWithPassword.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
      const comp = createComponent();
      comp.emailOrUsername = 'x@y.com';
      comp.password = 'secret';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pending = comp.handleSubmit();
      comp.destroy();
      rejectFn(new Error('late'));
      await pending;
      expect(comp.error).toBeNull();
      expect(comp.pendingState).toBeNull();
      warnSpy.mockRestore();
    });

    it('handleSubmit happy path does not navigate after destroy()', async () => {
      let resolveFn;
      mockLoginWithPassword.mockImplementationOnce(() => new Promise((resolve) => { resolveFn = resolve; }));
      const comp = createComponent();
      comp.emailOrUsername = 'x@y.com';
      comp.password = 'secret';
      const pending = comp.handleSubmit();
      comp.destroy();
      resolveFn({ data: { token: 't', username: 'u', expires_at: 'e' } });
      await pending;
      expect(mockRouterStore.navigate).not.toHaveBeenCalled();
    });

    it('handleResendVerification catch does not set error after destroy()', async () => {
      let rejectFn;
      mockResendVerification.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
      const comp = createComponent();
      comp.emailOrUsername = 'x@y.com';
      comp.password = 'secret';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pending = comp.handleResendVerification();
      comp.destroy();
      rejectFn(new Error('late'));
      await pending;
      expect(comp.error).toBeNull();
      expect(comp.resendSuccess).toBe(false);
      warnSpy.mockRestore();
    });
  });
});

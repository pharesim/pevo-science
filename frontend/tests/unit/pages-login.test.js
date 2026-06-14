import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLoginFromResponse } from './fixtures/mock-auth.js';

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
  expiresAt: null,
  _saveSession: vi.fn(),
  _startAccreditationPolling: vi.fn(),
  loginFromResponse: vi.fn(mockLoginFromResponse),
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
    vi.stubGlobal('sessionStorage', {
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

    // Per-site preserve-on-omit coverage. The login site routes through
    // loginFromResponse(), which enforces the atomic {token, expires_at}
    // pair invariant: if the backend omits expires_at, neither rotates.
    // A form that set token=res.data.token and expiresAt=undefined
    // unconditionally would have JSON.stringify drop the undefined, so
    // _restoreSession evicted on next load and the user was silently
    // logged out.
    it('atomic pair: preserves token + expiresAt when login response omits expires_at', async () => {
      mockLoginWithPassword.mockResolvedValue({
        data: {
          token: 'jwt-no-expiry',
          username: 'alice',
          is_accredited: true,
          accreditation: { orcid: '0000-0001' },
          custody: 'self',
          // expires_at omitted — atomic pair must NOT half-rotate.
        },
      });
      const originalToken = mockAuthStore.token;
      const originalExpiry = mockAuthStore.expiresAt;
      const comp = createComponent();
      comp.emailOrUsername = 'alice@x.com';
      comp.password = 'Secret1234';

      await comp.handleSubmit();

      expect(mockAuthStore.token).toBe(originalToken);
      expect(mockAuthStore.expiresAt).toBe(originalExpiry);
      // Non-atomic fields still land on the store (the helper assigns
      // them when present in data).
      expect(mockAuthStore.username).toBe('alice');
      expect(mockAuthStore.isAccredited).toBe(true);
      expect(mockAuthStore._saveSession).toHaveBeenCalledWith();
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

    // The login 409 PENDING_SIGNUP body now carries ONLY { email } — no
    // auth_token (it was removed because it is the row-lookup credential for
    // /confirm and /link). The SPA must route to the resume step with a
    // resume marker and the email hint, and must NOT put any auth_token in the
    // URL.
    it('redirects to resume step on PENDING_SIGNUP without leaking auth_token in the URL', async () => {
      mockLoginWithPassword.mockRejectedValue({
        code: 'PENDING_SIGNUP',
        data: { email: 'e@x.com' },
        message: 'pending',
      });
      const comp = createComponent();
      comp.emailOrUsername = 'e@x.com';
      comp.password = 'pass';

      await comp.handleSubmit();

      expect(mockRouterStore.navigate).toHaveBeenCalledTimes(1);
      const dest = mockRouterStore.navigate.mock.calls[0][0];
      expect(dest).toContain('/signup/verify?');
      expect(dest).toContain('resume=1');
      expect(dest).toContain('email=e%40x.com');
      // No auth_token anywhere in the navigation target.
      expect(dest).not.toContain('auth_token');
      // The literal "undefined" must never be encoded into the URL.
      expect(dest).not.toContain('undefined');
    });

    // Defensive: even if a stale backend ever sent a 409 with an auth_token in
    // the body, the SPA must not forward it to the address bar.
    it('does not forward a stray auth_token from the 409 body into the URL', async () => {
      mockLoginWithPassword.mockRejectedValue({
        code: 'PENDING_SIGNUP',
        data: { auth_token: 'confirmed:leak', email: 'e@x.com' },
        message: 'pending',
      });
      const comp = createComponent();
      comp.emailOrUsername = 'e@x.com';
      comp.password = 'pass';

      await comp.handleSubmit();

      const dest = mockRouterStore.navigate.mock.calls[0][0];
      expect(dest).not.toContain('auth_token');
      expect(dest).not.toContain('confirmed%3Aleak');
      expect(dest).toContain('resume=1');
    });

    // The 409 may arrive with no data at all; the redirect must still work
    // (resume marker present, email simply omitted).
    it('redirects to resume step on PENDING_SIGNUP even when the body has no data', async () => {
      mockLoginWithPassword.mockRejectedValue({
        code: 'PENDING_SIGNUP',
        message: 'pending',
      });
      const comp = createComponent();
      comp.emailOrUsername = 'e@x.com';
      comp.password = 'pass';

      await comp.handleSubmit();

      const dest = mockRouterStore.navigate.mock.calls[0][0];
      expect(dest).toContain('/signup/verify?');
      expect(dest).toContain('resume=1');
      expect(dest).not.toContain('auth_token');
      expect(dest).not.toContain('undefined');
    });

    // The PENDING_UNVERIFIED branch binds the localized login.pendingUnverified
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

    // The SIGNUP_EXPIRED branch binds the localized login.signupExpired key to
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

    // Unknown-code failures must surface a generic localized message and
    // route raw err to console.warn. PENDING_UNVERIFIED and SIGNUP_EXPIRED
    // follow the same invariant on dedicated i18n keys (see tests above).
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

    // Failure surfaces a generic localized message; raw err reaches
    // console.warn.
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

      expect(sessionStorage.setItem).toHaveBeenCalledWith('pevo_orcid_mode', 'login');
      expect(mockStartOrcid).toHaveBeenCalledWith('login');
    });

    it('does nothing if already loading', async () => {
      const comp = createComponent();
      comp.orcidLoading = true;
      await comp.handleOrcidLogin();
      expect(mockStartOrcid).not.toHaveBeenCalled();
    });

    // Failure surfaces a generic localized message; raw err reaches
    // console.warn.
    it('sanitizes failure: clears orcid mode, generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('fail hex=deadbeefcafebabe');
      mockStartOrcid.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();

      await comp.handleOrcidLogin();

      expect(comp.error).toBe('login.orcidStartFailed');
      expect(comp.error).not.toContain('deadbeef');
      expect(comp.orcidLoading).toBe(false);
      expect(sessionStorage.removeItem).toHaveBeenCalledWith('pevo_orcid_mode');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });

    // A non-allowlisted redirect_url host throws before navigating, routing
    // through the same sanitized error path the start-failure case uses.
    it('rejects a non-allowlisted redirect host without navigating', async () => {
      mockStartOrcid.mockResolvedValue({ redirect_url: 'https://evil.example.com/phish' });
      vi.stubGlobal('window', { ...globalThis.window, location: { href: '' } });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();

      await comp.handleOrcidLogin();

      expect(window.location.href).toBe(''); // never navigated
      expect(comp.error).toBe('login.orcidStartFailed');
      expect(comp.orcidLoading).toBe(false);
      expect(sessionStorage.removeItem).toHaveBeenCalledWith('pevo_orcid_mode');
      const warned = warnSpy.mock.calls.find((c) => c[0] === '[login orcid start]');
      expect(warned).toBeDefined();
      expect(warned[1].message).toBe('Invalid ORCID redirect URL');
      warnSpy.mockRestore();
    });
  });

  // Post-destroy() async continuations must not write to component state.
  // A login that resolves/rejects after
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

  // handleOrcidLogin sets orcidLoading=true then navigates away, resetting
  // only in catch. On browser Back the page restores from bfcache (init()/
  // destroy() do not re-run) and would stay disabled on its loading label. A
  // persisted pageshow (bfcache restore) must reset the flag. bfcache cannot
  // be simulated in jsdom, so a listener-recording window stub lets us fire a
  // synthetic pageshow whose `persisted` we set explicitly.
  describe('bfcache restore', () => {
    function stubPageshowWindow() {
      const listeners = new Map();
      const win = {
        addEventListener: vi.fn((type, fn) => {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type).add(fn);
        }),
        removeEventListener: vi.fn((type, fn) => { listeners.get(type)?.delete(fn); }),
        fire(type, event) { for (const fn of listeners.get(type) ?? []) fn(event); },
        count(type) { return listeners.get(type)?.size ?? 0; },
      };
      vi.stubGlobal('window', win);
      return win;
    }

    it('resets orcidLoading on a persisted pageshow after init()', () => {
      const win = stubPageshowWindow();
      const comp = createComponent();
      comp.init();
      comp.orcidLoading = true;
      win.fire('pageshow', { persisted: true });
      expect(comp.orcidLoading).toBe(false);
    });

    it('removes the listener on destroy() so a later pageshow does not reset', () => {
      const win = stubPageshowWindow();
      const comp = createComponent();
      comp.init();
      comp.destroy();
      expect(win.count('pageshow')).toBe(0);
      comp.orcidLoading = true;
      win.fire('pageshow', { persisted: true });
      expect(comp.orcidLoading).toBe(true);
    });
  });
});

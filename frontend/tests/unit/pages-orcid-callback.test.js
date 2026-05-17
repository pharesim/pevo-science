/**
 * Unit tests for the orcid-callback Alpine page.
 *
 * Carve-out for deterministic edge-case coverage (root CLAUDE.md clause a):
 * mocks `alpinejs` (Alpine.data, Alpine.store) and `completeOrcid` from
 * api.js. Real paths are impractical per-test — the Alpine store/data wiring
 * is non-trivial to bootstrap in isolation, and completeOrcid hits the live
 * /api/orcid/callback endpoint, which requires a full OAuth round-trip
 * (browser redirect to orcid.org, user consent, callback) that cannot be
 * deterministically reproduced inside a vitest unit run. No backend auth
 * middleware (verifyHiveSignature etc.) is exercised by this file, so
 * clause (b)'s real-middleware requirement does not apply here.
 *
 * Real-path companion (clause c): the deferred E2E test in
 * ui-multi-author-consent-affordances will exercise the live fresh_auth
 * callback against a running backend once the consent-op consumer side
 * lands (per the task file's acceptance §4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLoginFromResponse } from './fixtures/mock-auth.js';

const mockCompleteOrcid = vi.fn();

vi.mock('../../src/api.js', () => ({
  completeOrcid: (...args) => mockCompleteOrcid(...args),
}));

// The shared mockLoginFromResponse fixture's preserve-on-undefined branch
// is critical for this site: the ORCID login passes explicit
// `is_accredited: false` and `accreditation: null` overrides, which the
// helper lands on the store BEFORE _saveSession fires (locks in the
// "ORCID login clears stale accreditation state" invariant asserted below).
const mockAuthStore = {
  isConnected: true,
  token: '',
  username: '',
  custody: '',
  isAccredited: false,
  accreditation: null,
  expiresAt: null,
  _saveSession: vi.fn(),
  _checkAccreditation: vi.fn(),
  _startAccreditationPolling: vi.fn(),
  loginFromResponse: vi.fn(mockLoginFromResponse),
};
const mockRouterStore = { navigate: vi.fn(), query: { code: 'abc123', state: 'xyz' } };
const mockToastStore = { show: vi.fn() };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'auth') return mockAuthStore;
      if (name === 'router') return mockRouterStore;
      if (name === 'toast') return mockToastStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initOrcidCallbackPage } from '../../src/pages/orcid-callback.js';

let localStorageData;
let sessionStorageData;

function createComponent() {
  initOrcidCallbackPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  return comp;
}

describe('orcidCallbackPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageData = {};
    sessionStorageData = {};
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => localStorageData[key] ?? null),
      setItem: vi.fn((key, val) => { localStorageData[key] = val; }),
      removeItem: vi.fn((key) => { delete localStorageData[key]; }),
    });
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((key) => sessionStorageData[key] ?? null),
      setItem: vi.fn((key, val) => { sessionStorageData[key] = val; }),
      removeItem: vi.fn((key) => { delete sessionStorageData[key]; }),
    });
    mockRouterStore.query = { code: 'abc123', state: 'xyz' };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('init - query param validation', () => {
    it('sets error when code is missing', () => {
      mockRouterStore.query = { state: 'xyz' };
      const comp = createComponent();
      comp.init();
      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.missingParams');
    });

    it('sets error when state is missing', () => {
      mockRouterStore.query = { code: 'abc' };
      const comp = createComponent();
      comp.init();
      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.missingParams');
    });

    it('sets error when code is too long (>100)', () => {
      mockRouterStore.query = { code: 'a'.repeat(101), state: 'xyz' };
      const comp = createComponent();
      comp.init();
      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.missingParams');
    });

    it('sets error when state is too long (>256)', () => {
      mockRouterStore.query = { code: 'abc', state: 'x'.repeat(257) };
      const comp = createComponent();
      comp.init();
      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.missingParams');
    });

    it('sets error when code is not a string', () => {
      mockRouterStore.query = { code: 123, state: 'xyz' };
      const comp = createComponent();
      comp.init();
      expect(comp.status).toBe('error');
    });
  });

  describe('init - backPath routing from localStorage mode', () => {
    it('sets backPath to /signup for signup mode', () => {
      sessionStorageData['pevo_orcid_mode'] = 'signup';
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({ data: { mode: 'signup', orcid_token: 't', orcid_id: 'id' } });
      comp.init();
      expect(comp.backPath).toBe('/signup');
    });

    it('sets backPath to /login for login mode', () => {
      sessionStorageData['pevo_orcid_mode'] = 'login';
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({ data: { mode: 'login', token: 't', username: 'u', expires_at: 'e' } });
      comp.init();
      expect(comp.backPath).toBe('/login');
    });

    it('sets backPath to /accreditation for accredit mode', () => {
      sessionStorageData['pevo_orcid_mode'] = 'accredit';
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({ data: { mode: 'accredit', username: 'u' } });
      comp.init();
      expect(comp.backPath).toBe('/accreditation');
    });

    it('sets backPath to /settings for link mode', () => {
      sessionStorageData['pevo_orcid_mode'] = 'link';
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({ data: { mode: 'link' } });
      comp.init();
      expect(comp.backPath).toBe('/settings');
    });

    it('defaults backPath to / for unknown mode', () => {
      sessionStorageData['pevo_orcid_mode'] = 'unknown';
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({ data: { mode: 'accredit', username: 'u' } });
      comp.init();
      expect(comp.backPath).toBe('/');
    });

    it('removes pevo_orcid_mode from sessionStorage after successful completeOrcid', async () => {
      sessionStorageData['pevo_orcid_mode'] = 'accredit';
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({ data: { mode: 'accredit', username: 'u' } });
      // init() kicks off _verify(); awaiting completeOrcid's resolved promise
      // plus the trailing microtask ensures the removeItem has run.
      comp.init();
      await Promise.resolve();
      await Promise.resolve();
      expect(sessionStorage.removeItem).toHaveBeenCalledWith('pevo_orcid_mode');
    });

    it('does NOT remove pevo_orcid_mode before completeOrcid resolves (so a refresh after failure can retry)', async () => {
      sessionStorageData['pevo_orcid_mode'] = 'link';
      const comp = createComponent();
      // Never-resolving promise simulates an in-flight / crashed completeOrcid.
      mockCompleteOrcid.mockReturnValue(new Promise(() => {}));
      comp.init();
      expect(sessionStorage.removeItem).not.toHaveBeenCalledWith('pevo_orcid_mode');
      expect(sessionStorageData['pevo_orcid_mode']).toBe('link');
    });
  });

  describe('_verify - mode routing', () => {
    it('handles signup mode: stores tokens and navigates', async () => {
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: { mode: 'signup', orcid_token: 'token123', orcid_id: '0000-0001', name: 'Jane' },
      });

      await comp._verify('code', 'state', 'signup');

      expect(localStorage.setItem).toHaveBeenCalledWith('pevo_signup_orcid_token', 'token123');
      expect(localStorage.setItem).toHaveBeenCalledWith('pevo_signup_orcid_id', '0000-0001');
      // pevo_signup_orcid_name is intentionally not persisted (auto-fill
      // of fullName was abandoned; signup.js never read the key).
      expect(localStorage.setItem).not.toHaveBeenCalledWith('pevo_signup_orcid_name', 'Jane');
      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/signup');
    });

    it('handles signup mode with recover return path', async () => {
      localStorageData['pevo_orcid_return_to'] = 'recover';
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: { mode: 'signup', orcid_token: 't', orcid_id: 'id' },
      });

      await comp._verify('code', 'state', 'signup');
      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/recover');
    });

    it('handles login mode: sets auth store (including expiresAt) and navigates', async () => {
      vi.useFakeTimers();
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: { mode: 'login', token: 'jwt', username: 'alice', expires_at: '2025-01-01', custody: 'light' },
      });

      await comp._verify('code', 'state', 'login');

      expect(comp.status).toBe('login-success');
      expect(mockAuthStore.token).toBe('jwt');
      expect(mockAuthStore.username).toBe('alice');
      expect(mockAuthStore.isConnected).toBe(true);
      expect(mockAuthStore.custody).toBe('light');
      // expiresAt MUST be set on the store BEFORE _saveSession() is called,
      // otherwise _restoreSession() rejects the entry on the next page load
      // and the ORCID-login user is silently logged out.
      expect(mockAuthStore.expiresAt).toBe('2025-01-01');
      // _saveSession is called with no positional args now; it reads from this.*
      expect(mockAuthStore._saveSession).toHaveBeenCalledWith();
      expect(mockAuthStore._saveSession).toHaveBeenCalledTimes(1);
      // _handleLogin uses _startAccreditationPolling (not bare
      // _checkAccreditation) so transient accreditation-fetch failures retry
      // via the 60s polling loop instead of leaving the store permanently at
      // isAccredited=false. Matches sibling login paths in auth.js.
      expect(mockAuthStore._startAccreditationPolling).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(500);
      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/papers');
      vi.useRealTimers();
    });

    it('ORCID login clears stale accreditation state BEFORE _saveSession() fires', async () => {
      // Seed stale state (simulating a prior session or stale store defaults
      // that should NOT leak into localStorage for the newly-logged-in user).
      mockAuthStore.isAccredited = true;
      mockAuthStore.accreditation = { type: 'email' };

      // Capture store state at the moment _saveSession is invoked, to prove
      // the clearing happens BEFORE _saveSession (not after). The mock also
      // simulates the real _saveSession's localStorage write so the
      // end-to-end persistence assertion below is meaningful — without this,
      // the store-mock isolates _saveSession from the real localStorage call.
      let snapshotAtSave = null;
      mockAuthStore._saveSession.mockImplementationOnce(() => {
        snapshotAtSave = {
          isAccredited: mockAuthStore.isAccredited,
          accreditation: mockAuthStore.accreditation,
        };
        localStorage.setItem('pevo_session', JSON.stringify({
          username: mockAuthStore.username,
          token: mockAuthStore.token,
          custody: mockAuthStore.custody,
          expiresAt: mockAuthStore.expiresAt,
          isAccredited: mockAuthStore.isAccredited,
          accreditation: mockAuthStore.accreditation,
        }));
      });

      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: { mode: 'login', token: 'jwt', username: 'alice', expires_at: '2099-01-01', custody: 'light' },
      });

      await comp._verify('code', 'state', 'login');

      expect(mockAuthStore._saveSession).toHaveBeenCalled();
      expect(mockAuthStore._saveSession).toHaveBeenCalledTimes(1);
      expect(snapshotAtSave).not.toBeNull();
      expect(snapshotAtSave.isAccredited).toBe(false);
      expect(snapshotAtSave.accreditation).toBeNull();
      // End-to-end persistence: the actual localStorage payload reflects the
      // cleared state. Guards against a future _saveSession refactor that
      // reads the wrong store fields.
      expect(JSON.parse(localStorage.getItem('pevo_session'))).toMatchObject({ isAccredited: false, accreditation: null });
      // And the post-call state is also cleared (belt and suspenders).
      expect(mockAuthStore.isAccredited).toBe(false);
      expect(mockAuthStore.accreditation).toBeNull();
    });

    it('ORCID login leaves the auth store with a non-null expiresAt so reload keeps the session', async () => {
      vi.useFakeTimers();
      // Reset store so we prove expiresAt is the one written by _handleLogin.
      mockAuthStore.expiresAt = null;
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: {
          mode: 'login',
          token: 'jwt',
          username: 'alice',
          expires_at: '2099-01-01T00:00:00.000Z',
          custody: 'light',
        },
      });

      await comp._verify('code', 'state', 'login');

      expect(mockAuthStore.expiresAt).not.toBeNull();
      expect(mockAuthStore.expiresAt).toBe('2099-01-01T00:00:00.000Z');
      vi.useRealTimers();
    });

    // UI-AUTH-LOGINFROMRESPONSE-HELPER-ADOPTION: per-site preserve-on-omit
    // coverage. _handleLogin now routes through loginFromResponse() which
    // enforces the atomic {token, expires_at} pair invariant. The
    // explicit `is_accredited: false`/`accreditation: null` overrides
    // still land on the store regardless (those are non-atomic fields).
    it('atomic pair: preserves token + expiresAt when ORCID login response omits expires_at', async () => {
      vi.useFakeTimers();
      mockAuthStore.token = 'old-jwt';
      mockAuthStore.expiresAt = '2099-01-01T00:00:00.000Z';
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: {
          mode: 'login',
          token: 'jwt-no-expiry',
          username: 'alice',
          custody: 'light',
          // expires_at omitted — atomic pair must NOT half-rotate.
        },
      });

      await comp._verify('code', 'state', 'login');

      expect(mockAuthStore.token).toBe('old-jwt');
      expect(mockAuthStore.expiresAt).toBe('2099-01-01T00:00:00.000Z');
      // The explicit accreditation reset still fires (non-atomic field).
      expect(mockAuthStore.isAccredited).toBe(false);
      expect(mockAuthStore.accreditation).toBeNull();
      expect(mockAuthStore._saveSession).toHaveBeenCalledWith();
      vi.useRealTimers();
    });

    it('handles accredit mode: sets success and refreshes accreditation', async () => {
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: { mode: 'accredit', username: 'bob' },
      });

      await comp._verify('code', 'state', 'accredit');

      expect(comp.status).toBe('accredit-success');
      expect(comp.resultUsername).toBe('bob');
      expect(mockAuthStore._checkAccreditation).toHaveBeenCalled();
      expect(mockToastStore.show).toHaveBeenCalledWith('orcid.verificationSuccess', 'success');
    });

    it('handles link mode: sets localStorage flag and navigates to settings', async () => {
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: { mode: 'link' },
      });

      await comp._verify('code', 'state', 'link');

      expect(localStorage.setItem).toHaveBeenCalledWith('pevo_orcid_link_complete', '1');
      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/settings');
    });

    it('sets error for unknown mode', async () => {
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: { mode: 'unknown_mode' },
      });

      await comp._verify('code', 'state', '');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.verificationFailed');
    });
  });

  describe('_verify - error classification', () => {
    it('NO_ACCOUNT sets errorAction to signup', async () => {
      const comp = createComponent();
      const err = new Error('No account');
      err.code = 'NO_ACCOUNT';
      mockCompleteOrcid.mockRejectedValue(err);

      await comp._verify('code', 'state', 'login');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.noAccountFound');
      expect(comp.errorAction).toBe('signup');
    });

    it('VALIDATION_ERROR shows insufficient works message', async () => {
      const comp = createComponent();
      const err = new Error('Validation failed');
      err.code = 'VALIDATION_ERROR';
      mockCompleteOrcid.mockRejectedValue(err);

      await comp._verify('code', 'state', 'signup');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('signup.orcidInsufficientWorks');
      expect(comp.errorAction).toBe('');
    });

    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: generic (non-semantic)
    // failures surface the generic localized message; raw err reaches
    // console.warn. NO_ACCOUNT and VALIDATION_ERROR are semantic-code
    // branches above and render their own code-specific strings.
    it('sanitizes generic error: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('Server down hex=deadbeefcafebabe');
      mockCompleteOrcid.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();

      await comp._verify('code', 'state', 'accredit');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.verificationFailed');
      expect(comp.errorMessage).not.toContain('deadbeef');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });

    it('generic error without message still shows the generic i18n key', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      mockCompleteOrcid.mockRejectedValue({});

      await comp._verify('code', 'state', 'accredit');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.verificationFailed');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('post-teardown _verify resolution is a no-op (does not mutate status or navigate)', async () => {
      const comp = createComponent();
      let resolveFn;
      mockCompleteOrcid.mockReturnValue(new Promise((resolve) => { resolveFn = resolve; }));

      // Kick off _verify but do NOT await yet. Tear the component down while
      // the completeOrcid promise is still pending.
      const verifyP = comp._verify('code', 'state', 'accredit');
      comp.destroy();

      // Now resolve the in-flight completeOrcid. The _mounted guard should
      // make the post-await continuation a no-op — no handler fires, status
      // stays 'verifying', no navigation, no localStorage mode cleanup.
      resolveFn({ data: { mode: 'accredit', username: 'bob' } });
      await verifyP;

      expect(comp.status).toBe('verifying');
      expect(comp.resultUsername).toBe('');
      expect(mockRouterStore.navigate).not.toHaveBeenCalled();
      expect(mockAuthStore._checkAccreditation).not.toHaveBeenCalled();
      expect(mockToastStore.show).not.toHaveBeenCalled();
      // 503-refresh-retry invariant: mid-await teardown must not clear the
      // stored mode, so a refresh can retry against the right endpoint.
      expect(sessionStorage.removeItem).not.toHaveBeenCalledWith('pevo_orcid_mode');
    });

    it('post-teardown _verify rejection is a no-op (does not set error state)', async () => {
      const comp = createComponent();
      let rejectFn;
      mockCompleteOrcid.mockReturnValue(new Promise((_, reject) => { rejectFn = reject; }));

      const verifyP = comp._verify('code', 'state', 'login');
      comp.destroy();

      const err = new Error('boom');
      err.code = 'NO_ACCOUNT';
      rejectFn(err);
      await verifyP;

      // No error state should be written post-teardown.
      expect(comp.status).toBe('verifying');
      expect(comp.errorMessage).toBe('');
      expect(comp.errorAction).toBe('');
    });

    it('_handleLogin: setTimeout redirect is canceled by destroy() — navigate not called', async () => {
      vi.useFakeTimers();
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: { mode: 'login', token: 'jwt', username: 'alice', expires_at: '2099-01-01', custody: 'light' },
      });

      await comp._verify('code', 'state', 'login');
      expect(comp.status).toBe('login-success');
      // Timer is armed but not yet fired.
      expect(mockRouterStore.navigate).not.toHaveBeenCalled();

      // Destroy before the 500ms redirect fires.
      comp.destroy();

      // Advancing time past the redirect window MUST NOT trigger navigation,
      // since destroy() cleared the pending timer.
      vi.advanceTimersByTime(1000);
      expect(mockRouterStore.navigate).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('_handleSignup: post-teardown resolution does not write signup tokens or navigate', async () => {
      const comp = createComponent();
      let resolveFn;
      mockCompleteOrcid.mockReturnValue(new Promise((resolve) => { resolveFn = resolve; }));

      const verifyP = comp._verify('code', 'state', 'signup');
      comp.destroy();

      resolveFn({ data: { mode: 'signup', orcid_token: 'tok', orcid_id: 'id', name: 'Jane' } });
      await verifyP;

      expect(localStorage.setItem).not.toHaveBeenCalledWith('pevo_signup_orcid_token', 'tok');
      expect(localStorage.setItem).not.toHaveBeenCalledWith('pevo_signup_orcid_id', 'id');
      expect(localStorage.setItem).not.toHaveBeenCalledWith('pevo_signup_orcid_name', 'Jane');
      expect(mockRouterStore.navigate).not.toHaveBeenCalled();
      // The pevo_orcid_return_to key (consumed inside _handleSignup) must
      // stay intact so a later retry still knows whether to route to
      // /signup vs /recover.
      expect(localStorage.removeItem).not.toHaveBeenCalledWith('pevo_orcid_return_to');
    });

    it('_handleLink: post-teardown resolution does not set link flag or navigate', async () => {
      const comp = createComponent();
      let resolveFn;
      mockCompleteOrcid.mockReturnValue(new Promise((resolve) => { resolveFn = resolve; }));

      const verifyP = comp._verify('code', 'state', 'link');
      comp.destroy();

      resolveFn({ data: { mode: 'link' } });
      await verifyP;

      expect(localStorage.setItem).not.toHaveBeenCalledWith('pevo_orcid_link_complete', '1');
      expect(mockRouterStore.navigate).not.toHaveBeenCalled();
    });

    it('_handleAccredit direct-call post-teardown is a no-op (handler self-guards)', () => {
      const comp = createComponent();
      comp.destroy();
      comp._handleAccredit({ username: 'bob' });

      expect(comp.status).toBe('verifying');
      expect(comp.resultUsername).toBe('');
      expect(mockAuthStore._checkAccreditation).not.toHaveBeenCalled();
      expect(mockToastStore.show).not.toHaveBeenCalled();
    });

    it('_handleSignup direct-call post-teardown is a no-op (handler self-guards)', () => {
      const comp = createComponent();
      comp.destroy();
      comp._handleSignup({ orcid_token: 'tok', orcid_id: 'id', name: 'Jane' });

      expect(comp.status).toBe('verifying');
      expect(localStorage.setItem).not.toHaveBeenCalledWith('pevo_signup_orcid_token', 'tok');
      expect(localStorage.setItem).not.toHaveBeenCalledWith('pevo_signup_orcid_id', 'id');
      expect(localStorage.setItem).not.toHaveBeenCalledWith('pevo_signup_orcid_name', 'Jane');
      expect(localStorage.removeItem).not.toHaveBeenCalledWith('pevo_orcid_return_to');
      expect(mockRouterStore.navigate).not.toHaveBeenCalled();
      expect(mockToastStore.show).not.toHaveBeenCalled();
    });

    it('_handleLogin direct-call post-teardown is a no-op (handler self-guards)', () => {
      vi.useFakeTimers();
      // Snapshot auth-store state before the direct call so we can prove
      // the self-guard prevents any mutation.
      const priorToken = mockAuthStore.token;
      const priorUsername = mockAuthStore.username;
      const priorCustody = mockAuthStore.custody;
      const priorExpiresAt = mockAuthStore.expiresAt;

      const comp = createComponent();
      comp.destroy();
      comp._handleLogin({
        token: 'jwt',
        username: 'alice',
        custody: 'light',
        expires_at: '2099-01-01',
      });

      expect(comp.status).toBe('verifying');
      expect(mockAuthStore.token).toBe(priorToken);
      expect(mockAuthStore.username).toBe(priorUsername);
      expect(mockAuthStore.custody).toBe(priorCustody);
      expect(mockAuthStore.expiresAt).toBe(priorExpiresAt);
      expect(mockAuthStore._saveSession).not.toHaveBeenCalled();
      expect(mockAuthStore._checkAccreditation).not.toHaveBeenCalled();
      expect(mockAuthStore._startAccreditationPolling).not.toHaveBeenCalled();
      expect(mockToastStore.show).not.toHaveBeenCalled();

      // Also prove the 500ms setTimeout was NOT armed — advancing time past
      // the redirect window must not call navigate.
      vi.advanceTimersByTime(1000);
      expect(mockRouterStore.navigate).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('_handleLink direct-call post-teardown is a no-op (handler self-guards)', () => {
      const comp = createComponent();
      comp.destroy();
      comp._handleLink({});

      expect(comp.status).toBe('verifying');
      expect(localStorage.setItem).not.toHaveBeenCalledWith('pevo_orcid_link_complete', '1');
      expect(mockRouterStore.navigate).not.toHaveBeenCalled();
      expect(mockToastStore.show).not.toHaveBeenCalled();
    });

    // Per architect Option B (2026-04-29): backend dropped `retriable: true`
    // from the same-tick lock-contention 409 because the OAuth state token
    // is consumed before lock acquisition (any same-`{code, state}` retry
    // returns 400). Frontend treats every ORCID_ALREADY_LINKED 409 as
    // durable; user restarts OAuth via /recover. The previous auto-retry
    // machinery (countdown, MAX_RETRIES cap, _retryVerify) was removed
    // wholesale.
    it('ORCID_ALREADY_LINKED renders durable message and recover affordance, regardless of details/Retry-After shape', async () => {
      const comp = createComponent();
      const err = new Error('Already linked');
      err.code = 'ORCID_ALREADY_LINKED';
      // Even an envelope that LOOKS retriable (legacy backend, replay, etc.)
      // is treated as durable now — the frontend no longer branches on the
      // discriminator. Pinning this against accidental reintroduction.
      err.details = { retriable: true };
      err.retryAfterSeconds = 10;
      mockCompleteOrcid.mockRejectedValue(err);

      await comp._verify('code', 'state', 'link');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.alreadyLinkedDurable');
      expect(comp.errorAction).toBe('recover');
    });

    it('ORCID_ALREADY_LINKED with no details and null Retry-After: renders durable message', async () => {
      const comp = createComponent();
      const err = new Error('Already linked');
      err.code = 'ORCID_ALREADY_LINKED';
      err.details = undefined;
      err.retryAfterSeconds = null;
      mockCompleteOrcid.mockRejectedValue(err);

      await comp._verify('code', 'state', 'link');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.alreadyLinkedDurable');
      expect(comp.errorAction).toBe('recover');
    });

    // Forward-compat for BE-ORCID-BROADCAST-ABORT-TIMEOUT 504. Backend may
    // not yet emit this code; the branch is inert until it does.
    it('BROADCAST_TIMEOUT: renders pending message pointing to settings', async () => {
      const comp = createComponent();
      const err = new Error('Broadcast timed out');
      err.code = 'BROADCAST_TIMEOUT';
      mockCompleteOrcid.mockRejectedValue(err);

      await comp._verify('code', 'state', 'link');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.broadcastPending');
      expect(comp.errorAction).toBe('settings');
    });

    // Per backend cascade-rethrow rollout (cluster 2 task 4, commit 09e01e3):
    // POST_BROADCAST_FAILED 502 with details.outcome:'confirmed' means the
    // chain-side bind succeeded; only a downstream cascade write failed. The
    // SPA must NOT route the user through /recover (the ORCID is already
    // bound; a fresh OAuth flow would surface 409 ORCID_ALREADY_LINKED).
    // Render a settings-affordance success-with-warning instead.
    it('POST_BROADCAST_FAILED with outcome:confirmed: renders confirmed message and settings affordance, no recover', async () => {
      const comp = createComponent();
      const err = new Error('Cascade failed');
      err.code = 'POST_BROADCAST_FAILED';
      err.details = {
        retriable: false,
        outcome: 'confirmed',
        tx_id: 'a'.repeat(40),
        failed_step: 'account_update',
      };
      mockCompleteOrcid.mockRejectedValue(err);

      await comp._verify('code', 'state', 'link');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.postBroadcastFailedConfirmed');
      expect(comp.errorAction).toBe('settings');
      // Critical: must NOT route to /recover. The ORCID is already bound
      // on chain; restarting OAuth would surface 409 ORCID_ALREADY_LINKED.
      expect(comp.errorAction).not.toBe('recover');
    });

    // Mutation guard: the outcome:'confirmed' discriminator is load-bearing
    // per agents/docs/api-contracts/orcid.md:203. A 502 POST_BROADCAST_FAILED
    // without outcome:'confirmed' (legacy/malformed envelope, future variant)
    // must NOT take the success-with-warning path; it falls through to the
    // generic console.warn + verificationFailed path.
    it('POST_BROADCAST_FAILED without outcome:confirmed falls through to generic path', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      const err = new Error('Cascade failed');
      err.code = 'POST_BROADCAST_FAILED';
      err.details = { retriable: false, failed_step: 'cache_write' }; // no outcome
      mockCompleteOrcid.mockRejectedValue(err);

      await comp._verify('code', 'state', 'accredit');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.verificationFailed');
      expect(comp.errorAction).not.toBe('settings');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('POST_BROADCAST_FAILED with outcome other than "confirmed" falls through to generic path', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      const err = new Error('Cascade failed');
      err.code = 'POST_BROADCAST_FAILED';
      err.details = { retriable: false, outcome: 'uncertain', failed_step: 'cache_write' };
      mockCompleteOrcid.mockRejectedValue(err);

      await comp._verify('code', 'state', 'accredit');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.verificationFailed');
      expect(comp.errorAction).not.toBe('settings');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('POST_BROADCAST_FAILED with no details object falls through to generic path', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      const err = new Error('Cascade failed');
      err.code = 'POST_BROADCAST_FAILED';
      // details intentionally absent
      mockCompleteOrcid.mockRejectedValue(err);

      await comp._verify('code', 'state', 'link');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.verificationFailed');
      expect(comp.errorAction).not.toBe('settings');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    // Sibling code of POST_BROADCAST_FAILED, emitted when the cascade failure
    // is permanent-severity (TypeError/SyntaxError/RangeError or SQLSTATE
    // class 23*/42*). Per api-contracts/common.md, clients keying on
    // POST_BROADCAST_FAILED MUST also handle this. Same outcome-discriminator
    // load-bearing rule; same /settings affordance (the ORCID is bound on
    // chain); different copy (operator-contact framing, not "give it a
    // moment to sync"). Must NOT route to /recover for the same reason
    // POST_BROADCAST_FAILED does not.
    it('POST_BROADCAST_OPERATOR_REQUIRED with outcome:confirmed: renders operator-required message and settings affordance, no recover', async () => {
      const comp = createComponent();
      const err = new Error('Cascade failed permanently');
      err.code = 'POST_BROADCAST_OPERATOR_REQUIRED';
      err.details = {
        retriable: false,
        outcome: 'confirmed',
        tx_id: 'b'.repeat(40),
        failed_step: 'account_update',
      };
      mockCompleteOrcid.mockRejectedValue(err);

      await comp._verify('code', 'state', 'link');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.postBroadcastOperatorRequired');
      expect(comp.errorAction).toBe('settings');
      expect(comp.errorAction).not.toBe('recover');
    });

    // Mutation guards mirroring the POST_BROADCAST_FAILED ones. The
    // outcome:'confirmed' discriminator is load-bearing for this code too.
    it('POST_BROADCAST_OPERATOR_REQUIRED without outcome:confirmed falls through to generic path', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      const err = new Error('Cascade failed permanently');
      err.code = 'POST_BROADCAST_OPERATOR_REQUIRED';
      err.details = { retriable: false, failed_step: 'account_update' }; // no outcome
      mockCompleteOrcid.mockRejectedValue(err);

      await comp._verify('code', 'state', 'accredit');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.verificationFailed');
      expect(comp.errorAction).not.toBe('settings');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('POST_BROADCAST_OPERATOR_REQUIRED with outcome other than "confirmed" falls through to generic path', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      const err = new Error('Cascade failed permanently');
      err.code = 'POST_BROADCAST_OPERATOR_REQUIRED';
      err.details = { retriable: false, outcome: 'uncertain', failed_step: 'account_update' };
      mockCompleteOrcid.mockRejectedValue(err);

      await comp._verify('code', 'state', 'accredit');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.verificationFailed');
      expect(comp.errorAction).not.toBe('settings');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('POST_BROADCAST_OPERATOR_REQUIRED with no details object falls through to generic path', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      const err = new Error('Cascade failed permanently');
      err.code = 'POST_BROADCAST_OPERATOR_REQUIRED';
      // details intentionally absent
      mockCompleteOrcid.mockRejectedValue(err);

      await comp._verify('code', 'state', 'link');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.verificationFailed');
      expect(comp.errorAction).not.toBe('settings');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    // fresh_auth mode: target-bound (consent_op-kind) ORCID-mediated proof
    // issuance for self-custody / password-mechanism users who use ORCID as
    // the fresh-auth factor for `author_accept` / `author_resign` consent
    // ops. Callback handler must cache the proof against the
    // (action, root_author, root_permlink) triple so the eventual broadcast
    // consumer can look it up by matching target.
    it('handles fresh_auth mode: caches target-bound proof, navigates return path, fires success toast', async () => {
      sessionStorageData['pevo_fresh_auth_return_to'] = '/papers/alice/some-paper';
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: {
          mode: 'fresh_auth',
          fresh_auth_proof: 'tok-target-bound',
          expires_at: '2099-01-01T00:00:00.000Z',
          action: 'author_accept',
          root_author: 'alice',
          root_permlink: 'some-paper',
          mechanism: 'orcid',
        },
      });

      await comp._verify('code', 'state', 'fresh_auth');

      // Proof cached under the consent-op slot with the full target binding.
      const cached = JSON.parse(sessionStorageData['pevo_fresh_auth_consent_op_proof']);
      expect(cached.token).toBe('tok-target-bound');
      expect(cached.expiresAt).toBe('2099-01-01T00:00:00.000Z');
      expect(cached.action).toBe('author_accept');
      expect(cached.rootAuthor).toBe('alice');
      expect(cached.rootPermlink).toBe('some-paper');
      // Return path is consumed (cleared) so a subsequent flow can't reuse it.
      expect(sessionStorageData['pevo_fresh_auth_return_to']).toBeUndefined();
      // Navigated back to the page that initiated the flow.
      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/papers/alice/some-paper');
      // Same success-toast key as session_auth (per task acceptance §5: no new
      // i18n key — mirror the existing reauth pattern).
      expect(mockToastStore.show).toHaveBeenCalledWith('orcid.reauthSuccess', 'success');
    });

    // Regression: `set_password` action ships an empty-string `root_permlink`
    // by design — it's an account-level (non-paper) target, so the permlink
    // slot is intentionally vacant in the wire contract. A truthy check on
    // `root_permlink` would reject this contract-valid response and surface
    // the generic error page; type-check on string is required so the empty
    // string passes and propagates into the cache. The cache write must
    // include the empty string verbatim so the consumer-side strict-equality
    // lookup (which also keys on `root_permlink === ''` for `set_password`)
    // matches. See backend-settings-set-password-fresh-auth for the issuer
    // side of this contract.
    it('handles fresh_auth set_password action with empty root_permlink: caches target-bound proof including empty permlink, navigates return path, fires success toast', async () => {
      sessionStorageData['pevo_fresh_auth_return_to'] = '/settings';
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: {
          mode: 'fresh_auth',
          fresh_auth_proof: 'tok',
          expires_at: '2099-01-01T00:00:00.000Z',
          action: 'set_password',
          root_author: 'alice',
          root_permlink: '',
          mechanism: 'orcid',
        },
      });

      await comp._verify('code', 'state', 'fresh_auth');

      // (a) Cache write succeeds with all three target fields, including the
      // empty-string root_permlink stored verbatim.
      const cached = JSON.parse(sessionStorageData['pevo_fresh_auth_consent_op_proof']);
      expect(cached.token).toBe('tok');
      expect(cached.expiresAt).toBe('2099-01-01T00:00:00.000Z');
      expect(cached.action).toBe('set_password');
      expect(cached.rootAuthor).toBe('alice');
      expect(cached.rootPermlink).toBe('');
      // (b) Return-path navigation fires.
      expect(sessionStorageData['pevo_fresh_auth_return_to']).toBeUndefined();
      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/settings');
      // (c) Success toast appears.
      expect(mockToastStore.show).toHaveBeenCalledWith('orcid.reauthSuccess', 'success');
      // Status not flipped to error (the guard let the empty permlink through).
      expect(comp.status).not.toBe('error');
    });

    it('fresh_auth without a stored return path falls back to /', async () => {
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: {
          mode: 'fresh_auth',
          fresh_auth_proof: 'tok',
          expires_at: '2099-01-01T00:00:00.000Z',
          action: 'author_resign',
          root_author: 'bob',
          root_permlink: 'paper-x',
        },
      });

      await comp._verify('code', 'state', 'fresh_auth');

      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/');
    });

    it('_handleFreshAuth direct-call post-teardown is a no-op (handler self-guards)', () => {
      const comp = createComponent();
      comp.destroy();
      comp._handleFreshAuth({
        fresh_auth_proof: 'tok',
        expires_at: '2099-01-01T00:00:00.000Z',
        action: 'author_accept',
        root_author: 'alice',
        root_permlink: 'paper',
      });

      // No cache write, no navigation, no toast.
      expect(sessionStorageData['pevo_fresh_auth_consent_op_proof']).toBeUndefined();
      expect(mockRouterStore.navigate).not.toHaveBeenCalled();
      expect(mockToastStore.show).not.toHaveBeenCalled();
    });

    // Defense-in-depth against a future backend regression that drops one of
    // the echoed target fields. Without the guard, the SPA would silently
    // write `{action: undefined, …}` into the cache and every subsequent
    // strict-equality lookup would miss, leaving the user re-OAuthing
    // indefinitely with no error surface. The backend integration test pin
    // is the primary contract guard; this catches the case where a release
    // ships with the echo dropped between test runs.
    it('fresh_auth with missing action: surfaces error, no cache write, no navigation', async () => {
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: {
          mode: 'fresh_auth',
          fresh_auth_proof: 'tok',
          expires_at: '2099-01-01T00:00:00.000Z',
          // action intentionally omitted
          root_author: 'alice',
          root_permlink: 'some-paper',
        },
      });

      await comp._verify('code', 'state', 'fresh_auth');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.verificationFailed');
      expect(sessionStorageData['pevo_fresh_auth_consent_op_proof']).toBeUndefined();
      expect(mockRouterStore.navigate).not.toHaveBeenCalled();
      expect(mockToastStore.show).not.toHaveBeenCalled();
    });

    it('fresh_auth with missing root_author: surfaces error, no cache write', async () => {
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: {
          mode: 'fresh_auth',
          fresh_auth_proof: 'tok',
          expires_at: '2099-01-01T00:00:00.000Z',
          action: 'author_accept',
          // root_author intentionally omitted
          root_permlink: 'some-paper',
        },
      });

      await comp._verify('code', 'state', 'fresh_auth');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.verificationFailed');
      expect(sessionStorageData['pevo_fresh_auth_consent_op_proof']).toBeUndefined();
    });

    it('fresh_auth with missing root_permlink: surfaces error, no cache write', async () => {
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: {
          mode: 'fresh_auth',
          fresh_auth_proof: 'tok',
          expires_at: '2099-01-01T00:00:00.000Z',
          action: 'author_accept',
          root_author: 'alice',
          // root_permlink intentionally omitted
        },
      });

      await comp._verify('code', 'state', 'fresh_auth');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.verificationFailed');
      expect(sessionStorageData['pevo_fresh_auth_consent_op_proof']).toBeUndefined();
    });

    it('fresh_auth with non-string action: surfaces error, no cache write', async () => {
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({
        data: {
          mode: 'fresh_auth',
          fresh_auth_proof: 'tok',
          expires_at: '2099-01-01T00:00:00.000Z',
          action: 42, // wrong type
          root_author: 'alice',
          root_permlink: 'some-paper',
        },
      });

      await comp._verify('code', 'state', 'fresh_auth');

      expect(comp.status).toBe('error');
      expect(comp.errorMessage).toBe('orcid.verificationFailed');
      expect(sessionStorageData['pevo_fresh_auth_consent_op_proof']).toBeUndefined();
    });

    it('init sets backPath from getReturnPath for fresh_auth mode', () => {
      sessionStorageData['pevo_fresh_auth_return_to'] = '/papers/alice/some-paper';
      sessionStorageData['pevo_orcid_mode'] = 'fresh_auth';
      const comp = createComponent();
      mockCompleteOrcid.mockResolvedValue({ data: { mode: 'fresh_auth' } });
      comp.init();
      expect(comp.backPath).toBe('/papers/alice/some-paper');
    });

    it('503 from completeOrcid leaves pevo_orcid_mode in sessionStorage so a refresh-retry can re-enter the correct flow', async () => {
      sessionStorageData['pevo_orcid_mode'] = 'link';
      const firstComp = createComponent();
      const err503 = new Error('Service unavailable');
      err503.status = 503;
      mockCompleteOrcid.mockRejectedValueOnce(err503);

      firstComp.init();
      // Drain microtasks so _verify's rejection handler runs.
      await Promise.resolve();
      await Promise.resolve();

      expect(firstComp.status).toBe('error');
      // CRITICAL: mode must still be there so a user-triggered refresh has the
      // context needed for the retry to carry the correct auth (Bearer token
      // for link/accredit) and route to the right endpoint.
      expect(sessionStorageData['pevo_orcid_mode']).toBe('link');

      // Simulate the user refreshing the page: a NEW component init() runs.
      // The mode is still present, so the retry knows we're in link flow.
      const secondComp = createComponent();
      mockCompleteOrcid.mockResolvedValueOnce({ data: { mode: 'link' } });
      secondComp.init();
      await Promise.resolve();
      await Promise.resolve();

      // Retry sees the mode and routes correctly.
      expect(secondComp.backPath).toBe('/settings');
      // Only after the successful retry is the mode cleared.
      expect(sessionStorage.removeItem).toHaveBeenCalledWith('pevo_orcid_mode');
    });
  });
});

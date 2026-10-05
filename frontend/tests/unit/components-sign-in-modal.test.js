import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mockLoginFromResponse } from './fixtures/mock-auth.js';

const ROOT = resolve(__dirname, '../..');
const INDEX_HTML = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const EN_MESSAGES = JSON.parse(readFileSync(resolve(ROOT, 'public/messages/en.json'), 'utf8'));

// The shipped markup of one modal mode, from its x-if template to the next
// mode's.
function modeMarkup(mode) {
  const modal = INDEX_HTML.slice(INDEX_HTML.indexOf('<div x-data="signInModal">'));
  const start = modal.indexOf(`<template x-if="mode === '${mode}'">`);
  if (start === -1) throw new Error(`no ${mode} mode in the sign-in modal markup`);
  const next = modal.indexOf(`<template x-if="mode === '`, start + 1);
  return modal.slice(start, next === -1 ? undefined : next);
}

// Run shipped binding code with `scope` as its scope, the way Alpine runs it:
// `evaluate` returns an attribute binding's value, `runHandler` runs an event
// handler's statements.
function evaluate(expression, scope) {
  return new Function('scope', `with (scope) { return (${expression}); }`)(scope);
}

function runHandler(statements, scope) {
  new Function('scope', `with (scope) { ${statements} }`)(scope);
}

const mockLoginWithPassword = vi.fn();
const mockResendVerification = vi.fn();

vi.mock('../../src/api.js', () => ({
  loginWithPassword: (...args) => mockLoginWithPassword(...args),
  resendVerification: (...args) => mockResendVerification(...args),
}));

const mockAuthStore = {
  username: null,
  token: null,
  expiresAt: null,
  isAccredited: false,
  accreditation: null,
  custody: null,
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
import { initSignInModal } from '../../src/components/sign-in-modal.js';

function createComponent() {
  initSignInModal();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  comp.$store = { auth: mockAuthStore, router: mockRouterStore };
  return comp;
}

describe('signInModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('prompt', () => {
    it('opens modal in choose mode and returns a promise', () => {
      const comp = createComponent();
      const p = comp.prompt();
      expect(comp.open).toBe(true);
      expect(comp.mode).toBe('choose');
      expect(p).toBeInstanceOf(Promise);
    });

    it('resets all fields on prompt', () => {
      const comp = createComponent();
      comp.value = 'old';
      comp.emailValue = 'old@email.com';
      comp.passwordValue = 'secret';
      comp.error = 'old error';
      comp.prompt();
      expect(comp.value).toBe('');
      expect(comp.emailValue).toBe('');
      expect(comp.passwordValue).toBe('');
      expect(comp.error).toBe(null);
    });
  });

  describe('confirm (keychain path)', () => {
    it('resolves with trimmed lowercase username', async () => {
      const comp = createComponent();
      const p = comp.prompt();
      comp.value = '  Alice  ';
      comp.confirm();
      const result = await p;
      expect(result).toBe('alice');
      expect(comp.open).toBe(false);
    });

    it('sets error when username is empty', () => {
      const comp = createComponent();
      comp.prompt();
      comp.value = '   ';
      comp.confirm();
      expect(comp.error).toBe('signIn.usernameEmpty');
      expect(comp.open).toBe(true);
    });
  });

  describe('cancel', () => {
    it('resolves promise with null and closes modal', async () => {
      const comp = createComponent();
      const p = comp.prompt();
      comp.cancel();
      const result = await p;
      expect(result).toBe(null);
      expect(comp.open).toBe(false);
      expect(comp.mode).toBe('choose');
    });
  });

  describe('handleEmailLogin', () => {
    it('sets error when fields are empty', async () => {
      const comp = createComponent();
      comp.emailValue = '';
      comp.passwordValue = '';
      await comp.handleEmailLogin();
      expect(comp.emailError).toBe('signIn.fillAllFields');
      expect(mockLoginWithPassword).not.toHaveBeenCalled();
    });

    it('calls loginWithPassword and stores session on success', async () => {
      mockLoginWithPassword.mockResolvedValue({ data: { token: 'abc' } });
      const comp = createComponent();
      comp.prompt(); // open so _resolve is set
      comp.emailValue = 'test@example.com';
      comp.passwordValue = 'pass123';
      await comp.handleEmailLogin();
      expect(mockLoginWithPassword).toHaveBeenCalledWith('test@example.com', 'pass123');
      // is_accredited / accreditation explicit overrides prevent cross-user
      // re-login from leaking stale accreditation state per the loginFromResponse
      // preserve-on-undefined contract.
      expect(mockAuthStore.loginFromResponse).toHaveBeenCalledWith({
        token: 'abc',
        is_accredited: false,
        accreditation: null,
      });
      expect(comp.open).toBe(false);
    });

    // The login 409 PENDING_SIGNUP body now carries ONLY { email } — no
    // auth_token. The modal must route to the resume step with a resume marker
    // and the email hint, never an auth_token in the URL.
    it('navigates to the resume step on PENDING_SIGNUP without leaking auth_token in the URL', async () => {
      const err = new Error('Pending');
      err.code = 'PENDING_SIGNUP';
      err.data = { email: 'e@x.com' };
      mockLoginWithPassword.mockRejectedValue(err);
      const comp = createComponent();
      comp.prompt();
      comp.emailValue = 'e@x.com';
      comp.passwordValue = 'pass';
      await comp.handleEmailLogin();
      const dest = mockRouterStore.navigate.mock.calls[0][0];
      expect(dest).toContain('/signup/verify?');
      expect(dest).toContain('resume=1');
      expect(dest).toContain('email=e%40x.com');
      expect(dest).not.toContain('auth_token');
      expect(dest).not.toContain('undefined');
      // Modal closes and the keychain prompt resolves null.
      expect(comp.open).toBe(false);
    });

    // Defensive: a stray auth_token in the body must not reach the URL.
    it('does not forward a stray auth_token from the 409 body into the URL', async () => {
      const err = new Error('Pending');
      err.code = 'PENDING_SIGNUP';
      err.data = { auth_token: 'confirmed:leak', email: 'e@x.com' };
      mockLoginWithPassword.mockRejectedValue(err);
      const comp = createComponent();
      comp.prompt();
      comp.emailValue = 'e@x.com';
      comp.passwordValue = 'pass';
      await comp.handleEmailLogin();
      const dest = mockRouterStore.navigate.mock.calls[0][0];
      expect(dest).not.toContain('auth_token');
      expect(dest).not.toContain('confirmed%3Aleak');
      expect(dest).toContain('resume=1');
    });

    it('switches to unverified mode on PENDING_UNVERIFIED', async () => {
      const err = new Error('Unverified');
      err.code = 'PENDING_UNVERIFIED';
      mockLoginWithPassword.mockRejectedValue(err);
      const comp = createComponent();
      comp.emailValue = 'e@x.com';
      comp.passwordValue = 'pass';
      await comp.handleEmailLogin();
      expect(comp.mode).toBe('unverified');
    });

    // Unknown-code failures surface a generic localized message to the DOM;
    // the raw err reaches console.warn only, never user-facing text.
    it('sanitizes generic error: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('Bad creds hex=deadbeefcafebabe');
      mockLoginWithPassword.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.emailValue = 'e@x.com';
      comp.passwordValue = 'pass';
      await comp.handleEmailLogin();
      expect(comp.emailError).toBe('signIn.loginFailed');
      expect(comp.emailError).not.toContain('deadbeef');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });
  });

  describe('handleEmailLogin cross-user re-login scrub', () => {
    // The authoritative scrub lives in the real auth store's
    // loginFromResponse; the fixture mirror replicates its subject-adoption
    // semantics so this suite can assert the modal's login path funnels the
    // response subject through it. Uses jsdom's real sessionStorage.
    beforeEach(() => {
      sessionStorage.clear();
      mockAuthStore.username = null;
    });

    it('logging in as a different username scrubs the previous subject\'s sessionStorage state', async () => {
      mockAuthStore.username = 'alice';
      sessionStorage.setItem('pevo_tab_subject', 'alice');
      sessionStorage.setItem('pevo_fresh_auth_session_proof', '{"token":"w"}');
      sessionStorage.setItem('pevo_orcid_mode', 'session_auth');
      mockLoginWithPassword.mockResolvedValue({
        data: { token: 'jwt-bob', expires_at: '2099-01-01', username: 'bob', custody: 'light' },
      });
      const comp = createComponent();
      comp.prompt();
      comp.emailValue = 'bob@x.com';
      comp.passwordValue = 'pass';

      await comp.handleEmailLogin();

      expect(sessionStorage.getItem('pevo_fresh_auth_session_proof')).toBeNull();
      expect(sessionStorage.getItem('pevo_orcid_mode')).toBeNull();
      expect(sessionStorage.getItem('pevo_tab_subject')).toBe('bob');
      expect(mockAuthStore.username).toBe('bob');
    });

    it('logging in again as the same username keeps the cached window', async () => {
      mockAuthStore.username = 'alice';
      sessionStorage.setItem('pevo_tab_subject', 'alice');
      sessionStorage.setItem('pevo_fresh_auth_session_proof', '{"token":"w"}');
      mockLoginWithPassword.mockResolvedValue({
        data: { token: 'jwt-alice-2', expires_at: '2099-01-01', username: 'alice', custody: 'light' },
      });
      const comp = createComponent();
      comp.prompt();
      comp.emailValue = 'alice@x.com';
      comp.passwordValue = 'pass';

      await comp.handleEmailLogin();

      expect(sessionStorage.getItem('pevo_fresh_auth_session_proof')).toBe('{"token":"w"}');
      expect(sessionStorage.getItem('pevo_tab_subject')).toBe('alice');
    });
  });

  describe('handleResendVerification', () => {
    it('calls resendVerification and sets success', async () => {
      mockResendVerification.mockResolvedValue({});
      const comp = createComponent();
      comp.emailValue = 'e@x.com';
      comp.passwordValue = 'pass';
      await comp.handleResendVerification();
      expect(mockResendVerification).toHaveBeenCalledWith('e@x.com', 'pass');
      expect(comp.resendSuccess).toBe(true);
    });

    // Resend failure surfaces a generic localized message to the DOM;
    // the raw err reaches console.warn only, never user-facing text.
    it('sanitizes resend failure: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('Rate limited hex=deadbeefcafebabe');
      mockResendVerification.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.emailValue = 'e@x.com';
      comp.passwordValue = 'pass';
      await comp.handleResendVerification();
      expect(comp.emailError).toBe('signIn.resendFailed');
      expect(comp.emailError).not.toContain('deadbeef');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });

    it('does not double-send while resending', async () => {
      let resolveFirst;
      mockResendVerification.mockImplementation(() => new Promise((r) => { resolveFirst = r; }));
      const comp = createComponent();
      comp.emailValue = 'e@x.com';
      comp.passwordValue = 'pass';
      const p1 = comp.handleResendVerification();
      comp.handleResendVerification(); // second call while first is pending
      resolveFirst({});
      await p1;
      expect(mockResendVerification).toHaveBeenCalledTimes(1);
    });
  });

  // A passwordless light account cannot use the email path, and the browser
  // extension does not apply to it, so both the chooser and the email form
  // link to the /login page, where ORCID sign-in starts. The bindings are
  // taken from the shipped markup and evaluated against a real instance.
  describe('ORCID sign-in line', () => {
    const MODES = ['choose', 'email'];

    function loginLink(mode) {
      const links = [...modeMarkup(mode).matchAll(/<a\s[^>]*>/g)]
        .map(([tag]) => tag)
        .filter((tag) => tag.includes("navigate('/login')"));
      expect(links).toHaveLength(1);
      return links[0];
    }

    it.each(MODES)('the %s mode links to the locale-prefixed /login page', (mode) => {
      const href = loginLink(mode).match(/:href="([^"]+)"/)[1];
      expect(evaluate(href, { $lp: (path) => `lp:${path}` })).toBe('lp:/login');
    });

    it.each(MODES)('the %s mode link closes the modal and settles the prompt before navigating', async (mode) => {
      const click = loginLink(mode).match(/@click\.prevent="([^"]+)"/)[1];
      const comp = createComponent();
      const prompted = comp.prompt();
      comp.mode = mode;
      // The modal sits outside the routed page and survives the route
      // change, so it must already be closed when the router runs.
      let openWhenNavigated;
      mockRouterStore.navigate.mockImplementationOnce(() => { openWhenNavigated = comp.open; });

      runHandler(click, comp);

      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/login');
      expect(openWhenNavigated).toBe(false);
      expect(comp.mode).toBe('choose');
      await expect(prompted).resolves.toBeNull();
    });

    it.each(MODES)('every string in the %s mode resolves in en.json', (mode) => {
      const keys = [...modeMarkup(mode).matchAll(/\$t\('([^']+)'\)/g)].map(([, key]) => key);
      expect(keys).toEqual(expect.arrayContaining(['signIn.orcidPrompt', 'signIn.orcidGoToLogin']));
      for (const key of keys) {
        const value = key.split('.').reduce((node, part) => node?.[part], EN_MESSAGES);
        expect(typeof value, key).toBe('string');
      }
    });
  });

  // Post-destroy() async continuations must not write to component state. A
  // modal login that resolves after the modal is torn down would otherwise
  // flip auth state + modal mode on a destroyed scope.
  describe('teardown', () => {
    it('handleEmailLogin catch does not set emailError after destroy()', async () => {
      let rejectFn;
      mockLoginWithPassword.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
      const comp = createComponent();
      comp.emailValue = 'e@x.com';
      comp.passwordValue = 'pass';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pending = comp.handleEmailLogin();
      comp.destroy();
      rejectFn(new Error('late'));
      await pending;
      expect(comp.emailError).toBeNull();
      warnSpy.mockRestore();
    });

    it('handleEmailLogin happy path does not flip open/mode after destroy()', async () => {
      let resolveFn;
      mockLoginWithPassword.mockImplementationOnce(() => new Promise((resolve) => { resolveFn = resolve; }));
      const comp = createComponent();
      comp.emailValue = 'e@x.com';
      comp.passwordValue = 'pass';
      comp.open = true;
      comp.mode = 'email';
      const pending = comp.handleEmailLogin();
      comp.destroy();
      resolveFn({ data: { token: 't', username: 'u' } });
      await pending;
      // open/mode untouched, auth store write skipped
      expect(comp.open).toBe(true);
      expect(comp.mode).toBe('email');
      expect(mockAuthStore.loginFromResponse).not.toHaveBeenCalled();
    });

    it('handleResendVerification catch does not set emailError after destroy()', async () => {
      let rejectFn;
      mockResendVerification.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
      const comp = createComponent();
      comp.emailValue = 'e@x.com';
      comp.passwordValue = 'pass';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pending = comp.handleResendVerification();
      comp.destroy();
      rejectFn(new Error('late'));
      await pending;
      expect(comp.emailError).toBeNull();
      expect(comp.resendSuccess).toBe(false);
      warnSpy.mockRestore();
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import enMessages from '../../public/messages/en.json';

const mockVerifyRecovery = vi.fn();

vi.mock('../../src/api.js', () => ({
  verifyRecovery: (...args) => mockVerifyRecovery(...args),
}));

const mockRouterStore = { navigate: vi.fn(), query: {} };
// What the auth store does with the reissued session is pinned against the
// real store in pages-recover-session.test.js.
const mockAuthStore = { adoptRecoveredSession: vi.fn(() => true) };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'router') return mockRouterStore;
      if (name === 'auth') return mockAuthStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initRecoverVerifyPage, recoverVerifyPageTemplate } from '../../src/pages/recover-verify.js';

const TOKEN = 'c'.repeat(64);
const RECOVERED = { token: 'new-jwt', expires_at: '2099-01-01T00:00:00.000Z', custody: 'light', username: 'alice' };

function createComponent(query = { token: TOKEN }) {
  mockRouterStore.query = query;
  initRecoverVerifyPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  comp.init();
  return comp;
}

function makeApiError(code) {
  const e = new Error('mock hex=deadbeefcafebabe');
  e.name = 'ApiRequestError';
  e.code = code;
  return e;
}

const resolves = (key) => typeof key.split('.').reduce((node, part) => node?.[part], enMessages) === 'string';

describe('recoverVerifyPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.adoptRecoveredSession.mockImplementation(() => true);
  });

  describe('opening the link', () => {
    // A mail scanner that renders the page must not spend the single-use link.
    it('waits for the confirm button before sending the token', () => {
      const comp = createComponent();

      expect(comp.state).toBe('ready');
      expect(mockVerifyRecovery).not.toHaveBeenCalled();
    });

    it('shows the unusable-link state for a link without a token, and sends nothing', () => {
      const comp = createComponent({});

      expect(comp.state).toBe('invalid');
      expect(mockVerifyRecovery).not.toHaveBeenCalled();
    });
  });

  describe('confirming', () => {
    it('sends the token from the link exactly once while a confirmation is in flight', async () => {
      let resolveFn;
      mockVerifyRecovery.mockImplementationOnce(() => new Promise((resolve) => { resolveFn = resolve; }));
      const comp = createComponent();

      const first = comp.submit();
      const second = comp.submit();
      expect(comp.state).toBe('submitting');
      resolveFn({ status: 'ok', data: RECOVERED });
      await Promise.all([first, second]);

      expect(mockVerifyRecovery).toHaveBeenCalledTimes(1);
      expect(mockVerifyRecovery).toHaveBeenCalledWith(TOKEN);
    });

    it('hands the reissued session to the auth store and offers Settings once signed in', async () => {
      mockVerifyRecovery.mockResolvedValue({ status: 'ok', data: RECOVERED });
      const comp = createComponent();

      await comp.submit();

      expect(mockAuthStore.adoptRecoveredSession).toHaveBeenCalledWith(RECOVERED);
      expect(comp.state).toBe('done');
      expect(comp.signedIn).toBe(true);
      expect(comp.doneCopy).toEqual({ description: 'recover.verifyDoneSignedIn', action: 'recover.goToSettings' });
      comp.doneAction();
      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/settings');
    });

    it('offers to switch when another account stays signed in, and switches on request', async () => {
      mockAuthStore.adoptRecoveredSession.mockImplementationOnce(() => false).mockImplementationOnce(() => true);
      mockVerifyRecovery.mockResolvedValue({ status: 'ok', data: RECOVERED });
      const comp = createComponent();

      await comp.submit();

      expect(comp.signedIn).toBe(false);
      expect(comp.doneCopy).toEqual({ description: 'recover.verifyDoneOtherAccount', action: 'recover.switchAccount' });

      comp.doneAction();

      expect(mockAuthStore.adoptRecoveredSession).toHaveBeenLastCalledWith(RECOVERED, { replaceAnotherAccount: true });
      expect(comp.signedIn).toBe(true);
      expect(comp.doneCopy.description).toBe('recover.verifyDoneSignedIn');
      expect(mockRouterStore.navigate).not.toHaveBeenCalled();
    });
  });

  describe('a refused confirmation', () => {
    it.each([
      ['INVALID_TOKEN', 'invalid'],
      ['DUPLICATE', 'duplicate'],
    ])('maps %s to the %s state without a console warning', async (code, state) => {
      mockVerifyRecovery.mockRejectedValue(makeApiError(code));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();

      await comp.submit();

      expect(comp.state).toBe(state);
      expect(mockAuthStore.adoptRecoveredSession).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it.each(['INTERNAL_ERROR', 'RATE_LIMITED'])('maps %s to the failed state, with the raw error to console.warn only', async (code) => {
      const err = makeApiError(code);
      mockVerifyRecovery.mockRejectedValue(err);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();

      await comp.submit();

      expect(comp.state).toBe('failed');
      expect(mockAuthStore.adoptRecoveredSession).not.toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(err);
      warnSpy.mockRestore();
    });

    it.each(['TypeError', 'TimeoutError', 'AbortError'])('treats a %s from the network as retriable', async (name) => {
      const err = new Error('network');
      err.name = name;
      mockVerifyRecovery.mockRejectedValue(err);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();

      await comp.submit();

      expect(comp.state).toBe('failed');
    });

    it('sends the same token again from the retriable state', async () => {
      mockVerifyRecovery.mockRejectedValueOnce(makeApiError('INTERNAL_ERROR'))
        .mockResolvedValueOnce({ status: 'ok', data: RECOVERED });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();

      await comp.submit();
      await comp.submit();

      expect(mockVerifyRecovery).toHaveBeenCalledTimes(2);
      expect(mockVerifyRecovery.mock.calls[1][0]).toBe(TOKEN);
      expect(comp.state).toBe('done');
    });

    it.each(['invalid', 'duplicate', 'done'])('sends nothing from the %s state', async (state) => {
      const comp = createComponent();
      comp.state = state;

      await comp.submit();

      expect(mockVerifyRecovery).not.toHaveBeenCalled();
    });
  });

  describe('teardown', () => {
    it('leaves the page state alone when a failure lands after the page is gone', async () => {
      let rejectFn;
      mockVerifyRecovery.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();

      const pending = comp.submit();
      comp.destroy();
      rejectFn(makeApiError('INTERNAL_ERROR'));
      await pending;

      expect(comp.state).toBe('submitting');
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    // The server has spent the link and revoked the account's other sessions
    // by the time it answers, so the answer still goes to
    // adoptRecoveredSession.
    it('still hands the answer to adoptRecoveredSession when it lands after the page is gone', async () => {
      let resolveFn;
      mockVerifyRecovery.mockImplementationOnce(() => new Promise((resolve) => { resolveFn = resolve; }));
      const comp = createComponent();

      const pending = comp.submit();
      comp.destroy();
      resolveFn({ status: 'ok', data: RECOVERED });
      await pending;

      expect(mockAuthStore.adoptRecoveredSession).toHaveBeenCalledWith(RECOVERED);
      expect(comp.state).toBe('submitting');
    });
  });

  describe('copy', () => {
    it('resolves every string the template names in en.json', () => {
      const keys = [...recoverVerifyPageTemplate.matchAll(/\$t\('([^']+)'\)/g)].map((m) => m[1]);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((key) => !resolves(key))).toEqual([]);
    });

    it('resolves both done-screen variants in en.json', async () => {
      mockVerifyRecovery.mockResolvedValue({ status: 'ok', data: RECOVERED });
      mockAuthStore.adoptRecoveredSession.mockImplementationOnce(() => false);
      const comp = createComponent();
      await comp.submit();
      const otherAccount = comp.doneCopy;
      comp.doneAction();
      const signedIn = comp.doneCopy;

      for (const key of [...Object.values(otherAccount), ...Object.values(signedIn)]) {
        expect(resolves(key), key).toBe(true);
      }
    });
  });
});

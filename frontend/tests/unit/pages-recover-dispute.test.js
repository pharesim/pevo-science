import { describe, it, expect, vi, beforeEach } from 'vitest';
import enMessages from '../../public/messages/en.json';

const mockDisputeRecovery = vi.fn();

vi.mock('../../src/api.js', () => ({
  disputeRecovery: (...args) => mockDisputeRecovery(...args),
}));

const mockRouterStore = { navigate: vi.fn(), query: {} };

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
import { initRecoverDisputePage, recoverDisputePageTemplate } from '../../src/pages/recover-dispute.js';

const TOKEN = 'd'.repeat(64);

function createComponent(query = { token: TOKEN }) {
  mockRouterStore.query = query;
  initRecoverDisputePage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  comp.init();
  return comp;
}

const resolves = (key) => typeof key.split('.').reduce((node, part) => node?.[part], enMessages) === 'string';

function makeApiError(code) {
  const e = new Error('mock hex=deadbeefcafebabe');
  e.name = 'ApiRequestError';
  e.code = code;
  return e;
}

describe('recoverDisputePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('opening the link', () => {
    // A mail scanner on the old mailbox must not stop a recovery by opening
    // the link.
    it('waits for the stop button before sending the token', () => {
      const comp = createComponent();

      expect(comp.state).toBe('ready');
      expect(mockDisputeRecovery).not.toHaveBeenCalled();
    });

    it('shows the unusable-link state for a link without a token, and sends nothing', () => {
      const comp = createComponent({});

      expect(comp.state).toBe('invalid');
      expect(mockDisputeRecovery).not.toHaveBeenCalled();
    });
  });

  describe('stopping', () => {
    it('sends the token from the link exactly once while a request is in flight', async () => {
      let resolveFn;
      mockDisputeRecovery.mockImplementationOnce(() => new Promise((resolve) => { resolveFn = resolve; }));
      const comp = createComponent();

      const first = comp.submit();
      const second = comp.submit();
      expect(comp.state).toBe('submitting');
      resolveFn({ status: 'ok', data: { disputed: true, message: 'server text' } });
      await Promise.all([first, second]);

      expect(mockDisputeRecovery).toHaveBeenCalledTimes(1);
      expect(mockDisputeRecovery).toHaveBeenCalledWith(TOKEN);
      expect(comp.state).toBe('done');
    });

    it.each([
      ['INVALID_TOKEN', 'invalid'],
      ['INTERNAL_ERROR', 'failed'],
      ['RATE_LIMITED', 'failed'],
    ])('maps %s to the %s state, with the raw error to console.warn only', async (code, state) => {
      const err = makeApiError(code);
      mockDisputeRecovery.mockRejectedValue(err);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();

      await comp.submit();

      expect(comp.state).toBe(state);
      expect(warnSpy.mock.calls[0][1]).toBe(err);
      warnSpy.mockRestore();
    });

    it('treats a network failure as retriable and sends the same token again', async () => {
      const err = new TypeError('Failed to fetch');
      mockDisputeRecovery.mockRejectedValueOnce(err)
        .mockResolvedValueOnce({ status: 'ok', data: { disputed: true, message: 'server text' } });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();

      await comp.submit();
      expect(comp.state).toBe('failed');
      await comp.submit();

      expect(mockDisputeRecovery).toHaveBeenCalledTimes(2);
      expect(mockDisputeRecovery.mock.calls[1][0]).toBe(TOKEN);
      expect(comp.state).toBe('done');
    });

    it.each(['invalid', 'done'])('sends nothing from the %s state', async (state) => {
      const comp = createComponent();
      comp.state = state;

      await comp.submit();

      expect(mockDisputeRecovery).not.toHaveBeenCalled();
    });
  });

  describe('teardown', () => {
    it('leaves the page state alone when the answer lands after the page is gone', async () => {
      let resolveFn;
      mockDisputeRecovery.mockImplementationOnce(() => new Promise((resolve) => { resolveFn = resolve; }));
      const comp = createComponent();

      const pending = comp.submit();
      comp.destroy();
      resolveFn({ status: 'ok', data: { disputed: true, message: 'server text' } });
      await pending;

      expect(comp.state).toBe('submitting');
    });
  });

  describe('copy', () => {
    it('resolves every string the template names in en.json', () => {
      const keys = [...recoverDisputePageTemplate.matchAll(/\$t\('([^']+)'\)/g)].map((m) => m[1]);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((key) => !resolves(key))).toEqual([]);
    });

    // The server answers the same whether or not the recovery had already
    // been confirmed, and its own text says nothing changed, which is false
    // in that case. The page shows its own copy.
    it('keeps nothing of the server message', async () => {
      mockDisputeRecovery.mockResolvedValue({ status: 'ok', data: { disputed: true, message: 'server text' } });
      const comp = createComponent();

      await comp.submit();

      expect(comp.state).toBe('done');
      expect(JSON.stringify(comp)).not.toContain('server text');
    });
  });
});

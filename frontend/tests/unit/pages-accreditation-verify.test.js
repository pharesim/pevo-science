import { describe, it, expect, vi, beforeEach } from 'vitest';
import enMessages from '../../public/messages/en.json';

const mockVerifyAccreditation = vi.fn();

vi.mock('../../src/api.js', () => ({
  verifyAccreditation: (...args) => mockVerifyAccreditation(...args),
}));

const mockRouterStore = { query: { token: 'tok123' }, navigate: vi.fn() };
const mockAuthStore = { token: 'jwt-1', connect: vi.fn() };
const mockToastStore = { show: vi.fn() };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'router') return mockRouterStore;
      if (name === 'auth') return mockAuthStore;
      if (name === 'toast') return mockToastStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initAccreditationVerifyPage, accreditationVerifyPageTemplate } from '../../src/pages/accreditation-verify.js';

const resolves = (key) => typeof key.split('.').reduce((node, part) => node?.[part], enMessages) === 'string';

function createComponent() {
  initAccreditationVerifyPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  comp.$watch = vi.fn();
  return comp;
}

function makeApiError(code, { details, retryAfterSeconds = null } = {}) {
  const e = new Error('mock');
  e.code = code;
  e.details = details;
  e.retryAfterSeconds = retryAfterSeconds;
  return e;
}

// A sign-in, sign-out or session swap: the store's token changes, and Alpine
// reports it to every watcher of `$store.auth.token`.
function changeSession(comp, token) {
  mockAuthStore.token = token;
  for (const [expression, callback] of comp.$watch.mock.calls) {
    if (expression === '$store.auth.token') callback(token);
  }
}

describe('accreditationVerifyPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRouterStore.query = { token: 'tok123' };
    mockAuthStore.token = 'jwt-1';
  });

  it('shows noToken when token missing', () => {
    mockRouterStore.query = {};
    const comp = createComponent();
    comp.init();
    expect(comp.state).toBe('error');
    expect(comp.errorMessage).toBe('verify.noToken');
  });

  it('transitions to success on successful verification', async () => {
    mockVerifyAccreditation.mockResolvedValue({ data: { username: 'alice' } });
    const comp = createComponent();
    comp.init();
    await vi.waitFor(() => expect(comp.state).toBe('success'));
    expect(comp.resultUsername).toBe('alice');
  });

  // The page never posts the token without a session.
  describe('session requirement', () => {
    it('with no session, sends nothing and shows the sign-in state', () => {
      mockAuthStore.token = null;
      const comp = createComponent();
      comp.init();

      expect(comp.state).toBe('signin');
      expect(mockVerifyAccreditation).not.toHaveBeenCalled();
    });

    it('a sign-in on the page posts the captured token once', async () => {
      mockAuthStore.token = null;
      mockVerifyAccreditation.mockResolvedValue({ data: { username: 'alice' } });
      const comp = createComponent();
      comp.init();
      expect(comp.state).toBe('signin');

      changeSession(comp, 'jwt-new');
      expect(comp.state).toBe('loading');
      expect(mockVerifyAccreditation).toHaveBeenCalledTimes(1);
      expect(mockVerifyAccreditation).toHaveBeenCalledWith('tok123');

      // A further session change while that request is out posts nothing.
      changeSession(comp, 'jwt-other');
      await vi.waitFor(() => expect(comp.state).toBe('success'));
      expect(mockVerifyAccreditation).toHaveBeenCalledTimes(1);
    });

    it('a sign-out on the sign-in state posts nothing', () => {
      mockAuthStore.token = null;
      const comp = createComponent();
      comp.init();

      changeSession(comp, null);
      expect(comp.state).toBe('signin');
      expect(mockVerifyAccreditation).not.toHaveBeenCalled();
    });

    it('a session change after a final answer posts nothing', async () => {
      mockVerifyAccreditation.mockRejectedValue(makeApiError('BAD_REQUEST'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.init();
      await vi.waitFor(() => expect(comp.state).toBe('error'));

      changeSession(comp, 'jwt-new');
      expect(comp.state).toBe('error');
      expect(mockVerifyAccreditation).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it.each(['UNAUTHORIZED', 'SESSION_EXPIRED', 'SESSION_INVALIDATED'])(
      '%s shows the sign-in state, and a sign-in posts the same token again',
      async (code) => {
        mockVerifyAccreditation
          .mockRejectedValueOnce(makeApiError(code))
          .mockResolvedValueOnce({ data: { username: 'alice' } });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const comp = createComponent();
        comp.init();

        await vi.waitFor(() => expect(comp.state).toBe('signin'));
        expect(comp.errorMessage).toBe('');

        changeSession(comp, 'jwt-new');
        await vi.waitFor(() => expect(comp.state).toBe('success'));
        expect(mockVerifyAccreditation).toHaveBeenCalledTimes(2);
        expect(mockVerifyAccreditation).toHaveBeenNthCalledWith(2, 'tok123');
        warnSpy.mockRestore();
      },
    );

    it('a session-ended answer after the store took up a newer session posts again with it', async () => {
      mockVerifyAccreditation
        .mockImplementationOnce(() => {
          // The auth store adopts the session another tab saved.
          mockAuthStore.token = 'jwt-adopted';
          return Promise.reject(makeApiError('SESSION_INVALIDATED'));
        })
        .mockResolvedValueOnce({ data: { username: 'alice' } });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.init();

      await vi.waitFor(() => expect(comp.state).toBe('success'));
      expect(mockVerifyAccreditation).toHaveBeenCalledTimes(2);
      expect(mockVerifyAccreditation).toHaveBeenNthCalledWith(2, 'tok123');
      warnSpy.mockRestore();
    });

    it('a session-ended answer after the store signed out shows the sign-in state', async () => {
      mockVerifyAccreditation.mockImplementationOnce(() => {
        mockAuthStore.token = null;
        return Promise.reject(makeApiError('SESSION_INVALIDATED'));
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.init();

      await vi.waitFor(() => expect(comp.state).toBe('signin'));
      expect(mockVerifyAccreditation).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('ACCREDITATION_ACCOUNT_MISMATCH shows the different-account state', async () => {
      mockVerifyAccreditation.mockRejectedValue(makeApiError('ACCREDITATION_ACCOUNT_MISMATCH'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.init();

      await vi.waitFor(() => expect(comp.state).toBe('mismatch'));
      warnSpy.mockRestore();
    });

    it('the sign-in button opens the app sign-in and reports a failed one', async () => {
      mockAuthStore.token = null;
      const failure = new Error('Authentication failed');
      mockAuthStore.connect.mockRejectedValue(failure);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.init();

      await comp.handleConnect();
      expect(mockAuthStore.connect).toHaveBeenCalledTimes(1);
      expect(mockToastStore.show).toHaveBeenCalledWith('common.connectionFailed', 'error');
      expect(comp.state).toBe('signin');
      warnSpy.mockRestore();
    });
  });

  // Answers a new accreditation request cannot change: the page shows why and
  // offers the contact page, never the "Request New Accreditation" link.
  describe('refusals a new request cannot fix', () => {
    function stateBlock(state) {
      const start = accreditationVerifyPageTemplate.indexOf(`x-if="state === '${state}'"`);
      expect(start).toBeGreaterThan(-1);
      return accreditationVerifyPageTemplate.slice(start, accreditationVerifyPageTemplate.indexOf('</template>', start));
    }

    it('MAILBOX_ALREADY_BOUND shows the bound-mailbox state naming the holding account', async () => {
      mockVerifyAccreditation.mockRejectedValue(
        makeApiError('MAILBOX_ALREADY_BOUND', { details: { bound_to: 'olderaccount' } }),
      );
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.init();

      await vi.waitFor(() => expect(comp.state).toBe('mailbox_bound'));
      expect(comp.boundTo).toBe('olderaccount');
      warnSpy.mockRestore();
    });

    it('MAILBOX_ALREADY_BOUND without details.bound_to shows the state without a name', async () => {
      mockVerifyAccreditation.mockRejectedValue(makeApiError('MAILBOX_ALREADY_BOUND'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.init();

      await vi.waitFor(() => expect(comp.state).toBe('mailbox_bound'));
      expect(comp.boundTo).toBe('');
      warnSpy.mockRestore();
    });

    it('ACCREDITATION_SANCTIONED shows the sanctioned state', async () => {
      mockVerifyAccreditation.mockRejectedValue(makeApiError('ACCREDITATION_SANCTIONED'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.init();

      await vi.waitFor(() => expect(comp.state).toBe('sanctioned'));
      warnSpy.mockRestore();
    });

    it('the bound-mailbox state names the account only when the answer carries it', () => {
      const block = stateBlock('mailbox_bound');
      expect(block).toContain("boundTo ? $t('verify.mailboxBoundMessage', { account: '@' + boundTo }) : $t('verify.mailboxBoundMessageUnnamed')");
    });

    it.each(['mailbox_bound', 'sanctioned'])('the %s state links to the contact page and not to a new request', (state) => {
      const block = stateBlock(state);
      expect(block).toContain("navigate('/contact')");
      expect(block).not.toContain('verify.requestNew');
      expect(block).not.toContain('/accreditation');
    });

    it('every string the template names resolves in en.json', () => {
      const keys = [...accreditationVerifyPageTemplate.matchAll(/\$t\('([^']+)'/g)].map((m) => m[1]);
      expect(keys).toEqual(expect.arrayContaining(['verify.mailboxBoundTitle', 'verify.sanctionedTitle']));
      expect(keys.filter((key) => !resolves(key))).toEqual([]);
    });
  });

  // Failure surfaces a generic localized message; raw err reaches
  // console.warn (no leaky error text in the DOM).
  it('sanitizes failure: generic message to DOM, raw err to console.warn', async () => {
    const leaky = new Error('invalid hex=deadbeefcafebabe');
    mockVerifyAccreditation.mockRejectedValue(leaky);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const comp = createComponent();
    comp.init();

    await vi.waitFor(() => expect(comp.state).toBe('error'));
    expect(comp.errorMessage).toBe('verify.verificationFailed');
    expect(comp.errorMessage).not.toContain('deadbeef');
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][1]).toBe(leaky);
    warnSpy.mockRestore();
  });

  // A post-destroy() .catch continuation must not write to component state.
  // The verifyAccreditation promise rejects after destroy(), and the .catch
  // sees _mounted === false and short-circuits before touching `state` or
  // `errorMessage`.
  it('post-destroy() verifyAccreditation rejection does not write to state or errorMessage', async () => {
    let rejectFn;
    mockVerifyAccreditation.mockReturnValue(new Promise((_, reject) => { rejectFn = reject; }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const comp = createComponent();
    comp.init();
    // state starts 'loading'; destroy before the promise rejects.
    expect(comp.state).toBe('loading');

    comp.destroy();

    rejectFn(new Error('post-teardown'));
    // Drain microtasks so the .catch handler runs.
    await Promise.resolve();
    await Promise.resolve();

    // state must NOT transition to 'error' after teardown.
    expect(comp.state).toBe('loading');
    expect(comp.errorMessage).toBe('');
    warnSpy.mockRestore();
  });

  // The backend emits `ACCREDITATION_GATE_UNAVAILABLE` with
  // `details.retriable: true` when the
  // HAF gate query throws and preserves the verification token. The SPA must
  // route this distinctly from non-retriable 4xx errors so the user is shown
  // a Retry affordance instead of a Request New CTA that would burn one of
  // their 3/24h `/api/accreditation/request` slots.
  describe('retriable error handling', () => {
    it('ACCREDITATION_GATE_UNAVAILABLE with retriable=true routes to retriable_error state', async () => {
      mockVerifyAccreditation.mockRejectedValue(
        makeApiError('ACCREDITATION_GATE_UNAVAILABLE', { details: { retriable: true } })
      );
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.init();

      await vi.waitFor(() => expect(comp.state).toBe('retriable_error'));
      expect(comp.errorMessage).toBe('verify.serviceTemporarilyUnavailable');
      warnSpy.mockRestore();
    });

    it('clicking Retry re-invokes verifyAccreditation with the same token', async () => {
      mockVerifyAccreditation
        .mockRejectedValueOnce(
          makeApiError('ACCREDITATION_GATE_UNAVAILABLE', { details: { retriable: true } })
        )
        .mockResolvedValueOnce({ data: { username: 'alice' } });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.init();

      await vi.waitFor(() => expect(comp.state).toBe('retriable_error'));
      expect(mockVerifyAccreditation).toHaveBeenCalledTimes(1);
      expect(mockVerifyAccreditation).toHaveBeenNthCalledWith(1, 'tok123');

      comp.retryVerification();
      // Transitions back to loading before the new call resolves.
      expect(comp.state).toBe('loading');

      await vi.waitFor(() => expect(comp.state).toBe('success'));
      expect(mockVerifyAccreditation).toHaveBeenCalledTimes(2);
      expect(mockVerifyAccreditation).toHaveBeenNthCalledWith(2, 'tok123');
      expect(comp.resultUsername).toBe('alice');
      warnSpy.mockRestore();
    });

    it('non-retriable error code routes to the generic error state (Request New CTA)', async () => {
      mockVerifyAccreditation.mockRejectedValue(makeApiError('BAD_REQUEST'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.init();

      await vi.waitFor(() => expect(comp.state).toBe('error'));
      expect(comp.errorMessage).toBe('verify.verificationFailed');
      warnSpy.mockRestore();
    });

    it('details.retriable=true without ACCREDITATION_GATE_UNAVAILABLE still routes retriable', async () => {
      mockVerifyAccreditation.mockRejectedValue(
        makeApiError('INTERNAL_ERROR', { details: { retriable: true } })
      );
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.init();

      await vi.waitFor(() => expect(comp.state).toBe('retriable_error'));
      warnSpy.mockRestore();
    });

    it('Retry-After seconds initializes cooldown and decrements per second', async () => {
      vi.useFakeTimers();
      try {
        mockVerifyAccreditation.mockRejectedValue(
          makeApiError('ACCREDITATION_GATE_UNAVAILABLE', {
            details: { retriable: true },
            retryAfterSeconds: 3,
          })
        );
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const comp = createComponent();
        comp.init();

        await vi.waitFor(() => expect(comp.state).toBe('retriable_error'));
        expect(comp.retryCooldownRemaining).toBe(3);

        await vi.advanceTimersByTimeAsync(1000);
        expect(comp.retryCooldownRemaining).toBe(2);
        await vi.advanceTimersByTimeAsync(1000);
        expect(comp.retryCooldownRemaining).toBe(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(comp.retryCooldownRemaining).toBe(0);

        // Tick again to confirm the chain stops re-arming at 0.
        await vi.advanceTimersByTimeAsync(1000);
        expect(comp.retryCooldownRemaining).toBe(0);
        warnSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it('Retry click is a no-op while cooldown > 0', async () => {
      vi.useFakeTimers();
      try {
        mockVerifyAccreditation.mockRejectedValue(
          makeApiError('ACCREDITATION_GATE_UNAVAILABLE', {
            details: { retriable: true },
            retryAfterSeconds: 5,
          })
        );
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const comp = createComponent();
        comp.init();

        await vi.waitFor(() => expect(comp.state).toBe('retriable_error'));
        expect(comp.retryCooldownRemaining).toBe(5);
        expect(mockVerifyAccreditation).toHaveBeenCalledTimes(1);

        comp.retryVerification();
        // Still retriable_error; no new call.
        expect(comp.state).toBe('retriable_error');
        expect(mockVerifyAccreditation).toHaveBeenCalledTimes(1);
        warnSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it('absent retryAfterSeconds permits immediate retry', async () => {
      mockVerifyAccreditation
        .mockRejectedValueOnce(
          makeApiError('ACCREDITATION_GATE_UNAVAILABLE', { details: { retriable: true } })
        )
        .mockResolvedValueOnce({ data: { username: 'alice' } });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.init();

      await vi.waitFor(() => expect(comp.state).toBe('retriable_error'));
      expect(comp.retryCooldownRemaining).toBe(0);

      comp.retryVerification();
      await vi.waitFor(() => expect(comp.state).toBe('success'));
      expect(mockVerifyAccreditation).toHaveBeenCalledTimes(2);
      warnSpy.mockRestore();
    });

    // Concurrent _verify() flights race on shared state. The generation
    // counter bumped synchronously at the top of _verify() captures into the
    // .then/.catch closures so a stale loser's resolution bails before
    // overwriting the winner's state. The user-facing failure shape this
    // closes: flight B's retriable_error state must not be overwritten by
    // flight A's stale success resolution; the generation guard makes
    // flight A's late `.then` bail.
    it('concurrent _verify() flights: stale resolver does not overwrite newer flight state', async () => {
      // First call (flight A) returns a promise we resolve manually after
      // flight B has already landed its retriable_error rejection. Without
      // the generation guard, flight A's late success would overwrite
      // flight B's state. With the guard, flight A's .then bails on
      // generation mismatch and flight B's state stands.
      let resolveA;
      mockVerifyAccreditation
        .mockReturnValueOnce(new Promise((resolve) => { resolveA = resolve; }))
        .mockRejectedValueOnce(
          makeApiError('ACCREDITATION_GATE_UNAVAILABLE', { details: { retriable: true } })
        );
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.init(); // dispatches flight A, _verifyGeneration === 1
      expect(comp.state).toBe('loading');
      expect(mockVerifyAccreditation).toHaveBeenCalledTimes(1);

      // Synthetic second flight: invoke _verify() directly to bypass the
      // retryVerification loading-guard. This is the entry-point the
      // generation counter must defend against in case any future caller
      // bypasses retryVerification.
      comp._verify(); // flight B, _verifyGeneration === 2
      expect(mockVerifyAccreditation).toHaveBeenCalledTimes(2);

      // Flight B's rejection lands; state goes to retriable_error.
      await vi.waitFor(() => expect(comp.state).toBe('retriable_error'));

      // Flight A resolves AFTER flight B already overwrote state. Without
      // the generation guard this .then would set state='success' and
      // resultUsername, clobbering flight B's retriable_error.
      resolveA({ data: { username: 'alice' } });
      // Drain microtasks so flight A's .then runs.
      await Promise.resolve();
      await Promise.resolve();

      // Generation guard held: flight A's late success bailed; flight B's
      // state survives.
      expect(comp.state).toBe('retriable_error');
      expect(comp.resultUsername).toBe('');
      warnSpy.mockRestore();
    });

    // retryVerification() must drop a double-tap that lands while a verify
    // flight is already in-flight (state === 'loading'). Without the guard,
    // a rapid second click between state='loading' and Alpine's x-if
    // teardown of the Retry button would fire a second verifyAccreditation
    // call — the user-driven entry point into the concurrent-flight race the
    // generation guard defends against.
    // Network-layer errors (`TypeError` from fetch failure, `AbortError`
    // from the 30s fetch timeout in `api.js`) never reach `ApiRequestError`
    // — `api.js` constructs `ApiRequestError` from the response body, so a
    // fetch that never produces a response throws raw. Both carry no
    // `.code`/`.details`, so without an explicit branch they would fall
    // through to the generic `'error'` state with the Request New CTA and
    // burn a 3/24h `/api/accreditation/request` slot against a still-valid
    // token. The network-error branch routes them to the Retry CTA instead,
    // sharing the existing `_startCooldown`/`_cooldownId`/`_tickCooldown`
    // machinery — no new timer scaffolding.
    describe('network-layer error handling', () => {
      function makeTypeError() {
        // Real fetch failures construct a plain `TypeError`. Synthesize the
        // same shape so the test exercises the actual `err?.name` path.
        const e = new TypeError('Failed to fetch');
        return e;
      }
      function makeAbortError() {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        return e;
      }
      // The 30s timeout in api.js is `AbortSignal.timeout()`, whose expiry
      // rejects the fetch with a `DOMException` named `TimeoutError`.
      function makeTimeoutError() {
        return new DOMException('The operation timed out.', 'TimeoutError');
      }

      it('TimeoutError routes to retriable_error with networkUnavailable copy and 5s cooldown', async () => {
        vi.useFakeTimers();
        try {
          mockVerifyAccreditation.mockRejectedValue(makeTimeoutError());
          const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
          const comp = createComponent();
          comp.init();

          await vi.waitFor(() => expect(comp.state).toBe('retriable_error'));
          expect(comp.errorMessage).toBe('verify.networkUnavailable');
          expect(comp.retryCooldownRemaining).toBe(5);
          warnSpy.mockRestore();
        } finally {
          vi.useRealTimers();
        }
      });

      it('TypeError routes to retriable_error with networkUnavailable copy and 0s cooldown', async () => {
        mockVerifyAccreditation.mockRejectedValue(makeTypeError());
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const comp = createComponent();
        comp.init();

        await vi.waitFor(() => expect(comp.state).toBe('retriable_error'));
        expect(comp.errorMessage).toBe('verify.networkUnavailable');
        // TypeError = offline / DNS / conn refused: immediate retry permitted.
        expect(comp.retryCooldownRemaining).toBe(0);
        warnSpy.mockRestore();
      });

      it('AbortError routes to retriable_error with networkUnavailable copy and 5s cooldown', async () => {
        vi.useFakeTimers();
        try {
          mockVerifyAccreditation.mockRejectedValue(makeAbortError());
          const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
          const comp = createComponent();
          comp.init();

          await vi.waitFor(() => expect(comp.state).toBe('retriable_error'));
          expect(comp.errorMessage).toBe('verify.networkUnavailable');
          // Pin the cooldown initial value and one decrement to confirm it
          // shares the existing _tickCooldown machinery.
          expect(comp.retryCooldownRemaining).toBe(5);
          await vi.advanceTimersByTimeAsync(1000);
          expect(comp.retryCooldownRemaining).toBe(4);
          warnSpy.mockRestore();
        } finally {
          vi.useRealTimers();
        }
      });

      it('Retry click after network error re-invokes verifyAccreditation with the same token', async () => {
        mockVerifyAccreditation
          .mockRejectedValueOnce(makeTypeError())
          .mockResolvedValueOnce({ data: { username: 'alice' } });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const comp = createComponent();
        comp.init();

        await vi.waitFor(() => expect(comp.state).toBe('retriable_error'));
        expect(mockVerifyAccreditation).toHaveBeenCalledTimes(1);
        expect(mockVerifyAccreditation).toHaveBeenNthCalledWith(1, 'tok123');
        // TypeError path: cooldown is 0 so Retry is immediately available.
        expect(comp.retryCooldownRemaining).toBe(0);

        comp.retryVerification();
        expect(comp.state).toBe('loading');

        await vi.waitFor(() => expect(comp.state).toBe('success'));
        expect(mockVerifyAccreditation).toHaveBeenCalledTimes(2);
        // Same token preserved across retry — backend was never reached on a
        // network error, so the token is still valid server-side.
        expect(mockVerifyAccreditation).toHaveBeenNthCalledWith(2, 'tok123');
        expect(comp.resultUsername).toBe('alice');
        warnSpy.mockRestore();
      });
    });

    it('rapid double-tap on Retry while state=loading fires verifyAccreditation exactly once', async () => {
      mockVerifyAccreditation
        .mockRejectedValueOnce(
          makeApiError('ACCREDITATION_GATE_UNAVAILABLE', { details: { retriable: true } })
        )
        .mockReturnValueOnce(new Promise(() => {})); // never resolves; keeps state='loading'
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      comp.init();

      await vi.waitFor(() => expect(comp.state).toBe('retriable_error'));
      expect(mockVerifyAccreditation).toHaveBeenCalledTimes(1);
      expect(comp.retryCooldownRemaining).toBe(0);

      // First click: passes the loading-guard (state is 'retriable_error'),
      // sets state='loading', dispatches flight 2.
      comp.retryVerification();
      expect(comp.state).toBe('loading');
      expect(mockVerifyAccreditation).toHaveBeenCalledTimes(2);

      // Second click while flight 2 is still in-flight: loading-guard must
      // drop it; verifyAccreditation must NOT be called a third time.
      comp.retryVerification();
      expect(mockVerifyAccreditation).toHaveBeenCalledTimes(2);

      // Third synthetic rapid-fire to pin the no-op even harder.
      comp.retryVerification();
      expect(mockVerifyAccreditation).toHaveBeenCalledTimes(2);

      warnSpy.mockRestore();
    });
  });
});

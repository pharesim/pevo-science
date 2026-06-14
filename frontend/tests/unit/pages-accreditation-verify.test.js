import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockVerifyAccreditation = vi.fn();

vi.mock('../../src/api.js', () => ({
  verifyAccreditation: (...args) => mockVerifyAccreditation(...args),
}));

const mockRouterStore = { query: { token: 'tok123' }, navigate: vi.fn() };

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
import { initAccreditationVerifyPage } from '../../src/pages/accreditation-verify.js';

function createComponent() {
  initAccreditationVerifyPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  return comp;
}

describe('accreditationVerifyPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRouterStore.query = { token: 'tok123' };
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
    function makeApiError(code, { details, retryAfterSeconds = null } = {}) {
      const e = new Error('mock');
      e.code = code;
      e.details = details;
      e.retryAfterSeconds = retryAfterSeconds;
      return e;
    }

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
        // `AbortSignal.timeout()` rejects with a `DOMException` whose
        // `name === 'AbortError'`. jsdom has DOMException; if a future
        // runtime omits it the discriminator still matches a plain
        // `Error` with `name = 'AbortError'`, so synthesize the simplest
        // shape the discriminator must accept.
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        return e;
      }

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
          // AbortError = fetch timed out: 5s fixed cooldown so the backend
          // has time to recover before the next attempt re-arms the 30s
          // timeout. Pin the cooldown initial value and one decrement to
          // confirm it shares the existing _tickCooldown machinery.
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

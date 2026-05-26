import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchBridgeLookup = vi.fn();
const mockFetchBridgeCheck = vi.fn();
const mockRegisterBridgePaper = vi.fn();

vi.mock('../../src/api.js', () => ({
  fetchBridgeLookup: (...args) => mockFetchBridgeLookup(...args),
  fetchBridgeCheck: (...args) => mockFetchBridgeCheck(...args),
  registerBridgePaper: (...args) => mockRegisterBridgePaper(...args),
}));

const mockAuthStore = {
  isConnected: true,
  isAccredited: true,
  username: 'testuser',
};
const mockRouterStore = { navigate: vi.fn() };
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
import { initBridgePage } from '../../src/pages/bridge.js';

function createComponent() {
  initBridgePage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  return comp;
}

describe('bridgePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.isConnected = true;
    mockAuthStore.isAccredited = true;
    mockAuthStore.username = 'testuser';
  });

  describe('filteredTaxonomy', () => {
    it('returns full taxonomy when search is empty', () => {
      const comp = createComponent();
      comp.disciplineSearch = '';
      const result = comp.filteredTaxonomy;
      expect(result.length).toBeGreaterThan(0);
      // Check that known fields exist
      expect(result.some((g) => g.field === 'Natural Sciences')).toBe(true);
    });

    it('returns full taxonomy when search is only whitespace', () => {
      const comp = createComponent();
      comp.disciplineSearch = '   ';
      expect(comp.filteredTaxonomy.length).toBeGreaterThan(0);
    });

    it('filters by subfield name (case-insensitive)', () => {
      const comp = createComponent();
      comp.disciplineSearch = 'physics';
      const result = comp.filteredTaxonomy;
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].subfields).toContain('Physics');
    });

    it('excludes groups with no matching subfields', () => {
      const comp = createComponent();
      comp.disciplineSearch = 'physics';
      const result = comp.filteredTaxonomy;
      result.forEach((group) => {
        expect(group.subfields.length).toBeGreaterThan(0);
      });
    });

    it('returns empty when no subfields match', () => {
      const comp = createComponent();
      comp.disciplineSearch = 'xyznonexistent';
      expect(comp.filteredTaxonomy).toEqual([]);
    });
  });

  describe('isDuplicate', () => {
    it('returns true when check.exists is true', () => {
      const comp = createComponent();
      comp.check = { exists: true, author: 'a', permlink: 'p' };
      expect(comp.isDuplicate).toBe(true);
    });

    it('returns false when check.exists is false', () => {
      const comp = createComponent();
      comp.check = { exists: false };
      expect(comp.isDuplicate).toBe(false);
    });

    it('returns false when check is null', () => {
      const comp = createComponent();
      comp.check = null;
      expect(comp.isDuplicate).toBeFalsy();
    });
  });

  describe('canRegister', () => {
    it('returns truthy when all conditions met', () => {
      const comp = createComponent();
      comp.lookup = { title: 'Paper' };
      comp.check = { exists: false };
      comp.discipline = 'Physics';
      comp.step = 'idle';
      expect(comp.canRegister).toBeTruthy();
    });

    it('returns falsy when no lookup', () => {
      const comp = createComponent();
      comp.lookup = null;
      comp.discipline = 'Physics';
      comp.step = 'idle';
      expect(comp.canRegister).toBeFalsy();
    });

    it('returns falsy when isDuplicate', () => {
      const comp = createComponent();
      comp.lookup = { title: 'Paper' };
      comp.check = { exists: true };
      comp.discipline = 'Physics';
      comp.step = 'idle';
      expect(comp.canRegister).toBeFalsy();
    });

    it('returns falsy when discipline is empty', () => {
      const comp = createComponent();
      comp.lookup = { title: 'Paper' };
      comp.check = { exists: false };
      comp.discipline = '';
      comp.step = 'idle';
      expect(comp.canRegister).toBeFalsy();
    });

    it('returns falsy when step is not idle', () => {
      const comp = createComponent();
      comp.lookup = { title: 'Paper' };
      comp.check = { exists: false };
      comp.discipline = 'Physics';
      comp.step = 'registering';
      expect(comp.canRegister).toBeFalsy();
    });
  });

  describe('prefillDiscipline', () => {
    it('does nothing when lookup is falsy', () => {
      const comp = createComponent();
      comp.prefillDiscipline(null);
      expect(comp.discipline).toBe('');
    });

    it('uses first subject when subjects exist', () => {
      const comp = createComponent();
      comp.prefillDiscipline({ subjects: ['Neuroscience', 'Biology'] });
      expect(comp.discipline).toBe('Neuroscience');
      expect(comp.disciplineSearch).toBe('Neuroscience');
    });

    it('falls back to normalized source_name when no subjects', () => {
      const comp = createComponent();
      comp.prefillDiscipline({ subjects: [], source_name: 'Journal of the Physics' });
      expect(comp.discipline).toBe('Physics');
    });

    it('strips "Frontiers in" prefix', () => {
      const comp = createComponent();
      comp.prefillDiscipline({ subjects: [], source_name: 'Frontiers in Neuroscience' });
      expect(comp.discipline).toBe('Neuroscience');
    });

    it('strips "Proceedings of the" prefix', () => {
      const comp = createComponent();
      comp.prefillDiscipline({ subjects: [], source_name: 'Proceedings of the ACM' });
      expect(comp.discipline).toBe('ACM');
    });

    it('capitalizes first letter', () => {
      const comp = createComponent();
      comp.prefillDiscipline({ subjects: [], source_name: 'journal of chemistry' });
      expect(comp.discipline).toBe('Chemistry');
    });

    it('does nothing if source_name is empty', () => {
      const comp = createComponent();
      comp.prefillDiscipline({ subjects: [], source_name: '' });
      expect(comp.discipline).toBe('');
    });

    it('does nothing if normalized name is >= 60 chars', () => {
      const comp = createComponent();
      const longName = 'A'.repeat(60);
      comp.prefillDiscipline({ subjects: [], source_name: longName });
      expect(comp.discipline).toBe('');
    });
  });

  describe('handleLookup', () => {
    it('does nothing when identifier is empty', async () => {
      const comp = createComponent();
      comp.identifier = '   ';
      await comp.handleLookup();
      expect(mockFetchBridgeLookup).not.toHaveBeenCalled();
    });

    it('calls both lookup and check in parallel', async () => {
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      mockFetchBridgeLookup.mockResolvedValue({ data: { title: 'Found', subjects: [] } });
      mockFetchBridgeCheck.mockResolvedValue({ data: { exists: false } });
      await comp.handleLookup();
      expect(mockFetchBridgeLookup).toHaveBeenCalledWith('10.1234/test');
      expect(mockFetchBridgeCheck).toHaveBeenCalledWith('10.1234/test');
      expect(comp.lookup).toEqual({ title: 'Found', subjects: [] });
      expect(comp.check).toEqual({ exists: false });
      expect(comp.lookingUp).toBe(false);
    });

    it('sets lookupError on INTERNAL_ERROR', async () => {
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      const err = new Error('fail');
      err.code = 'INTERNAL_ERROR';
      mockFetchBridgeLookup.mockRejectedValue(err);
      mockFetchBridgeCheck.mockResolvedValue({ data: {} });
      await comp.handleLookup();
      expect(comp.lookupError).toBe('bridge.lookupUnavailable');
      expect(comp.lookingUp).toBe(false);
    });

    it('sets generic lookupError for other errors', async () => {
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      mockFetchBridgeLookup.mockRejectedValue(new Error('fail'));
      mockFetchBridgeCheck.mockResolvedValue({ data: {} });
      await comp.handleLookup();
      expect(comp.lookupError).toBe('bridge.lookupFailed');
    });

    it('resets lookup and check before fetching', async () => {
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.lookup = { old: true };
      comp.check = { old: true };
      mockFetchBridgeLookup.mockResolvedValue({ data: { title: 'New' } });
      mockFetchBridgeCheck.mockResolvedValue({ data: { exists: false } });
      // Verify reset happens during the call
      let lookupDuringFetch;
      const origLookup = mockFetchBridgeLookup;
      mockFetchBridgeLookup.mockImplementation(() => {
        lookupDuringFetch = comp.lookup;
        return Promise.resolve({ data: { title: 'New' } });
      });
      await comp.handleLookup();
      expect(lookupDuringFetch).toBeNull();
    });

    it('clears duplicateExisting, step, and errorMessage when looking up a new identifier after a prior DUPLICATE error', async () => {
      const comp = createComponent();
      // Seed the post-DUPLICATE state: a prior /register call returned 409
      // DUPLICATE for identifier A, leaving the component with the duplicate
      // card visible and step in 'error'.
      comp.duplicateExisting = { author: 'someone', permlink: 'paper-a' };
      comp.step = 'error';
      comp.errorMessage = 'Already registered';
      // User types a different identifier B and clicks Lookup.
      comp.identifier = '10.5678/different-paper';
      mockFetchBridgeLookup.mockResolvedValue({ data: { title: 'Different Paper' } });
      mockFetchBridgeCheck.mockResolvedValue({ data: { exists: false } });
      await comp.handleLookup();
      // All three error-context fields must clear so the resolved lookup
      // renders against a clean state. A regression that drops any one of
      // the three would leave a stale field visible to the user during the
      // window between lookup-success and the next user action.
      expect(comp.duplicateExisting).toBeNull();
      expect(comp.step).toBe('idle');
      expect(comp.errorMessage).toBe('');
    });

    it('bails without firing lookup while a register broadcast is in flight', async () => {
      const comp = createComponent();
      comp.identifier = '10.1234/paper-a';
      comp.discipline = 'Physics';
      // Drive handleRegister to the in-flight 'registering' state via a
      // never-resolving registerBridgePaper. step transitions synchronously
      // before the first await, so the gate can observe it.
      mockRegisterBridgePaper.mockImplementation(() => new Promise(() => {}));
      void comp.handleRegister();
      expect(comp.step).toBe('registering');
      // User types a different identifier and attempts a Lookup mid-broadcast.
      comp.identifier = '10.5678/paper-b';
      await comp.handleLookup();
      // The gate must bail before the lookup fetches fire. Without the bail,
      // handleLookup's entry resets (step = 'idle', duplicateExisting = null)
      // would mask the in-flight register state from the visible UI and the
      // user would land on paper A after the original broadcast resolves
      // while seeing paper B's preview.
      expect(mockFetchBridgeLookup).not.toHaveBeenCalled();
      expect(mockFetchBridgeCheck).not.toHaveBeenCalled();
      expect(comp.step).toBe('registering');
    });
  });

  describe('handleRegister', () => {
    it('does nothing without username', async () => {
      const comp = createComponent();
      mockAuthStore.username = '';
      comp.discipline = 'Physics';
      await comp.handleRegister();
      expect(mockRegisterBridgePaper).not.toHaveBeenCalled();
    });

    it('does nothing without discipline', async () => {
      const comp = createComponent();
      comp.discipline = '';
      await comp.handleRegister();
      expect(mockRegisterBridgePaper).not.toHaveBeenCalled();
    });

    // Async-enqueue success: /register returns HTTP 202 with a pending queue
    // entry, queue_position, and eta_seconds. The page renders the 'queued'
    // state (position + ETA) and does NOT redirect to a paper page (the paper
    // is not on chain yet).
    it('transitions to registering then queued on 202 enqueue', async () => {
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.discipline = 'Physics';
      comp.keywordsText = 'quantum, optics';
      comp.language = 'en';
      mockRegisterBridgePaper.mockResolvedValue({
        data: { entry: { id: 7, state: 'pending' }, queue_position: 3, eta_seconds: 600 },
      });

      await comp.handleRegister();
      expect(comp.step).toBe('queued');
      expect(comp.queuedPosition).toBe(3);
      expect(comp.queuedEtaSeconds).toBe(600);
      expect(mockRegisterBridgePaper).toHaveBeenCalledWith({
        identifier: '10.1234/test',
        discipline: 'Physics',
        keywords: ['quantum', 'optics'],
        language: 'en',
      });
      // No redirect on the async path.
      expect(mockRouterStore.navigate).not.toHaveBeenCalled();
    });

    // Per-user in-flight cap: 429 RATE_LIMITED carrying details.cap is the cap
    // rejection (vs. the per-IP limiter, which omits details.cap). It surfaces
    // the cap-specific 'userCap' state, distinct from the transient error path.
    it('RATE_LIMITED with details.cap transitions to userCap and records inflight count', async () => {
      const capErr = new Error('Too many pending imports');
      capErr.code = 'RATE_LIMITED';
      capErr.details = { retriable: true, inflight: 5, cap: 5 };
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.discipline = 'Physics';
      mockRegisterBridgePaper.mockRejectedValue(capErr);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await comp.handleRegister();

      expect(comp.step).toBe('userCap');
      expect(comp.userCapInflight).toBe(5);
      expect(comp.errorMessage).toBe('');
      // A usage-cap hit is expected operation, not log-worthy noise.
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    // The per-IP limiter shares the RATE_LIMITED code but omits details.cap.
    // It must NOT hit the userCap branch; it falls through to the generic
    // error surface like any other transient failure.
    it('RATE_LIMITED without details.cap falls through to the generic error surface', async () => {
      const ipErr = new Error('Rate limit exceeded');
      ipErr.code = 'RATE_LIMITED';
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.discipline = 'Physics';
      mockRegisterBridgePaper.mockRejectedValue(ipErr);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await comp.handleRegister();

      expect(comp.step).toBe('error');
      expect(comp.userCapInflight).toBeNull();
      expect(comp.errorMessage).toBe('common.registrationFailed');
      warnSpy.mockRestore();
    });

    // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: failure surfaces a
    // generic localized message; raw err reaches console.warn.
    it('sanitizes failure: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('Server error hex=deadbeefcafebabe');
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.discipline = 'Physics';
      mockRegisterBridgePaper.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await comp.handleRegister();

      expect(comp.step).toBe('error');
      expect(comp.errorMessage).toBe('common.registrationFailed');
      expect(comp.errorMessage).not.toContain('deadbeef');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });

    it('omits keywords when empty', async () => {
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.discipline = 'Physics';
      comp.keywordsText = '';
      comp.language = '';
      mockRegisterBridgePaper.mockResolvedValue({ data: { entry: { id: 1 }, queue_position: 1, eta_seconds: 0 } });
      await comp.handleRegister();
      expect(mockRegisterBridgePaper).toHaveBeenCalledWith({
        identifier: '10.1234/test',
        discipline: 'Physics',
        keywords: undefined,
        language: undefined,
      });
    });

    // 409 LOCK_HELD (concurrent registration of the same preprint, Redis
    // lock held on the backend) auto-retries transparently with short
    // backoffs. If the retry budget is exhausted, the catch surfaces the
    // LOCK_HELD-specific message with the manual "Try again" affordance.
    // 409 DUPLICATE branches separately and surfaces existing_author /
    // existing_permlink from err.details so the template renders a link
    // to the existing paper instead of the generic try-again button.
    it('LOCK_HELD: persistent contention exhausts retry budget and surfaces lockHeldRetry', async () => {
      vi.useFakeTimers();
      const lockErr = new Error('Registration already in progress');
      lockErr.code = 'LOCK_HELD';
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.discipline = 'Physics';
      mockRegisterBridgePaper.mockRejectedValue(lockErr);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const registerP = comp.handleRegister();
      // Drive the retry backoffs forward; total budget is 1500+2500+3500ms
      // plus the trailing rejection that exits the loop.
      await vi.advanceTimersByTimeAsync(10000);
      await registerP;

      expect(comp.step).toBe('error');
      expect(comp.errorMessage).toBe('bridge.lockHeldRetry');
      expect(comp.duplicateExisting).toBeNull();
      // Initial attempt + 3 retries = 4 total invocations before surfacing.
      expect(mockRegisterBridgePaper).toHaveBeenCalledTimes(4);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
      vi.useRealTimers();
    });

    it('LOCK_HELD: a retry that succeeds reaches the queued path without surfacing the error UI', async () => {
      vi.useFakeTimers();
      const lockErr = new Error('Registration already in progress');
      lockErr.code = 'LOCK_HELD';
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.discipline = 'Physics';
      mockRegisterBridgePaper
        .mockRejectedValueOnce(lockErr)
        .mockResolvedValueOnce({ data: { entry: { id: 9 }, queue_position: 1, eta_seconds: 0 } });

      const registerP = comp.handleRegister();
      await vi.advanceTimersByTimeAsync(2000);
      await registerP;

      expect(comp.step).toBe('queued');
      expect(comp.errorMessage).toBe('');
      expect(mockRegisterBridgePaper).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('DUPLICATE code surfaces existing_author/existing_permlink from err.details on duplicateExisting', async () => {
      const dupErr = new Error('Preprint already registered');
      dupErr.code = 'DUPLICATE';
      dupErr.details = { existing_author: 'someone', existing_permlink: 'paper-x' };
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.discipline = 'Physics';
      mockRegisterBridgePaper.mockRejectedValue(dupErr);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await comp.handleRegister();

      expect(comp.step).toBe('error');
      expect(comp.duplicateExisting).toEqual({ author: 'someone', permlink: 'paper-x' });
      expect(comp.errorMessage).toBe('');
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('DUPLICATE without details falls back to the generic message (no broken link)', async () => {
      const dupErr = new Error('Preprint already registered');
      dupErr.code = 'DUPLICATE';
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.discipline = 'Physics';
      mockRegisterBridgePaper.mockRejectedValue(dupErr);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await comp.handleRegister();

      expect(comp.step).toBe('error');
      expect(comp.duplicateExisting).toBeNull();
      expect(comp.errorMessage).toBe('common.registrationFailed');
      warnSpy.mockRestore();
    });

    it('non-409 errors (503/500 without code) still reach generic fallback', async () => {
      const genericErr = new Error('Internal server error');
      // No `.code` property — simulates a 500/503 reaching the catch.
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.discipline = 'Physics';
      mockRegisterBridgePaper.mockRejectedValue(genericErr);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await comp.handleRegister();

      expect(comp.step).toBe('error');
      expect(comp.errorMessage).toBe('common.registrationFailed');
      warnSpy.mockRestore();
    });

    // Post-destroy() success continuation must not write to component state.
    // The async-enqueue path resolves after the user navigated away; the
    // _mounted guard short-circuits before the resolve writes 'queued'.
    it('destroy() before the 202 resolves stops the queued-state write', async () => {
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.discipline = 'Physics';

      let resolveFn;
      mockRegisterBridgePaper.mockReturnValue(new Promise((resolve) => { resolveFn = resolve; }));

      const registerP = comp.handleRegister();
      // 'registering' set synchronously before the await.
      expect(comp.step).toBe('registering');

      comp.destroy();
      resolveFn({ data: { entry: { id: 1 }, queue_position: 1, eta_seconds: 0 } });
      await registerP;

      // step must NOT transition to 'queued' after teardown.
      expect(comp.step).toBe('registering');
      expect(comp.queuedPosition).toBeNull();
      expect(mockRouterStore.navigate).not.toHaveBeenCalled();
    });

    // Pins the post-await `_mounted` guard between the LOCK_HELD backoff
    // sleep and the next `registerBridgePaper` attempt. If a future change
    // moves or removes the guard, this test catches the regression: the
    // backoff timer fires after destroy() and would otherwise reach the
    // next `continue` (or, worse, mutate `step` / `errorMessage`) on a
    // torn-down component.
    it('destroy() during LOCK_HELD backoff stops further retries and state mutations', async () => {
      vi.useFakeTimers();
      const lockErr = new Error('Registration already in progress');
      lockErr.code = 'LOCK_HELD';
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.discipline = 'Physics';
      mockRegisterBridgePaper.mockRejectedValue(lockErr);

      const registerP = comp.handleRegister();
      // Let the initial attempt reject and the first backoff sleep begin.
      // First delay is 1500ms; advance 500ms so we're inside the window.
      await vi.advanceTimersByTimeAsync(500);
      expect(mockRegisterBridgePaper).toHaveBeenCalledTimes(1);

      // Tear down mid-backoff.
      comp.destroy();

      // Advance well past the full retry budget. The sleep promise resolves
      // and the post-await `_mounted` check must short-circuit before the
      // next `registerBridgePaper` invocation.
      await vi.advanceTimersByTimeAsync(20000);
      await registerP;

      expect(mockRegisterBridgePaper).toHaveBeenCalledTimes(1);
      // No state mutation past destroy: step stays at 'registering' (set
      // synchronously before the first await), errorMessage stays cleared.
      expect(comp.step).toBe('registering');
      expect(comp.errorMessage).toBe('');
      expect(comp.duplicateExisting).toBeNull();
      vi.useRealTimers();
    });

    // Partial-details fall-through: only one of existing_author /
    // existing_permlink present. The `if (author && permlink)` gate must
    // skip the duplicate-link block and surface the generic message,
    // otherwise the template would render a broken link with the missing
    // field as undefined.
    it('DUPLICATE with only existing_author (no permlink) falls through to generic message', async () => {
      const dupErr = new Error('Preprint already registered');
      dupErr.code = 'DUPLICATE';
      dupErr.details = { existing_author: 'someone' };
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.discipline = 'Physics';
      mockRegisterBridgePaper.mockRejectedValue(dupErr);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await comp.handleRegister();

      expect(comp.step).toBe('error');
      expect(comp.duplicateExisting).toBeNull();
      expect(comp.errorMessage).toBe('common.registrationFailed');
      warnSpy.mockRestore();
    });
  });

  // UI-ASYNC-CONTINUATION-TEARDOWN-GUARD-SWEEP: post-destroy() catch
  // continuation must not write to component state. The registerBridgePaper
  // broadcast rejects after destroy(), and handleRegister's catch sees
  // _mounted === false and short-circuits before touching `step` or
  // `errorMessage`.
  describe('teardown guard', () => {
    it('post-destroy() handleRegister rejection does not write to step or errorMessage', async () => {
      const comp = createComponent();
      comp.identifier = '10.1234/test';
      comp.discipline = 'Physics';

      let rejectFn;
      mockRegisterBridgePaper.mockReturnValue(new Promise((_, reject) => { rejectFn = reject; }));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const registerP = comp.handleRegister();
      // 'registering' is set synchronously before the await.
      expect(comp.step).toBe('registering');

      comp.destroy();

      rejectFn(new Error('post-teardown'));
      await registerP;

      // step must NOT transition to 'error' after teardown.
      expect(comp.step).toBe('registering');
      expect(comp.errorMessage).toBe('');
      warnSpy.mockRestore();
    });
  });

  describe('queuedDetailText', () => {
    // $t echoes "key|JSON(params)" so the test can assert which key and which
    // interpolation params the getter selected.
    function withParamCapturingT(comp) {
      comp.$t = (key, params) => (params ? `${key}|${JSON.stringify(params)}` : key);
      return comp;
    }

    it('uses position + ETA copy when eta_seconds is a finite number', () => {
      const comp = withParamCapturingT(createComponent());
      comp.queuedPosition = 3;
      comp.queuedEtaSeconds = 600; // 10 min
      const out = comp.queuedDetailText;
      expect(out).toContain('bridge.queuedPositionAndEta');
      expect(out).toContain('"position":3');
      // ETA is formatted via myImports.etaMinutes (~10 min).
      expect(out).toContain('myImports.etaMinutes');
    });

    it('falls back to position-only copy when eta_seconds is missing', () => {
      const comp = withParamCapturingT(createComponent());
      comp.queuedPosition = 2;
      comp.queuedEtaSeconds = null;
      const out = comp.queuedDetailText;
      expect(out).toContain('bridge.queuedPositionOnly');
      expect(out).toContain('"position":2');
    });

    it('renders position-agnostic no-detail copy when queuedPosition is null and no ETA', () => {
      const comp = withParamCapturingT(createComponent());
      comp.queuedPosition = null;
      comp.queuedEtaSeconds = null;
      const out = comp.queuedDetailText;
      // No fabricated "position 1": render the position-agnostic line.
      expect(out).toBe('bridge.queuedNoDetail');
      expect(out).not.toContain('position');
    });

    it('renders ETA-only copy when queuedPosition is null but an ETA is present', () => {
      const comp = withParamCapturingT(createComponent());
      comp.queuedPosition = null;
      comp.queuedEtaSeconds = 600; // 10 min
      const out = comp.queuedDetailText;
      expect(out).toContain('bridge.queuedEtaOnly');
      expect(out).toContain('myImports.etaMinutes');
      expect(out).not.toContain('position');
    });
  });

  describe('userCapMessageText', () => {
    it('interpolates the in-flight count into the cap message', () => {
      const comp = createComponent();
      comp.$t = (key, params) => (params ? `${key}|${JSON.stringify(params)}` : key);
      comp.userCapInflight = 5;
      const out = comp.userCapMessageText;
      expect(out).toContain('bridge.userCapMessage');
      expect(out).toContain('"pending":5');
    });
  });

  describe('disciplineDisplayValue', () => {
    it('returns disciplineSearch when dropdown is open', () => {
      const comp = createComponent();
      comp.disciplineDropdownOpen = true;
      comp.disciplineSearch = 'phys';
      comp.discipline = 'Physics';
      expect(comp.disciplineDisplayValue).toBe('phys');
    });

    it('returns discipline when dropdown is closed and discipline is set', () => {
      const comp = createComponent();
      comp.disciplineDropdownOpen = false;
      comp.discipline = 'Physics';
      comp.disciplineSearch = 'phys';
      expect(comp.disciplineDisplayValue).toBe('Physics');
    });

    it('returns disciplineSearch when dropdown is closed and no discipline', () => {
      const comp = createComponent();
      comp.disciplineDropdownOpen = false;
      comp.discipline = '';
      comp.disciplineSearch = 'phys';
      expect(comp.disciplineDisplayValue).toBe('phys');
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchBridgeImports = vi.fn();
const mockRegisterBridgePaper = vi.fn();

vi.mock('../../src/api.js', () => ({
  fetchBridgeImports: (...args) => mockFetchBridgeImports(...args),
  registerBridgePaper: (...args) => mockRegisterBridgePaper(...args),
}));

// paper-card.formatDate is imported for the submitted/completed lines; stub it
// so the page module loads without dragging the full component in.
vi.mock('../../src/components/paper-card.js', () => ({
  formatDate: (iso) => `DATE(${iso})`,
}));

const mockAuthStore = { isConnected: true, username: 'testuser', connect: vi.fn() };
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
import { initMyImportsPage } from '../../src/pages/my-imports.js';

function createComponent() {
  initMyImportsPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key, params) => (params ? `${key}|${JSON.stringify(params)}` : key);
  return comp;
}

// Set window.location.search without triggering navigation (jsdom).
function setSearch(search) {
  delete window.location;
  window.location = new URL(`http://localhost/en/my-imports${search}`);
}

describe('myImportsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.isConnected = true;
    mockAuthStore.username = 'testuser';
    setSearch('');
  });

  describe('loadEntries adapter', () => {
    it('maps wire fields (created_at, error_message, existing_*) into the view model', async () => {
      mockFetchBridgeImports.mockResolvedValue({
        data: {
          cap: 5,
          entries: [
            {
              id: 42,
              identifier: '2301.12345',
              title: 'Attention',
              state: 'completed',
              discipline: 'Computer Science',
              keywords: ['transformers'],
              language: 'en',
              created_at: '2026-05-26T14:00:00.000Z',
              completed_at: '2026-05-26T14:05:00.000Z',
              existing_author: 'pevo.bridge',
              existing_permlink: 'bridge-arxiv-2301-12345',
              permlink: 'bridge-arxiv-2301-12345',
              error_message: null,
            },
          ],
        },
      });

      const comp = createComponent();
      await comp.loadEntries();

      expect(mockFetchBridgeImports).toHaveBeenCalledTimes(1);
      expect(comp.error).toBe(false);
      const e = comp.entries[0];
      expect(e.id).toBe(42);
      expect(e.submitted_at).toBe('2026-05-26T14:00:00.000Z');
      expect(e.completed_at).toBe('2026-05-26T14:05:00.000Z');
      expect(e.author).toBe('pevo.bridge');
      expect(e.permlink).toBe('bridge-arxiv-2301-12345');
      expect(e.failure_reason).toBeNull();
      expect(e.retriable).toBe(false); // not failed
    });

    it('maps a failed entry with a transient error_code: error_message → failure_reason, retriable true, no author', async () => {
      mockFetchBridgeImports.mockResolvedValue({
        data: {
          entries: [
            {
              id: 7,
              identifier: '10.1234/notreal',
              title: null,
              state: 'failed',
              created_at: '2026-05-26T13:00:00.000Z',
              completed_at: '2026-05-26T13:01:00.000Z',
              existing_author: null,
              permlink: 'bridge-doi-10-1234-notreal',
              error_message: 'The publishing network rejected the submission.',
              error_code: 'BROADCAST_FAILED',
            },
          ],
        },
      });

      const comp = createComponent();
      await comp.loadEntries();

      const e = comp.entries[0];
      expect(e.failure_reason).toBe('The publishing network rejected the submission.');
      expect(e.retriable).toBe(true);
      expect(e.author).toBeNull(); // no existing_author → link suppressed in template
    });

    it('derives retriable from error_code: BAD_REQUEST and SERVICE_UNAVAILABLE are terminal, broadcast failures are transient', async () => {
      mockFetchBridgeImports.mockResolvedValue({
        data: {
          entries: [
            { id: 1, identifier: 'a', state: 'failed', created_at: 'x', existing_author: null, permlink: 'p', error_message: 'gone', error_code: 'BAD_REQUEST' },
            { id: 2, identifier: 'b', state: 'failed', created_at: 'x', existing_author: null, permlink: 'p', error_message: 'timeout', error_code: 'BROADCAST_TIMEOUT' },
            { id: 3, identifier: 'c', state: 'failed', created_at: 'x', existing_author: null, permlink: 'p', error_message: 'svc', error_code: 'SERVICE_UNAVAILABLE' },
            { id: 4, identifier: 'd', state: 'completed', created_at: 'x', existing_author: 'pevo.bridge', permlink: 'p', error_message: null, error_code: null },
            { id: 5, identifier: 'e', state: 'failed', created_at: 'x', existing_author: null, permlink: 'p', error_message: 'unknown', error_code: null },
          ],
        },
      });

      const comp = createComponent();
      await comp.loadEntries();
      const byId = Object.fromEntries(comp.entries.map((e) => [e.id, e]));
      expect(byId[1].retriable).toBe(false); // BAD_REQUEST → terminal (source gone)
      expect(byId[2].retriable).toBe(true); // BROADCAST_TIMEOUT → transient, re-POST re-enqueues
      expect(byId[3].retriable).toBe(false); // SERVICE_UNAVAILABLE → terminal posting-key case
      expect(byId[4].retriable).toBe(false); // completed → not a failure
      // Fail-open default: a failed entry with no/unrecognized error_code stays
      // retriable, so an unexpected wire shape never silently hides the Retry
      // affordance.
      expect(byId[5].retriable).toBe(true);
    });

    it('completed entry without existing_author leaves author null (View paper link suppressed)', async () => {
      mockFetchBridgeImports.mockResolvedValue({
        data: { entries: [{ id: 9, identifier: 'x', state: 'completed', created_at: 'x', existing_author: null, permlink: 'p', error_message: null }] },
      });
      const comp = createComponent();
      await comp.loadEntries();
      expect(comp.entries[0].author).toBeNull();
    });

    it('completed fresh-broadcast entry resolves author from wire.author (existing_author null) so the View paper link renders', async () => {
      mockFetchBridgeImports.mockResolvedValue({
        data: { entries: [{ id: 11, identifier: 'x', state: 'completed', created_at: 'x', author: 'pevo.bridge', existing_author: null, permlink: 'bridge-x', error_message: null }] },
      });
      const comp = createComponent();
      await comp.loadEntries();
      const e = comp.entries[0];
      // Widened resolution prefers the contract's own `author` (fresh broadcast)
      // over the null existing_author. author + permlink both present is the
      // view-model condition under which the template renders the View paper link.
      expect(e.author).toBe('pevo.bridge');
      expect(e.permlink).toBe('bridge-x');
    });

    it('tolerates a missing entries array', async () => {
      mockFetchBridgeImports.mockResolvedValue({ data: {} });
      const comp = createComponent();
      await comp.loadEntries();
      expect(comp.entries).toEqual([]);
      expect(comp.error).toBe(false);
    });

    it('sets error on fetch rejection', async () => {
      mockFetchBridgeImports.mockRejectedValue(new Error('HAF down'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      await comp.loadEntries();
      expect(comp.error).toBe(true);
      expect(comp.entries).toEqual([]);
      warnSpy.mockRestore();
    });

    it('demo mode renders representative entries through the same adapter without fetching', async () => {
      setSearch('?demo=1');
      const comp = createComponent();
      await comp.loadEntries();
      expect(mockFetchBridgeImports).not.toHaveBeenCalled();
      expect(comp.entries.length).toBe(5);
      // Demo rows pass through adaptEntry, so the completed row resolves author.
      const completed = comp.entries.find((e) => e.state === 'completed');
      expect(completed.author).toBe('pevo.bridge');
      // Two failed rows exercise both template branches: a terminal
      // BAD_REQUEST (cannotRetry) and a transient BROADCAST_FAILED (Retry).
      const failed = comp.entries.filter((e) => e.state === 'failed');
      expect(failed.length).toBe(2);
      expect(failed.some((e) => e.retriable === true)).toBe(true);
      expect(failed.some((e) => e.retriable === false)).toBe(true);
    });

    it('ignores a concurrent loadEntries call while one is in flight', async () => {
      let resolveFetch;
      mockFetchBridgeImports.mockImplementationOnce(() => new Promise((r) => { resolveFetch = r; }));
      const comp = createComponent();
      const p1 = comp.loadEntries(); // sets loading=true, awaits the fetch
      await comp.loadEntries(); // second call must early-return on the in-flight guard
      expect(mockFetchBridgeImports).toHaveBeenCalledTimes(1);
      resolveFetch({ data: { entries: [] } });
      await p1;
      expect(comp.loading).toBe(false);
    });
  });

  describe('etaLabel', () => {
    it('formats a non-terminal entry ETA via the shared formatter', () => {
      const comp = createComponent();
      expect(comp.etaLabel({ etaSeconds: 600 })).toBe('myImports.etaMinutes|{"minutes":10}');
    });

    it('returns etaUnknown when the entry carries no ETA', () => {
      const comp = createComponent();
      expect(comp.etaLabel({ etaSeconds: null })).toBe('myImports.etaUnknown');
      expect(comp.etaLabel(undefined)).toBe('myImports.etaUnknown');
    });
  });

  describe('retryEntry', () => {
    it('re-POSTs /register with the entry payload and reloads on success', async () => {
      mockRegisterBridgePaper.mockResolvedValue({ data: { entry: { id: 99 }, queue_position: 1, eta_seconds: 0 } });
      mockFetchBridgeImports.mockResolvedValue({ data: { entries: [] } });

      const comp = createComponent();
      await comp.retryEntry({
        id: 7,
        identifier: '10.1234/notreal',
        discipline: 'Computer Science',
        keywords: ['x'],
        language: 'en',
        state: 'failed',
        retriable: true,
      });

      expect(mockRegisterBridgePaper).toHaveBeenCalledWith({
        identifier: '10.1234/notreal',
        discipline: 'Computer Science',
        keywords: ['x'],
        language: 'en',
      });
      // Reload fired after the re-enqueue.
      expect(mockFetchBridgeImports).toHaveBeenCalledTimes(1);
      expect(mockToastStore.show).toHaveBeenCalledWith('bridge.queuedTitle', 'success');
      expect(comp.retryingId).toBeNull();
    });

    it('omits empty optional fields from the retry payload', async () => {
      mockRegisterBridgePaper.mockResolvedValue({ data: { entry: { id: 1 }, queue_position: 1, eta_seconds: 0 } });
      mockFetchBridgeImports.mockResolvedValue({ data: { entries: [] } });
      const comp = createComponent();
      await comp.retryEntry({ id: 1, identifier: '2301.1', discipline: '', keywords: [], language: '', retriable: true });
      expect(mockRegisterBridgePaper).toHaveBeenCalledWith({
        identifier: '2301.1',
        discipline: undefined,
        keywords: undefined,
        language: undefined,
      });
    });

    it('surfaces an error toast and clears retryingId on failure', async () => {
      mockRegisterBridgePaper.mockRejectedValue(new Error('boom'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      await comp.retryEntry({ id: 5, identifier: 'x', retriable: true });
      expect(mockToastStore.show).toHaveBeenCalledWith('common.error', 'error');
      expect(comp.retryingId).toBeNull();
      // A failed reload is not attempted on the error path.
      expect(mockFetchBridgeImports).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('ignores a re-entrant retry while one is in flight for the same entry', async () => {
      const comp = createComponent();
      comp.retryingId = 5;
      await comp.retryEntry({ id: 5, identifier: 'x', retriable: true });
      expect(mockRegisterBridgePaper).not.toHaveBeenCalled();
    });

    it('runs only one retry at a time across distinct entries', async () => {
      let resolveFirst;
      mockRegisterBridgePaper.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
      mockFetchBridgeImports.mockResolvedValue({ data: { entries: [] } });
      const comp = createComponent();
      // First retry (entry 5) starts and parks on the in-flight re-POST.
      const p1 = comp.retryEntry({ id: 5, identifier: 'a', retriable: true });
      expect(comp.retryingId).toBe(5);
      // Second retry on a DIFFERENT entry while the first is in flight must
      // bail before re-POSTing — otherwise both re-enqueue and race the reload.
      await comp.retryEntry({ id: 7, identifier: 'b', retriable: true });
      expect(mockRegisterBridgePaper).toHaveBeenCalledTimes(1);
      resolveFirst({ data: { entry: { id: 5 }, queue_position: 1, eta_seconds: 0 } });
      await p1;
      expect(comp.retryingId).toBeNull();
    });

    it('surfaces the cap message (not the generic toast) when retry hits the per-user cap', async () => {
      const capErr = new Error('Too many pending imports');
      capErr.code = 'RATE_LIMITED';
      capErr.details = { retriable: true, inflight: 5, cap: 5 };
      mockRegisterBridgePaper.mockRejectedValue(capErr);
      const comp = createComponent();
      await comp.retryEntry({ id: 5, identifier: 'x', retriable: true });
      expect(mockToastStore.show).toHaveBeenCalledWith('bridge.userCapMessage|{"pending":5}', 'error');
      expect(mockToastStore.show).not.toHaveBeenCalledWith('common.error', 'error');
      expect(comp.retryingId).toBeNull();
    });

    it('surfaces the lock-held message when retry hits LOCK_HELD contention', async () => {
      const lockErr = new Error('Registration already in progress');
      lockErr.code = 'LOCK_HELD';
      mockRegisterBridgePaper.mockRejectedValue(lockErr);
      const comp = createComponent();
      await comp.retryEntry({ id: 5, identifier: 'x', retriable: true });
      expect(mockToastStore.show).toHaveBeenCalledWith('bridge.lockHeldRetry', 'error');
      expect(mockToastStore.show).not.toHaveBeenCalledWith('common.error', 'error');
      expect(comp.retryingId).toBeNull();
    });

    it('short-circuits in demo mode (?demo=1) and never reaches the live /register', async () => {
      setSearch('?demo=1');
      const comp = createComponent();
      await comp.retryEntry({ id: 5, identifier: 'x', retriable: true });
      expect(mockRegisterBridgePaper).not.toHaveBeenCalled();
      expect(comp.retryingId).toBeNull();
    });

    it('treats an on-chain DUPLICATE during retry as already-registered: reloads and shows the duplicate notice', async () => {
      const dupErr = new Error('Preprint already registered');
      dupErr.code = 'DUPLICATE';
      dupErr.details = { existing_author: 'pevo.bridge', existing_permlink: 'bridge-x' };
      mockRegisterBridgePaper.mockRejectedValue(dupErr);
      mockFetchBridgeImports.mockResolvedValue({ data: { entries: [] } });
      const comp = createComponent();
      await comp.retryEntry({ id: 5, identifier: 'x', retriable: true });
      expect(mockToastStore.show).toHaveBeenCalledWith('bridge.duplicateWarning', 'success');
      // The list is reloaded so the row reflects the already-on-chain post.
      expect(mockFetchBridgeImports).toHaveBeenCalledTimes(1);
      expect(comp.retryingId).toBeNull();
    });

    it('treats an already-queued DUPLICATE during retry as in-flight: reloads and shows a neutral queued notice (not "already registered")', async () => {
      const dupErr = new Error('Preprint already queued');
      dupErr.code = 'DUPLICATE';
      dupErr.details = { existing_entry_id: 88, existing_entry_state: 'pending' };
      mockRegisterBridgePaper.mockRejectedValue(dupErr);
      mockFetchBridgeImports.mockResolvedValue({ data: { entries: [] } });
      const comp = createComponent();
      await comp.retryEntry({ id: 5, identifier: 'x', retriable: true });
      // An in-flight duplicate is queued, not on chain — neutral framing only.
      expect(mockToastStore.show).toHaveBeenCalledWith('bridge.queuedTitle', 'info');
      expect(mockToastStore.show).not.toHaveBeenCalledWith('bridge.duplicateWarning', 'success');
      expect(mockFetchBridgeImports).toHaveBeenCalledTimes(1);
      expect(comp.retryingId).toBeNull();
    });
  });

  describe('stateLabel / badgeClass', () => {
    it('maps each state to a distinct label key', () => {
      const comp = createComponent();
      expect(comp.stateLabel('pending')).toBe('myImports.statePending');
      expect(comp.stateLabel('in_progress')).toBe('myImports.stateInProgress');
      expect(comp.stateLabel('completed')).toBe('myImports.stateCompleted');
      expect(comp.stateLabel('failed')).toBe('myImports.stateFailed');
      expect(comp.stateLabel('weird')).toBe('weird');
    });

    it('maps each state to a distinct badge class, with a default fallback', () => {
      const comp = createComponent();
      const pending = comp.badgeClass('pending');
      const inProgress = comp.badgeClass('in_progress');
      const completed = comp.badgeClass('completed');
      const failed = comp.badgeClass('failed');
      const classes = [pending, inProgress, completed, failed];
      // Each known state resolves to a non-empty, distinct class string.
      expect(new Set(classes).size).toBe(4);
      classes.forEach((c) => expect(c.length).toBeGreaterThan(0));
      // Unknown state falls back to the pending/neutral class.
      expect(comp.badgeClass('weird')).toBe(pending);
    });
  });

  describe('init / handleConnect', () => {
    it('does not load entries when disconnected', () => {
      mockAuthStore.isConnected = false;
      const comp = createComponent();
      comp.init();
      expect(mockFetchBridgeImports).not.toHaveBeenCalled();
    });

    it('loads entries on init when already connected', async () => {
      mockAuthStore.isConnected = true;
      mockFetchBridgeImports.mockResolvedValue({ data: { entries: [] } });
      const comp = createComponent();
      comp.init();
      // init kicks off loadEntries without awaiting; flush the microtask queue.
      await Promise.resolve();
      expect(mockFetchBridgeImports).toHaveBeenCalledTimes(1);
    });

    it('handleConnect loads entries after a successful connect', async () => {
      mockAuthStore.isConnected = true;
      mockAuthStore.connect.mockResolvedValue(undefined);
      mockFetchBridgeImports.mockResolvedValue({ data: { entries: [] } });
      const comp = createComponent();
      await comp.handleConnect();
      expect(mockAuthStore.connect).toHaveBeenCalled();
      expect(mockFetchBridgeImports).toHaveBeenCalledTimes(1);
    });

    it('handleConnect shows a toast and does not load when connect rejects', async () => {
      mockAuthStore.connect.mockRejectedValue(new Error('user cancelled'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      await comp.handleConnect();
      expect(mockToastStore.show).toHaveBeenCalledWith('common.connectionFailed', 'error');
      expect(mockFetchBridgeImports).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // page-mount.js calls Alpine.destroyTree on route change; an async
  // continuation resolving after destroy() must not write reactive state or
  // fire a toast on a torn-down component. createTimerGuard()'s _mounted flag
  // gates every post-await write.
  describe('teardown guard', () => {
    it('loadEntries torn down mid-fetch does not write entries or loading', async () => {
      let resolveFetch;
      mockFetchBridgeImports.mockImplementationOnce(() => new Promise((r) => { resolveFetch = r; }));
      const comp = createComponent();
      const p = comp.loadEntries();
      expect(comp.loading).toBe(true);
      comp.destroy(); // route change tears the component down mid-fetch
      resolveFetch({ data: { entries: [{ id: 1, identifier: 'x', state: 'pending', created_at: 'x' }] } });
      await p;
      // No post-teardown writes: entries stays empty, loading is not reset
      // true→false (the finally's reset is gated behind _mounted).
      expect(comp.entries).toEqual([]);
      expect(comp.loading).toBe(true);
      expect(comp._mounted).toBe(false);
    });

    it('retryEntry torn down mid-flight does not toast or reload', async () => {
      let resolveRetry;
      mockRegisterBridgePaper.mockImplementationOnce(() => new Promise((r) => { resolveRetry = r; }));
      const comp = createComponent();
      const p = comp.retryEntry({ id: 5, identifier: 'x', retriable: true });
      expect(comp.retryingId).toBe(5);
      comp.destroy();
      resolveRetry({ data: { entry: { id: 5 }, queue_position: 1, eta_seconds: 0 } });
      await p;
      // The success continuation short-circuits: no toast, no reload.
      expect(mockToastStore.show).not.toHaveBeenCalled();
      expect(mockFetchBridgeImports).not.toHaveBeenCalled();
    });

    it('retryEntry torn down DURING the post-success reload does not fire the success toast', async () => {
      // Re-POST succeeds, then the reload parks; teardown fires mid-reload.
      // Exercises the second _mounted recheck added after `await loadEntries()`
      // (the toast-after-await reorder), distinct from the pre-reload guard above.
      mockRegisterBridgePaper.mockResolvedValue({ data: { entry: { id: 5 }, queue_position: 1, eta_seconds: 0 } });
      let resolveReload;
      mockFetchBridgeImports.mockImplementationOnce(() => new Promise((r) => { resolveReload = r; }));
      const comp = createComponent();
      const p = comp.retryEntry({ id: 5, identifier: 'x', retriable: true });
      // Flush past the resolved re-POST so the post-success loadEntries() reload
      // starts and parks on the still-pending fetch.
      await Promise.resolve();
      await Promise.resolve();
      expect(mockFetchBridgeImports).toHaveBeenCalledTimes(1);
      comp.destroy(); // route change tears the component down mid-reload
      resolveReload({ data: { entries: [] } });
      await p;
      // Post-reload _mounted recheck suppresses the success toast.
      expect(mockToastStore.show).not.toHaveBeenCalledWith('bridge.queuedTitle', 'success');
    });
  });
});

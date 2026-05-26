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

    it('maps a failed entry: error_message → failure_reason, retriable true, no author', async () => {
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
              error_message: 'Source metadata could not be retrieved.',
              error_code: 'BAD_REQUEST',
            },
          ],
        },
      });

      const comp = createComponent();
      await comp.loadEntries();

      const e = comp.entries[0];
      expect(e.failure_reason).toBe('Source metadata could not be retrieved.');
      expect(e.retriable).toBe(true);
      expect(e.author).toBeNull(); // no existing_author → link suppressed in template
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
      expect(comp.entries.length).toBe(4);
      // Demo rows pass through adaptEntry, so the completed row resolves author.
      const completed = comp.entries.find((e) => e.state === 'completed');
      expect(completed.author).toBe('pevo.bridge');
      const failed = comp.entries.find((e) => e.state === 'failed');
      expect(failed.retriable).toBe(true);
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
  });
});

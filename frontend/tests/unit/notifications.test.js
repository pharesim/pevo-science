import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let store;
const mockFetchNotifications = vi.fn();

vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name, def) => {
      if (def) store = def;
      return store;
    }),
  },
}));

vi.mock('../../src/api.js', () => ({
  fetchNotifications: (...args) => mockFetchNotifications(...args),
}));

import { initNotifications } from '../../src/notifications.js';

// Helper: flush microtasks without advancing timers
function flushMicrotasks() {
  return new Promise((r) => setTimeout(r, 0));
}

describe('notifications store', () => {
  let localStorageData;

  beforeEach(() => {
    vi.useFakeTimers();
    store = null;
    localStorageData = {};
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => localStorageData[key] ?? null),
      setItem: vi.fn((key, val) => { localStorageData[key] = val; }),
      removeItem: vi.fn((key) => { delete localStorageData[key]; }),
    });
    mockFetchNotifications.mockReset();
    initNotifications();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('cursor/seenBlock localStorage helpers', () => {
    it('getCursor returns 0 when nothing stored', () => {
      mockFetchNotifications.mockResolvedValue({ status: 'ok', data: { events: [], latest_block: 0 } });
      store.start('alice');
      expect(mockFetchNotifications).toHaveBeenCalledWith(0, 50);
    });

    it('setCursor persists and getCursor reads it back', async () => {
      localStorageData['pevo_notification_cursor_alice'] = '42';
      mockFetchNotifications.mockResolvedValue({ status: 'ok', data: { events: [], latest_block: 42 } });
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0); // flush the async poll
      expect(mockFetchNotifications).toHaveBeenCalledWith(42, 50);
    });

    it('seenBlock is restored from localStorage on start', () => {
      localStorageData['pevo_notification_seen_block_bob'] = '100';
      mockFetchNotifications.mockResolvedValue({ status: 'ok', data: { events: [], latest_block: 0 } });
      store.start('bob');
      expect(store.seenBlock).toBe(100);
    });
  });

  describe('polling start/stop', () => {
    it('start calls poll immediately', () => {
      mockFetchNotifications.mockResolvedValue({ status: 'ok', data: { events: [], latest_block: 0 } });
      store.start('alice');
      expect(mockFetchNotifications).toHaveBeenCalledTimes(1);
    });

    it('stop clears state and cancels timer', async () => {
      mockFetchNotifications.mockResolvedValue({ status: 'ok', data: { events: [{ block_num: 1, type: 'vote', actor: 'x', permlink: 'p' }], latest_block: 1 } });
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0);
      expect(store.events.length).toBe(1);
      store.stop();
      expect(store.events).toHaveLength(0);
      expect(store._username).toBeNull();
      expect(store._timer).toBeNull();
    });

    it('schedules next poll after success', async () => {
      mockFetchNotifications.mockResolvedValue({ status: 'ok', data: { events: [], latest_block: 5 } });
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0);
      expect(store._timer).not.toBeNull();
    });
  });

  describe('exponential backoff on failure', () => {
    it('doubles interval on each failure', async () => {
      mockFetchNotifications.mockRejectedValue(new Error('network'));
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0); // first poll fails
      // First failure: 5min * 2 = 10min
      expect(store._currentInterval).toBe(10 * 60 * 1000);
      expect(store.error).toBe('Failed to fetch notifications');
    });

    it('caps interval at MAX_POLL_INTERVAL_MS (60min)', async () => {
      mockFetchNotifications.mockRejectedValue(new Error('network'));
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0); // fail 1: interval = 10min
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // fail 2: interval = 20min
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000); // fail 3: interval = 40min
      await vi.advanceTimersByTimeAsync(40 * 60 * 1000); // fail 4: interval = capped at 60min
      expect(store._currentInterval).toBe(60 * 60 * 1000);
    });

    it('stops polling after MAX_CONSECUTIVE_FAILURES (5)', async () => {
      mockFetchNotifications.mockRejectedValue(new Error('network'));
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0); // fail 1
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // fail 2
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000); // fail 3
      await vi.advanceTimersByTimeAsync(40 * 60 * 1000); // fail 4
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // fail 5
      expect(store.pollingStopped).toBe(true);
      expect(store.error).toContain('stopped');
    });

    it('resets failure count on success', async () => {
      mockFetchNotifications
        .mockRejectedValueOnce(new Error('net'))
        .mockResolvedValueOnce({ status: 'ok', data: { events: [], latest_block: 0 } });
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0); // fail 1
      expect(store._failureCount).toBe(1);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // success
      expect(store._failureCount).toBe(0);
      expect(store._currentInterval).toBe(5 * 60 * 1000);
    });
  });

  describe('MAX_EVENTS cap', () => {
    it('caps events at 200', async () => {
      const events = Array.from({ length: 250 }, (_, i) => ({
        block_num: i + 1, type: 'vote', actor: `user${i}`, permlink: `p${i}`,
      }));
      mockFetchNotifications.mockResolvedValue({ status: 'ok', data: { events, latest_block: 250 } });
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0);
      expect(store.events.length).toBe(200);
    });
  });

  describe('markAllRead', () => {
    it('sets seenBlock to max block_num and persists', async () => {
      mockFetchNotifications.mockResolvedValue({
        status: 'ok',
        data: { events: [{ block_num: 10, type: 'vote', actor: 'a', permlink: 'x' }, { block_num: 20, type: 'reply', actor: 'b', permlink: 'y' }], latest_block: 20 },
      });
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0);
      store.markAllRead();
      expect(store.seenBlock).toBe(20);
      expect(localStorage.setItem).toHaveBeenCalledWith('pevo_notification_seen_block_alice', '20');
    });

    it('does nothing when no events', () => {
      mockFetchNotifications.mockResolvedValue({ status: 'ok', data: { events: [], latest_block: 0 } });
      store.start('alice');
      store.events = [];
      store.markAllRead();
      expect(store.seenBlock).toBe(0);
    });

    it('does nothing when no username', () => {
      store.markAllRead();
      expect(store.seenBlock).toBe(0);
    });
  });

  describe('unreadCount', () => {
    it('counts events with block_num > seenBlock', async () => {
      mockFetchNotifications.mockResolvedValue({
        status: 'ok',
        data: { events: [{ block_num: 5, type: 'vote', actor: 'a', permlink: 'x' }, { block_num: 15, type: 'reply', actor: 'b', permlink: 'y' }], latest_block: 15 },
      });
      localStorageData['pevo_notification_seen_block_alice'] = '10';
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0);
      expect(store.unreadCount).toBe(1);
    });
  });

  describe('refresh', () => {
    it('resets failure state and polls', async () => {
      mockFetchNotifications.mockRejectedValue(new Error('net'));
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0); // fail 1
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // fail 2
      expect(store._failureCount).toBe(2);

      mockFetchNotifications.mockResolvedValue({ status: 'ok', data: { events: [], latest_block: 0 } });
      await store.refresh();
      expect(store._failureCount).toBe(0);
      expect(store.pollingStopped).toBe(false);
    });
  });

  describe('dedup logic', () => {
    it('deduplicates events by composite key', async () => {
      const ev = { block_num: 1, type: 'vote', actor: 'a', permlink: 'p' };
      mockFetchNotifications.mockResolvedValue({ status: 'ok', data: { events: [ev, ev], latest_block: 1 } });
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0);
      expect(store.events.length).toBe(1);
    });

    // new_vote events carry no top-level `permlink` (the target is under
    // `target_permlink`), so the dedup key must read the per-type permlink field
    // to keep two same-block, same-actor votes on different targets distinct.
    it('keeps distinct new_vote events that differ only by target_permlink', async () => {
      const events = [
        { block_num: 7, type: 'new_vote', actor: 'a', target_permlink: 'paper-one', target_type: 'paper', weight: 100 },
        { block_num: 7, type: 'new_vote', actor: 'a', target_permlink: 'paper-two', target_type: 'paper', weight: 100 },
      ];
      mockFetchNotifications.mockResolvedValue({ status: 'ok', data: { events, latest_block: 7 } });
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0);
      expect(store.events.length).toBe(2);
    });

    it('still deduplicates new_vote events with the same target_permlink', async () => {
      const ev = { block_num: 7, type: 'new_vote', actor: 'a', target_permlink: 'paper-one', target_type: 'paper', weight: 100 };
      mockFetchNotifications.mockResolvedValue({ status: 'ok', data: { events: [ev, ev], latest_block: 7 } });
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0);
      expect(store.events.length).toBe(1);
    });

    // new_citation events carry the target under `citing_permlink` (no top-level
    // `permlink`), so the dedup key must fall through to that leg to keep two
    // same-block, same-actor citations of different citing papers distinct.
    it('keeps distinct new_citation events that differ only by citing_permlink', async () => {
      const events = [
        { block_num: 9, type: 'new_citation', actor: 'a', citing_permlink: 'cite-one', paper_title: 'P1' },
        { block_num: 9, type: 'new_citation', actor: 'a', citing_permlink: 'cite-two', paper_title: 'P2' },
      ];
      mockFetchNotifications.mockResolvedValue({ status: 'ok', data: { events, latest_block: 9 } });
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0);
      expect(store.events.length).toBe(2);
    });

    // claim_* events carry the target under `paper_permlink`, so the dedup key
    // must fall through to that leg to keep two same-block, same-actor claims on
    // different papers distinct.
    it('keeps distinct claim_pending events that differ only by paper_permlink', async () => {
      const events = [
        { block_num: 11, type: 'claim_pending', actor: 'a', paper_author: 'z', paper_permlink: 'paper-one' },
        { block_num: 11, type: 'claim_pending', actor: 'a', paper_author: 'z', paper_permlink: 'paper-two' },
      ];
      mockFetchNotifications.mockResolvedValue({ status: 'ok', data: { events, latest_block: 11 } });
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0);
      expect(store.events.length).toBe(2);
    });
  });

  describe('generation guard', () => {
    it('ignores stale poll results after stop', async () => {
      let resolveFirst;
      mockFetchNotifications.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
      store.start('alice');
      store.stop(); // increments generation
      resolveFirst({ status: 'ok', data: { events: [{ block_num: 1, type: 'vote', actor: 'x', permlink: 'p' }], latest_block: 1 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.events).toHaveLength(0);
    });
  });

  describe('cursor update', () => {
    it('updates cursor when latest_block > current cursor', async () => {
      mockFetchNotifications.mockResolvedValue({ status: 'ok', data: { events: [], latest_block: 99 } });
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0);
      expect(localStorage.setItem).toHaveBeenCalledWith('pevo_notification_cursor_alice', '99');
    });

    it('does not update cursor when latest_block <= current cursor', async () => {
      localStorageData['pevo_notification_cursor_alice'] = '100';
      mockFetchNotifications.mockResolvedValue({ status: 'ok', data: { events: [], latest_block: 50 } });
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0);
      const cursorCalls = localStorage.setItem.mock.calls.filter((c) => c[0] === 'pevo_notification_cursor_alice');
      expect(cursorCalls).toHaveLength(0);
    });

    // When the server's LIMIT cut the batch mid-window it reports has_more=true.
    // Advancing the cursor to latest_block would skip events sharing that block
    // (or just beyond it) on the next poll, so the cursor rewinds one block.
    it('rewinds cursor to latest_block - 1 when has_more is true', async () => {
      mockFetchNotifications.mockResolvedValue({
        status: 'ok',
        data: {
          events: [{ block_num: 99, type: 'new_review', actor: 'a', permlink: 're-x' }],
          latest_block: 99,
          has_more: true,
        },
      });
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0);
      expect(localStorage.setItem).toHaveBeenCalledWith('pevo_notification_cursor_alice', '98');
    });

    it('advances cursor to latest_block when has_more is false', async () => {
      mockFetchNotifications.mockResolvedValue({
        status: 'ok',
        data: {
          events: [{ block_num: 99, type: 'new_review', actor: 'a', permlink: 're-x' }],
          latest_block: 99,
          has_more: false,
        },
      });
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0);
      expect(localStorage.setItem).toHaveBeenCalledWith('pevo_notification_cursor_alice', '99');
    });

    // End-to-end across the rewind: poll 1 cuts at block 99 (has_more) and
    // rewinds the cursor to 98; poll 2 re-fetches from 98, re-delivering the
    // block-99 boundary event plus the previously-cut remainder. The dedup key
    // keeps the re-fetched boundary event from rendering twice.
    it('re-fetches the boundary block on the next poll and dedups the overlap', async () => {
      const boundary = { block_num: 99, type: 'new_review', actor: 'rev', permlink: 're-x' };
      const remainder = { block_num: 99, type: 'new_review', actor: 'rev2', permlink: 're-y' };
      mockFetchNotifications
        .mockResolvedValueOnce({ status: 'ok', data: { events: [boundary], latest_block: 99, has_more: true } })
        .mockResolvedValueOnce({ status: 'ok', data: { events: [boundary, remainder], latest_block: 99, has_more: false } });
      store.start('alice');
      await vi.advanceTimersByTimeAsync(0); // poll 1: since_block 0, rewinds cursor to 98
      expect(mockFetchNotifications).toHaveBeenNthCalledWith(1, 0, 50);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000); // scheduled poll 2 fires
      expect(mockFetchNotifications).toHaveBeenNthCalledWith(2, 98, 50);
      expect(store.events.filter((e) => e.permlink === 're-x')).toHaveLength(1);
      expect(store.events.some((e) => e.permlink === 're-y')).toBe(true);
      expect(localStorage.setItem).toHaveBeenCalledWith('pevo_notification_cursor_alice', '99');
    });
  });
});

import Alpine from 'alpinejs';
import { fetchNotifications } from './api.js';

const BASE_POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_POLL_INTERVAL_MS = 60 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 5;
const STORAGE_KEY_CURSOR = 'pevo_notification_cursor';
const STORAGE_KEY_SEEN = 'pevo_notification_seen_block';
const MAX_EVENTS = 200;

function getCursor(username) {
  const val = localStorage.getItem(`${STORAGE_KEY_CURSOR}_${username}`);
  const n = val ? parseInt(val, 10) : 0;
  return (Number.isFinite(n) && n > 0 && n < 2_000_000_000) ? n : 0;
}

function setCursor(username, block) {
  localStorage.setItem(`${STORAGE_KEY_CURSOR}_${username}`, String(block));
}

function getSeenBlock(username) {
  const val = localStorage.getItem(`${STORAGE_KEY_SEEN}_${username}`);
  const n = val ? parseInt(val, 10) : 0;
  return (Number.isFinite(n) && n > 0 && n < 2_000_000_000) ? n : 0;
}

function setSeenBlock(username, block) {
  localStorage.setItem(`${STORAGE_KEY_SEEN}_${username}`, String(block));
}

export function initNotifications() {
  Alpine.store('notifications', {
    events: [],
    seenBlock: 0,
    isLoading: false,
    error: null,
    pollingStopped: false,
    _timer: null,
    _failureCount: 0,
    _currentInterval: BASE_POLL_INTERVAL_MS,
    _username: null,
    _generation: 0,

    get unreadCount() {
      return this.events.filter((e) => e.block_num > this.seenBlock).length;
    },

    start(username) {
      this.stop();
      this._generation += 1;
      this._username = username;
      this.seenBlock = getSeenBlock(username);
      this._failureCount = 0;
      this._currentInterval = BASE_POLL_INTERVAL_MS;
      this.pollingStopped = false;
      this.poll();
    },

    stop() {
      this._generation += 1;
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      this._username = null;
      this.events = [];
      this.seenBlock = 0;
      this._failureCount = 0;
      this._currentInterval = BASE_POLL_INTERVAL_MS;
      this.pollingStopped = false;
      this.error = null;
    },

    async poll() {
      if (!this._username) return;
      const username = this._username;
      const gen = this._generation;
      const cursor = getCursor(username);

      try {
        this.isLoading = true;
        this.error = null;
        this.pollingStopped = false;

        const res = await fetchNotifications(cursor, 50);

        if (gen !== this._generation) return;

        if (res.status === 'ok' && res.data) {
          const batch = res.data;
          if (batch.events.length > 0) {
            const merged = [...batch.events, ...this.events];
            const seen = new Set();
            const deduped = merged.filter((e) => {
              const actor = 'actor' in e ? e.actor : 'system';
              // Events carry their target's permlink under different keys by type
              // (new_review/new_reply: permlink; new_vote: target_permlink;
              // new_citation: citing_permlink; claim_*: paper_permlink). Fall
              // through the known fields so the dedup key keeps a per-target
              // discriminator instead of collapsing distinct same-block,
              // same-actor events of these types into one.
              const permlink = e.permlink || e.target_permlink
                || e.citing_permlink || e.paper_permlink || '';
              const key = `${e.block_num}_${e.type}_${actor}_${permlink}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            // Render newest-first: sort the deduped merge by block_num descending
            // and trim to MAX_EVENTS. Sorting unconditionally (not only when over
            // the cap) keeps the feed order stable across polls -- an oversized
            // whole-block poll cannot flip the list asc<->desc against the next
            // under-cap poll. Whole-block delivery can hand back a single response
            // larger than MAX_EVENTS (a citation fan-out block is delivered
            // atomically), so the trim is a pure tail-cut that keeps the most
            // recent activity and sheds the oldest. Caveat: events that share one
            // block_num are not separable by this comparator, so a single block
            // carrying more than MAX_EVENTS events for one recipient is not
            // trimmed newest-first within that block -- deferred as a
            // single-instance non-concern.
            this.events = [...deduped]
              .sort((a, b) => b.block_num - a.block_num)
              .slice(0, MAX_EVENTS);
          }
          if (batch.latest_block > cursor) {
            // Whole-block delivery guarantees latest_block is a fully delivered
            // block (the server never splits a Hive block across responses), so
            // advancing the cursor straight to it can never skip intra-block
            // events. Advance unconditionally regardless of has_more -- there is
            // no rewind. A persistent has_more drains on the next timer-driven
            // poll, not by re-fetching a boundary block.
            setCursor(username, batch.latest_block);
          }
        }

        this._failureCount = 0;
        this._currentInterval = BASE_POLL_INTERVAL_MS;
        this._scheduleNext();
      } catch {
        this._failureCount += 1;
        if (this._failureCount >= MAX_CONSECUTIVE_FAILURES) {
          this.error = 'Notification polling stopped after repeated failures.';
          this.pollingStopped = true;
        } else {
          this.error = 'Failed to fetch notifications';
          this._currentInterval = Math.min(
            this._currentInterval * 2,
            MAX_POLL_INTERVAL_MS,
          );
          this._scheduleNext();
        }
      } finally {
        this.isLoading = false;
      }
    },

    _scheduleNext() {
      if (this._timer) clearTimeout(this._timer);
      if (this._failureCount >= MAX_CONSECUTIVE_FAILURES) return;
      this._timer = setTimeout(() => this.poll(), this._currentInterval);
    },

    markAllRead() {
      if (!this._username || this.events.length === 0) return;
      // Advance seenBlock to the newest retained block_num, marking everything
      // currently in memory as read. The cap keeps the newest MAX_EVENTS, so this
      // never marks a newer-than-shown event read. It does NOT guarantee full
      // unread integrity: the cap sheds the OLDEST events beyond MAX_EVENTS --
      // those leave memory and stop counting toward unreadCount regardless of
      // markAllRead. That is the accepted trade-off of a bounded in-memory feed.
      const maxBlock = Math.max(...this.events.map((e) => e.block_num));
      this.seenBlock = maxBlock;
      setSeenBlock(this._username, maxBlock);
    },

    async refresh() {
      this._failureCount = 0;
      this._currentInterval = BASE_POLL_INTERVAL_MS;
      this.pollingStopped = false;
      await this.poll();
    },
  });
}

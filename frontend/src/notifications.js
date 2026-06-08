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
            this.events = merged.filter((e) => {
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
            }).slice(0, MAX_EVENTS);
          }
          if (batch.latest_block > cursor) {
            // The server applies its LIMIT after the in-app since_block cursor
            // filter, so a `has_more` response means events sharing latest_block
            // (or just beyond it) were cut from this batch. Advancing the cursor
            // straight to latest_block would let the next poll's strict
            // since_block filter skip those undelivered boundary events. Rewind
            // to latest_block - 1 so the boundary block is re-fetched; the dedup
            // key (block_num_type_actor_permlink) collapses the re-rendered
            // overlap so the user never sees a duplicate.
            const nextCursor = batch.has_more ? batch.latest_block - 1 : batch.latest_block;
            setCursor(username, nextCursor);
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

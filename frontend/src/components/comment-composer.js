import Alpine from 'alpinejs';
import { broadcastOps } from '../signer.js';
import { getAppTag, getAppId } from '../config.js';
import { createTimerGuard } from '../lib/timer-guard.js';

function generatePermlink(parentPermlink) {
  const timestamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `re-${parentPermlink.slice(0, 40)}-${timestamp}-${rand}`;
}

export function initCommentComposer() {
  Alpine.data('commentComposer', (opts = {}) => ({
    // Lifecycle guard. See frontend/src/lib/timer-guard.js. handleSubmit
    // awaits a broadcast-confirm prompt and a multi-second Hive broadcast;
    // Alpine.destroyTree (e.g. SPA route change) fires synchronously and
    // the post-await continuations must not write to torn-down state.
    ...createTimerGuard(),

    parentAuthor: opts.parentAuthor || '',
    parentPermlink: opts.parentPermlink || '',
    body: '',
    isSubmitting: false,
    error: null,

    get isConnected() { return Alpine.store('auth').isConnected; },
    get isAccredited() { return Alpine.store('auth').isAccredited; },
    get username() { return Alpine.store('auth').username; },

    destroy() {
      this._teardownTimers();
    },

    async handleSubmit() {
      const trimmed = this.body.trim();
      if (!trimmed || !this.username) return;

      this.isSubmitting = true;
      this.error = null;

      try {
        const commentConfirmed = await Alpine.store('broadcastConfirm').request({
          title: this.$t('confirm.commentTitle'),
          message: this.$t('confirm.commentMessage'),
          confirmLabel: this.$t('confirm.comment'),
        });
        if (!this._mounted) return;
        if (!commentConfirmed) { this.isSubmitting = false; return; }

        const permlink = generatePermlink(this.parentPermlink);
        const APP_TAG = getAppTag();
        const APP_ID = getAppId();
        const jsonMetadata = {
          app: APP_ID,
          tags: [APP_TAG],
          [APP_TAG]: { type: 'comment', version: 1 },
        };
        const operations = [
          ['comment', {
            parent_author: this.parentAuthor,
            parent_permlink: this.parentPermlink,
            author: this.username,
            permlink,
            title: '',
            body: trimmed,
            json_metadata: JSON.stringify(jsonMetadata),
          }],
          ['comment_options', {
            author: this.username,
            permlink,
            max_accepted_payout: '1000000.000 HBD',
            percent_hbd: 0,
            allow_votes: true,
            allow_curation_rewards: true,
            extensions: [],
          }],
        ];
        await broadcastOps(this.username, operations);
        if (!this._mounted) return;
        this.body = '';
        // Dispatch event so parent can refresh
        this.$dispatch('comment-posted', { parentPermlink: this.parentPermlink });
      } catch (err) {
        if (!this._mounted) return;
        // Sanitization pattern (shared with executeUpgrade()): generic
        // localized message to the DOM, raw err to console.warn. The
        // comment body itself is user-authored plaintext so this handler
        // is low-risk today, but the invariant (no raw err.message in
        // DOM) is a single consistent rule across the app.
        console.warn('[comment composer post]', err);
        this.error = this.$t('comments.postFailed');
      } finally {
        if (this._mounted) this.isSubmitting = false;
      }
    },
  }));
}

import Alpine from 'alpinejs';
import { postComment } from '../keychain.js';

function generatePermlink(parentPermlink) {
  const timestamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `re-${parentPermlink.slice(0, 40)}-${timestamp}-${rand}`;
}

export function initCommentComposer() {
  Alpine.data('commentComposer', (opts = {}) => ({
    parentAuthor: opts.parentAuthor || '',
    parentPermlink: opts.parentPermlink || '',
    body: '',
    isSubmitting: false,
    error: null,

    get isConnected() { return Alpine.store('auth').isConnected; },
    get isAccredited() { return Alpine.store('auth').isAccredited; },
    get username() { return Alpine.store('auth').username; },

    async handleSubmit() {
      const trimmed = this.body.trim();
      if (!trimmed || !this.username) return;

      this.isSubmitting = true;
      this.error = null;

      try {
        const permlink = generatePermlink(this.parentPermlink);
        await postComment(this.username, permlink, this.parentAuthor, this.parentPermlink, trimmed);
        this.body = '';
        // Dispatch event so parent can refresh
        this.$dispatch('comment-posted', { parentPermlink: this.parentPermlink });
      } catch (err) {
        this.error = err.message || this.$t('comments.postFailed');
      } finally {
        this.isSubmitting = false;
      }
    },
  }));
}

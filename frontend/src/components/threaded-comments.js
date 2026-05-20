import Alpine from 'alpinejs';
import { fetchPaperComments, isRetriable503 } from '../api.js';
import { renderMarkdown } from './markdown-renderer.js';

function formatTimeAgo(iso, t) {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return t('time.minutesShort', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursShort', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('time.daysShort', { count: days });
  return new Date(iso).toLocaleDateString();
}

function countComments(comments) {
  let count = 0;
  for (const c of comments) {
    count += 1 + countComments(c.replies || []);
  }
  return count;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return String(text).replace(/[&"'<>`]/g, (ch) => ({
    '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;', '`': '&#96;',
  }[ch]));
}

function renderCommentTree(comments, depth, t) {
  if (!comments || comments.length === 0) return '';

  return comments.map((comment) => {
    const depthClass = depth > 0 ? 'border-l-2 border-parchment-dark pl-2 sm:pl-4' : '';
    const bodyHtml = renderMarkdown(comment.body || '');
    const repliesHtml = renderCommentTree(comment.replies || [], depth + 1, t);
    const safeAuthor = escapeAttr(comment.author);
    const safePermlink = escapeAttr(comment.permlink);
    const commentId = `comment-${safeAuthor}-${safePermlink}`;

    return `
      <div class="${depthClass}" id="${commentId}">
        <div class="flex items-center gap-2 text-xs text-ink-muted">
          <button class="text-ink-muted hover:text-ink font-mono text-xs"
                  @click="toggleCollapse('${commentId}')"
                  x-text="collapsed['${commentId}'] ? '[+]' : '[-]'">[-]</button>
          <a :href="$lp('/profile/${safeAuthor}')"
             @click.prevent="navigate('/profile/${safeAuthor}')"
             class="font-medium text-ink no-underline hover:text-pevo-teal">@${escapeHtml(comment.author)}</a>
          <time datetime="${escapeAttr(comment.created)}">${escapeHtml(formatTimeAgo(comment.created, t))}</time>
        </div>
        <div x-show="!collapsed['${commentId}']">
          <div class="mt-1 text-sm text-ink-light leading-relaxed prose prose-sm max-w-none">${bodyHtml}</div>
          <div class="flex items-center gap-3 mt-1.5">
            <div x-data="voteButtons({ author: '${safeAuthor}', permlink: '${safePermlink}', netVotes: ${Number(comment.net_votes) || 0} })">
              <div class="flex items-center gap-1">
                <button class="p-1 rounded transition-colors disabled:opacity-50"
                        :class="voteState === 'up' ? 'text-pevo-green' : 'text-ink-muted hover:text-pevo-green'"
                        @click="handleVote(10000)" :disabled="isVoting" :title="$t('vote.upvote')">
                  <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3l-7 7h4v7h6v-7h4L10 3z" /></svg>
                </button>
                <span class="text-sm font-medium text-ink min-w-[1.5rem] text-center" x-text="displayVotes"></span>
                <button class="p-1 rounded transition-colors disabled:opacity-50"
                        :class="voteState === 'down' ? 'text-pevo-crimson' : 'text-ink-muted hover:text-pevo-crimson'"
                        @click="handleVote(-10000)" :disabled="isVoting" :title="$t('vote.downvote')">
                  <svg class="h-4 w-4 rotate-180" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3l-7 7h4v7h6v-7h4L10 3z" /></svg>
                </button>
              </div>
            </div>
            <template x-if="$store.auth.isConnected">
              <button class="text-xs text-ink-muted hover:text-pevo-teal transition-colors"
                      @click="toggleReply('${commentId}')"
                      x-text="$t('comments.reply')"></button>
            </template>
          </div>
          <div x-show="replyOpen['${commentId}']" class="mt-2">
            <div x-data="commentComposer({ parentAuthor: '${safeAuthor}', parentPermlink: '${safePermlink}' })"
                 x-on:comment-posted.window="if ($event.detail.parentPermlink === '${safePermlink}') { replyOpen['${commentId}'] = false; loadComments(); }">
              <textarea class="w-full rounded-md border border-parchment-dark bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-pevo-teal focus:outline-none focus:ring-1 focus:ring-pevo-teal resize-y"
                        rows="2" :placeholder="$t('comments.replyTo', { author: '${safeAuthor}' })"
                        x-model="body" :disabled="isSubmitting"></textarea>
              <p x-show="error" class="text-xs text-pevo-crimson mt-1" x-text="error"></p>
              <div class="flex items-center justify-end gap-2 mt-2">
                <button class="btn-secondary text-xs" @click="replyOpen['${commentId}'] = false" :disabled="isSubmitting" x-text="$t('common.cancel')"></button>
                <button class="btn-primary text-xs" @click="handleSubmit()" :disabled="isSubmitting || !body.trim()"
                        x-text="isSubmitting ? $t('comments.posting') : $t('comments.postComment')"></button>
              </div>
            </div>
          </div>
          ${repliesHtml ? `<div class="mt-3 space-y-3">${repliesHtml}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

export function initThreadedComments() {
  Alpine.data('threadedComments', (opts = {}) => ({
    paperAuthor: opts.paperAuthor || '',
    paperPermlink: opts.paperPermlink || '',
    comments: [],
    loading: true,
    error: null,
    // Discriminator on 503 SERVICE_UNAVAILABLE + details.retriable so the
    // template can render a Retry button instead of a generic error string.
    errorRetriable: false,
    // In-flight guard distinct from the user-visible `loading` flag, which
    // starts true to drive the initial skeleton render. Using `loading` as
    // the guard would block the first call from init() since it's already
    // true at the entry-check.
    _loadInFlight: false,
    totalCount: 0,
    collapsed: {},
    replyOpen: {},

    navigate(path) { Alpine.store('router').navigate(path); },

    init() {
      this.loadComments();
    },

    async loadComments() {
      // Synchronous in-flight guard before the first await so re-entry from
      // retry-button clicks plus the `comment-posted` window listener cannot
      // produce overlapping fetches whose catch arms clobber state.
      if (this._loadInFlight) return;
      this._loadInFlight = true;
      this.loading = true;
      this.error = null;
      this.errorRetriable = false;
      try {
        const res = await fetchPaperComments(this.paperAuthor, this.paperPermlink);
        this.comments = res.data || [];
        this.totalCount = countComments(this.comments);
      } catch (err) {
        if (isRetriable503(err)) {
          this.error = this.$t('comments.serviceUnavailable');
          this.errorRetriable = true;
        } else {
          this.error = this.$t('comments.error');
        }
        this.comments = [];
      } finally {
        this.loading = false;
        this._loadInFlight = false;
      }
    },

    toggleCollapse(id) {
      this.collapsed[id] = !this.collapsed[id];
    },

    toggleReply(id) {
      this.replyOpen[id] = !this.replyOpen[id];
    },

    get commentsHtml() {
      if (!this.comments || this.comments.length === 0) return '';
      const t = (key) => this.$t(key);
      return this.comments.map((comment) => {
        const inner = renderCommentTree([comment], 0, t);
        return `<div class="card">${inner}</div>`;
      }).join('');
    },
  }));
}

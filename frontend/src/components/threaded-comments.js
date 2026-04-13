import Alpine from 'alpinejs';
import { fetchPaperComments } from '../api.js';
import { renderMarkdown } from './markdown-renderer.js';

function formatTimeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
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

function renderCommentTree(comments, depth, t) {
  if (!comments || comments.length === 0) return '';

  return comments.map((comment) => {
    const depthClass = depth > 0 ? 'border-l-2 border-parchment-dark pl-2 sm:pl-4' : '';
    const accreditedBadge = comment.is_accredited
      ? `<span class="badge-accredited text-[10px]" title="${escapeHtml(t('badge.accreditedTitle'))}">
           <svg class="mr-0.5 h-2.5 w-2.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
             <path fill-rule="evenodd" d="M16.403 12.652a3 3 0 010-5.304 3 3 0 00-3.75-3.751 3 3 0 00-5.305 0 3 3 0 00-3.751 3.75 3 3 0 000 5.305 3 3 0 003.75 3.751 3 3 0 005.305 0 3 3 0 003.751-3.75zm-2.546-4.46a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" />
           </svg>
           ${escapeHtml(t('badge.accredited'))}
         </span>`
      : '';

    const bodyHtml = renderMarkdown(comment.body || '');
    const repliesHtml = renderCommentTree(comment.replies || [], depth + 1, t);
    const commentId = `comment-${comment.author}-${comment.permlink}`;

    return `
      <div class="${depthClass}" id="${commentId}">
        <div class="flex items-center gap-2 text-xs text-ink-muted">
          <button class="text-ink-muted hover:text-ink font-mono text-xs"
                  @click="toggleCollapse('${commentId}')"
                  x-text="collapsed['${commentId}'] ? '[+]' : '[-]'">[-]</button>
          <a :href="$lp('/profile/${comment.author}')"
             @click.prevent="navigate('/profile/${comment.author}')"
             class="font-medium text-ink no-underline hover:text-pevo-teal">@${comment.author}</a>
          ${accreditedBadge}
          <time datetime="${comment.created}">${formatTimeAgo(comment.created)}</time>
        </div>
        <div x-show="!collapsed['${commentId}']">
          <div class="mt-1 text-sm text-ink-light leading-relaxed prose prose-sm max-w-none">${bodyHtml}</div>
          <div class="flex items-center gap-3 mt-1.5">
            <div x-data="voteButtons({ author: '${comment.author}', permlink: '${comment.permlink}', netVotes: ${comment.net_votes ?? 0} })">
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
            <div x-data="commentComposer({ parentAuthor: '${comment.author}', parentPermlink: '${comment.permlink}' })"
                 x-on:comment-posted.window="if ($event.detail.parentPermlink === '${comment.permlink}') { replyOpen['${commentId}'] = false; loadComments(); }">
              <textarea class="w-full rounded-md border border-parchment-dark bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-pevo-teal focus:outline-none focus:ring-1 focus:ring-pevo-teal resize-y"
                        rows="2" :placeholder="$t('comments.replyTo', { author: '${comment.author}' })"
                        x-model="body" :disabled="isSubmitting"></textarea>
              <p x-show="error" class="text-xs text-pevo-crimson mt-1" x-text="error"></p>
              <div class="flex items-center justify-end gap-2 mt-2">
                <button class="btn-secondary text-xs" @click="replyOpen['${commentId}'] = false" :disabled="isSubmitting" x-text="$t('comments.cancel')"></button>
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
    totalCount: 0,
    collapsed: {},
    replyOpen: {},

    navigate(path) { Alpine.store('router').navigate(path); },

    init() {
      this.loadComments();
    },

    async loadComments() {
      this.loading = true;
      this.error = null;
      try {
        const res = await fetchPaperComments(this.paperAuthor, this.paperPermlink);
        this.comments = res.data || [];
        this.totalCount = countComments(this.comments);
      } catch {
        this.error = this.$t('comments.error');
        this.comments = [];
      } finally {
        this.loading = false;
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

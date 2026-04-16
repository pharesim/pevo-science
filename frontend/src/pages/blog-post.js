import Alpine from 'alpinejs';
import { fetchBlogPost } from '../api.js';
import { formatDate } from '../components/paper-card.js';

const template = `
      <div x-data="blogPostPage" class="container-narrow py-8">
        <!-- Loading -->
        <template x-if="loading">
          <div class="card animate-pulse">
            <div class="h-8 bg-parchment-warm rounded w-3/4 mb-4"></div>
            <div class="h-4 bg-parchment-warm rounded w-24 mb-6"></div>
            <div class="space-y-2">
              <div class="h-4 bg-parchment-warm rounded w-full"></div>
              <div class="h-4 bg-parchment-warm rounded w-full"></div>
              <div class="h-4 bg-parchment-warm rounded w-5/6"></div>
            </div>
          </div>
        </template>

        <!-- Error -->
        <template x-if="!loading && error">
          <div class="card text-center py-12">
            <p class="text-ink-muted mb-4" x-text="error"></p>
            <a :href="$lp('/blog')" @click.prevent="navigate('/blog')" class="btn-primary" x-text="$t('blog.backToBlog')"></a>
          </div>
        </template>

        <!-- Post content -->
        <template x-if="!loading && !error && post">
          <article>
            <a :href="$lp('/blog')" @click.prevent="navigate('/blog')"
               class="inline-flex items-center text-sm text-ink-muted hover:text-pevo-teal mb-6">
              <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
              </svg>
              <span x-text="$t('blog.backToBlog')"></span>
            </a>
            <h1 class="text-3xl font-bold text-ink mb-3" x-text="post.title"></h1>
            <div class="flex items-center gap-3 text-sm text-ink-muted mb-8">
              <time :datetime="post.created" x-text="formatDate(post.created)"></time>
              <template x-if="post.tags.length > 1">
                <div class="flex flex-wrap gap-1.5">
                  <template x-for="tag in post.tags.slice(1, 4)" :key="tag">
                    <span class="px-2 py-0.5 rounded-full bg-parchment-warm text-ink-muted text-xs" x-text="tag"></span>
                  </template>
                </div>
              </template>
            </div>
            <div class="prose prose-ink max-w-none" x-markdown="post.body"></div>
          </article>
        </template>
      </div>
`;

export { template as blogPostPageTemplate };

export function initBlogPostPage() {
  Alpine.data('blogPostPage', () => ({
    post: null,
    loading: true,
    error: null,

    formatDate,

    init() {
      this.loadPost();
    },

    async loadPost() {
      this.loading = true;
      this.error = null;
      try {
        const permlink = this.$store.router.params.permlink;
        const res = await fetchBlogPost(permlink);
        this.post = res.data || null;
        if (this.post) {
          document.title = `${this.post.title} — PEvO Blog`;
        }
      } catch {
        this.error = this.$t('blog.errorLoading');
      } finally {
        this.loading = false;
      }
    },

    navigate(path) {
      this.$store.router.navigate(path);
    },
  }));
}

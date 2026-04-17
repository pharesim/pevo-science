import Alpine from 'alpinejs';
import { fetchBlogPosts } from '../api.js';
import { formatDate } from '../components/paper-card.js';

const template = `
      <div x-data="blogPage" class="container-narrow py-8">
        <h1 class="text-3xl font-bold text-ink mb-2" x-text="$t('blog.title')"></h1>
        <p class="text-ink-muted mb-8" x-text="$t('blog.description')"></p>

        <!-- Loading -->
        <template x-if="loading">
          <div class="space-y-4">
            <template x-for="i in 3" :key="i">
              <div class="card animate-pulse">
                <div class="h-4 bg-parchment-warm rounded w-24 mb-3"></div>
                <div class="h-6 bg-parchment-warm rounded w-3/4 mb-2"></div>
                <div class="h-4 bg-parchment-warm rounded w-full mb-2"></div>
                <div class="h-4 bg-parchment-warm rounded w-5/6"></div>
              </div>
            </template>
          </div>
        </template>

        <!-- Error -->
        <template x-if="!loading && error">
          <div class="card text-center py-12">
            <p class="text-ink-muted mb-4" x-text="error"></p>
            <button class="btn-primary" @click="loadPosts()" x-text="$t('common.retry')"></button>
          </div>
        </template>

        <!-- Empty -->
        <template x-if="!loading && !error && posts.length === 0">
          <div class="card text-center py-12">
            <p class="text-ink-muted" x-text="$t('blog.noPosts')"></p>
          </div>
        </template>

        <!-- Post list -->
        <template x-if="!loading && !error && posts.length > 0">
          <div class="space-y-6">
            <template x-for="post in posts" :key="post.permlink">
              <article class="card hover:shadow-sm transition-shadow">
                <div class="flex items-center justify-between text-xs text-ink-muted mb-3">
                  <div class="flex flex-wrap gap-1.5">
                    <template x-for="tag in post.tags.slice(1, 4)" :key="tag">
                      <span class="px-2 py-0.5 rounded-full bg-parchment-warm text-ink-muted" x-text="tag"></span>
                    </template>
                  </div>
                  <time :datetime="post.created" x-text="formatDate(post.created)"></time>
                </div>
                <h2 class="text-xl font-semibold leading-snug mb-2">
                  <a :href="$lp('/blog/' + post.permlink)"
                     @click.prevent="navigate('/blog/' + post.permlink)"
                     class="text-ink hover:text-pevo-teal no-underline" x-text="post.title"></a>
                </h2>
                <p class="text-sm text-ink-muted leading-relaxed" x-text="truncateBody(post.body)"></p>
              </article>
            </template>
          </div>
        </template>
      </div>
`;

export { template as blogPageTemplate };

export function initBlogPage() {
  Alpine.data('blogPage', () => ({
    posts: [],
    loading: true,
    error: null,

    formatDate,

    init() {
      this.loadPosts();
    },

    async loadPosts() {
      this.loading = true;
      this.error = null;
      try {
        const res = await fetchBlogPosts({ limit: 20 });
        this.posts = res.data || [];
      } catch {
        this.error = this.$t('blog.errorLoading');
      } finally {
        this.loading = false;
      }
    },

    truncateBody(body, maxLength = 300) {
      if (!body || body.length <= maxLength) return body || '';
      // Strip markdown images and links for preview
      const plain = body
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/#{1,6}\s*/g, '')
        .replace(/[*_~`]/g, '')
        .trim();
      if (plain.length <= maxLength) return plain;
      return plain.slice(0, maxLength).replace(/\s+\S*$/, '') + '...';
    },

    navigate(path) {
      this.$store.router.navigate(path);
    },
  }));
}

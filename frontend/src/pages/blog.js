import Alpine from 'alpinejs';
import { fetchBlogPosts, fetchBlogPost } from '../api.js';
import { formatDate } from '../components/paper-card.js';

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

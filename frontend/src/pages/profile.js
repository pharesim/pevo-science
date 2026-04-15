import Alpine from 'alpinejs';
import { fetchProfile, fetchProfilePapers, fetchProfileReviews } from '../api.js';
import { truncateText, formatDate } from '../components/paper-card.js';

export function initProfilePage() {
  Alpine.data('profilePage', () => ({
    profile: null,
    userPapers: [],
    userReviews: [],
    reviewsLoaded: false,
    reviewsLoading: false,
    activeTab: 'publications',
    loading: true,
    error: null,

    truncateText,
    formatDate,

    get username() {
      return this.$store.router.params.username;
    },

    init() {
      this.loadProfile();
    },

    async loadProfile() {
      const username = this.username;
      this.loading = true;
      this.error = null;
      try {
        const [profileRes, papersRes] = await Promise.all([
          fetchProfile(username),
          fetchProfilePapers(username).catch(() => ({ data: [] })),
        ]);
        if (this.username !== username) return;
        this.profile = profileRes.data;
        this.userPapers = papersRes.data || [];
        if (username) document.title = `${username} — PEvO`;
      } catch (err) {
        if (this.username !== username) return;
        this.error = err?.message || this.$t('profile.loadFailed');
      } finally {
        this.loading = false;
      }
    },

    get maxBreakdownValue() {
      if (!this.profile?.reputation?.breakdown) return 1;
      return Math.max(...Object.values(this.profile.reputation.breakdown), 1);
    },

    get breakdownEntries() {
      if (!this.profile?.reputation?.breakdown) return [];
      const deprecated = ['paper_votes', 'review_votes', 'account_age'];
      return Object.entries(this.profile.reputation.breakdown)
        .filter(([key]) => !deprecated.includes(key));
    },

    breakdownPct(value) {
      return this.maxBreakdownValue > 0 ? (value / this.maxBreakdownValue) * 100 : 0;
    },

    switchTab(tab) {
      this.activeTab = tab;
      if (tab === 'reviews' && !this.reviewsLoaded) {
        this.loadReviews();
      }
    },

    async loadReviews() {
      const username = this.username;
      this.reviewsLoading = true;
      try {
        const res = await fetchProfileReviews(username);
        if (this.username !== username) return;
        this.userReviews = res.data || [];
        this.reviewsLoaded = true;
      } catch (err) {
        if (this.username !== username) return;
        this.userReviews = [];
        this.reviewsLoaded = true;
      } finally {
        this.reviewsLoading = false;
      }
    },

    ratingLabel(key) {
      return this.$t('profile.rating.' + key) || key.charAt(0).toUpperCase() + key.slice(1);
    },

    navigate(path) {
      this.$store.router.navigate(path);
    },
  }));
}

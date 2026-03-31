import Alpine from 'alpinejs';
import { fetchProfile, fetchProfilePapers } from '../api.js';
import { truncateText, formatDate } from '../components/paper-card.js';

export function initProfilePage() {
  Alpine.data('profilePage', () => ({
    profile: null,
    userPapers: [],
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
      this.loading = true;
      this.error = null;
      try {
        const [profileRes, papersRes] = await Promise.all([
          fetchProfile(this.username),
          fetchProfilePapers(this.username).catch(() => ({ data: [] })),
        ]);
        this.profile = profileRes.data;
        this.userPapers = papersRes.data || [];
      } catch (err) {
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
      return Object.entries(this.profile.reputation.breakdown);
    },

    breakdownPct(value) {
      return this.maxBreakdownValue > 0 ? (value / this.maxBreakdownValue) * 100 : 0;
    },

    navigate(path) {
      this.$store.router.navigate(path);
    },
  }));
}

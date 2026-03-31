import Alpine from 'alpinejs';
import { fetchPlatformStats } from '../api.js';

export function initStatsPage() {
  Alpine.data('statsPage', () => ({
    stats: null,
    loading: true,
    error: null,

    get statCards() {
      if (!this.stats) return [];
      return [
        { key: 'total_papers', label: this.$t('stats.totalPapers') },
        { key: 'total_reviews', label: this.$t('stats.totalReviews') },
        { key: 'total_accredited_researchers', label: this.$t('stats.accreditedResearchers') },
        { key: 'total_citations', label: this.$t('stats.totalCitations') },
        { key: 'active_disciplines', label: this.$t('stats.activeDisciplines') },
        { key: 'total_bridge_papers', label: this.$t('stats.totalBridgePapers') },
        { key: 'papers_last_30_days', label: this.$t('stats.papersLast30') },
        { key: 'reviews_last_30_days', label: this.$t('stats.reviewsLast30') },
      ];
    },

    statValue(key) {
      if (!this.stats || this.stats[key] === undefined) return 0;
      return Number(this.stats[key]).toLocaleString();
    },

    init() {
      this.loadStats();
    },

    async loadStats() {
      this.loading = true;
      this.error = null;
      try {
        const res = await fetchPlatformStats();
        this.stats = res.data;
      } catch (err) {
        this.error = err?.message || this.$t('stats.loadFailed');
      } finally {
        this.loading = false;
      }
    },
  }));
}

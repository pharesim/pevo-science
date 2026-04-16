import Alpine from 'alpinejs';
import { fetchPlatformStats } from '../api.js';

const template = `
      <div x-data="statsPage" class="container-narrow py-8">
        <h1 class="text-3xl font-bold text-ink font-serif mb-2" x-text="$t('stats.title')"></h1>
        <p class="text-ink-muted mb-6" x-text="$t('stats.description')"></p>

        <!-- Loading -->
        <template x-if="loading">
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <template x-for="i in 8" :key="i">
              <div class="card text-center animate-pulse">
                <div class="h-10 bg-parchment-warm rounded w-20 mx-auto mb-2"></div>
                <div class="h-4 bg-parchment-warm rounded w-32 mx-auto"></div>
              </div>
            </template>
          </div>
        </template>

        <!-- Error -->
        <template x-if="!loading && error">
          <div class="card text-center py-12">
            <p class="text-ink-muted mb-4" x-text="error"></p>
            <button class="btn-primary" @click="loadStats()" x-text="$t('common.retry')"></button>
          </div>
        </template>

        <!-- Stats grid -->
        <template x-if="!loading && !error && stats">
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <template x-for="card in statCards" :key="card.key">
              <div class="card text-center">
                <div class="text-4xl font-bold text-ink font-serif" x-text="statValue(card.key)"></div>
                <div class="text-sm text-ink-muted mt-2" x-text="card.label"></div>
              </div>
            </template>
          </div>
        </template>
      </div>
`;

export { template as statsPageTemplate };

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

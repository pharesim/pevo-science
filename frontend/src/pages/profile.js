import Alpine from 'alpinejs';
import { fetchProfile, fetchProfilePapers, fetchProfileReviews } from '../api.js';
import { truncateText, formatDate } from '../components/paper-card.js';

const template = `
      <div x-data="profilePage" class="container-narrow py-8">
        <!-- Loading -->
        <template x-if="loading">
          <div class="card animate-pulse">
            <div class="h-8 bg-parchment-warm rounded w-48 mb-3"></div>
            <div class="h-4 bg-parchment-warm rounded w-32 mb-2"></div>
            <div class="h-4 bg-parchment-warm rounded w-64"></div>
          </div>
        </template>

        <!-- Error -->
        <template x-if="!loading && error">
          <div class="card text-center py-12">
            <h1 class="text-2xl font-bold text-ink mb-2" x-text="$t('profile.notFoundTitle')"></h1>
            <p class="text-ink-muted mb-4" x-text="error"></p>
            <a :href="$lp('/')" @click.prevent="navigate('/')" class="btn-primary no-underline" x-text="$t('common.backToPapers')"></a>
          </div>
        </template>

        <!-- Profile loaded -->
        <template x-if="!loading && !error && profile">
          <div>
            <!-- Profile header -->
            <div class="card mb-6">
              <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div>
                  <div class="flex items-center gap-3 mb-2">
                    <h1 class="text-2xl font-bold text-ink" x-text="profile.accreditation?.name ?? ('@' + profile.username)"></h1>
                    <template x-if="profile.is_accredited">
                      <span class="badge-accredited" :title="$t('badge.accreditedTitle')">
                        <svg class="mr-1 h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                          <path fill-rule="evenodd" d="M16.403 12.652a3 3 0 010-5.304 3 3 0 00-3.75-3.751 3 3 0 00-5.305 0 3 3 0 00-3.751 3.75 3 3 0 000 5.305 3 3 0 003.75 3.751 3 3 0 005.305 0 3 3 0 003.751-3.75zm-2.546-4.46a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" />
                        </svg>
                        <span x-text="$t('badge.accredited')"></span>
                      </span>
                    </template>
                  </div>
                  <p class="text-sm text-ink-muted" x-text="'@' + profile.username"></p>
                  <template x-if="profile.accreditation">
                    <div class="mt-2 text-sm text-ink-light">
                      <p x-text="profile.accreditation.institution"></p>
                      <p class="capitalize" x-text="profile.accreditation.field"></p>
                    </div>
                  </template>
                </div>
                <!-- Reputation score -->
                <div class="text-center sm:text-right">
                  <div class="text-4xl font-bold text-ink font-serif" x-text="profile.reputation?.score ?? 0"></div>
                  <div class="text-xs text-ink-muted mt-1" x-text="$t('profile.reputationScore')"></div>
                </div>
              </div>
              <template x-if="profile.accreditation">
                <div class="mt-4 pt-4 border-t border-parchment-dark text-xs text-ink-muted flex items-center gap-2 flex-wrap">
                  <span x-text="$t('profile.accreditedVia', { method: profile.accreditation.method, date: formatDate(profile.accreditation.timestamp) })"></span>
                  <template x-if="profile.accreditation.field">
                    <span> -- field: <span class="capitalize" x-text="profile.accreditation.field"></span></span>
                  </template>
                </div>
              </template>
            </div>

            <!-- Stats + Reputation breakdown -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
              <!-- Quick stats -->
              <div class="card">
                <h2 class="text-section-title text-ink font-serif mb-4" x-text="$t('profile.activity')"></h2>
                <div class="grid grid-cols-3 gap-2 sm:gap-4">
                  <div class="text-center">
                    <div class="text-2xl font-bold text-ink font-serif" x-text="profile.stats?.paper_count ?? 0"></div>
                    <div class="text-xs text-ink-muted mt-1" x-text="$t('profile.papers')"></div>
                  </div>
                  <div class="text-center">
                    <div class="text-2xl font-bold text-ink font-serif" x-text="profile.stats?.review_count ?? 0"></div>
                    <div class="text-xs text-ink-muted mt-1" x-text="$t('profile.reviews')"></div>
                  </div>
                  <div class="text-center">
                    <div class="text-2xl font-bold text-ink font-serif" x-text="profile.stats?.citation_count ?? 0"></div>
                    <div class="text-xs text-ink-muted mt-1" x-text="$t('profile.citationsLabel')"></div>
                  </div>
                </div>
                <template x-if="profile.stats?.first_pevo_post">
                  <div class="mt-4 pt-3 border-t border-parchment-dark text-xs text-ink-muted" x-text="$t('profile.firstPost', { date: formatDate(profile.stats.first_pevo_post) })"></div>
                </template>
              </div>

              <!-- Reputation breakdown -->
              <div class="card">
                <h2 class="text-section-title text-ink font-serif mb-4" x-text="$t('profile.reputationBreakdown')"></h2>
                <div class="space-y-2">
                  <template x-for="[key, value] in breakdownEntries" :key="key">
                    <div class="flex items-center gap-2 sm:gap-3 text-sm">
                      <span class="w-20 sm:w-28 text-ink-muted shrink-0 capitalize text-xs sm:text-sm" x-text="$t('profile.breakdown.' + key) || key.replace(/_/g, ' ')"></span>
                      <div class="flex-1 h-2 bg-parchment-warm rounded-full overflow-hidden">
                        <div class="h-full bg-pevo-teal rounded-full" :style="\`width: \${breakdownPct(value)}%\`"></div>
                      </div>
                      <span class="w-8 text-right font-medium text-ink" x-text="value"></span>
                    </div>
                  </template>
                </div>
              </div>
            </div>

            <!-- Web of Trust vouching -->
            <template x-if="!profile.is_accredited && profile.username !== $store.auth.username">
              <div x-data="vouchSection({ targetUsername: profile.username, isTargetAccredited: profile.is_accredited })" class="card mb-8">
                <h2 class="text-section-title text-ink font-serif mb-4" x-text="$t('wot.title')"></h2>

                <!-- Vouch count progress -->
                <div class="flex items-center gap-3 mb-4">
                  <div class="flex-1 h-2 bg-parchment-warm rounded-full overflow-hidden">
                    <div class="h-full bg-pevo-teal rounded-full transition-all" :style="\`width: \${Math.min(100, ((vouchStatus?.vouch_count ?? 0) / (vouchStatus?.threshold ?? 3)) * 100)}%\`"></div>
                  </div>
                  <span class="text-sm text-ink-muted whitespace-nowrap" x-text="$t('wot.vouches', { count: vouchStatus?.vouch_count ?? 0, threshold: vouchStatus?.threshold ?? 3 })"></span>
                </div>

                <!-- Existing vouchers -->
                <template x-if="vouchStatus?.vouches?.length > 0">
                  <div class="mb-4">
                    <p class="text-xs font-medium text-ink-muted mb-2" x-text="$t('wot.vouchedBy')"></p>
                    <div class="flex flex-wrap gap-2">
                      <template x-for="v in vouchStatus.vouches" :key="v.voucher">
                        <a :href="$lp('/profile/' + v.voucher)" @click.prevent="navigate('/profile/' + v.voucher)"
                           class="inline-flex items-center gap-1 px-2 py-1 rounded bg-parchment-warm text-xs text-ink hover:text-pevo-teal no-underline">
                          <span x-text="'@' + v.voucher"></span>
                          <span class="text-ink-muted capitalize" x-text="'(' + relationshipLabel(v.relationship) + ')'"></span>
                        </a>
                      </template>
                    </div>
                  </div>
                </template>

                <!-- Light account message -->
                <template x-if="isConnected && isLightAccount && !currentUserHasVouched">
                  <p class="text-sm text-ink-muted italic" x-text="$t('wot.keychainRequiredToVouch')"></p>
                </template>

                <!-- Not connected -->
                <template x-if="!isConnected">
                  <p class="text-sm text-ink-muted" x-text="$t('wot.connectToVouch')"></p>
                </template>

                <!-- Vouch form -->
                <template x-if="canVouch">
                  <div>
                    <p class="text-sm text-ink-muted mb-3" x-text="$t('wot.vouchPrompt')"></p>
                    <div class="flex flex-wrap items-end gap-3">
                      <div>
                        <label class="text-xs text-ink-muted block mb-1">Relationship</label>
                        <select x-model="relationship" class="input text-sm py-1.5">
                          <option value="colleague" x-text="$t('wot.colleague')"></option>
                          <option value="advisor" x-text="$t('wot.advisor')"></option>
                          <option value="collaborator" x-text="$t('wot.collaborator')"></option>
                        </select>
                      </div>
                      <button @click="handleVouch" :disabled="step === 'signing'" class="btn-primary text-sm">
                        <span x-show="step !== 'signing'" x-text="$t('wot.vouchButton')"></span>
                        <span x-show="step === 'signing'" x-text="$t('wot.signing')"></span>
                      </button>
                    </div>
                  </div>
                </template>

                <!-- Retract -->
                <template x-if="canRetract">
                  <div>
                    <template x-if="!showRetract">
                      <button @click="showRetract = true" class="text-sm text-pevo-crimson hover:underline" x-text="$t('wot.retractVouch')"></button>
                    </template>
                    <template x-if="showRetract">
                      <div class="mt-2 p-3 bg-red-50 rounded border border-red-200">
                        <p class="text-sm text-ink mb-2" x-text="$t('wot.retractConfirm')"></p>
                        <input type="text" x-model="retractReason" :placeholder="$t('wot.retractReasonPlaceholder')" class="input text-sm mb-2 w-full" />
                        <div class="flex gap-2">
                          <button @click="handleRetract" :disabled="step === 'signing'" class="btn-danger text-sm" x-text="$t('wot.confirmRetract')"></button>
                          <button @click="showRetract = false" class="btn-secondary text-sm" x-text="$t('wot.cancel')"></button>
                        </div>
                      </div>
                    </template>
                  </div>
                </template>

                <!-- Status messages -->
                <template x-if="message">
                  <p class="mt-3 text-sm" :class="step === 'error' ? 'text-pevo-crimson' : 'text-pevo-green'" x-text="message"></p>
                </template>
              </div>
            </template>

            <!-- Publications / Reviews tabs -->
            <section>
              <div class="flex border-b border-parchment-dark mb-4">
                <button @click="switchTab('publications')"
                        :class="activeTab === 'publications' ? 'border-pevo-teal text-ink font-semibold' : 'border-transparent text-ink-muted hover:text-ink'"
                        class="px-4 py-2 text-sm font-serif border-b-2 -mb-px transition-colors" x-text="$t('profile.tabPublications')"></button>
                <button @click="switchTab('reviews')"
                        :class="activeTab === 'reviews' ? 'border-pevo-teal text-ink font-semibold' : 'border-transparent text-ink-muted hover:text-ink'"
                        class="px-4 py-2 text-sm font-serif border-b-2 -mb-px transition-colors" x-text="$t('profile.tabReviews')"></button>
              </div>

              <!-- Publications tab -->
              <template x-if="activeTab === 'publications'">
                <div>
                  <template x-if="userPapers.length > 0">
                    <div class="space-y-4">
                      <template x-for="paper in userPapers" :key="paper.author + '/' + paper.permlink">
                        <article class="card hover:shadow-sm transition-shadow">
                          <div class="flex items-center justify-between text-xs text-ink-muted mb-3">
                            <div class="flex items-center gap-2">
                              <span class="badge-discipline capitalize" x-text="paper.discipline"></span>
                              <template x-if="paper.source_type && paper.source_type !== 'native'">
                                <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-pevo-teal-light text-pevo-teal-dark border border-pevo-teal/20"
                                      x-text="paper.source_type === 'arxiv' ? 'arXiv' : 'DOI'"></span>
                              </template>
                            </div>
                            <time :datetime="paper.created" x-text="formatDate(paper.created)"></time>
                          </div>
                          <h3 class="text-paper-title leading-snug mb-2">
                            <a :href="$lp('/paper/' + paper.author + '/' + paper.permlink)"
                               @click.prevent="navigate('/paper/' + paper.author + '/' + paper.permlink)"
                               class="text-ink hover:text-pevo-teal no-underline" x-text="paper.title"></a>
                          </h3>
                          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 mb-3">
                            <p class="text-sm text-ink-light" x-text="paper.authors.map(a => a.name).join(', ')"></p>
                          </div>
                          <p class="text-sm text-ink-muted leading-relaxed mb-4" x-text="truncateText(paper.abstract)"></p>
                          <div class="flex items-center gap-5 text-xs text-ink-muted pt-3 border-t border-parchment-dark">
                            <span class="flex items-center gap-1">
                              <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zm-5 0H8v2h2V9z" clip-rule="evenodd" /></svg>
                              <span x-text="paper.review_count ?? 0"></span>
                            </span>
                          </div>
                        </article>
                      </template>
                    </div>
                  </template>
                  <template x-if="userPapers.length === 0">
                    <div class="card text-center py-8">
                      <p class="text-ink-muted" x-text="$t('profile.noPapers')"></p>
                    </div>
                  </template>
                </div>
              </template>

              <!-- Reviews tab -->
              <template x-if="activeTab === 'reviews'">
                <div>
                  <template x-if="reviewsLoading">
                    <div class="card animate-pulse">
                      <div class="h-4 bg-parchment-warm rounded w-3/4 mb-3"></div>
                      <div class="h-3 bg-parchment-warm rounded w-1/2 mb-2"></div>
                      <div class="h-3 bg-parchment-warm rounded w-full"></div>
                    </div>
                  </template>
                  <template x-if="!reviewsLoading && userReviews.length > 0">
                    <div class="space-y-4">
                      <template x-for="review in userReviews" :key="review.author + '/' + review.permlink">
                        <article class="card hover:shadow-sm transition-shadow">
                          <div class="flex items-center justify-between text-xs text-ink-muted mb-3">
                            <template x-if="review.is_anonymous">
                              <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 text-[10px] font-semibold uppercase tracking-wide border border-amber-200" x-text="$t('profile.anonymousReview')"></span>
                            </template>
                            <time :datetime="review.created" x-text="formatDate(review.created)"></time>
                          </div>
                          <h3 class="text-paper-title leading-snug mb-2">
                            <a :href="$lp('/paper/' + review.paper.author + '/' + review.paper.permlink + '#review-' + review.author.replace(/[\/.]/g, '-') + '-' + review.permlink.replace(/[\/.]/g, '-'))"
                               @click.prevent="navigate('/paper/' + review.paper.author + '/' + review.paper.permlink + '#review-' + review.author.replace(/[\/.]/g, '-') + '-' + review.permlink.replace(/[\/.]/g, '-'))"
                               class="text-ink hover:text-pevo-teal no-underline" x-text="review.paper.title"></a>
                          </h3>
                          <template x-if="review.rating">
                            <div class="flex flex-wrap gap-3 text-xs text-ink-muted mb-3">
                              <template x-for="[key, val] in Object.entries(review.rating)" :key="key">
                                <span class="inline-flex items-center gap-1">
                                  <span class="capitalize" x-text="ratingLabel(key)"></span>
                                  <span class="font-semibold text-ink" x-text="val + '/5'"></span>
                                </span>
                              </template>
                            </div>
                          </template>
                          <p class="text-sm text-ink-muted leading-relaxed" x-text="truncateText(review.body, 200)"></p>
                        </article>
                      </template>
                    </div>
                  </template>
                  <template x-if="!reviewsLoading && reviewsLoaded && userReviews.length === 0">
                    <div class="card text-center py-8">
                      <p class="text-ink-muted" x-text="$t('profile.noReviews')"></p>
                    </div>
                  </template>
                </div>
              </template>
            </section>
          </div>
        </template>
      </div>`;

export { template as profilePageTemplate };

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

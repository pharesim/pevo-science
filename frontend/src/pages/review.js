import Alpine from 'alpinejs';
import { fetchPaper, submitAnonymousReview } from '../api.js';
import { broadcastWithFreshAuth, FRESH_AUTH_REDIRECT_PENDING } from '../lib/fresh-auth.js';
import { slugify } from '../crypto.js';
import { getAppTag, getAppId } from '../config.js';
import { createTimerGuard } from '../lib/timer-guard.js';
import { accreditationBannerTemplate } from '../components/accreditation-banner.js';

// Gating shape for connected+unaccredited (non-own paper): we render the
// rating form in a disabled, read-only preview alongside the red
// accreditation banner. Banner-only would leave a blank stretch of page
// where the rating bars normally live; an inert preview lets unaccredited
// readers see what reviewing looks like (academic transparency) without
// being able to submit. Matches publish.js's pattern (banner + visible
// form, submit swapped for "Get accredited" CTA). Submit is impossible
// regardless: handleSubmit no-ops without `isAccredited`, and the submit
// slot in the template swaps to a "Get accredited" anchor instead of a
// submit button when the user lacks accreditation.

const template = `
      <div x-data="reviewPage" class="container-narrow py-8">
        <a :href="$lp('/paper/' + author + '/' + permlink)" @click.prevent="navigate('/paper/' + author + '/' + permlink)" class="text-sm text-pevo-teal hover:text-pevo-teal-dark no-underline">&larr; <span x-text="$t('review.backToPaper')"></span></a>

        <h1 class="text-3xl font-bold text-ink mt-4 mb-2" x-text="$t('review.title')"></h1>
        <p class="text-ink-muted mb-2" x-text="$t('review.reviewing')"></p>
        <template x-if="loadingPaper">
          <p class="text-sm text-ink-muted mb-8" x-text="$t('review.loadingPaper')"></p>
        </template>
        <template x-if="!loadingPaper">
          <a :href="$lp('/paper/' + author + '/' + permlink)" @click.prevent="navigate('/paper/' + author + '/' + permlink)" class="text-sm font-medium text-pevo-teal no-underline hover:underline mb-8 block" x-text="paperTitle"></a>
        </template>

        <!-- Not connected warning -->
        <template x-if="!isConnected">
          <div class="card bg-pevo-crimson-light border-pevo-crimson/30 mb-6">
            <div class="flex items-start gap-3">
              <svg class="h-5 w-5 text-pevo-crimson shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" /></svg>
              <div>
                <p class="font-medium text-ink text-sm" x-text="$t('signIn.signInToReview')"></p>
                <p class="text-xs text-ink-muted mt-1" x-text="$t('review.signInHint')"></p>
                <button class="btn-primary text-xs mt-2" @click="handleConnect()" x-text="$t('signIn.signInButton')"></button>
              </div>
            </div>
          </div>
        </template>

        <!-- Not accredited -->
        ${accreditationBannerTemplate('review.accreditationRequired')}

        <!-- Own paper warning -->
        <template x-if="isConnected && isOwnPaper">
          <div class="card bg-pevo-crimson-light border-pevo-crimson/30 mb-6">
            <div class="flex items-start gap-3">
              <svg class="h-5 w-5 text-pevo-crimson shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" /></svg>
              <p class="font-medium text-ink text-sm" x-text="$t('review.cannotReviewOwn')"></p>
            </div>
          </div>
        </template>

        <!-- Progress indicator -->
        <template x-if="step !== 'idle'">
          <div class="card mb-6" :class="stepClass">
            <p class="text-sm font-medium" x-text="stepMessage"></p>
            <template x-if="step === 'error'">
              <button class="btn-secondary text-xs mt-2" @click="step = 'idle'" x-text="$t('common.tryAgain')"></button>
            </template>
          </div>
        </template>

        <template x-if="isConnected && !isOwnPaper">
          <form @submit.prevent="isAccredited ? handleSubmit() : null" class="space-y-6" :class="!isAccredited ? 'opacity-75' : ''">
            <!-- Star ratings -->
            <div class="card">
              <h2 class="text-section-title text-ink font-serif mb-4" x-text="$t('review.ratingsTitle')"></h2>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <template x-for="key in ratingKeys" :key="key">
                  <div class="p-4 bg-parchment rounded-lg">
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-sm font-medium text-ink" x-text="ratingLabel(key)"></span>
                      <span class="text-sm font-bold text-ink" x-text="ratings[key] > 0 ? ratings[key] + '/5' : '--'"></span>
                    </div>
                    <p class="text-xs text-ink-muted mb-2" x-text="ratingDesc(key)"></p>
                    <div class="flex gap-1">
                      <template x-for="star in [1,2,3,4,5]" :key="star">
                        <button type="button" @click="isAccredited && setRating(key, star)" :disabled="!isAccredited"
                                :class="(star <= ratings[key] ? 'text-pevo-teal' : 'text-parchment-dark') + (isAccredited ? ' hover:text-ink-muted' : ' cursor-not-allowed')"
                                class="p-2 rounded transition-colors">
                          <svg class="h-7 w-7 sm:h-6 sm:w-6" viewBox="0 0 20 20" fill="currentColor"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" /></svg>
                        </button>
                      </template>
                    </div>
                  </div>
                </template>
              </div>
            </div>

            <!-- Review body -->
            <div class="card">
              <div class="flex items-center justify-between mb-2">
                <label for="review-body" class="text-sm font-semibold text-ink" x-text="$t('review.writtenReview')"></label>
                <button type="button" class="text-xs text-pevo-teal hover:text-pevo-teal-dark" @click="showPreview = !showPreview" x-text="showPreview ? $t('review.edit') : $t('review.preview')"></button>
              </div>
              <div x-show="showPreview" class="min-h-[200px] p-4 bg-parchment rounded-lg text-sm text-ink-light leading-relaxed whitespace-pre-line" x-text="reviewBody || $t('review.nothingToPreview')"></div>
              <textarea x-show="!showPreview" id="review-body" class="select-control font-mono text-sm min-h-[200px] resize-y" :placeholder="$t('review.reviewPlaceholder')" x-model="reviewBody" :disabled="!isAccredited" :required="isAccredited"></textarea>
            </div>

            <!-- Anonymous option -->
            <div class="card">
              <label class="flex items-start gap-3" :class="isAccredited ? 'cursor-pointer' : 'cursor-not-allowed'">
                <input type="checkbox" class="mt-1 h-4 w-4 rounded border-parchment-dark text-pevo-teal focus:ring-accent" x-model="isAnonymous" :disabled="!isAccredited" />
                <div>
                  <span class="text-sm font-medium text-ink" x-text="$t('review.anonymousLabel')"></span>
                  <p class="text-xs text-ink-muted mt-1" x-text="$t('review.anonymousDescription')"></p>
                </div>
              </label>
            </div>

            <!-- Submit -->
            <div class="flex flex-col-reverse sm:flex-row items-start sm:items-center justify-between gap-3">
              <p class="text-xs text-ink-muted" x-text="$t('review.permanentNotice')"></p>
              <template x-if="isAccredited">
                <button type="submit" class="btn-primary w-full sm:w-auto shrink-0" :disabled="!isConnected || !allRated || isSubmitting"
                        x-text="isSubmitting ? $t('review.submitting') : $t('review.submitButton')"></button>
              </template>
              <template x-if="!isAccredited">
                <a :href="$lp('/accreditation')" @click.prevent="navigate('/accreditation')" class="btn-primary w-full sm:w-auto shrink-0 text-center no-underline" x-text="$t('common.getAccredited')"></a>
              </template>
            </div>
          </form>
        </template>
      </div>
`;

export { template as reviewPageTemplate };

const RATING_KEYS = ['methodology', 'novelty', 'clarity', 'significance'];

export function initReviewPage() {
  Alpine.data('reviewPage', () => ({
    // Post-teardown setTimeout guard. See frontend/src/lib/timer-guard.js.
    ...createTimerGuard(),

    paper: null,
    loadingPaper: true,
    ratings: { methodology: 0, novelty: 0, clarity: 0, significance: 0 },
    reviewBody: '',
    isAnonymous: false,
    showPreview: false,
    step: 'idle',
    errorMessage: '',

    navigate(path) { Alpine.store('router').navigate(path); },
    get isConnected() { return Alpine.store('auth').isConnected; },
    get isAccredited() { return Alpine.store('auth').isAccredited; },
    get username() { return Alpine.store('auth').username; },
    get author() { return Alpine.store('router').params.author || ''; },
    get permlink() { return Alpine.store('router').params.permlink || ''; },

    get isOwnPaper() {
      if (!this.username) return false;
      if (this.username === this.author) return true;
      const authors = this.paper?.authors || this.paper?.json_metadata?.[getAppTag()]?.authors || [];
      return authors.some(a => a.hive === this.username);
    },

    get paperTitle() {
      return this.paper?.title ?? `${this.author}/${this.permlink}`;
    },

    get allRated() {
      return Object.values(this.ratings).every((v) => v > 0);
    },

    get isSubmitting() {
      return this.step !== 'idle' && this.step !== 'success' && this.step !== 'error';
    },

    get stepMessage() {
      if (this.step === 'idle') return '';
      if (this.step === 'submitting') return this.isAnonymous ? this.$t('review.stepSubmittingAnon') : this.$t('review.stepSubmitting');
      if (this.step === 'success') return this.$t('review.stepSuccess');
      if (this.step === 'error') return this.errorMessage || this.$t('common.error');
      return '';
    },

    get stepClass() {
      if (this.step === 'success') return 'bg-pevo-green-light border-pevo-green/30';
      if (this.step === 'error') return 'bg-pevo-crimson-light border-pevo-crimson/30';
      return 'bg-pevo-teal-light border-pevo-teal/30';
    },

    ratingKeys: RATING_KEYS,

    ratingLabel(key) {
      return this.$t(`review.${key}`);
    },

    ratingDesc(key) {
      return this.$t(`review.${key}Desc`);
    },

    setRating(key, value) {
      this.ratings[key] = value;
    },

    init() {
      this.loadPaper();
    },

    destroy() {
      this._teardownTimers();
    },

    async loadPaper() {
      const author = this.author;
      const permlink = this.permlink;
      this.loadingPaper = true;
      try {
        const res = await fetchPaper(author, permlink);
        if (!this._mounted) return;
        if (this.author !== author || this.permlink !== permlink) return;
        this.paper = res.data;
      } catch (err) {
        // Sibling data-fetch methods (edit.js loadPaperData, paper-feed.js
        // loadPapers, vouch-section.js loadVouchStatus) all wrap in try/catch
        // for the same reason: init() calls loadPaper() without await, so a
        // bare rejection would escape as an unhandled promise. Swallow to a
        // console.warn; the template falls through to the not-found branch.
        if (!this._mounted) return;
        if (this.author !== author || this.permlink !== permlink) return;
        console.warn('[review loadPaper]', err);
        this.paper = null;
      } finally {
        // Polarity switch vs the dominant early-exit guard: finally always
        // runs (including post-destroy), so we gate the write itself rather
        // than returning early.
        if (this._mounted && this.author === author && this.permlink === permlink) {
          this.loadingPaper = false;
        }
      }
    },

    async handleConnect() {
      try {
        await Alpine.store('auth').connect();
      } catch (err) {
        if (!this._mounted) return;
        console.warn('[review connect]', err);
        Alpine.store('toast').show(this.$t('common.connectionFailed'), 'error');
      }
    },

    async handleSubmit() {
      const username = this.username;
      if (!username || !this.isConnected || !this.allRated) return;
      // Defense in depth — the template already swaps the submit slot for an
      // accreditation CTA when !isAccredited, but a programmatic form submit
      // (e.g. Enter in textarea) would still fire @submit; gate at the
      // handler level too.
      if (!this.isAccredited) return;

      this.step = 'submitting';
      this.errorMessage = '';

      try {
        if (this.isAnonymous) {
          await submitAnonymousReview({
            paper_author: this.author,
            paper_permlink: this.permlink,
            body: this.reviewBody,
            rating: this.ratings,
          });
          if (!this._mounted) return;
        } else {
          const reviewPermlink = `re-${slugify(this.author)}-${slugify(this.permlink)}-${Date.now().toString(36)}`;
          const APP_TAG = getAppTag();
          const APP_ID = getAppId();

          const jsonMetadata = {
            app: APP_ID,
            tags: [APP_TAG, 'review'],
            [APP_TAG]: {
              type: 'review',
              version: 1,
              rating: this.ratings,
              is_anonymous: false,
              reviewer_attestation_id: null,
            },
          };

          const confirmed = await Alpine.store('broadcastConfirm').request({
            title: this.$t('confirm.reviewTitle'),
            message: this.$t('confirm.reviewMessage', { title: this.paper?.title || '' }),
            confirmLabel: this.$t('confirm.review'),
          });
          if (!this._mounted) return;
          if (!confirmed) { this.step = 'idle'; return; }

          const reviewOps = [
            ['comment', {
              parent_author: this.author,
              parent_permlink: this.permlink,
              author: username,
              permlink: reviewPermlink,
              title: '',
              body: this.reviewBody,
              json_metadata: JSON.stringify(jsonMetadata),
            }],
            ['comment_options', {
              author: username,
              permlink: reviewPermlink,
              max_accepted_payout: '1000000.000 HBD',
              percent_hbd: 0,
              allow_votes: true,
              allow_curation_rewards: true,
              extensions: [],
            }],
          ];
          const broadcastResult = await broadcastWithFreshAuth(username, reviewOps);
          if (!this._mounted) return;
          if (broadcastResult === FRESH_AUTH_REDIRECT_PENDING) return;
        }

        this.step = 'success';
        this._setTimer(() => {
          this.navigate(`/paper/${this.author}/${this.permlink}`);
        }, 1500);
      } catch (err) {
        if (!this._mounted) return;
        this.step = 'error';
        // Sanitization pattern (see executeUpgrade() in settings.js).
        console.warn('[review submit]', err);
        this.errorMessage = this.$t('review.submissionFailed');
      }
    },
  }));
}

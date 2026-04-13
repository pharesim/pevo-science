import Alpine from 'alpinejs';
import { fetchPaper, submitAnonymousReview } from '../api.js';
import { broadcastOps } from '../signer.js';
import { slugify } from '../crypto.js';
import { getAppTag, getAppId } from '../config.js';

const RATING_KEYS = ['methodology', 'novelty', 'clarity', 'significance'];

export function initReviewPage() {
  Alpine.data('reviewPage', () => ({
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
      const authors = this.paper?.authors || this.paper?.json_metadata?.pevo?.authors || [];
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

    async loadPaper() {
      const author = this.author;
      const permlink = this.permlink;
      this.loadingPaper = true;
      try {
        const res = await fetchPaper(author, permlink);
        if (this.author !== author || this.permlink !== permlink) return;
        this.paper = res.data;
      } catch { /* non-critical */ } finally {
        this.loadingPaper = false;
      }
    },

    async handleConnect() {
      try {
        await Alpine.store('auth').connect();
      } catch (err) {
        Alpine.store('toast').show(err.message || this.$t('common.connectionFailed'), 'error');
      }
    },

    async handleSubmit() {
      const username = this.username;
      if (!username || !this.isConnected || !this.allRated) return;

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
        } else {
          const reviewPermlink = `re-${slugify(this.author)}-${slugify(this.permlink)}-${Date.now().toString(36)}`;
          const paperVersion = this.paper?.versions?.[this.paper.versions.length - 1]?.version_number ?? 1;
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
              reviewed_version: paperVersion,
            },
          };

          const confirmed = await Alpine.store('broadcastConfirm').request({
            title: this.$t('confirm.reviewTitle'),
            message: this.$t('confirm.reviewMessage', { title: this.paper?.title || '' }),
            confirmLabel: this.$t('confirm.review'),
          });
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
          await broadcastOps(username, reviewOps);
        }

        this.step = 'success';
        setTimeout(() => {
          this.navigate(`/paper/${this.author}/${this.permlink}`);
        }, 1500);
      } catch (err) {
        this.step = 'error';
        this.errorMessage = err.message || this.$t('review.submissionFailed');
      }
    },
  }));
}

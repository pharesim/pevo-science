import Alpine from 'alpinejs';
import { broadcastWithFreshAuth, FRESH_AUTH_REDIRECT_PENDING } from '../lib/fresh-auth.js';
import { invalidatePaperCache } from '../api.js';
import { getAppTag } from '../config.js';
import { createTimerGuard } from '../lib/timer-guard.js';

const VOTE_LEVELS = [
  { label: 'vote.strongEndorsement', weight: 10000, cls: 'text-emerald-700 bg-emerald-50 border-emerald-200 hover:bg-emerald-100' },
  { label: 'vote.endorsement', weight: 6000, cls: 'text-emerald-600 bg-emerald-50/60 border-emerald-200/70 hover:bg-emerald-100/70' },
  { label: 'vote.mildEndorsement', weight: 2500, cls: 'text-emerald-500 bg-emerald-50/40 border-emerald-200/50 hover:bg-emerald-100/50' },
  { label: 'vote.mildConcerns', weight: -2500, cls: 'text-red-500 bg-red-50/40 border-red-200/50 hover:bg-red-100/50' },
  { label: 'vote.reject', weight: -6000, cls: 'text-red-600 bg-red-50/60 border-red-200/70 hover:bg-red-100/70' },
  { label: 'vote.strongReject', weight: -10000, cls: 'text-red-700 bg-red-50 border-red-200 hover:bg-red-100' },
];

export function initVoteButtons() {
  Alpine.data('voteButtons', (opts = {}) => ({
    ...createTimerGuard(),
    author: opts.author || '',
    permlink: opts.permlink || '',
    voteState: 'none', // 'none' | 'up' | 'down'
    currentWeight: 0,
    displayVotes: opts.netVotes ?? 0,
    voteStrength: opts.voteStrength || null,
    isVoting: false,
    selectorOpen: false,
    created: opts.created || null,
    versions: opts.versions || null,

    get isConnected() { return Alpine.store('auth').isConnected; },
    get isAccredited() { return Alpine.store('auth').isAccredited; },
    get username() { return Alpine.store('auth').username; },
    get voteLevels() { return VOTE_LEVELS; },

    voters: opts.voters || [],

    get myVotedVersion() {
      if (!this.username) return null;
      const entry = this.voters.find((v) => v.voter === this.username);
      return entry ? (entry.voted_version ?? null) : null;
    },

    get voteIsOutdated() {
      return this.myVotedVersion !== null && this.myVotedVersion < this._latestVersion();
    },

    get activeVoteCount() {
      return this.voters.filter((v) => v.weight !== 0).length;
    },

    _isPastPayout() {
      if (!this.created) return false;
      const payoutEnd = new Date(this.created + 'Z').getTime() + 7 * 24 * 60 * 60 * 1000;
      return Date.now() > payoutEnd;
    },

    _latestVersion() {
      if (!this.versions || !this.versions.length) return 1;
      return this.versions[this.versions.length - 1].version_number ?? 1;
    },

    _updateLocalVoter(weight) {
      const existing = this.voters.find((v) => v.voter === this.username);
      if (weight === 0) {
        this.voters = this.voters.filter((v) => v.voter !== this.username);
      } else if (existing) {
        existing.weight = weight;
        existing.effective_weight = weight;
      }
    },

    init() {
      this.$watch('username', () => this._restoreVoteState());
      this._restoreVoteState();
    },

    destroy() {
      // _teardownTimers flips _mounted so in-flight broadcastOps /
      // invalidatePaperCache / Alpine.store('auth').connect continuations
      // bail before touching reactive state. Hive broadcasts take multiple
      // seconds; the user can easily navigate away mid-flight.
      this._teardownTimers();
    },

    _restoreVoteState() {
      if (!this.username || !this.voters.length) return;
      const myVote = this.voters.find((v) => v.voter === this.username);
      if (myVote) {
        this.voteState = myVote.weight > 0 ? 'up' : 'down';
        this.currentWeight = myVote.weight;
      }
    },

    navigate(path) { Alpine.store('router').navigate(path); },

    currentLevelLabel() {
      if (this.voteState === 'none') return null;
      const level = VOTE_LEVELS.find((l) => l.weight === this.currentWeight);
      return level ? this.$t(level.label) : null;
    },

    strengthLabel() {
      return this.$t('vote.strength.' + this.voteStrength);
    },

    voteCountLabel() {
      const strength = this.strengthLabel();
      return this.$t('vote.votesWithStrength', { count: this.displayVotes, strength });
    },

    async _broadcastVote(weight) {
      // Past payout window and user has already voted: Hive won't accept a
      // native vote weight change, so use custom_json revote instead.
      // Returns FRESH_AUTH_REDIRECT_PENDING (null) when a re-auth round-trip
      // was initiated; callers should bail without surfacing an error.
      if (this._isPastPayout() && this.voteState !== 'none') {
        return broadcastWithFreshAuth(this.username, [['custom_json', {
          required_auths: [],
          required_posting_auths: [this.username],
          id: getAppTag(),
          json: JSON.stringify({ action: 'revote', author: this.author, permlink: this.permlink, weight, version: this._latestVersion() }),
        }]]);
      }
      return broadcastWithFreshAuth(this.username, [['vote', { voter: this.username, author: this.author, permlink: this.permlink, weight }]]);
    },

    async handleVote(weight) {
      if (!this.isConnected) {
        try {
          await Alpine.store('auth').connect();
        } catch {
          return;
        }
        return;
      }

      if (!this.username) return;

      // Non-accredited users: simple up/down only
      if (!this.isAccredited) {
        this.navigate('/accreditation');
        return;
      }

      // Entry guard: the template's `:disabled="isVoting"` is stale between a
      // double-click and the first await that sets `isVoting = true` (currently
      // set only after `broadcastConfirm.request()` resolves). Without this
      // guard, two rapid clicks both reach the body and race the broadcast.
      if (this.isVoting) return;

      // Already voted at this weight — ignore
      if (this.currentWeight === weight) {
        this.selectorOpen = false;
        return;
      }

      // Retract vote (weight=0)
      if (weight === 0) {
        const retractConfirmed = await Alpine.store('broadcastConfirm').request({
          title: this.$t('confirm.voteTitle'),
          message: this.$t('confirm.retractMessage'),
          confirmLabel: this.$t('confirm.retract'),
        });
        if (!this._mounted) return;
        if (!retractConfirmed) return;

        this.isVoting = true;
        try {
          const broadcastResult = await this._broadcastVote(0);
          if (!this._mounted) return;
          if (broadcastResult === FRESH_AUTH_REDIRECT_PENDING) return;
          const previousState = this.voteState;
          this.displayVotes += previousState === 'up' ? -1 : 1;
          this.voteState = 'none';
          this.currentWeight = 0;
          this._updateLocalVoter(0);
          invalidatePaperCache(this.author, this.permlink).catch(() => {});
        } catch (err) {
          if (!this._mounted) return;
          console.warn('[vote cancel]', err);
          Alpine.store('toast').show(this.$t('vote.cancelFailed'), 'error');
        } finally {
          if (this._mounted) {
            this.isVoting = false;
            this.selectorOpen = false;
          }
        }
        return;
      }

      const level = VOTE_LEVELS.find((l) => l.weight === weight);
      const confirmed = await Alpine.store('broadcastConfirm').request({
        title: this.$t('confirm.voteTitle'),
        message: this.$t('confirm.voteMessage', { strength: level ? this.$t(level.label) : '' }),
        confirmLabel: this.$t('confirm.vote'),
      });
      if (!this._mounted) return;
      if (!confirmed) return;

      this.isVoting = true;
      try {
        const broadcastResult = await this._broadcastVote(weight);
        if (!this._mounted) return;
        if (broadcastResult === FRESH_AUTH_REDIRECT_PENDING) return;
        const previousState = this.voteState;
        const direction = weight > 0 ? 'up' : 'down';
        this.voteState = direction;
        this.currentWeight = weight;
        this._updateLocalVoter(weight);

        let delta = 0;
        if (previousState === 'none') delta = direction === 'up' ? 1 : -1;
        else if (previousState === 'up' && direction === 'down') delta = -2;
        else if (previousState === 'down' && direction === 'up') delta = 2;
        this.displayVotes += delta;
        invalidatePaperCache(this.author, this.permlink).catch(() => {});
      } catch (err) {
        if (!this._mounted) return;
        console.warn('[vote submit]', err);
        Alpine.store('toast').show(this.$t('vote.voteFailed'), 'error');
      } finally {
        if (this._mounted) {
          this.isVoting = false;
          this.selectorOpen = false;
        }
      }
    },

  }));
}

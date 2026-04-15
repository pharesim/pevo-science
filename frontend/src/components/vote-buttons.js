import Alpine from 'alpinejs';
import { broadcastOps } from '../signer.js';
import { invalidatePaperCache } from '../api.js';

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
    author: opts.author || '',
    permlink: opts.permlink || '',
    voteState: 'none', // 'none' | 'up' | 'down'
    currentWeight: 0,
    displayVotes: opts.netVotes ?? 0,
    isVoting: false,
    selectorOpen: false,

    get isConnected() { return Alpine.store('auth').isConnected; },
    get isAccredited() { return Alpine.store('auth').isAccredited; },
    get username() { return Alpine.store('auth').username; },
    get voteLevels() { return VOTE_LEVELS; },

    voters: opts.voters || [],

    init() {
      this.$watch('username', () => this._restoreVoteState());
      this._restoreVoteState();
    },

    _restoreVoteState() {
      if (!this.username || !this.voters.length) return;
      const myVote = this.voters.find((v) => v.voter === this.username);
      if (myVote) {
        this.voteState = myVote.weight > 0 ? 'up' : 'down';
      }
    },

    navigate(path) { Alpine.store('router').navigate(path); },

    currentLevelLabel() {
      if (this.voteState === 'none') return null;
      const level = VOTE_LEVELS.find((l) => l.weight === this.currentWeight);
      return level ? this.$t(level.label) : null;
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

      // Already voted at this weight — ignore
      if (this.currentWeight === weight) {
        this.selectorOpen = false;
        return;
      }

      const level = VOTE_LEVELS.find((l) => l.weight === weight);
      const confirmed = await Alpine.store('broadcastConfirm').request({
        title: this.$t('confirm.voteTitle'),
        message: this.$t('confirm.voteMessage', { strength: level ? this.$t(level.label) : '' }),
        confirmLabel: this.$t('confirm.vote'),
      });
      if (!confirmed) return;

      this.isVoting = true;
      try {
        await broadcastOps(this.username, [['vote', { voter: this.username, author: this.author, permlink: this.permlink, weight }]]);
        const previousState = this.voteState;
        const direction = weight > 0 ? 'up' : 'down';
        this.voteState = direction;
        this.currentWeight = weight;

        let delta = 0;
        if (previousState === 'none') delta = direction === 'up' ? 1 : -1;
        else if (previousState === 'up' && direction === 'down') delta = -2;
        else if (previousState === 'down' && direction === 'up') delta = 2;
        this.displayVotes += delta;
        invalidatePaperCache(this.author, this.permlink).catch(() => {});
      } catch (err) {
        Alpine.store('toast').show(err.message || this.$t('vote.voteFailed'), 'error');
      } finally {
        this.isVoting = false;
        this.selectorOpen = false;
      }
    },

    // Simple up/down for non-accredited users
    async handleSimpleVote(weight) {
      if (!this.isConnected) {
        try {
          await Alpine.store('auth').connect();
        } catch {
          return;
        }
        return;
      }

      if (!this.username) return;

      const direction = weight > 0 ? 'up' : 'down';
      if (this.voteState === direction) return;

      const simpleConfirmed = await Alpine.store('broadcastConfirm').request({
        title: this.$t('confirm.voteTitle'),
        message: this.$t('confirm.voteSimpleMessage', { direction: this.$t('vote.' + direction) }),
        confirmLabel: this.$t('confirm.vote'),
      });
      if (!simpleConfirmed) return;

      this.isVoting = true;
      try {
        await broadcastOps(this.username, [['vote', { voter: this.username, author: this.author, permlink: this.permlink, weight }]]);
        const previousState = this.voteState;
        this.voteState = direction;
        this.currentWeight = weight;
        let delta = 0;
        if (previousState === 'none') delta = direction === 'up' ? 1 : -1;
        else if (previousState === 'up' && direction === 'down') delta = -2;
        else if (previousState === 'down' && direction === 'up') delta = 2;
        this.displayVotes += delta;
        invalidatePaperCache(this.author, this.permlink).catch(() => {});
      } catch (err) {
        Alpine.store('toast').show(err.message || this.$t('vote.voteFailed'), 'error');
      } finally {
        this.isVoting = false;
      }
    },
  }));
}

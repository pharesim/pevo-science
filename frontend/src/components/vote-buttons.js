import Alpine from 'alpinejs';
import { vote } from '../keychain.js';

export function initVoteButtons() {
  Alpine.data('voteButtons', (opts = {}) => ({
    author: opts.author || '',
    permlink: opts.permlink || '',
    voteState: 'none',
    displayVotes: opts.netVotes ?? 0,
    isVoting: false,

    get isConnected() { return Alpine.store('auth').isConnected; },
    get isAccredited() { return Alpine.store('auth').isAccredited; },
    get username() { return Alpine.store('auth').username; },

    navigate(path) { Alpine.store('router').navigate(path); },

    async handleVote(weight) {
      if (!this.isConnected) {
        try {
          await Alpine.store('auth').connect();
        } catch {
          return;
        }
        return;
      }

      if (!this.isAccredited) {
        this.navigate('/accreditation');
        return;
      }

      if (!this.username) return;

      const direction = weight > 0 ? 'up' : 'down';
      if (this.voteState === direction) return;

      this.isVoting = true;
      try {
        await vote(this.username, this.author, this.permlink, weight);
        const previousState = this.voteState;
        this.voteState = direction;
        let delta = 0;
        if (previousState === 'none') delta = direction === 'up' ? 1 : -1;
        else if (previousState === 'up' && direction === 'down') delta = -2;
        else if (previousState === 'down' && direction === 'up') delta = 2;
        this.displayVotes += delta;
      } catch (err) {
        Alpine.store('toast').show(err.message || this.$t('vote.voteFailed'), 'error');
      } finally {
        this.isVoting = false;
      }
    },
  }));
}

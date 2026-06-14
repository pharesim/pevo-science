import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockBroadcastWithFreshAuth = vi.fn();
const mockInvalidatePaperCache = vi.fn();

// vote-buttons now broadcasts via the fresh-auth helper rather than
// signer.broadcastOps directly. Mock the helper at its import site.
// FRESH_AUTH_REDIRECT_PENDING is the sentinel returned when a re-auth
// round-trip is in progress (the component bails on that branch).
vi.mock('../../src/lib/fresh-auth.js', () => ({
  broadcastWithFreshAuth: (...args) => mockBroadcastWithFreshAuth(...args),
  FRESH_AUTH_REDIRECT_PENDING: null,
}));

vi.mock('../../src/api.js', () => ({
  invalidatePaperCache: (...args) => mockInvalidatePaperCache(...args),
}));

vi.mock('../../src/config.js', () => ({
  getAppTag: () => 'pevotest',
}));

const mockAuthStore = { isConnected: true, isAccredited: true, username: 'alice' };
const mockRouterStore = { navigate: vi.fn() };
const mockToastStore = { show: vi.fn() };
const mockBroadcastConfirmStore = { request: vi.fn().mockResolvedValue(true) };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'auth') return mockAuthStore;
      if (name === 'router') return mockRouterStore;
      if (name === 'toast') return mockToastStore;
      if (name === 'broadcastConfirm') return mockBroadcastConfirmStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initVoteButtons } from '../../src/components/vote-buttons.js';

function createComponent(opts = {}) {
  initVoteButtons();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory(opts);
  comp.$t = (key, params) => params ? `${key}:${JSON.stringify(params)}` : key;
  comp.$store = {
    auth: mockAuthStore,
    router: mockRouterStore,
    toast: mockToastStore,
    broadcastConfirm: mockBroadcastConfirmStore,
  };
  comp.$watch = vi.fn();
  return comp;
}

describe('voteButtons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.isConnected = true;
    mockAuthStore.isAccredited = true;
    mockAuthStore.username = 'alice';
    mockBroadcastWithFreshAuth.mockResolvedValue(undefined);
    mockInvalidatePaperCache.mockResolvedValue(undefined);
    mockBroadcastConfirmStore.request.mockResolvedValue(true);
  });

  describe('_isPastPayout', () => {
    it('returns false when no created date', () => {
      const comp = createComponent({ author: 'bob', permlink: 'p1' });
      expect(comp._isPastPayout()).toBe(false);
    });

    it('returns false within 7-day window', () => {
      const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().replace('Z', '');
      const comp = createComponent({ author: 'bob', permlink: 'p1', created: recent });
      expect(comp._isPastPayout()).toBe(false);
    });

    it('returns true after 7-day window', () => {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().replace('Z', '');
      const comp = createComponent({ author: 'bob', permlink: 'p1', created: old });
      expect(comp._isPastPayout()).toBe(true);
    });
  });

  describe('_latestVersion', () => {
    it('returns 1 when no versions', () => {
      const comp = createComponent({ author: 'bob', permlink: 'p1' });
      expect(comp._latestVersion()).toBe(1);
    });

    it('returns last version number', () => {
      const comp = createComponent({
        author: 'bob', permlink: 'p1',
        versions: [{ version_number: 1 }, { version_number: 2 }, { version_number: 3 }],
      });
      expect(comp._latestVersion()).toBe(3);
    });
  });

  describe('_restoreVoteState', () => {
    it('restores up state from voters array', () => {
      const comp = createComponent({
        author: 'bob', permlink: 'p1',
        voters: [{ voter: 'alice', weight: 6000 }],
      });
      comp._restoreVoteState();
      expect(comp.voteState).toBe('up');
      expect(comp.currentWeight).toBe(6000);
    });

    it('restores down state from voters array', () => {
      const comp = createComponent({
        author: 'bob', permlink: 'p1',
        voters: [{ voter: 'alice', weight: -2500 }],
      });
      comp._restoreVoteState();
      expect(comp.voteState).toBe('down');
      expect(comp.currentWeight).toBe(-2500);
    });

    it('does nothing when user has no vote', () => {
      const comp = createComponent({
        author: 'bob', permlink: 'p1',
        voters: [{ voter: 'carol', weight: 6000 }],
      });
      comp._restoreVoteState();
      expect(comp.voteState).toBe('none');
    });
  });

  describe('_updateLocalVoter', () => {
    it('removes voter when weight is 0', () => {
      const comp = createComponent({
        author: 'bob', permlink: 'p1',
        voters: [{ voter: 'alice', weight: 6000, effective_weight: 6000 }],
      });
      comp._updateLocalVoter(0);
      expect(comp.voters).toEqual([]);
    });

    it('updates existing voter weight', () => {
      const comp = createComponent({
        author: 'bob', permlink: 'p1',
        voters: [{ voter: 'alice', weight: 6000, effective_weight: 6000 }],
      });
      comp._updateLocalVoter(-2500);
      expect(comp.voters[0].weight).toBe(-2500);
      expect(comp.voters[0].effective_weight).toBe(-2500);
    });
  });

  describe('myVotedVersion / voteIsOutdated', () => {
    it('returns null when user has no vote', () => {
      const comp = createComponent({ author: 'bob', permlink: 'p1', voters: [] });
      expect(comp.myVotedVersion).toBe(null);
    });

    it('detects outdated vote', () => {
      const comp = createComponent({
        author: 'bob', permlink: 'p1',
        voters: [{ voter: 'alice', weight: 10000, voted_version: 1 }],
        versions: [{ version_number: 1 }, { version_number: 2 }],
      });
      comp._restoreVoteState();
      expect(comp.myVotedVersion).toBe(1);
      expect(comp.voteIsOutdated).toBe(true);
    });

    it('not outdated when vote is on latest version', () => {
      const comp = createComponent({
        author: 'bob', permlink: 'p1',
        voters: [{ voter: 'alice', weight: 10000, voted_version: 2 }],
        versions: [{ version_number: 1 }, { version_number: 2 }],
      });
      expect(comp.voteIsOutdated).toBe(false);
    });
  });

  describe('activeVoteCount', () => {
    it('counts only non-zero weight voters', () => {
      const comp = createComponent({
        author: 'bob', permlink: 'p1',
        voters: [
          { voter: 'alice', weight: 10000 },
          { voter: 'bob', weight: 0 },
          { voter: 'carol', weight: -6000 },
        ],
      });
      expect(comp.activeVoteCount).toBe(2);
    });
  });

  describe('handleVote', () => {
    it('redirects to accreditation if not accredited', async () => {
      mockAuthStore.isAccredited = false;
      const comp = createComponent({ author: 'bob', permlink: 'p1', netVotes: 5 });
      await comp.handleVote(10000);
      expect(mockRouterStore.navigate).toHaveBeenCalledWith('/accreditation');
    });

    it('ignores vote if already at same weight', async () => {
      const comp = createComponent({
        author: 'bob', permlink: 'p1', netVotes: 5,
        voters: [{ voter: 'alice', weight: 10000 }],
      });
      comp._restoreVoteState();
      await comp.handleVote(10000);
      expect(mockBroadcastWithFreshAuth).not.toHaveBeenCalled();
    });

    it('broadcasts vote and updates display count (none -> up)', async () => {
      const comp = createComponent({ author: 'bob', permlink: 'p1', netVotes: 5 });
      await comp.handleVote(10000);
      expect(mockBroadcastWithFreshAuth).toHaveBeenCalledWith('alice', [['vote', {
        voter: 'alice', author: 'bob', permlink: 'p1', weight: 10000,
      }]]);
      expect(comp.displayVotes).toBe(6);
      expect(comp.voteState).toBe('up');
    });

    it('computes delta correctly (up -> down = -2)', async () => {
      const comp = createComponent({
        author: 'bob', permlink: 'p1', netVotes: 5,
        voters: [{ voter: 'alice', weight: 10000, effective_weight: 10000 }],
      });
      comp._restoreVoteState();
      await comp.handleVote(-6000);
      expect(comp.displayVotes).toBe(3);
      expect(comp.voteState).toBe('down');
    });

    it('uses custom_json for past-payout revote', async () => {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().replace('Z', '');
      const comp = createComponent({
        author: 'bob', permlink: 'p1', netVotes: 5, created: old,
        voters: [{ voter: 'alice', weight: 10000, effective_weight: 10000 }],
        versions: [{ version_number: 1 }, { version_number: 2 }],
      });
      comp._restoreVoteState();
      await comp.handleVote(6000);
      expect(mockBroadcastWithFreshAuth).toHaveBeenCalledWith('alice', [['custom_json', expect.objectContaining({
        id: 'pevotest',
      })]]);
    });

    it('shows sanitized toast on broadcast error (vote submit)', async () => {
      const leaky = new Error('broadcast-failed-sentinel');
      mockBroadcastWithFreshAuth.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent({ author: 'bob', permlink: 'p1', netVotes: 5 });
      await comp.handleVote(10000);
      expect(mockToastStore.show).toHaveBeenCalledWith('vote.voteFailed', 'error');
      expect(mockToastStore.show.mock.calls[0][0]).not.toContain('sentinel');
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
    });

    it('shows sanitized toast on vote-cancel error', async () => {
      const leaky = new Error('cancel-failed-sentinel');
      mockBroadcastWithFreshAuth.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent({ author: 'bob', permlink: 'p1', netVotes: 5 });
      comp.voteState = 'up';
      comp.currentWeight = 10000;
      await comp.handleVote(0);
      expect(mockToastStore.show).toHaveBeenCalledWith('vote.cancelFailed', 'error');
      expect(mockToastStore.show.mock.calls[0][0]).not.toContain('sentinel');
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
    });

    // Regression for the entry-guard race-protection: two synchronous
    // handleVote calls must result in exactly one broadcast. Without the
    // `if (this.isVoting) return;` guard (and the pre-await `isVoting = true`
    // flip), both clicks pass the template's `:disabled` check (stale until
    // the first re-render), both reach the body, and both broadcast.
    it('two synchronous handleVote calls broadcast once', async () => {
      // Hold broadcastConfirm in a pending state so the first handleVote is
      // suspended at the modal-confirm await when the second click arrives.
      let resolveConfirm;
      mockBroadcastConfirmStore.request.mockImplementationOnce(
        () => new Promise((resolve) => { resolveConfirm = resolve; }),
      );
      const comp = createComponent({ author: 'bob', permlink: 'p1', netVotes: 5 });
      const first = comp.handleVote(10000);
      // Synchronous second click: the entry guard short-circuits because
      // `isVoting` was flipped before the broadcastConfirm await.
      const second = comp.handleVote(10000);
      await second;
      // Resolve the first click's confirm so the broadcast proceeds.
      resolveConfirm(true);
      await first;
      expect(mockBroadcastWithFreshAuth).toHaveBeenCalledTimes(1);
    });
  });

  // Hive broadcasts can take multiple
  // seconds, and a user easily navigates away mid-flight. Post-destroy()
  // writes to voteState / displayVotes / currentWeight / isVoting /
  // selectorOpen on a destroyed reactive scope must not happen.
  describe('teardown', () => {
    it('handleVote happy path does not mutate vote state after destroy()', async () => {
      let resolveBroadcast;
      mockBroadcastWithFreshAuth.mockImplementationOnce(() => new Promise((resolve) => { resolveBroadcast = resolve; }));
      const comp = createComponent({ author: 'bob', permlink: 'p1', netVotes: 5 });
      comp.voteState = 'none';
      comp.currentWeight = 0;
      comp.displayVotes = 5;
      const pending = comp.handleVote(10000);
      // Let the broadcastConfirm resolve + broadcastOps start.
      await Promise.resolve();
      await Promise.resolve();
      // isVoting flipped synchronously before the broadcastOps await.
      expect(comp.isVoting).toBe(true);
      comp.destroy();
      resolveBroadcast();
      await pending;
      // Post-await writes skipped: voteState/currentWeight/displayVotes
      // must not have moved, and the finally block's `isVoting = false` is
      // guarded, so it stays true (the reactive scope is dead anyway).
      expect(comp.voteState).toBe('none');
      expect(comp.currentWeight).toBe(0);
      expect(comp.displayVotes).toBe(5);
      expect(mockInvalidatePaperCache).not.toHaveBeenCalled();
    });

    it('handleVote catch does not toast or flip isVoting after destroy()', async () => {
      let rejectBroadcast;
      mockBroadcastWithFreshAuth.mockImplementationOnce(() => new Promise((_, reject) => { rejectBroadcast = reject; }));
      const comp = createComponent({ author: 'bob', permlink: 'p1', netVotes: 5 });
      comp.isVoting = false;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pending = comp.handleVote(10000);
      await Promise.resolve();
      await Promise.resolve();
      comp.destroy();
      rejectBroadcast(new Error('late'));
      await pending;
      expect(mockToastStore.show).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('retract (weight=0) happy path does not mutate state after destroy()', async () => {
      let resolveBroadcast;
      mockBroadcastWithFreshAuth.mockImplementationOnce(() => new Promise((resolve) => { resolveBroadcast = resolve; }));
      const comp = createComponent({ author: 'bob', permlink: 'p1', netVotes: 5 });
      comp.voteState = 'up';
      comp.currentWeight = 10000;
      comp.displayVotes = 5;
      const pending = comp.handleVote(0);
      await Promise.resolve();
      await Promise.resolve();
      comp.destroy();
      resolveBroadcast();
      await pending;
      // State preserved — retract-path post-await writes were guarded.
      expect(comp.voteState).toBe('up');
      expect(comp.currentWeight).toBe(10000);
      expect(comp.displayVotes).toBe(5);
    });
  });
});

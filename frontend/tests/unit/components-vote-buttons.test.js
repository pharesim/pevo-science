import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockBroadcastOps = vi.fn();
const mockInvalidatePaperCache = vi.fn();

vi.mock('../../src/signer.js', () => ({
  broadcastOps: (...args) => mockBroadcastOps(...args),
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
    mockBroadcastOps.mockResolvedValue(undefined);
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
      expect(mockBroadcastOps).not.toHaveBeenCalled();
    });

    it('broadcasts vote and updates display count (none -> up)', async () => {
      const comp = createComponent({ author: 'bob', permlink: 'p1', netVotes: 5 });
      await comp.handleVote(10000);
      expect(mockBroadcastOps).toHaveBeenCalledWith('alice', [['vote', {
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
      expect(mockBroadcastOps).toHaveBeenCalledWith('alice', [['custom_json', expect.objectContaining({
        id: 'pevotest',
      })]]);
    });

    it('shows sanitized toast on broadcast error (vote submit)', async () => {
      const leaky = new Error('broadcast-failed-sentinel');
      mockBroadcastOps.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent({ author: 'bob', permlink: 'p1', netVotes: 5 });
      await comp.handleVote(10000);
      expect(mockToastStore.show).toHaveBeenCalledWith('vote.voteFailed', 'error');
      expect(mockToastStore.show.mock.calls[0][0]).not.toContain('sentinel');
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
    });

    it('shows sanitized toast on vote-cancel error', async () => {
      const leaky = new Error('cancel-failed-sentinel');
      mockBroadcastOps.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent({ author: 'bob', permlink: 'p1', netVotes: 5 });
      comp.voteState = 'up';
      comp.currentWeight = 10000;
      await comp.handleVote(0);
      expect(mockToastStore.show).toHaveBeenCalledWith('vote.cancelFailed', 'error');
      expect(mockToastStore.show.mock.calls[0][0]).not.toContain('sentinel');
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let mockAuthStore;

vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name) => {
      if (name === 'auth') return mockAuthStore;
      return {};
    }),
  },
}));

import { broadcastOps } from '../../src/signer.js';

describe('signer - broadcastOps', () => {
  beforeEach(() => {
    mockAuthStore = { custody: 'keychain', token: null };
    delete window.hive_keychain;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('light account path', () => {
    beforeEach(() => {
      mockAuthStore = { custody: 'light', token: 'jwt-token-123' };
    });

    it('sends operations to /api/custody/broadcast with auth header', async () => {
      const mockResponse = { tx_id: 'abc', block_num: 100 };
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const ops = [['comment', { author: 'alice', body: 'test' }]];
      const result = await broadcastOps('alice', ops);

      expect(global.fetch).toHaveBeenCalledWith('/api/custody/broadcast', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer jwt-token-123',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ operations: ops }),
      });
      expect(result).toEqual(mockResponse);
    });

    it('routes multi-op light account broadcasts to custody endpoint', async () => {
      // Guards against the light-account condition being narrowed to single-op only,
      // which would fall through to the Keychain path.
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tx_id: 'multi' }),
      });

      const ops = [
        ['comment', { author: 'alice', body: 'paper' }],
        ['comment_options', { author: 'alice', permlink: 'p', max_accepted_payout: '1000000.000 HBD' }],
      ];
      await broadcastOps('alice', ops);

      expect(global.fetch).toHaveBeenCalledWith('/api/custody/broadcast', expect.objectContaining({
        body: JSON.stringify({ operations: ops }),
      }));
    });

    it('throws with error message from response body on failure', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Insufficient permissions' }),
      });

      await expect(broadcastOps('alice', [['vote', {}]])).rejects.toThrow('Insufficient permissions');
    });

    it('throws generic message when response body is not JSON', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.reject(new Error('parse error')),
      });

      await expect(broadcastOps('alice', [['vote', {}]])).rejects.toThrow('Broadcast failed');
    });
  });

  describe('keychain path - vote operations', () => {
    beforeEach(() => {
      mockAuthStore = { custody: 'keychain', token: null };
    });

    it('rejects if keychain is not installed', async () => {
      const ops = [['vote', { voter: 'alice', author: 'bob', permlink: 'post1', weight: 10000 }]];
      await expect(broadcastOps('alice', ops)).rejects.toThrow('Hive Keychain is not installed');
    });

    it('calls requestVote with correct arguments for single vote op', async () => {
      const mockRequestVote = vi.fn((voter, permlink, author, weight, cb) => {
        cb({ success: true, tx_id: 'vote-tx' });
      });
      window.hive_keychain = { requestVote: mockRequestVote };

      const ops = [['vote', { voter: 'alice', author: 'bob', permlink: 'post1', weight: 10000 }]];
      const result = await broadcastOps('alice', ops);

      expect(mockRequestVote).toHaveBeenCalledWith('alice', 'post1', 'bob', 10000, expect.any(Function));
      expect(result).toEqual({ success: true, tx_id: 'vote-tx' });
    });

    it('rejects on vote failure', async () => {
      window.hive_keychain = {
        requestVote: vi.fn((voter, permlink, author, weight, cb) => {
          cb({ success: false, message: 'Vote rejected' });
        }),
      };

      const ops = [['vote', { voter: 'alice', author: 'bob', permlink: 'post1', weight: 10000 }]];
      await expect(broadcastOps('alice', ops)).rejects.toThrow('Vote rejected');
    });
  });

  describe('keychain path - non-vote operations', () => {
    beforeEach(() => {
      mockAuthStore = { custody: 'keychain', token: null };
    });

    it('rejects if keychain is not installed', async () => {
      const ops = [['comment', { author: 'alice', body: 'hello' }]];
      await expect(broadcastOps('alice', ops)).rejects.toThrow('Hive Keychain is not installed');
    });

    it('calls requestBroadcast with correct arguments', async () => {
      const mockRequestBroadcast = vi.fn((user, ops, key, cb) => {
        cb({ success: true, tx_id: 'bcast-tx' });
      });
      window.hive_keychain = { requestBroadcast: mockRequestBroadcast };

      const ops = [['comment', { author: 'alice', body: 'hello' }]];
      const result = await broadcastOps('alice', ops, 'posting');

      expect(mockRequestBroadcast).toHaveBeenCalledWith('alice', ops, 'posting', expect.any(Function));
      expect(result).toEqual({ success: true, tx_id: 'bcast-tx' });
    });

    it('rejects on broadcast failure', async () => {
      window.hive_keychain = {
        requestBroadcast: vi.fn((user, ops, key, cb) => {
          cb({ success: false, message: 'Broadcast error' });
        }),
      };

      const ops = [['comment', { author: 'alice', body: 'test' }]];
      await expect(broadcastOps('alice', ops)).rejects.toThrow('Broadcast error');
    });

    it('routes multiple ops to requestBroadcast even if first is vote', async () => {
      const mockRequestBroadcast = vi.fn((user, ops, key, cb) => {
        cb({ success: true });
      });
      window.hive_keychain = { requestBroadcast: mockRequestBroadcast };

      const ops = [
        ['vote', { voter: 'alice', author: 'bob', permlink: 'p1', weight: 10000 }],
        ['comment', { author: 'alice', body: 'nice' }],
      ];
      await broadcastOps('alice', ops);

      expect(mockRequestBroadcast).toHaveBeenCalledWith('alice', ops, 'posting', expect.any(Function));
    });
  });
});

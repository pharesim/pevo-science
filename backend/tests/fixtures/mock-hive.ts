/**
 * Configurable mock Hive client factory.
 *
 * Usage in test files:
 *
 *   import { createMockHiveClient } from '../fixtures/mock-hive.js';
 *   import { ALL_PAPERS, REVIEW_CAROL_ON_QUANTUM } from '../fixtures/data.js';
 *
 *   vi.mock('../../src/hive.js', () => ({
 *     hiveClient: createMockHiveClient({
 *       papers: ALL_PAPERS,
 *       replies: { 'quantum-paper': [REVIEW_CAROL_ON_QUANTUM] },
 *     }),
 *   }));
 */

import { vi } from 'vitest';
import type { MockHivePost, MockHiveAccount } from './data.js';

export interface MockHiveConfig {
  /** Top-level PEvO papers returned by getDiscussions */
  papers?: MockHivePost[];
  /** Replies keyed by parent_permlink. Used by get_content_replies. */
  replies?: Record<string, MockHivePost[]>;
  /** Hive accounts returned by getAccounts */
  accounts?: MockHiveAccount[];
  /** Account history entries for notifications (get_account_history) */
  accountHistory?: unknown[];
  /** Whether broadcast.json should succeed */
  broadcastJson?: boolean;
  /** Whether broadcast.comment should succeed */
  broadcastComment?: boolean;
}

export function createMockHiveClient(config: MockHiveConfig = {}) {
  const {
    papers = [],
    replies = {},
    accounts = [],
    accountHistory = [],
    broadcastJson = true,
    broadcastComment = true,
  } = config;

  // Build a flat lookup of all known posts (papers + all replies)
  const allPosts = new Map<string, MockHivePost>();
  for (const p of papers) allPosts.set(`${p.author}/${p.permlink}`, p);
  for (const group of Object.values(replies)) {
    for (const r of group) allPosts.set(`${r.author}/${r.permlink}`, r);
  }

  return {
    database: {
      getDiscussions: vi.fn().mockResolvedValue(papers),
      call: vi.fn().mockImplementation((method: string, args: string[]) => {
        if (method === 'get_content') {
          const [author, permlink] = args;
          const post = allPosts.get(`${author}/${permlink}`);
          if (post) return Promise.resolve(post);
          // Hive returns an empty-author object for non-existent content
          return Promise.resolve({ author: '', title: '' });
        }
        if (method === 'get_content_replies') {
          const [, parentPermlink] = args;
          return Promise.resolve(replies[parentPermlink] || []);
        }
        if (method === 'get_account_history') {
          return Promise.resolve(accountHistory);
        }
        return Promise.resolve(null);
      }),
      getAccounts: vi.fn().mockImplementation((names: string[]) => {
        const found = accounts.filter((a) => names.includes(a.name));
        return Promise.resolve(found);
      }),
    },
    broadcast: {
      json: broadcastJson
        ? vi.fn().mockResolvedValue({ id: 'mock-tx-id' })
        : vi.fn().mockRejectedValue(new Error('broadcast failed')),
      comment: broadcastComment
        ? vi.fn().mockResolvedValue({ id: 'mock-tx-id' })
        : vi.fn().mockRejectedValue(new Error('broadcast failed')),
    },
  };
}

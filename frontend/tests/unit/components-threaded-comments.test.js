import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchPaperComments = vi.fn();

vi.mock('../../src/api.js', () => ({
  fetchPaperComments: (...args) => mockFetchPaperComments(...args),
}));

vi.mock('../../src/components/markdown-renderer.js', () => ({
  renderMarkdown: (text) => `<p>${text}</p>`,
}));

const mockAuthStore = { isConnected: true, username: 'alice' };
const mockRouterStore = { navigate: vi.fn() };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'auth') return mockAuthStore;
      if (name === 'router') return mockRouterStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initThreadedComments } from '../../src/components/threaded-comments.js';

function createComponent(opts = {}) {
  initThreadedComments();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory(opts);
  comp.$t = (key) => key;
  comp.$store = { auth: mockAuthStore, router: mockRouterStore };
  return comp;
}

describe('threadedComments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('countComments (via totalCount)', () => {
    it('counts flat comments', async () => {
      mockFetchPaperComments.mockResolvedValue({
        data: [
          { author: 'a', permlink: 'p1', body: 'hi' },
          { author: 'b', permlink: 'p2', body: 'hello' },
        ],
      });
      const comp = createComponent({ paperAuthor: 'x', paperPermlink: 'y' });
      await comp.loadComments();
      expect(comp.totalCount).toBe(2);
    });

    it('counts nested replies recursively', async () => {
      mockFetchPaperComments.mockResolvedValue({
        data: [
          {
            author: 'a', permlink: 'p1', body: 'hi',
            replies: [
              { author: 'b', permlink: 'p2', body: 'reply', replies: [
                { author: 'c', permlink: 'p3', body: 'nested' },
              ]},
            ],
          },
        ],
      });
      const comp = createComponent({ paperAuthor: 'x', paperPermlink: 'y' });
      await comp.loadComments();
      expect(comp.totalCount).toBe(3);
    });

    it('handles empty comment list', async () => {
      mockFetchPaperComments.mockResolvedValue({ data: [] });
      const comp = createComponent({ paperAuthor: 'x', paperPermlink: 'y' });
      await comp.loadComments();
      expect(comp.totalCount).toBe(0);
    });
  });

  describe('loadComments error handling', () => {
    it('sets error state on fetch failure', async () => {
      mockFetchPaperComments.mockRejectedValue(new Error('Network'));
      const comp = createComponent({ paperAuthor: 'x', paperPermlink: 'y' });
      await comp.loadComments();
      expect(comp.error).toBe('comments.error');
      expect(comp.comments).toEqual([]);
    });
  });

  describe('toggleCollapse / toggleReply', () => {
    it('toggles collapse state', () => {
      const comp = createComponent({});
      comp.toggleCollapse('comment-a-p1');
      expect(comp.collapsed['comment-a-p1']).toBe(true);
      comp.toggleCollapse('comment-a-p1');
      expect(comp.collapsed['comment-a-p1']).toBe(false);
    });

    it('toggles reply state', () => {
      const comp = createComponent({});
      comp.toggleReply('comment-a-p1');
      expect(comp.replyOpen['comment-a-p1']).toBe(true);
      comp.toggleReply('comment-a-p1');
      expect(comp.replyOpen['comment-a-p1']).toBe(false);
    });
  });
});

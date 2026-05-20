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
      expect(comp.errorRetriable).toBe(false);
      expect(comp.comments).toEqual([]);
    });

    it('flags errorRetriable on 503 SERVICE_UNAVAILABLE + details.retriable', async () => {
      const err = Object.assign(new Error('Service Unavailable'), {
        code: 'SERVICE_UNAVAILABLE',
        details: { retriable: true },
      });
      mockFetchPaperComments.mockRejectedValueOnce(err);
      const comp = createComponent({ paperAuthor: 'x', paperPermlink: 'y' });
      await comp.loadComments();
      expect(comp.errorRetriable).toBe(true);
      expect(comp.error).toBe('comments.serviceUnavailable');
      expect(comp.comments).toEqual([]);
    });

    it('does not flag errorRetriable when SERVICE_UNAVAILABLE lacks the retriable hint', async () => {
      const err = Object.assign(new Error('Service Unavailable'), {
        code: 'SERVICE_UNAVAILABLE',
        details: {},
      });
      mockFetchPaperComments.mockRejectedValueOnce(err);
      const comp = createComponent({ paperAuthor: 'x', paperPermlink: 'y' });
      await comp.loadComments();
      expect(comp.errorRetriable).toBe(false);
      expect(comp.error).toBe('comments.error');
    });

    it('clears errorRetriable on a subsequent successful retry', async () => {
      const err = Object.assign(new Error('Service Unavailable'), {
        code: 'SERVICE_UNAVAILABLE',
        details: { retriable: true },
      });
      mockFetchPaperComments.mockRejectedValueOnce(err);
      mockFetchPaperComments.mockResolvedValueOnce({
        data: [{ author: 'a', permlink: 'p1', body: 'hi' }],
      });
      const comp = createComponent({ paperAuthor: 'x', paperPermlink: 'y' });
      await comp.loadComments();
      expect(comp.errorRetriable).toBe(true);
      await comp.loadComments();
      expect(comp.errorRetriable).toBe(false);
      expect(comp.error).toBeNull();
      expect(comp.totalCount).toBe(1);
    });

    // Synchronous-flag-before-await: a second loadComments() invoked while
    // the first is still in-flight must not dispatch a second fetch. The
    // retry button + the comment-posted window listener make this race
    // newly reachable (rapid retry-click, or a comment-posted event firing
    // during an active retry fetch).
    it('drops a concurrent loadComments() while one is in-flight', async () => {
      let resolveFirst;
      mockFetchPaperComments.mockImplementationOnce(
        () => new Promise((resolve) => { resolveFirst = resolve; }),
      );
      const comp = createComponent({ paperAuthor: 'x', paperPermlink: 'y' });
      const first = comp.loadComments();
      const second = comp.loadComments();
      // Initial mount's init() does not run in this test fixture, so the
      // only fetches in-flight come from the two explicit calls.
      expect(mockFetchPaperComments).toHaveBeenCalledTimes(1);
      resolveFirst({ data: [{ author: 'a', permlink: 'p1', body: 'hi' }] });
      await Promise.all([first, second]);
      expect(comp.totalCount).toBe(1);
      expect(comp.errorRetriable).toBe(false);
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

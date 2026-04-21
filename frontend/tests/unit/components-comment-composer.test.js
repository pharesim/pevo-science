import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockBroadcastOps = vi.fn();

vi.mock('../../src/signer.js', () => ({
  broadcastOps: (...args) => mockBroadcastOps(...args),
}));

vi.mock('../../src/config.js', () => ({
  getAppTag: () => 'pevotest',
  getAppId: () => 'pevo/1.0',
}));

const mockAuthStore = { isConnected: true, isAccredited: true, username: 'alice', custody: 'light' };
const mockBroadcastConfirmStore = { request: vi.fn().mockResolvedValue(true) };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'auth') return mockAuthStore;
      if (name === 'broadcastConfirm') return mockBroadcastConfirmStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initCommentComposer } from '../../src/components/comment-composer.js';

function createComponent(opts = {}) {
  initCommentComposer();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory(opts);
  comp.$t = (key) => key;
  comp.$store = { auth: mockAuthStore, broadcastConfirm: mockBroadcastConfirmStore };
  comp.$dispatch = vi.fn();
  return comp;
}

describe('commentComposer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.username = 'alice';
    mockBroadcastOps.mockResolvedValue(undefined);
    mockBroadcastConfirmStore.request.mockResolvedValue(true);
  });

  it('does nothing when body is empty', async () => {
    const comp = createComponent({ parentAuthor: 'bob', parentPermlink: 'post1' });
    comp.body = '   ';
    await comp.handleSubmit();
    expect(mockBroadcastOps).not.toHaveBeenCalled();
  });

  it('does nothing when username is falsy', async () => {
    mockAuthStore.username = '';
    const comp = createComponent({ parentAuthor: 'bob', parentPermlink: 'post1' });
    comp.body = 'Hello';
    await comp.handleSubmit();
    expect(mockBroadcastOps).not.toHaveBeenCalled();
  });

  it('broadcasts comment with correct metadata', async () => {
    const comp = createComponent({ parentAuthor: 'bob', parentPermlink: 'post1' });
    comp.body = 'Great paper!';
    await comp.handleSubmit();

    expect(mockBroadcastOps).toHaveBeenCalledWith('alice', expect.arrayContaining([
      expect.arrayContaining(['comment', expect.objectContaining({
        parent_author: 'bob',
        parent_permlink: 'post1',
        author: 'alice',
        body: 'Great paper!',
      })]),
    ]));

    // Check json_metadata
    const ops = mockBroadcastOps.mock.calls[0][1];
    const commentOp = ops.find((op) => op[0] === 'comment');
    const meta = JSON.parse(commentOp[1].json_metadata);
    expect(meta.app).toBe('pevo/1.0');
    expect(meta.tags).toContain('pevotest');
    expect(meta.pevotest.type).toBe('comment');
  });

  it('generates permlink with correct prefix', async () => {
    const comp = createComponent({ parentAuthor: 'bob', parentPermlink: 'my-great-paper' });
    comp.body = 'Nice';
    await comp.handleSubmit();

    const ops = mockBroadcastOps.mock.calls[0][1];
    const commentOp = ops.find((op) => op[0] === 'comment');
    expect(commentOp[1].permlink).toMatch(/^re-my-great-paper-\d+-[a-z0-9]+$/);
  });

  it('includes comment_options operation', async () => {
    const comp = createComponent({ parentAuthor: 'bob', parentPermlink: 'post1' });
    comp.body = 'Nice!';
    await comp.handleSubmit();

    const ops = mockBroadcastOps.mock.calls[0][1];
    const optionsOp = ops.find((op) => op[0] === 'comment_options');
    expect(optionsOp).toBeDefined();
    expect(optionsOp[1].author).toBe('alice');
    expect(optionsOp[1].allow_votes).toBe(true);
  });

  it('dispatches comment-posted event on success', async () => {
    const comp = createComponent({ parentAuthor: 'bob', parentPermlink: 'post1' });
    comp.body = 'Hey';
    await comp.handleSubmit();
    expect(comp.$dispatch).toHaveBeenCalledWith('comment-posted', { parentPermlink: 'post1' });
    expect(comp.body).toBe('');
  });

  // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: broadcast failure
  // surfaces a generic localized message; raw err reaches console.warn.
  it('sanitizes broadcast failure: generic message to DOM, raw err to console.warn', async () => {
    const leaky = new Error('Network error hex=deadbeefcafebabe');
    mockBroadcastOps.mockRejectedValue(leaky);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const comp = createComponent({ parentAuthor: 'bob', parentPermlink: 'post1' });
    comp.body = 'Hey';
    await comp.handleSubmit();
    expect(comp.error).toBe('comments.postFailed');
    expect(comp.error).not.toContain('deadbeef');
    expect(comp.isSubmitting).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][1]).toBe(leaky);
    warnSpy.mockRestore();
  });

  it('does not broadcast when confirmation is cancelled', async () => {
    mockBroadcastConfirmStore.request.mockResolvedValue(false);
    const comp = createComponent({ parentAuthor: 'bob', parentPermlink: 'post1' });
    comp.body = 'Hey';
    await comp.handleSubmit();
    expect(mockBroadcastOps).not.toHaveBeenCalled();
    expect(comp.isSubmitting).toBe(false);
  });
});

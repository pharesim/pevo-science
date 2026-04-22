import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal test harness for frontend/src/pages/edit.js focused on the
// FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND catch-block behavior.
// The handleSubmit() flow is long, but all error shapes land in the same
// terminal catch: set step = 'error', console.warn the raw err, bind the
// generic i18n key to errorMessage.

vi.mock('../../src/api.js', () => ({
  fetchPaper: vi.fn(),
  fetchPaperEnrichment: vi.fn(),
  invalidatePaperCache: vi.fn(),
  uploadToIpfs: vi.fn(),
}));

vi.mock('../../src/signer.js', () => ({
  broadcastOps: vi.fn(),
}));

vi.mock('../../src/crypto.js', () => ({
  sha256File: vi.fn(() => Promise.resolve('abc123')),
  slugify: vi.fn((s) => s.toLowerCase().replace(/\s+/g, '-')),
}));

vi.mock('../../src/config.js', () => ({
  getAppTag: () => 'pevotest',
  getAppId: () => 'pevotest/1.0',
  getMaxUploadSize: () => 50 * 1024 * 1024,
  getMaxUploadSizeMB: () => 50,
}));

const mockStores = {
  router: { params: { author: 'alice', permlink: 'p1' }, navigate: vi.fn() },
  auth: { isConnected: true, isAccredited: true, username: 'alice' },
  toast: { show: vi.fn() },
  broadcastConfirm: { request: vi.fn(() => Promise.resolve(true)) },
};

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => mockStores[name] || {}),
  },
}));

import Alpine from 'alpinejs';
import { broadcastOps } from '../../src/signer.js';
import { initEditPage } from '../../src/pages/edit.js';

function createComponent() {
  initEditPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$store = mockStores;
  comp.$t = (key) => key;
  comp.$watch = vi.fn();
  comp.$nextTick = vi.fn((fn) => fn && fn());
  return comp;
}

describe('editPage handleSubmit sanitization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStores.auth.isConnected = true;
    mockStores.auth.isAccredited = true;
    mockStores.auth.username = 'alice';
  });

  // FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND: broadcast failure
  // surfaces a generic localized message; raw err reaches console.warn.
  it('sanitizes broadcast failure: generic message to DOM, raw err to console.warn', async () => {
    const leaky = new Error('edit broadcast boom hex=deadbeefcafebabe');
    broadcastOps.mockRejectedValueOnce(leaky);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const comp = createComponent();
    // Prefill minimal state so handleSubmit proceeds past guards and into
    // the broadcast path. The paper object is required by the try block
    // (references this.paper.author in the edit branch).
    comp.paper = {
      author: 'alice',
      permlink: 'p1',
      body: 'old body',
      json_metadata: JSON.stringify({ pevotest: { version: 1 } }),
    };
    comp._originalBody = '## Abstract\n\nold abstract\n\n---\n\nold body';
    comp.title = 'Title';
    comp.abstract = 'new abstract';
    comp.body = 'new body';
    comp.discipline = 'Physics';
    comp.authorName = 'Alice';
    comp.authorAffiliation = 'MIT';
    comp.authorOrcid = '';
    comp.keywordsText = 'quantum';

    await comp.handleSubmit();

    expect(comp.step).toBe('error');
    expect(comp.errorMessage).toBe('common.editFailed');
    expect(comp.errorMessage).not.toContain('deadbeef');
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][1]).toBe(leaky);
    warnSpy.mockRestore();
  });

  // UI-SETTIMEOUT-NAVIGATE-TEARDOWN-GUARD-SWEEP: the 1.5s post-success
  // redirect must be cancelable on BOTH the same-author edit path and
  // the continuation path. If the user navigates away during the wait,
  // destroy() clears the pending timer and navigate MUST NOT fire.
  it('same-author edit path: destroy() cancels the post-success redirect timer', async () => {
    vi.useFakeTimers();
    const { invalidatePaperCache } = await import('../../src/api.js');
    broadcastOps.mockResolvedValue({ tx_id: 'tx' });
    invalidatePaperCache.mockResolvedValue({});

    const comp = createComponent();
    // Same-author path: username === paper.author and no continuation chain
    // (head_author === author && head_permlink === permlink).
    mockStores.auth.username = 'alice';
    comp.paper = {
      author: 'alice',
      permlink: 'p1',
      head_author: 'alice',
      head_permlink: 'p1',
      canonical_author: 'alice',
      canonical_permlink: 'p1',
      body: 'old body',
      json_metadata: JSON.stringify({ pevotest: { version: 1 } }),
      title: 'Old Title',
    };
    comp._originalBody = '## Abstract\n\nold abstract\n\n---\n\nold body';
    comp.title = 'New Title';
    comp.abstract = 'new abstract';
    comp.body = 'new body';
    comp.discipline = 'Physics';
    comp.authorName = 'Alice';
    comp.authorAffiliation = 'MIT';
    comp.authorOrcid = '';
    comp.keywordsText = 'quantum';

    await comp.handleSubmit();
    expect(comp.step).toBe('success');
    expect(mockStores.router.navigate).not.toHaveBeenCalled();

    comp.destroy();
    vi.advanceTimersByTime(3000);
    expect(mockStores.router.navigate).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('continuation path: destroy() cancels the post-success redirect timer', async () => {
    vi.useFakeTimers();
    const { invalidatePaperCache } = await import('../../src/api.js');
    broadcastOps.mockResolvedValue({ tx_id: 'tx' });
    invalidatePaperCache.mockResolvedValue({});

    const comp = createComponent();
    // Continuation path: username !== paper.author (different user editing)
    // forces isContinuation=true and routes through the continuation branch.
    mockStores.auth.username = 'bob';
    comp.paper = {
      author: 'alice',
      permlink: 'p1',
      head_author: 'alice',
      head_permlink: 'p1',
      canonical_author: 'alice',
      canonical_permlink: 'p1',
      body: 'old body',
      json_metadata: JSON.stringify({ pevotest: { version: 1 } }),
      title: 'Old Title',
      versions: [{ version_number: 1 }],
    };
    comp._originalBody = '## Abstract\n\nold abstract\n\n---\n\nold body';
    comp.title = 'Continuation Title';
    comp.abstract = 'new abstract';
    comp.body = 'new body';
    comp.discipline = 'Physics';
    comp.authorName = 'Bob';
    comp.authorAffiliation = 'Harvard';
    comp.authorOrcid = '';
    comp.keywordsText = 'quantum';

    await comp.handleSubmit();
    expect(comp.step).toBe('success');
    expect(mockStores.router.navigate).not.toHaveBeenCalled();

    comp.destroy();
    vi.advanceTimersByTime(3000);
    expect(mockStores.router.navigate).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

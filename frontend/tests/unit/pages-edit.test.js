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
import { fetchPaper, fetchPaperEnrichment } from '../../src/api.js';
import { initEditPage } from '../../src/pages/edit.js';

// Sentinel the DOM-bound field / toast must NOT contain.
const LEAK_SENTINEL = 'deadbeef-leak-sentinel';

function leakyError() {
  return new Error(`server leak: ${LEAK_SENTINEL} pg=table_not_found`);
}

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

  // UI-ASYNC-CONTINUATION-TEARDOWN-GUARD-SWEEP: post-destroy() async
  // continuation catches must not write step/errorMessage. A broadcast
  // that rejects after Alpine tears the component down would otherwise
  // mutate a destroyed reactive scope.
  // UI-ERR-MESSAGE-SANITIZE-PAPER-DETAIL-SURVIVORS: the loadPaperData catch
  // block was sanitized in commit 0ee5bfe to bind a generic localized key
  // instead of err?.message. Mirrors the pages-paper-detail.test.js pattern.
  // The catch fires on unexpected failures after the Promise.allSettled
  // (e.g. a synchronous throw in _prefillForm during post-fetch bookkeeping),
  // and the error binding must use this.$t('edit.loadError') — not err.message.
  it('loadPaperData catch: generic key bound to loadError, raw err to warn, no leak', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchPaper.mockResolvedValue({ data: { author: 'alice', permlink: 'p1', body: '', json_metadata: '{}' } });
    fetchPaperEnrichment.mockResolvedValue({ data: {} });

    const comp = createComponent();
    comp._mounted = true;
    const err = leakyError();
    // Force the catch branch by making post-fetch bookkeeping throw.
    comp._prefillForm = () => { throw err; };

    await comp.loadPaperData();

    expect(comp.loadError).toBe('edit.loadError');
    expect(comp.loadError).not.toContain(LEAK_SENTINEL);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][1]).toBe(err);
    warnSpy.mockRestore();
  });

  // Round-2 item 2: $watch handlers + storage listener registration
  // moved out of loadPaperData() into init()/_setupReactiveBindings().
  // The Retry button at edit.js:50 re-invokes loadPaperData(); before
  // the refactor each retry duplicated 8 $watch handlers (Alpine's
  // returned unsubscribe handle was discarded) and overwrote
  // _storageListener without removeEventListener'ing the prior one. The
  // invariant: registrations happen exactly once across init + N
  // loadPaperData calls.
  describe('reactive bindings register exactly once across retries', () => {
    it('init() registers all 8 $watch handlers + 1 storage listener; subsequent loadPaperData() does not re-register', async () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
      fetchPaper.mockResolvedValue({ data: { author: 'alice', permlink: 'p1', body: '', json_metadata: '{}' } });
      fetchPaperEnrichment.mockResolvedValue({ data: {} });

      const comp = createComponent();
      comp._mounted = true;

      // init() is the canonical entry. It calls _setupReactiveBindings()
      // and then loadPaperData(). We assert post-init state then verify
      // a second loadPaperData() is invariant.
      comp.init();
      const watchCallsAfterInit = comp.$watch.mock.calls.length;
      const storageListenersAfterInit = addEventListenerSpy.mock.calls.filter(
        c => c[0] === 'storage'
      ).length;

      expect(watchCallsAfterInit).toBe(8); // title, abstract, body, keywordsText, authorName, authorAffiliation, authorOrcid, citations
      expect(storageListenersAfterInit).toBe(1);

      // Retry: simulate the user clicking the Retry button after a
      // (hypothetical) load error.
      await comp.loadPaperData();

      const watchCallsAfterRetry = comp.$watch.mock.calls.length;
      const storageListenersAfterRetry = addEventListenerSpy.mock.calls.filter(
        c => c[0] === 'storage'
      ).length;

      // Invariant: no duplication.
      expect(watchCallsAfterRetry).toBe(watchCallsAfterInit);
      expect(storageListenersAfterRetry).toBe(storageListenersAfterInit);

      addEventListenerSpy.mockRestore();
    });
  });

  // UI-EDIT-LOADPAPERDATA-CONCURRENT-RETRY-GUARD: loadPaperData() is
  // re-entrant via the Retry button at edit.js:50. Without an in-flight
  // guard, double-clicking Retry on a slow network races two fetches;
  // the slower-resolving one overwrites _originalBody / this.paper,
  // corrupting the diff base for the next native edit. The
  // _loadInFlight flag guards the entry; it must clear in finally on
  // both success and Promise.allSettled-rejection paths so a
  // failed-then-retry sequence still works.
  describe('loadPaperData concurrent-retry guard', () => {
    it('rapid concurrent invocation: only one fetch fires; post-state reflects single consistent result', async () => {
      let resolveFetch;
      const slowFetch = new Promise((resolve) => { resolveFetch = resolve; });
      fetchPaper.mockReturnValueOnce(slowFetch);
      fetchPaperEnrichment.mockResolvedValue({ data: {} });

      const comp = createComponent();
      comp._mounted = true;

      // Fire two synchronous calls before the slow fetch resolves.
      // Without the guard p2 would call fetchPaper a second time,
      // race p1, and either corrupt this.paper / _originalBody on
      // resolution-order skew or set loadError via paperRes.value
      // being undefined (subsequent mockReturnValueOnce exhausted).
      const p1 = comp.loadPaperData();
      const p2 = comp.loadPaperData();

      resolveFetch({ data: { author: 'alice', permlink: 'p1', body: 'first body', json_metadata: '{}' } });

      await Promise.all([p1, p2]);

      // Mutation-kill: removing the guard makes this 2.
      expect(fetchPaper).toHaveBeenCalledTimes(1);
      expect(comp.paper).toBeTruthy();
      expect(comp.paper.author).toBe('alice');
      expect(comp._originalBody).toContain('first body');
      // Without the guard, p2's failed allSettled value lands in the
      // catch block and writes loadError; with the guard, no error.
      expect(comp.loadError).toBeNull();
      expect(comp._loadInFlight).toBe(false);
    });

    it('flag resets after Promise.allSettled rejection so retry can proceed', async () => {
      fetchPaper.mockRejectedValueOnce(new Error('boom'));
      fetchPaper.mockResolvedValueOnce({ data: { author: 'alice', permlink: 'p1', body: 'recovery body', json_metadata: '{}' } });
      fetchPaperEnrichment.mockResolvedValue({ data: {} });

      const comp = createComponent();
      comp._mounted = true;

      // First load: paperRes.status === 'rejected', sets loadError,
      // returns early. Finally clears _loadInFlight regardless.
      await comp.loadPaperData();
      expect(comp.loadError).toBe('edit.loadError');
      expect(comp._loadInFlight).toBe(false);

      // Retry: must proceed because the flag was cleared.
      await comp.loadPaperData();
      expect(fetchPaper).toHaveBeenCalledTimes(2);
      expect(comp.paper).toBeTruthy();
      expect(comp.paper.author).toBe('alice');
    });
  });

  // STEP_IN_PROGRESS is a positive-set inclusion list used by isSubmitting.
  // Mirrors the parameterized table pattern in pages-publish.test.js and
  // pages-review.test.js. A regression that drops a step name from
  // STEP_IN_PROGRESS would silently re-enable Submit mid-flight; the
  // unrecognized-step case pins the positive-set semantics so a typo or
  // future step name keeps the button disabled by default.
  describe('isSubmitting', () => {
    it.each([
      ['idle', false],
      ['success', false],
      ['error', false],
      ['diffing', true],
      ['uploading', true],
      ['broadcasting', true],
      ['unknown-future-step', false],
    ])('step=%s -> isSubmitting=%s', (step, expected) => {
      const comp = createComponent();
      comp.step = step;
      expect(comp.isSubmitting).toBe(expected);
    });
  });

  // UI-COAUTHOR-CONTINUATION-PUBLISHING: a co-author who already has a
  // post in the version chain (e.g. bob with bob/cont-1) must native-edit
  // their existing post on subsequent edits, not balloon the chain with a
  // new continuation post per edit. The version-chain walk surfaces the
  // user's own post; isContinuation flips to false; broadcast targets the
  // user's (author, permlink) pair from the chain.
  describe('userPostInChain / chain-aware native edit', () => {
    it('userPostInChain returns null when no version is authored by the user', () => {
      const comp = createComponent();
      mockStores.auth.username = 'carol';
      comp.paper = {
        author: 'alice', permlink: 'p1',
        head_author: 'bob', head_permlink: 'cont-1',
        versions: [
          { version_number: 1, author: 'alice', permlink: 'p1' },
          { version_number: 2, author: 'bob', permlink: 'cont-1' },
        ],
      };
      expect(comp.userPostInChain).toBeNull();
    });

    // Round-2 item 8: dedicated unit spec for the user-is-chain-head
    // partition. Previously only exercised indirectly via the
    // handleSubmit broadcast-target test; making the partition explicit
    // protects against regressions in the version walk's tail behavior.
    it('userPostInChain returns the head entry when the user IS the chain head', () => {
      const comp = createComponent();
      mockStores.auth.username = 'bob';
      comp.paper = {
        author: 'alice', permlink: 'p1',
        head_author: 'bob', head_permlink: 'cont-1',
        versions: [
          { version_number: 1, author: 'alice', permlink: 'p1' },
          { version_number: 2, author: 'bob', permlink: 'cont-1' },
        ],
      };
      const own = comp.userPostInChain;
      expect(own).not.toBeNull();
      expect(own.author).toBe('bob');
      expect(own.permlink).toBe('cont-1');
    });

    it('userPostInChain returns the latest entry where author === username', () => {
      const comp = createComponent();
      mockStores.auth.username = 'bob';
      comp.paper = {
        author: 'alice', permlink: 'p1',
        head_author: 'bob', head_permlink: 'cont-1',
        versions: [
          { version_number: 1, author: 'alice', permlink: 'p1' },
          { version_number: 2, author: 'bob', permlink: 'cont-1' },
          { version_number: 3, author: 'bob', permlink: 'cont-1' },
        ],
      };
      const own = comp.userPostInChain;
      expect(own).not.toBeNull();
      expect(own.author).toBe('bob');
      expect(own.permlink).toBe('cont-1');
      expect(own.version_number).toBe(3);
    });

    it('isContinuation flips to false when the user has a post in the chain', () => {
      const comp = createComponent();
      mockStores.auth.username = 'bob';
      comp.paper = {
        author: 'alice', permlink: 'p1',
        head_author: 'bob', head_permlink: 'cont-1',
        versions: [
          { version_number: 1, author: 'alice', permlink: 'p1' },
          { version_number: 2, author: 'bob', permlink: 'cont-1' },
        ],
      };
      expect(comp.isContinuation).toBe(false);
    });

    it('isContinuation stays true for a named co-author who has not yet published', () => {
      const comp = createComponent();
      mockStores.auth.username = 'carol';
      comp.paper = {
        author: 'alice', permlink: 'p1',
        head_author: 'bob', head_permlink: 'cont-1',
        versions: [
          { version_number: 1, author: 'alice', permlink: 'p1' },
          { version_number: 2, author: 'bob', permlink: 'cont-1' },
        ],
      };
      expect(comp.isContinuation).toBe(true);
    });

    // Round-2 item 3: the `ownPost ?` ternary in handleSubmit's edit
    // branch is a load-bearing null guard for the sparse-versions
    // root-author case (versions[] entries lack author/permlink in some
    // HAF-replay-not-run states). isContinuation returns false because
    // username === paper.author and chain pointers indicate single-post,
    // but userPostInChain returns null because the version walk found no
    // matching `author` field. The broadcast must target paper.author /
    // paper.permlink, not throw on null.author.
    it('sparse-versions root-author edit: broadcast targets paper.author/permlink (ownPost null guard load-bearing)', async () => {
      const { invalidatePaperCache } = await import('../../src/api.js');
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      invalidatePaperCache.mockResolvedValue({});

      const comp = createComponent();
      mockStores.auth.username = 'alice';
      comp.paper = {
        author: 'alice', permlink: 'p1',
        head_author: 'alice', head_permlink: 'p1',
        canonical_author: 'alice', canonical_permlink: 'p1',
        body: 'old body',
        json_metadata: JSON.stringify({ pevotest: { version: 1 } }),
        title: 'Old Title',
        // Sparse versions[] without author/permlink fields — the shape
        // the backend emits when HAF replay returns nothing.
        versions: [{ version_number: 1 }],
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

      // Pre-condition: isContinuation false (sparse-versions fallback,
      // username === paper.author), userPostInChain null (no entry
      // carries an `author` field).
      expect(comp.isContinuation).toBe(false);
      expect(comp.userPostInChain).toBeNull();

      await comp.handleSubmit();

      expect(comp.step).toBe('success');
      const commentOp = broadcastOps.mock.calls[0][1][0];
      // Targets paper.author/paper.permlink via the `ownPost ?` null
      // guard. A regression that drops the ternary would crash on
      // `null.author` and never reach this assertion.
      expect(commentOp[1].author).toBe('alice');
      expect(commentOp[1].permlink).toBe('p1');
    });

    it('isContinuation falls back to legacy semantics when versions[] is sparse', () => {
      // papers.ts emits a synthetic single-version stub (no author/permlink)
      // when HAF replay returns nothing. The fallback must keep
      // single-version paper edits working — same-author native-edit when
      // username === paper.author, continuation otherwise.
      const comp = createComponent();
      comp.paper = {
        author: 'alice', permlink: 'p1',
        head_author: 'alice', head_permlink: 'p1',
        versions: [{ version_number: 1 }],
      };
      mockStores.auth.username = 'alice';
      expect(comp.isContinuation).toBe(false);
      mockStores.auth.username = 'bob';
      expect(comp.isContinuation).toBe(true);
    });

    it('returning co-author native-edits their own post: broadcast targets userPostInChain author/permlink, not paper.author', async () => {
      const { invalidatePaperCache } = await import('../../src/api.js');
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      invalidatePaperCache.mockResolvedValue({});

      const comp = createComponent();
      mockStores.auth.username = 'bob';
      comp.paper = {
        author: 'alice', permlink: 'p1',
        head_author: 'bob', head_permlink: 'cont-1',
        canonical_author: 'alice', canonical_permlink: 'p1',
        body: 'old body',
        json_metadata: JSON.stringify({ pevotest: { version: 1 } }),
        title: 'Old Title',
        versions: [
          { version_number: 1, author: 'alice', permlink: 'p1' },
          { version_number: 2, author: 'bob', permlink: 'cont-1' },
        ],
      };
      comp._originalBody = '## Abstract\n\nold abstract\n\n---\n\nold body';
      comp.title = 'Bob revises his version';
      comp.abstract = 'revised';
      comp.body = 'revised body';
      comp.discipline = 'Physics';
      comp.authorName = 'Bob';
      comp.authorAffiliation = 'Harvard';
      comp.authorOrcid = '';
      comp.keywordsText = 'quantum';

      await comp.handleSubmit();

      expect(comp.step).toBe('success');
      expect(broadcastOps).toHaveBeenCalledTimes(1);
      const [, ops] = broadcastOps.mock.calls[0];
      // Single comment op (native edit), no comment_options follow-up
      // — that's the new-continuation shape.
      expect(ops).toHaveLength(1);
      const commentOp = ops[0];
      expect(commentOp[0]).toBe('comment');
      // Target is bob/cont-1 (Bob's own existing post in the chain),
      // NOT alice/p1 (the canonical root) and NOT a fresh permlink.
      expect(commentOp[1].author).toBe('bob');
      expect(commentOp[1].permlink).toBe('cont-1');
      // The collapsed `allAuthors[0].hive = username` (formerly the
      // vestigial `isContinuation ? username : paper.author` ternary)
      // must embed the broadcaster, not the canonical root author. A
      // regression that re-introduces the ternary would silently set
      // authors[0].hive to 'alice' here even though Bob is the
      // broadcaster — undetectable without parsing json_metadata.
      const parsedMeta = JSON.parse(commentOp[1].json_metadata);
      expect(parsedMeta.pevotest.authors[0].hive).toBe('bob');
      // Cache invalidation keys off the canonical root (papers endpoint
      // resolves any chain entry to canonical before reading).
      expect(invalidatePaperCache).toHaveBeenCalledWith('alice', 'p1');
    });

    it('non-head native edit broadcasts full body, not a diff (diff base would be wrong)', async () => {
      // Alice (root author) editing alice/p1 while the chain head is
      // bob/cont-1. The form pre-fills from the chain head body, but
      // alice/p1's actual on-chain body is different — applying a diff
      // computed against bob's body to alice's post would corrupt it.
      const { invalidatePaperCache } = await import('../../src/api.js');
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      invalidatePaperCache.mockResolvedValue({});

      const comp = createComponent();
      mockStores.auth.username = 'alice';
      comp.paper = {
        author: 'alice', permlink: 'p1',
        head_author: 'bob', head_permlink: 'cont-1',
        canonical_author: 'alice', canonical_permlink: 'p1',
        body: 'bob current body',
        json_metadata: JSON.stringify({ pevotest: { version: 1 } }),
        title: 'Bob version title',
        versions: [
          { version_number: 1, author: 'alice', permlink: 'p1' },
          { version_number: 2, author: 'bob', permlink: 'cont-1' },
        ],
      };
      comp._originalBody = '## Abstract\n\nbob abstract\n\n---\n\nbob current body';
      comp.title = 'Alice revises';
      comp.abstract = 'alice abstract';
      comp.body = 'alice body revision';
      comp.discipline = 'Physics';
      comp.authorName = 'Alice';
      comp.authorAffiliation = 'MIT';
      comp.authorOrcid = '';
      comp.keywordsText = 'quantum';

      await comp.handleSubmit();

      expect(comp.step).toBe('success');
      const commentOp = broadcastOps.mock.calls[0][1][0];
      // Targets alice/p1 (her own post in chain).
      expect(commentOp[1].author).toBe('alice');
      expect(commentOp[1].permlink).toBe('p1');
      // Body is the FULL composed body, not a `@@`-diff. Hive applies
      // diffs against the post's own body; since paper.body is bob's body
      // and the target is alice/p1, only full-body broadcast is safe.
      expect(commentOp[1].body.startsWith('@@')).toBe(false);
      expect(commentOp[1].body).toContain('alice abstract');
      expect(commentOp[1].body).toContain('alice body revision');
    });

    it('head-author native edit still computes diff (diff base IS the chain head body)', async () => {
      // Bob (chain head) edits bob/cont-1. paper.body IS bob's current
      // body, so the diff is correct and the size optimization applies.
      const { invalidatePaperCache } = await import('../../src/api.js');
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      invalidatePaperCache.mockResolvedValue({});

      const comp = createComponent();
      mockStores.auth.username = 'bob';
      comp.paper = {
        author: 'alice', permlink: 'p1',
        head_author: 'bob', head_permlink: 'cont-1',
        canonical_author: 'alice', canonical_permlink: 'p1',
        body: 'bob current body that is reasonably long to make the diff a worthwhile optimization compared to a full-body resend on chain space.',
        json_metadata: JSON.stringify({ pevotest: { version: 1 } }),
        title: 'Bob version',
        versions: [
          { version_number: 1, author: 'alice', permlink: 'p1' },
          { version_number: 2, author: 'bob', permlink: 'cont-1' },
        ],
      };
      // _originalBody matches paper.body shape (composed) — head case.
      comp._originalBody = '## Abstract\n\nbob abstract that is also reasonably long to encourage the diff path\n\n---\n\nbob current body that is reasonably long to make the diff a worthwhile optimization compared to a full-body resend on chain space.';
      comp.title = 'Bob version';
      comp.abstract = 'bob abstract that is also reasonably long to encourage the diff path';
      // Tiny tweak so a diff is meaningfully smaller than a full body resend.
      comp.body = 'bob current body that is reasonably long to make the diff a worthwhile optimization compared to a full-body resend on chain space TWEAK.';
      comp.discipline = 'Physics';
      comp.authorName = 'Bob';
      comp.authorAffiliation = 'Harvard';
      comp.authorOrcid = '';
      comp.keywordsText = 'quantum';

      await comp.handleSubmit();

      expect(comp.step).toBe('success');
      const commentOp = broadcastOps.mock.calls[0][1][0];
      expect(commentOp[1].author).toBe('bob');
      expect(commentOp[1].permlink).toBe('cont-1');
      // Diff path: body should start with @@ when the diff was smaller
      // than the full body. Both this and the full-body fallback are
      // valid Hive comment ops, so this assertion just guards the
      // size-optimization regression we're protecting.
      expect(commentOp[1].body.startsWith('@@')).toBe(true);
    });
  });

  it('handleSubmit catch does not write step=error / errorMessage after destroy()', async () => {
    let rejectFn;
    broadcastOps.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
    const comp = createComponent();
    mockStores.auth.username = 'alice';
    comp.paper = {
      author: 'alice',
      permlink: 'p1',
      head_author: 'alice',
      head_permlink: 'p1',
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

    const pending = comp.handleSubmit();
    // Let the flow progress into the pending broadcastOps.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    comp.destroy();
    rejectFn(new Error('post-teardown boom'));
    await pending;
    expect(comp.step).not.toBe('error');
    expect(comp.errorMessage).toBe('');
  });
});

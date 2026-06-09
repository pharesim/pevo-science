import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal test harness for frontend/src/pages/edit.js focused on the
// FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND catch-block behavior.
// The handleSubmit() flow is long, but all error shapes land in the same
// terminal catch: set step = 'error', console.warn the raw err, bind the
// generic i18n key to errorMessage.

// Mocked createEditor for the dynamic `await import('../editor.js')` inside
// _mountEditors. The test for the teardown-during-init guard asserts that
// the FACTORY is not invoked when the component is destroyed before the
// dynamic import resolves — i.e. that the `if (!this._mounted) return;` is
// reached before createEditor runs.
const mockCreateEditor = vi.fn(() => ({
  destroy: vi.fn(),
  setContent: vi.fn(),
}));

vi.mock('../../src/editor.js', () => ({
  createEditor: (...args) => mockCreateEditor(...args),
}));

vi.mock('../../src/api.js', () => ({
  fetchPaper: vi.fn(),
  fetchPaperEnrichment: vi.fn(),
  invalidatePaperCache: vi.fn(),
  fetchAccreditations: vi.fn(() => Promise.resolve({ data: [] })),
}));

// Supplementary-file upload goes through the batch session in
// lib/ipfs-upload.js (mirrors pages-publish.test.js). edit.js's submit handler
// drives `createUploadSession().upload(file)` and `dispose()` in a finally;
// route every upload through one controllable fn and expose dispose so the
// supplementary-upload test can assert both fired.
const mockSessionUpload = vi.fn();
const mockSessionDispose = vi.fn();
vi.mock('../../src/lib/ipfs-upload.js', () => ({
  createUploadSession: () => ({
    upload: (...a) => mockSessionUpload(...a),
    dispose: (...a) => mockSessionDispose(...a),
  }),
  uploadFile: (...a) => mockSessionUpload(...a),
  describeUploadError: (err) =>
    err?.code === 'UPLOAD_REAUTH_UNAVAILABLE' ? 'common.uploadReauthRequired'
      : err?.code === 'UPLOAD_CANCELLED' ? 'common.uploadCancelled'
        : 'common.uploadFailed',
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

  // UI-EDIT-NARROW-GATING-DROP-ACCREDITED-FALLBACK: isAuthorized recognises
  // exactly three paths to the edit form — original author, named co-author,
  // accepted authorship-claimer. Accreditation alone is NOT sufficient (the
  // dropped fallback). The backend continuation consent-gate filters
  // non-co-author continuations from chain reconstruction, so the UI affordance
  // for accredited non-authors silently failed before this narrowing.
  describe('isAuthorized', () => {
    it('returns true for the original author', () => {
      const comp = createComponent();
      mockStores.auth.username = 'alice';
      comp.paper = { author: 'alice', permlink: 'p1', authors: [], authorship_claims: [] };
      expect(comp.isAuthorized).toBe(true);
    });

    it('returns true for a named co-author', () => {
      const comp = createComponent();
      mockStores.auth.username = 'bob';
      comp.paper = {
        author: 'alice', permlink: 'p1',
        authors: [{ hive: 'bob' }],
        authorship_claims: [],
      };
      expect(comp.isAuthorized).toBe(true);
    });

    it('returns true for an accepted authorship-claimer', () => {
      const comp = createComponent();
      mockStores.auth.username = 'carol';
      comp.paper = {
        author: 'alice', permlink: 'p1', authors: [],
        authorship_claims: [{ claimer: 'carol', status: 'accepted' }],
      };
      expect(comp.isAuthorized).toBe(true);
    });

    // Mutation-kill for the dropped fallback. The accredited-non-author has
    // no positive path. Restoring `|| this.isAccredited` (or any equivalent
    // re-introduction of the auth-store fallback) makes this assertion fail
    // because the mocked auth store defaults to isAccredited: true.
    it('returns false for an accredited non-author with no claim', () => {
      const comp = createComponent();
      mockStores.auth.username = 'dave';
      mockStores.auth.isAccredited = true;
      comp.paper = { author: 'alice', permlink: 'p1', authors: [], authorship_claims: [] };
      expect(comp.isAuthorized).toBe(false);
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

  // UI-MOUNT-EDITORS-DESTROYED-GUARD: _mountEditors awaits a dynamic import
  // of editor.js. If the component is destroyed (Alpine teardown) between
  // the $nextTick dispatch and the import resolving, $refs are stale and
  // any editor instances created post-await leak (destroy() already nulled
  // _abstractEditor / _bodyEditor, so it cannot tear down what we assign
  // afterwards). The guard is a `if (!this._mounted) return;` immediately
  // after the dynamic import.
  describe('_mountEditors teardown-during-init guard', () => {
    beforeEach(() => {
      mockCreateEditor.mockClear();
    });

    it('is a no-op when the component was destroyed before the import resolved', async () => {
      const comp = createComponent();
      // Simulate teardown that races with the in-flight dynamic import:
      // destroy() flips _mounted to false. The guard inside _mountEditors
      // must short-circuit before calling createEditor.
      comp.destroy();
      expect(comp._mounted).toBe(false);

      // Stale $refs are what destroy() would have left behind. The guard
      // must fire BEFORE these are touched.
      comp.$refs = { abstractEditor: null, bodyEditor: null };
      comp._abstractEditor = null;
      comp._bodyEditor = null;

      await comp._mountEditors();

      expect(mockCreateEditor).not.toHaveBeenCalled();
      expect(comp._abstractEditor).toBe(null);
      expect(comp._bodyEditor).toBe(null);
      // Mutation-kill for `if (!this._mounted) { ...; return; }`: the reset of
      // _editorsInitialized to false is reachable ONLY via the mounted-guard
      // early-return branch (the synchronous prefix sets it to true; the
      // null-ref guards in production return BEFORE any reset). If the
      // mounted-guard block is removed, _editorsInitialized stays true and
      // this assertion fails.
      expect(comp._editorsInitialized).toBe(false);
    });

    it('still mounts editors when the component is alive at import resolution', async () => {
      const comp = createComponent();
      // Simulate live refs after $nextTick.
      const abstractEl = {};
      const bodyEl = {};
      comp.$refs = { abstractEditor: abstractEl, bodyEditor: bodyEl };

      await comp._mountEditors();

      // Guard does NOT fire — createEditor runs for both refs.
      expect(mockCreateEditor).toHaveBeenCalledTimes(2);
      expect(comp._abstractEditor).toBeTruthy();
      expect(comp._bodyEditor).toBeTruthy();
    });

    // Mount-during-mount idempotency: loadPaperData's _loadInFlight mutex
    // clears in `finally` before _mountEditors actually runs (deferred via
    // $nextTick + async import). A Retry that lands in that window can
    // schedule a second _mountEditors; the `_editorsInitialized` guard at the
    // top short-circuits the second call synchronously, so createEditor runs
    // exactly twice total (one abstract + one body), not four times.
    it('is idempotent when invoked concurrently before the first import resolves', async () => {
      const comp = createComponent();
      const abstractEl = {};
      const bodyEl = {};
      comp.$refs = { abstractEditor: abstractEl, bodyEditor: bodyEl };

      // Two concurrent calls. The second hits `if (this._editorsInitialized)
      // return;` synchronously, before the first call's `await import(...)`
      // resolves, so it never reaches createEditor.
      const p1 = comp._mountEditors();
      const p2 = comp._mountEditors();
      await Promise.all([p1, p2]);

      expect(mockCreateEditor).toHaveBeenCalledTimes(2);
      // Both instances come from the FIRST _mountEditors invocation — no
      // orphaned-and-replaced pair from a second mount.
      expect(comp._abstractEditor).toBe(mockCreateEditor.mock.results[0].value);
      expect(comp._bodyEditor).toBe(mockCreateEditor.mock.results[1].value);
    });

    // The idempotency flag must clear on destroy so a later legitimate remount
    // (live-reload, navigation back to the page) can re-mount editors fresh.
    it('releases the idempotency flag on destroy so a later remount can re-init', async () => {
      const comp = createComponent();
      comp.$refs = { abstractEditor: {}, bodyEditor: {} };

      await comp._mountEditors();
      expect(comp._editorsInitialized).toBe(true);

      comp.destroy();
      expect(comp._editorsInitialized).toBe(false);
    });
  });
});

// Held re-review item 3: page-integration of the ORCID prefill flow on
// edit.js. The new-co-author rows mirror publish.js's behavior; the
// existing-co-author rows must stay disabled regardless of accreditation
// state (the publish/edit asymmetry the task calls out).
describe('editPage co-author ORCID prefill (page integration)', () => {
  const directory = {
    alice: { username: 'alice', orcid: '0000-0001-1111-1111', name: 'Alice' },
    bob: { username: 'bob', orcid: '0000-0002-2222-2222', name: 'Bob' },
    carol: { username: 'carol', name: 'Carol' }, // accredited, no orcid in record
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updateNewCoAuthor: typing accredited hive prefills ORCID + locks the input', () => {
    const comp = createComponent();
    comp.accreditedDirectory = directory;
    comp.newCoAuthors = [{ name: 'A', hive: '', orcid: '', affiliation: '' }];
    comp.updateNewCoAuthor(0, 'hive', 'alice');
    expect(comp.newCoAuthors[0].orcid).toBe('0000-0001-1111-1111');
    expect(comp.isNewCoAuthorAccredited(0)).toBe(true);
  });

  it('updateNewCoAuthor: typing non-accredited hive leaves ORCID editable', () => {
    const comp = createComponent();
    comp.accreditedDirectory = directory;
    comp.newCoAuthors = [{ name: 'A', hive: '', orcid: '', affiliation: '' }];
    comp.updateNewCoAuthor(0, 'hive', 'mallory');
    expect(comp.newCoAuthors[0].orcid).toBe('');
    expect(comp.isNewCoAuthorAccredited(0)).toBe(false);
  });

  // ITEM 1
  it('updateNewCoAuthor: accredited→non-accredited transition clears prefilled ORCID', () => {
    const comp = createComponent();
    comp.accreditedDirectory = directory;
    comp.newCoAuthors = [{ name: 'A', hive: '', orcid: '', affiliation: '' }];
    comp.updateNewCoAuthor(0, 'hive', 'alice');
    expect(comp.newCoAuthors[0].orcid).toBe('0000-0001-1111-1111');
    comp.updateNewCoAuthor(0, 'hive', 'mallory');
    expect(comp.newCoAuthors[0].orcid).toBe('');
    expect(comp.isNewCoAuthorAccredited(0)).toBe(false);
  });

  it('updateNewCoAuthor: stay-accredited hive change rewrites ORCID to the new accreditation', () => {
    const comp = createComponent();
    comp.accreditedDirectory = directory;
    comp.newCoAuthors = [{ name: 'A', hive: '', orcid: '', affiliation: '' }];
    comp.updateNewCoAuthor(0, 'hive', 'alice');
    expect(comp.newCoAuthors[0].orcid).toBe('0000-0001-1111-1111');
    comp.updateNewCoAuthor(0, 'hive', 'bob');
    expect(comp.newCoAuthors[0].orcid).toBe('0000-0002-2222-2222');
  });

  // ITEM 9
  it('updateNewCoAuthor: accredited hive with no orcid in directory leaves typed orcid intact', () => {
    const comp = createComponent();
    comp.accreditedDirectory = directory;
    comp.newCoAuthors = [{ name: 'A', hive: '', orcid: '0000-9999-9999-9999', affiliation: '' }];
    comp.updateNewCoAuthor(0, 'hive', 'carol');
    expect(comp.newCoAuthors[0].orcid).toBe('0000-9999-9999-9999');
    expect(comp.isNewCoAuthorAccredited(0)).toBe(true);
  });

  // ITEM 2
  it('_loadAccreditedDirectory: reapplication preserves user-typed ORCID on a draft row', async () => {
    const { _resetAccreditedDirectoryForTests } = await import('../../src/lib/accredited-directory.js');
    _resetAccreditedDirectoryForTests();
    const { fetchAccreditations } = await import('../../src/api.js');
    fetchAccreditations.mockResolvedValueOnce({
      data: [
        { username: 'alice', orcid: '0000-0001-1111-1111', name: 'Alice' },
      ],
    });

    const comp = createComponent();
    comp.newCoAuthors = [
      { name: 'A', hive: 'alice', orcid: '0000-9999-9999-9999', affiliation: '' },
    ];

    await comp._loadAccreditedDirectory();

    expect(comp.newCoAuthors[0].orcid).toBe('0000-9999-9999-9999');
    expect(comp.accreditedDirectory.alice).toBeDefined();
    expect(comp.isNewCoAuthorAccredited(0)).toBe(true);
  });

  it('_loadAccreditedDirectory: reapplication fills blank ORCID on an accredited new-row', async () => {
    const { _resetAccreditedDirectoryForTests } = await import('../../src/lib/accredited-directory.js');
    _resetAccreditedDirectoryForTests();
    const { fetchAccreditations } = await import('../../src/api.js');
    fetchAccreditations.mockResolvedValueOnce({
      data: [
        { username: 'alice', orcid: '0000-0001-1111-1111', name: 'Alice' },
      ],
    });

    const comp = createComponent();
    comp.newCoAuthors = [
      { name: 'A', hive: 'alice', orcid: '', affiliation: '' },
    ];

    await comp._loadAccreditedDirectory();

    expect(comp.newCoAuthors[0].orcid).toBe('0000-0001-1111-1111');
  });

  it('_loadAccreditedDirectory: bails out if component teardown happened mid-fetch', async () => {
    const { _resetAccreditedDirectoryForTests } = await import('../../src/lib/accredited-directory.js');
    _resetAccreditedDirectoryForTests();
    const { fetchAccreditations } = await import('../../src/api.js');
    let resolveFn;
    fetchAccreditations.mockReturnValueOnce(new Promise((r) => { resolveFn = r; }));

    const comp = createComponent();
    comp.newCoAuthors = [{ name: 'A', hive: 'alice', orcid: '', affiliation: '' }];

    const pending = comp._loadAccreditedDirectory();
    comp._teardownTimers();
    resolveFn({ data: [{ username: 'alice', orcid: '0000-0001-1111-1111' }] });
    await pending;

    expect(comp.accreditedDirectory).toEqual({});
  });

  // Edit-specific asymmetry: existingCoAuthors are always disabled in the
  // template regardless of accreditation state. The page does not expose a
  // helper analogous to `isNewCoAuthorAccredited` for the existing rows,
  // and the template hardcodes `disabled` on every existing-row input.
  // Assert that no method on the page would re-enable an existing row.
  it('existingCoAuthors remain disabled in the template (no enabling helper exists)', () => {
    const comp = createComponent();
    comp.accreditedDirectory = directory;
    comp.existingCoAuthors = [
      { name: 'Old', hive: 'alice', orcid: 'whatever', affiliation: '' },
    ];
    // There is no `updateCoAuthor` (singular) or `isCoAuthorAccredited`
    // helper on the edit page — only the `New*` variants. Confirm the
    // surface explicitly so future maintainers do not accidentally add
    // a re-enable path that mutates the read-only existing rows.
    expect(comp.updateNewCoAuthor).toBeTypeOf('function');
    expect(comp.isNewCoAuthorAccredited).toBeTypeOf('function');
    expect(comp.updateCoAuthor).toBeUndefined();
    expect(comp.isCoAuthorAccredited).toBeUndefined();
  });
});

// UI-PAPERS-ORCID-NULL-FALLBACK-VERIFICATION: backend's vouch-coauthor
// spoof-suppression branch in buildCumulativeAuthorsForChain emits
// `authors[].orcid = null` for accredited authors on continuation chains.
// The API contract at `agents/docs/api-contracts/papers.md` widened the
// field to `string | null`. Edit-page _prefillForm is the only SPA site
// that consumes paper authors[].orcid in a non-template context.
//
// These tests pin data-side normalization: _prefillForm coalesces a null
// orcid to '' for BOTH the primary author (authorOrcid) and existing
// co-authors, so a re-broadcast carries the form's canonical ''-for-absent
// shape rather than a read-side null. The original regression intent
// (_prefillForm does not throw on a null orcid from the API) is preserved:
// null is accepted as input and coalesced. The template binding
// `:value="ca.orcid || ''"` remains as defense-in-depth; asserting it
// end-to-end would require mounting Alpine via jsdom and is out of scope.
describe('editPage _prefillForm null-orcid regression (UI-PAPERS-ORCID-NULL-FALLBACK)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStores.auth.isConnected = true;
    mockStores.auth.isAccredited = true;
    mockStores.auth.username = 'alice';
  });

  it('primary author with orcid: null normalizes to authorOrcid = ""', () => {
    const comp = createComponent();
    comp.paper = {
      title: 'A Paper',
      body: 'Abstract\n\n---\n\nBody',
      json_metadata: {
        pevotest: {
          authors: [
            { name: 'Alice', hive: 'alice', orcid: null, affiliation: 'MIT' },
          ],
        },
      },
      authors: [
        { name: 'Alice', hive: 'alice', orcid: null, affiliation: 'MIT' },
      ],
    };

    expect(() => comp._prefillForm()).not.toThrow();
    expect(comp.authorOrcid).toBe('');
    expect(comp.authorName).toBe('Alice');
    expect(comp.authorAffiliation).toBe('MIT');
  });

  it('existing co-authors with orcid: null normalize to "" on existingCoAuthors without throwing', () => {
    const comp = createComponent();
    comp.paper = {
      title: 'A Paper',
      body: 'Abstract\n\n---\n\nBody',
      json_metadata: {
        pevotest: {
          authors: [
            { name: 'Alice', hive: 'alice', orcid: '0000-0001-2345-6789', affiliation: 'MIT' },
            { name: 'Bob', hive: 'bob', orcid: null, affiliation: 'Harvard' },
            { name: 'Carol', hive: 'carol', orcid: null, affiliation: '' },
          ],
        },
      },
      authors: [
        { name: 'Alice', hive: 'alice', orcid: '0000-0001-2345-6789', affiliation: 'MIT' },
        { name: 'Bob', hive: 'bob', orcid: null, affiliation: 'Harvard' },
        { name: 'Carol', hive: 'carol', orcid: null, affiliation: '' },
      ],
    };

    expect(() => comp._prefillForm()).not.toThrow();
    expect(comp.existingCoAuthors).toHaveLength(2);
    // Pin the data-side normalization: _prefillForm coalesces a null orcid
    // on existing co-author rows to '' (consistent with the primary author),
    // so a re-broadcast carries the form's canonical shape. The template
    // binding `:value="ca.orcid || ''"` remains as defense-in-depth;
    // asserting it would require mounting Alpine via jsdom.
    expect(comp.existingCoAuthors[0].orcid).toBe('');
    expect(comp.existingCoAuthors[1].orcid).toBe('');
  });

  it('primary author with orcid: null AND no other fields set still prefills cleanly', () => {
    const comp = createComponent();
    comp.paper = {
      title: '',
      body: '',
      json_metadata: { pevotest: { authors: [{ name: '', hive: 'alice', orcid: null }] } },
      authors: [{ name: '', hive: 'alice', orcid: null }],
    };

    expect(() => comp._prefillForm()).not.toThrow();
    expect(comp.authorOrcid).toBe('');
    expect(comp.authorName).toBe('');
    expect(comp.authorAffiliation).toBe('');
  });
});

// A revision must default to "same authors as before" so co-authors aren't
// silently dropped at the write path. _prefillForm seats the broadcaster's
// prior entry into the editable primary fields and keeps every other author
// (including Hive-less display-only credits) as a read-only existing row,
// sourcing from the API cumulative-union authors[] rather than raw chain
// json_metadata. Author ORDER is preserved across the revision: the
// broadcaster edits their entry in place rather than being hoisted to front.
describe('editPage author-list prefill on revision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStores.auth.isConnected = true;
    mockStores.auth.isAccredited = true;
    mockStores.auth.username = 'alice';
  });

  // Prefill sources from the API-resolved authors[], not the raw head-post
  // json_metadata claim, so the cumulative-union set carries forward.
  // Distinguished by giving the two surfaces divergent data.
  it('prefills from API authors[], not raw json_metadata pevo.authors', () => {
    const comp = createComponent();
    mockStores.auth.username = 'alice';
    comp.paper = {
      title: 'A Paper',
      body: 'abstract\n\n---\n\nbody',
      json_metadata: { pevotest: { authors: [{ name: 'StaleName', hive: 'alice' }] } },
      authors: [
        { name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' },
        { name: 'Bob', hive: 'bob', orcid: '', affiliation: 'Harvard' },
      ],
    };

    comp._prefillForm();

    // From p.authors (the resolved set), NOT json_metadata's 'StaleName'.
    expect(comp.authorName).toBe('Alice');
    expect(comp.authorAffiliation).toBe('MIT');
    expect(comp.existingCoAuthors).toHaveLength(1);
    expect(comp.existingCoAuthors[0].hive).toBe('bob');
    expect(comp._primaryIndex).toBe(0);
  });

  // Source fallback: when the API p.authors is absent or empty (a surface
  // that didn't resolve the cumulative-union set), _prefillForm falls back to
  // the raw json_metadata pevo.authors claim, so the broadcaster and the
  // claimed co-authors are still seated rather than starting from an empty
  // form.
  it('falls back to raw json_metadata authors when API p.authors is empty', () => {
    const comp = createComponent();
    mockStores.auth.username = 'alice';
    comp.paper = {
      title: 'A Paper',
      body: 'abstract\n\n---\n\nbody',
      json_metadata: {
        pevotest: {
          authors: [
            { name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' },
            { name: 'Bob', hive: 'bob', orcid: '', affiliation: 'Harvard' },
          ],
        },
      },
      authors: [], // API resolved set absent/empty -> fall back to chain claim
    };

    comp._prefillForm();

    expect(comp._primaryIndex).toBe(0);
    expect(comp.authorName).toBe('Alice');
    expect(comp.authorAffiliation).toBe('MIT');
    expect(comp.existingCoAuthors).toHaveLength(1);
    expect(comp.existingCoAuthors[0].hive).toBe('bob');
  });

  // When a co-author (not the original first author) revises, the broadcaster
  // is seated into the primary fields but their original index is recorded,
  // and every other author stays as an existing row.
  it('seats the broadcaster in place and records _primaryIndex (co-author revision)', () => {
    const comp = createComponent();
    mockStores.auth.username = 'bob';
    comp.paper = {
      title: 'A Paper',
      body: 'abstract\n\n---\n\nbody',
      json_metadata: { pevotest: {} },
      authors: [
        { name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' },
        { name: 'Bob', hive: 'bob', orcid: '', affiliation: 'Harvard' },
      ],
    };

    comp._prefillForm();

    expect(comp.authorName).toBe('Bob');
    expect(comp.authorAffiliation).toBe('Harvard');
    expect(comp._primaryIndex).toBe(1);
    // Alice (the other author) is the only existing row, kept read-only.
    expect(comp.existingCoAuthors).toHaveLength(1);
    expect(comp.existingCoAuthors[0].hive).toBe('alice');
  });

  // Hive-less display-only credits (hive: null) are prefilled into the
  // existing rows so they aren't dropped on re-broadcast.
  it('carries Hive-less display-only credits into existingCoAuthors', () => {
    const comp = createComponent();
    mockStores.auth.username = 'alice';
    comp.paper = {
      title: 'A Paper',
      body: 'abstract\n\n---\n\nbody',
      json_metadata: { pevotest: {} },
      authors: [
        { name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' },
        { name: 'Carol Hiveless', hive: null, orcid: '0000-0003-3333-3333', affiliation: 'Oxford' },
      ],
    };

    comp._prefillForm();

    expect(comp.existingCoAuthors).toHaveLength(1);
    expect(comp.existingCoAuthors[0].name).toBe('Carol Hiveless');
    expect(comp.existingCoAuthors[0].hive).toBeNull();
  });

  // Defensive name fallback: a read-only existing row can't be edited to add
  // a missing name, so prefill guarantees one (name -> hive -> orcid),
  // mirroring the backend read-time fallback. orcid normalizes null -> ''.
  it('applies a name fallback (hive) to a name-less existing entry, normalizing orcid', () => {
    const comp = createComponent();
    mockStores.auth.username = 'alice';
    comp.paper = {
      title: 'A Paper',
      body: 'abstract\n\n---\n\nbody',
      json_metadata: { pevotest: {} },
      authors: [
        { name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' },
        { name: '', hive: 'bob', orcid: null, affiliation: 'Harvard' },
      ],
    };

    comp._prefillForm();

    expect(comp.existingCoAuthors[0].name).toBe('bob'); // fell back to hive
    expect(comp.existingCoAuthors[0].orcid).toBe(''); // null normalized to ''
  });

  // Broadcaster not yet a listed author (an accepted-claim co-author's first
  // continuation): the full prior list is kept and the broadcaster is an
  // addition (_primaryIndex stays -1), so prior order is left intact.
  it('keeps the full prior list when the broadcaster is not yet listed (_primaryIndex -1)', () => {
    const comp = createComponent();
    mockStores.auth.username = 'carol';
    comp.paper = {
      title: 'A Paper',
      body: 'abstract\n\n---\n\nbody',
      json_metadata: { pevotest: {} },
      authors: [
        { name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' },
        { name: 'Bob', hive: 'bob', orcid: '', affiliation: 'Harvard' },
      ],
    };

    comp._prefillForm();

    expect(comp._primaryIndex).toBe(-1);
    expect(comp.existingCoAuthors).toHaveLength(2);
    expect(comp.existingCoAuthors.map(a => a.hive)).toEqual(['alice', 'bob']);
  });

  // End-to-end order preservation: Bob revising [Alice, Bob] re-broadcasts
  // [Alice, Bob] — Bob stays at index 1, NOT hoisted to the front.
  it('re-broadcasts the prior author set in original order (no reorder, no drop)', async () => {
    const { invalidatePaperCache } = await import('../../src/api.js');
    broadcastOps.mockResolvedValue({ tx_id: 'tx' });
    invalidatePaperCache.mockResolvedValue({});

    const comp = createComponent();
    mockStores.auth.username = 'bob';
    comp.paper = {
      author: 'alice', permlink: 'p1',
      head_author: 'alice', head_permlink: 'p1',
      canonical_author: 'alice', canonical_permlink: 'p1',
      title: 'A Paper',
      body: 'abstract\n\n---\n\nbody',
      json_metadata: { pevotest: { version: 1 } },
      versions: [{ version_number: 1 }],
      authors: [
        { name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' },
        { name: 'Bob', hive: 'bob', orcid: '', affiliation: 'Harvard' },
      ],
    };

    comp._prefillForm();
    comp.title = 'Revised';
    comp.abstract = 'new abstract';
    comp.body = 'new body';
    comp.discipline = 'Physics';
    comp.keywordsText = 'quantum';

    // Continuation (bob !== paper.author, sparse versions) routes through the
    // continuation broadcast branch where allAuthors lands in json_metadata.
    expect(comp.isContinuation).toBe(true);
    await comp.handleSubmit();

    expect(comp.step).toBe('success');
    const commentOp = broadcastOps.mock.calls[0][1][0];
    const meta = JSON.parse(commentOp[1].json_metadata);
    expect(meta.pevotest.authors.map(a => a.hive)).toEqual(['alice', 'bob']);
    expect(meta.pevotest.authors[1].name).toBe('Bob');
  });

  // A new author addition lands at the end, after the preserved prior set.
  it('appends an accepted-claim broadcaster after the preserved prior set', async () => {
    const { invalidatePaperCache } = await import('../../src/api.js');
    broadcastOps.mockResolvedValue({ tx_id: 'tx' });
    invalidatePaperCache.mockResolvedValue({});

    const comp = createComponent();
    mockStores.auth.username = 'carol';
    comp.paper = {
      author: 'alice', permlink: 'p1',
      head_author: 'alice', head_permlink: 'p1',
      canonical_author: 'alice', canonical_permlink: 'p1',
      title: 'A Paper',
      body: 'abstract\n\n---\n\nbody',
      json_metadata: { pevotest: { version: 1 } },
      versions: [{ version_number: 1 }],
      authors: [
        { name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' },
        { name: 'Bob', hive: 'bob', orcid: '', affiliation: 'Harvard' },
      ],
    };

    comp._prefillForm();
    comp.authorName = 'Carol'; // broadcaster fills in their own name
    comp.title = 'Revised';
    comp.abstract = 'new abstract';
    comp.body = 'new body';
    comp.discipline = 'Physics';
    comp.keywordsText = 'quantum';

    await comp.handleSubmit();

    expect(comp.step).toBe('success');
    const commentOp = broadcastOps.mock.calls[0][1][0];
    const meta = JSON.parse(commentOp[1].json_metadata);
    expect(meta.pevotest.authors.map(a => a.hive)).toEqual(['alice', 'bob', 'carol']);
  });

  describe('per-entry name requirement blocks submission', () => {
    function paperWith(authors) {
      return {
        author: 'alice', permlink: 'p1',
        head_author: 'alice', head_permlink: 'p1',
        canonical_author: 'alice', canonical_permlink: 'p1',
        title: 'A Paper',
        body: 'abstract\n\n---\n\nbody',
        json_metadata: { pevotest: { version: 1 } },
        versions: [{ version_number: 1 }],
        authors,
      };
    }

    it('blocks submission when a new co-author row has data but no name', async () => {
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      const comp = createComponent();
      mockStores.auth.username = 'alice';
      comp.paper = paperWith([{ name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' }]);
      comp._prefillForm();
      comp.title = 'Revised';
      comp.abstract = 'a';
      comp.body = 'b';
      comp.discipline = 'Physics';
      // Partial new co-author: hive filled, name empty.
      comp.newCoAuthors = [{ name: '', hive: 'mallory', orcid: '', affiliation: '' }];

      await comp.handleSubmit();

      expect(comp._hasIncompleteAuthor()).toBe(true);
      expect(broadcastOps).not.toHaveBeenCalled();
      expect(comp.step).toBe('idle');
      expect(mockStores.toast.show).toHaveBeenCalledWith('edit.authorNameRequired', 'error');
    });

    it('allows submission when a new co-author row is wholly blank (unused row, dropped)', async () => {
      const { invalidatePaperCache } = await import('../../src/api.js');
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      invalidatePaperCache.mockResolvedValue({});
      const comp = createComponent();
      mockStores.auth.username = 'alice';
      comp.paper = paperWith([{ name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' }]);
      comp._prefillForm();
      comp.title = 'Revised';
      comp.abstract = 'a';
      comp.body = 'b';
      comp.discipline = 'Physics';
      comp.newCoAuthors = [{ name: '', hive: '', orcid: '', affiliation: '' }];

      expect(comp._hasIncompleteAuthor()).toBe(false);
      await comp.handleSubmit();

      expect(comp.step).toBe('success');
      const commentOp = broadcastOps.mock.calls[0][1][0];
      const meta = JSON.parse(commentOp[1].json_metadata);
      // Blank row dropped: only Alice remains.
      expect(meta.pevotest.authors.map(a => a.hive)).toEqual(['alice']);
    });

    it('blocks submission when the primary author name is empty', async () => {
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      const comp = createComponent();
      mockStores.auth.username = 'alice';
      comp.paper = paperWith([{ name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' }]);
      comp._prefillForm();
      comp.authorName = '   '; // whitespace-only
      comp.title = 'Revised';
      comp.abstract = 'a';
      comp.body = 'b';
      comp.discipline = 'Physics';

      await comp.handleSubmit();

      expect(broadcastOps).not.toHaveBeenCalled();
      expect(comp.step).toBe('idle');
    });
  });
});

// handleSubmit drops duplicate-hive author entries before broadcast so a
// revision never persists a redundant entry in json_metadata.authors. Two
// sources produce a duplicate: a prior author set already carrying the same
// hive twice, or a new co-author row colliding with an existing author by
// hive. First occurrence wins, order is preserved, and Hive-less display-only
// credits (no account identity) are never deduped against each other. The
// backend re-dedups on read; this is a write-path cleanliness guard.
describe('editPage handleSubmit drops duplicate-hive authors on re-broadcast', () => {
  function paperWith(authors) {
    return {
      author: 'alice', permlink: 'p1',
      head_author: 'alice', head_permlink: 'p1',
      canonical_author: 'alice', canonical_permlink: 'p1',
      title: 'A Paper',
      body: 'abstract\n\n---\n\nbody',
      json_metadata: { pevotest: { version: 1 } },
      versions: [{ version_number: 1 }],
      authors,
    };
  }

  async function broadcastAuthors(comp) {
    comp.title = 'Revised';
    comp.abstract = 'new abstract';
    comp.body = 'new body';
    comp.discipline = 'Physics';
    comp.keywordsText = 'quantum';
    await comp.handleSubmit();
    expect(comp.step).toBe('success');
    const commentOp = broadcastOps.mock.calls[0][1][0];
    return JSON.parse(commentOp[1].json_metadata).pevotest.authors;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockStores.auth.isConnected = true;
    mockStores.auth.isAccredited = true;
    const { invalidatePaperCache } = await import('../../src/api.js');
    broadcastOps.mockResolvedValue({ tx_id: 'tx' });
    invalidatePaperCache.mockResolvedValue({});
  });

  // Source 1: the prior author set already carries the same hive twice.
  // First occurrence wins, so the kept entry is the first 'bob' ('Bob'),
  // not the duplicate ('Bob Dup').
  it('collapses a prior set that carries the same hive twice (first occurrence wins)', async () => {
    const comp = createComponent();
    mockStores.auth.username = 'alice';
    comp.paper = paperWith([
      { name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' },
      { name: 'Bob', hive: 'bob', orcid: '', affiliation: 'Harvard' },
      { name: 'Bob Dup', hive: 'bob', orcid: '', affiliation: 'Elsewhere' },
    ]);
    comp._prefillForm();

    const authors = await broadcastAuthors(comp);

    expect(authors.map((a) => a.hive)).toEqual(['alice', 'bob']);
    expect(authors.find((a) => a.hive === 'bob').name).toBe('Bob');
  });

  // Source 2: a new co-author row's hive collides with an existing author.
  // The new row does not add a second entry for that account.
  it('drops a new co-author whose hive matches an existing author', async () => {
    const comp = createComponent();
    mockStores.auth.username = 'alice';
    comp.paper = paperWith([
      { name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' },
      { name: 'Bob', hive: 'bob', orcid: '', affiliation: 'Harvard' },
    ]);
    comp._prefillForm();
    comp.newCoAuthors = [{ name: 'Bob Again', hive: 'bob', orcid: '', affiliation: 'Elsewhere' }];

    const authors = await broadcastAuthors(comp);

    expect(authors.map((a) => a.hive)).toEqual(['alice', 'bob']);
    expect(authors.find((a) => a.hive === 'bob').name).toBe('Bob');
  });

  // Hive-less display-only credits carry no account identity and must all be
  // preserved — they are never collapsed together even though they share the
  // falsy hive value.
  it('preserves every Hive-less display-only credit (no collapse)', async () => {
    const comp = createComponent();
    mockStores.auth.username = 'alice';
    comp.paper = paperWith([
      { name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' },
      { name: 'Carol', hive: null, orcid: '', affiliation: 'Oxford' },
      { name: 'Dave', hive: null, orcid: '', affiliation: 'Cambridge' },
    ]);
    comp._prefillForm();

    const authors = await broadcastAuthors(comp);

    expect(authors.map((a) => a.hive)).toEqual(['alice', null, null]);
    expect(authors.map((a) => a.name)).toEqual(['Alice', 'Carol', 'Dave']);
  });

  // A non-string hive (e.g. a number) is reachable via the broadcaster-controlled
  // raw json_metadata author fallback and is unvalidated. The dedup key must not
  // call string methods on it: a non-string hive carries no usable account
  // identity, so it is treated as hive-less (preserved, never collapsed) rather
  // than throwing a TypeError that would abort the whole revision broadcast.
  it('treats a non-string hive as hive-less: broadcast succeeds with the entry preserved', async () => {
    const comp = createComponent();
    mockStores.auth.username = 'alice';
    comp.paper = paperWith([
      { name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' },
      { name: 'Numeric', hive: 12345, orcid: '', affiliation: 'Poisoned' },
    ]);
    comp._prefillForm();

    const authors = await broadcastAuthors(comp);

    expect(authors.map((a) => a.hive)).toEqual(['alice', 12345]);
    expect(authors.map((a) => a.name)).toEqual(['Alice', 'Numeric']);
  });
});

// edit.js's submit handler uploads new supplementary files through ONE batch
// upload session: createUploadSession() -> upload(sf.file) per file ->
// dispose() in a finally. The structurally-identical publish.js path is tested
// in pages-publish.test.js; this covers the edit page so the session wiring is
// not silently broken (the prior stale `uploadToIpfs` mock gave false green).
describe('editPage handleSubmit supplementary-file upload session', () => {
  function basePaper() {
    return {
      author: 'alice', permlink: 'p1',
      head_author: 'alice', head_permlink: 'p1',
      canonical_author: 'alice', canonical_permlink: 'p1',
      body: 'old body',
      json_metadata: JSON.stringify({ pevotest: { version: 1 } }),
      title: 'Old Title',
      versions: [{ version_number: 1 }],
    };
  }

  function fillForm(comp) {
    comp._originalBody = '## Abstract\n\nold abstract\n\n---\n\nold body';
    comp.title = 'New Title';
    comp.abstract = 'new abstract';
    comp.body = 'new body';
    comp.discipline = 'Physics';
    comp.authorName = 'Alice';
    comp.authorAffiliation = 'MIT';
    comp.authorOrcid = '';
    comp.keywordsText = 'quantum';
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockStores.auth.isConnected = true;
    mockStores.auth.isAccredited = true;
    mockStores.auth.username = 'alice';
    const { invalidatePaperCache } = await import('../../src/api.js');
    broadcastOps.mockResolvedValue({ tx_id: 'tx' });
    invalidatePaperCache.mockResolvedValue({});
  });

  it('drives the session: upload() called per file, cid embedded, dispose() runs in finally', async () => {
    mockSessionUpload.mockResolvedValue({ data: { cid: 'bafycid123' } });

    const comp = createComponent();
    comp.paper = basePaper();
    fillForm(comp);
    const file = new Blob(['x'], { type: 'application/pdf' });
    comp.supplementaryFiles = [{
      file,
      fileName: 'data.pdf',
      description: 'dataset',
      cid: null,
      error: null,
      uploading: false,
    }];

    await comp.handleSubmit();

    expect(comp.step).toBe('success');
    // The session's upload() ran for the one supplementary file.
    expect(mockSessionUpload).toHaveBeenCalledTimes(1);
    expect(mockSessionUpload).toHaveBeenCalledWith(file);
    // dispose() always runs (the finally around the upload loop).
    expect(mockSessionDispose).toHaveBeenCalledTimes(1);
    // The returned cid is embedded in the broadcast json_metadata.
    const commentOp = broadcastOps.mock.calls[0][1][0];
    const meta = JSON.parse(commentOp[1].json_metadata).pevotest;
    expect(meta.supplementary_files).toEqual([
      expect.objectContaining({ cid: 'bafycid123', filename: 'data.pdf' }),
    ]);
  });

  it('dispose() still runs in the finally when an upload throws', async () => {
    mockSessionUpload.mockRejectedValueOnce(new Error('ipfs boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const comp = createComponent();
    comp.paper = basePaper();
    fillForm(comp);
    comp.supplementaryFiles = [{
      file: new Blob(['x'], { type: 'application/pdf' }),
      fileName: 'data.pdf',
      description: 'dataset',
      cid: null,
      error: null,
      uploading: false,
    }];

    await comp.handleSubmit();

    expect(comp.step).toBe('error');
    expect(mockSessionUpload).toHaveBeenCalledTimes(1);
    // dispose() runs even on the upload-failure path (wipes the cached password).
    expect(mockSessionDispose).toHaveBeenCalledTimes(1);
    // The per-file inline error is the generic localized key, not the raw err.
    expect(comp.supplementaryFiles[0].error).toBe('common.uploadFailed');
    expect(broadcastOps).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Minimal test harness for frontend/src/pages/edit.js focused on the
// error-message-sanitization catch-block behavior.
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

// The real lib/fresh-auth.js runs in these tests (only its api.js dependencies
// are stubbed), so the acquire-before-commit ordering the page relies on is
// exercised end to end rather than asserted against a stubbed gate.
const mockFetchEmailStatus = vi.fn(() => Promise.resolve({ data: { hasPassword: true } }));
const mockMintSessionAuthProof = vi.fn();
const mockStartOrcid = vi.fn();
vi.mock('../../src/api.js', () => ({
  fetchPaper: vi.fn(),
  fetchPaperEnrichment: vi.fn(),
  invalidatePaperCache: vi.fn(),
  fetchAccreditations: vi.fn(() => Promise.resolve({ data: [] })),
  fetchEmailStatus: (...a) => mockFetchEmailStatus(...a),
  mintSessionAuthProof: (...a) => mockMintSessionAuthProof(...a),
  startOrcid: (...a) => mockStartOrcid(...a),
  consentOpRequestFields: (t) => t,
}));

// Supplementary-file upload goes through `uploadFile` in lib/ipfs-upload.js
// (mirrors pages-publish.test.js), which acquires the shared session window
// itself; route every upload through one controllable fn so the
// supplementary-upload tests can drive per-case resolve/reject.
const mockSessionUpload = vi.fn();
vi.mock('../../src/lib/ipfs-upload.js', () => ({
  uploadFile: (...a) => mockSessionUpload(...a),
  UPLOAD_SESSION_TORN_DOWN: 'UPLOAD_SESSION_TORN_DOWN',
  // Mirrors the real mapper, including the null contract for the
  // already-reported teardown code (the teardown's own toast is the message).
  describeUploadError: (err) =>
    err?.code === 'UPLOAD_SESSION_TORN_DOWN' ? null
      : err?.code === 'UPLOAD_CANCELLED' ? 'common.uploadCancelled'
        : err?.code === 'UPLOAD_REAUTH_FAILED' ? 'settings.reauthFailed'
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
  reauthModal: { request: vi.fn(() => Promise.resolve('hunter2')) },
  i18n: { messages: {} },
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
import { clearPasswordFactorMemo } from '../../src/lib/fresh-auth.js';
import { initEditPage, editPageTemplate } from '../../src/pages/edit.js';

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

  // Broadcast failure surfaces a generic localized message; raw err
  // reaches console.warn (error-message sanitization).
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

  // The 1.5s post-success redirect must be cancelable on BOTH the
  // same-author edit path and the continuation path. If the user navigates
  // away during the wait, destroy() clears the pending timer and navigate
  // MUST NOT fire.
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

  // Post-destroy() async continuation catches must not write
  // step/errorMessage. A broadcast that rejects after Alpine tears the
  // component down would otherwise mutate a destroyed reactive scope.
  // The loadPaperData catch block binds a generic localized key instead of
  // err?.message (error-message sanitization). Mirrors the
  // pages-paper-detail.test.js pattern. The catch fires on unexpected
  // failures after the Promise.allSettled (e.g. a synchronous throw in
  // _prefillForm during post-fetch bookkeeping), and the error binding must
  // use this.$t('edit.loadError') — not err.message.
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

  // $watch handlers + storage listener registration live in
  // init()/_setupReactiveBindings(), not loadPaperData(). The Retry button
  // re-invokes loadPaperData(); if registration lived there, each retry
  // would duplicate the $watch handlers (Alpine's returned unsubscribe
  // handle was discarded) and overwrite _storageListener without
  // removeEventListener'ing the prior one. The invariant: registrations
  // happen exactly once across init + N loadPaperData calls.
  describe('reactive bindings register exactly once across retries', () => {
    it('init() registers every draft $watch handler + 1 storage listener exactly once; subsequent loadPaperData() does not re-register', async () => {
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

      // Every field _scheduleDraftSave persists needs a watcher, or a change
      // to it never reaches the stored draft.
      expect(comp.$watch.mock.calls.map(([expr]) => expr)).toEqual([
        'title', 'abstract', 'body', 'keywordsText', 'authorName',
        'authorAffiliation', 'authorOrcid', 'citations', 'addressedReviews',
      ]);
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

  // loadPaperData() is re-entrant via the Retry button. Without an in-flight
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

  // isSubmitting derives from step by EXCLUSION against the three resting
  // states {idle, success, error}, mirroring publish.js. Mirrors the
  // parameterized table pattern in pages-publish.test.js and
  // pages-review.test.js. The exclusion form fails closed: an unrecognized or
  // future step name reads as in-progress and keeps Submit disabled, where an
  // inclusion list would silently re-enable the button mid-flight for any
  // step it did not register.
  describe('isSubmitting', () => {
    it.each([
      ['idle', false],
      ['success', false],
      ['error', false],
      ['authorizing', true],
      ['diffing', true],
      ['uploading', true],
      ['broadcasting', true],
      ['unknown-future-step', true],
    ])('step=%s -> isSubmitting=%s', (step, expected) => {
      const comp = createComponent();
      comp.step = step;
      expect(comp.isSubmitting).toBe(expected);
    });
  });

  // isAuthorized recognises
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

  // A co-author who already has a
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

    // Dedicated unit spec for the user-is-chain-head partition. Previously
    // only exercised indirectly via the handleSubmit broadcast-target test;
    // making the partition explicit protects against regressions in the
    // version walk's tail behavior.
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

    // The `ownPost ?` ternary in handleSubmit's edit
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
    // Let the flow progress into the pending broadcastOps. The submit sequence
    // crosses several awaits (re-auth gate, upload leg) before it reaches the
    // broadcast, so drain until the broadcast is genuinely in flight rather
    // than counting a fixed number of microtask hops.
    for (let i = 0; i < 100 && !rejectFn; i++) await Promise.resolve();
    expect(typeof rejectFn).toBe('function');
    comp.destroy();
    rejectFn(new Error('post-teardown boom'));
    await pending;
    expect(comp.step).not.toBe('error');
    expect(comp.errorMessage).toBe('');
  });

  // _mountEditors awaits a dynamic import
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

// Page-integration of the ORCID prefill flow on
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

  it('updateNewCoAuthor: accredited hive with no orcid in directory leaves typed orcid intact', () => {
    const comp = createComponent();
    comp.accreditedDirectory = directory;
    comp.newCoAuthors = [{ name: 'A', hive: '', orcid: '0000-9999-9999-9999', affiliation: '' }];
    comp.updateNewCoAuthor(0, 'hive', 'carol');
    expect(comp.newCoAuthors[0].orcid).toBe('0000-9999-9999-9999');
    expect(comp.isNewCoAuthorAccredited(0)).toBe(true);
  });

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

// Backend's vouch-coauthor
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

// edit.js's submit handler uploads new supplementary files one at a time
// through `uploadFile`, all riding the session window the submit entry
// acquired. The structurally-identical publish.js path is tested in
// pages-publish.test.js; this covers the edit page so the upload wiring is not
// silently broken (a prior stale `uploadToIpfs` mock gave false green).
describe('editPage handleSubmit supplementary-file upload', () => {
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

  it('uploads once per file and embeds the returned cid', async () => {
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
    // uploadFile ran for the one supplementary file.
    expect(mockSessionUpload).toHaveBeenCalledTimes(1);
    expect(mockSessionUpload).toHaveBeenCalledWith(file);
    // The returned cid is embedded in the broadcast json_metadata.
    const commentOp = broadcastOps.mock.calls[0][1][0];
    const meta = JSON.parse(commentOp[1].json_metadata).pevotest;
    expect(meta.supplementary_files).toEqual([
      expect.objectContaining({ cid: 'bafycid123', filename: 'data.pdf' }),
    ]);
  });

  it('aborts the submit and surfaces an inline error when an upload throws', async () => {
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
    // The per-file inline error is the generic localized key, not the raw err.
    expect(comp.supplementaryFiles[0].error).toBe('common.uploadFailed');
    expect(broadcastOps).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('a torn-down session during a supplementary upload leaves no inline retry row', async () => {
    // uploadFile's session teardown has already disconnected and shown the
    // re-login toast when its already-reported rejection reaches the page
    // (the mock stands in for both); the inline row and the error panel must
    // stay quiet on top of it, and the step machine unwinds to idle.
    mockSessionUpload.mockImplementation(async () => {
      Alpine.store('toast').show('Session inconsistency detected. Please sign in again.', 'error');
      const err = new Error('Session torn down. Sign in again.');
      err.code = 'UPLOAD_SESSION_TORN_DOWN';
      throw err;
    });

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

    // The teardown's toast is the only message: no inline row inviting a
    // retry that cannot succeed until re-login, no error panel on top.
    expect(mockStores.toast.show).toHaveBeenCalledTimes(1);
    expect(comp.supplementaryFiles[0].error).toBeNull();
    expect(comp.supplementaryFiles[0].uploading).toBe(false);
    expect(comp.step).toBe('idle');
    expect(comp.errorMessage).toBe('');
    expect(broadcastOps).not.toHaveBeenCalled();
  });
});

describe('editPage re-auth window ordering', () => {
  function unchangedLightComponent() {
    const comp = createComponent();
    mockStores.auth.custody = 'light';
    mockStores.auth.username = 'alice';
    comp.paper = {
      author: 'alice',
      permlink: 'p1',
      head_author: 'alice',
      head_permlink: 'p1',
      canonical_author: 'alice',
      canonical_permlink: 'p1',
      body: 'body text',
      // Parsed, the way `_prefillForm` leaves it: the page reads
      // `paper.json_metadata[APP_TAG]`, so a raw string would read as empty
      // metadata and every field would look changed.
      json_metadata: {
        pevotest: {
          version: 1,
          keywords: ['quantum'],
          authors: [{ name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' }],
        },
      },
      title: 'Same Title',
    };
    comp._originalBody = '## Abstract\n\nsame abstract\n\n---\n\nbody text';
    comp._primaryIndex = -1;
    comp.title = 'Same Title';
    comp.abstract = 'same abstract';
    comp.body = 'body text';
    comp.discipline = 'Physics';
    comp.authorName = 'Alice';
    comp.authorAffiliation = 'MIT';
    comp.authorOrcid = '';
    comp.keywordsText = 'quantum';
    return comp;
  }

  beforeEach(() => {
    // Fresh call counts per test (matches the sibling describes): the
    // exactly-one-toast and never-navigated assertions below must not count
    // calls made by earlier tests in this describe.
    vi.clearAllMocks();
    mockStores.reauthModal.request.mockResolvedValue('hunter2');
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: true } });
    mockMintSessionAuthProof.mockResolvedValue({
      fresh_auth_proof: 'window-proof',
      expires_at: new Date(Date.now() + 900_000).toISOString(),
      absolute_expires_at: new Date(Date.now() + 7_200_000).toISOString(),
      mechanism: 'password',
    });
    sessionStorage.clear();
    // The real fresh-auth.js memoizes a positive password answer per username
    // for the tab, and this suite reuses one username, so a prior test's
    // password-holder answer would decide a later test's factor.
    clearPasswordFactorMemo();
  });

  afterEach(() => {
    delete mockStores.auth.custody;
    sessionStorage.clear();
  });

  it('an unchanged form costs no re-auth act at all', async () => {
    // The no-op detection reads only values already in hand. Running the gate
    // first charges a password prompt — or, for a passwordless account, a
    // full-page round-trip — to come back and say nothing changed.
    const comp = unchangedLightComponent();

    await comp.handleSubmit();

    expect(comp.step).toBe('error');
    expect(comp.errorMessage).toBe('edit.noChanges');
    expect(mockStores.reauthModal.request).not.toHaveBeenCalled();
    expect(mockMintSessionAuthProof).not.toHaveBeenCalled();
    expect(broadcastOps).not.toHaveBeenCalled();
  });

  it('a real change still acquires the window before the broadcast', async () => {
    const { invalidatePaperCache } = await import('../../src/api.js');
    invalidatePaperCache.mockResolvedValue({});
    broadcastOps.mockResolvedValue({ tx_id: 'tx' });
    const comp = unchangedLightComponent();
    comp.title = 'A New Title';

    await comp.handleSubmit();

    expect(comp.step).toBe('success');
    expect(mockMintSessionAuthProof).toHaveBeenCalledTimes(1);
    expect(broadcastOps.mock.calls[0][2]).toMatchObject({ freshAuthProof: 'window-proof' });
  });

  it('disables the submit button before the first await, not after it', async () => {
    // Same double-submit hazard as the publish page: `isSubmitting` derives
    // from `step` and drives the button's :disabled, so taking the re-auth
    // await while still 'idle' leaves the button live for a second click.
    const { invalidatePaperCache } = await import('../../src/api.js');
    invalidatePaperCache.mockResolvedValue({});
    broadcastOps.mockResolvedValue({ tx_id: 'tx' });
    const comp = unchangedLightComponent();
    comp.title = 'A New Title';

    const pending = comp.handleSubmit();
    expect(comp.isSubmitting).toBe(true);

    await pending;
    expect(comp.step).toBe('success');
  });

  it('a passwordless window closing during the uploads refuses without navigation', async () => {
    // The pre-broadcast gate sits AFTER the supplementary uploads, and the
    // uploaded CIDs live in handleSubmit locals the draft does not carry. The
    // navigating factor is suppressed there, so a passwordless account gets
    // the re-authenticate toast with the pins and the form intact instead of
    // an ORCID round-trip that discards them.
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
    sessionStorage.setItem('pevo_fresh_auth_session_proof', JSON.stringify({
      token: 'live-window',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
      idlePeriodMs: 900_000,
    }));
    mockSessionUpload.mockImplementation(async () => {
      // Stand in for a slow upload: leave the window with seconds on it.
      const raw = JSON.parse(sessionStorage.getItem('pevo_fresh_auth_session_proof'));
      raw.expiresAt = new Date(Date.now() + 5_000).toISOString();
      sessionStorage.setItem('pevo_fresh_auth_session_proof', JSON.stringify(raw));
      return { data: { cid: 'bafy', filename: 'data.pdf' } };
    });

    const comp = unchangedLightComponent();
    comp.supplementaryFiles = [{
      file: new Blob(['x'], { type: 'application/pdf' }),
      fileName: 'data.pdf',
      description: '',
      cid: null,
      error: null,
      uploading: false,
    }];
    await comp.handleSubmit();

    expect(mockSessionUpload).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(broadcastOps).not.toHaveBeenCalled();
    expect(comp.step).toBe('idle');
    // The refusal was told: a suppressed gate that says nothing reads as a
    // dead button. Same assertion as the publish sibling.
    expect(mockStores.toast.show).toHaveBeenCalledWith(
      'Please confirm your identity again, then try once more.',
      'error',
    );
  });

  it('continuation posture: a passwordless window closing during the uploads refuses without navigation', async () => {
    // Twin of the same-author case above, selected onto the OTHER
    // pre-broadcast gate: the continuation and same-author gates are
    // mutually exclusive branch arms, so a fixture that resolves
    // isContinuation false proves nothing about this one. A username
    // differing from the paper's author with no version chain routes the
    // isContinuation getter to true, so the continuation gate is the one
    // that must refuse without discarding the pins.
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
    sessionStorage.setItem('pevo_fresh_auth_session_proof', JSON.stringify({
      token: 'live-window',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
      idlePeriodMs: 900_000,
    }));
    mockSessionUpload.mockImplementation(async () => {
      // Stand in for a slow upload: leave the window with seconds on it.
      const raw = JSON.parse(sessionStorage.getItem('pevo_fresh_auth_session_proof'));
      raw.expiresAt = new Date(Date.now() + 5_000).toISOString();
      sessionStorage.setItem('pevo_fresh_auth_session_proof', JSON.stringify(raw));
      return { data: { cid: 'bafy', filename: 'data.pdf' } };
    });

    const comp = unchangedLightComponent();
    mockStores.auth.username = 'bob';
    comp.authorName = 'Bob';
    comp.supplementaryFiles = [{
      file: new Blob(['x'], { type: 'application/pdf' }),
      fileName: 'data.pdf',
      description: '',
      cid: null,
      error: null,
      uploading: false,
    }];
    // Fixture-posture proof: this test exercises the continuation gate.
    expect(comp.isContinuation).toBe(true);

    await comp.handleSubmit();

    expect(mockSessionUpload).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(broadcastOps).not.toHaveBeenCalled();
    expect(comp.step).toBe('idle');
    expect(mockStores.toast.show).toHaveBeenCalledWith(
      'Please confirm your identity again, then try once more.',
      'error',
    );
  });

  it('same-author posture: a passwordless remintable 401 at the broadcast leg refuses instead of navigating', async () => {
    // The pre-broadcast gate passed on a live window and the broadcast then
    // finds it closed server-side (another tab's password reset or custody
    // upgrade). The 401 retry's re-acquisition must inherit the suppressed
    // posture the page passes to broadcastWithFreshAuth: re-authenticate
    // toast with the form intact, never a full-page ORCID navigation.
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
    sessionStorage.setItem('pevo_fresh_auth_session_proof', JSON.stringify({
      token: 'live-window',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
      idlePeriodMs: 900_000,
    }));
    broadcastOps.mockRejectedValueOnce(Object.assign(new Error('FRESH_AUTH_REQUIRED'), {
      status: 401, code: 'FRESH_AUTH_REQUIRED', details: { reason: 'expired' },
    }));

    const comp = unchangedLightComponent();
    comp.title = 'A New Title';
    // Fixture-posture proof: this test exercises the same-author branch.
    expect(comp.isContinuation).toBe(false);

    await comp.handleSubmit();

    expect(broadcastOps).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(comp.step).toBe('idle');
    expect(mockStores.toast.show).toHaveBeenCalledWith(
      'Please confirm your identity again, then try once more.',
      'error',
    );
  });

  it('continuation posture: a passwordless remintable 401 at the broadcast leg refuses instead of navigating', async () => {
    // Twin of the same-author 401 case, selected onto the continuation
    // branch's broadcast call: each broadcast call site threads its own
    // redirect posture, so each needs its own discriminating test.
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
    sessionStorage.setItem('pevo_fresh_auth_session_proof', JSON.stringify({
      token: 'live-window',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
      idlePeriodMs: 900_000,
    }));
    broadcastOps.mockRejectedValueOnce(Object.assign(new Error('FRESH_AUTH_REQUIRED'), {
      status: 401, code: 'FRESH_AUTH_REQUIRED', details: { reason: 'expired' },
    }));

    const comp = unchangedLightComponent();
    mockStores.auth.username = 'bob';
    comp.authorName = 'Bob';
    // Fixture-posture proof: this test exercises the continuation branch.
    expect(comp.isContinuation).toBe(true);

    await comp.handleSubmit();

    expect(broadcastOps).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(comp.step).toBe('idle');
    expect(mockStores.toast.show).toHaveBeenCalledWith(
      'Please confirm your identity again, then try once more.',
      'error',
    );
  });

  // Whether the form holds a new file decides whether a gate may navigate:
  // new supplementary files live in component state, never in the draft, so
  // a full-page ORCID round-trip discards them. Same rule as the publish page.
  it('a passwordless account resubmitting with a supplementary file attached refuses without navigation and keeps the file', async () => {
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
    mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
    const comp = unchangedLightComponent();
    const attached = {
      file: { name: 'data.pdf', size: 10, type: 'application/pdf' },
      fileName: 'data.pdf',
      description: '',
      cid: null,
      error: null,
      uploading: false,
    };
    comp.supplementaryFiles = [attached];

    await comp.handleSubmit();

    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(mockSessionUpload).not.toHaveBeenCalled();
    expect(broadcastOps).not.toHaveBeenCalled();
    expect(comp.supplementaryFiles).toEqual([attached]);
    expect(comp.step).toBe('idle');
    expect(mockStores.toast.show).toHaveBeenCalledWith(
      'Please confirm your identity again, then try once more.',
      'error',
    );
  });

  it('with nothing attached, the entry gate still navigates a passwordless account', async () => {
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
    mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
    vi.stubGlobal('window', { ...globalThis.window, location: { href: '', pathname: '/edit/alice/p1' } });
    try {
      const comp = unchangedLightComponent();
      comp.title = 'A New Title';

      await comp.handleSubmit();

      expect(mockStartOrcid).toHaveBeenCalledTimes(1);
      expect(window.location.href).toBe('https://orcid.org/oauth/authorize?x=1');
      expect(broadcastOps).not.toHaveBeenCalled();
      expect(comp.step).toBe('idle');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('picking more supplementary files with one already attached refuses a passwordless account without navigation and keeps it', async () => {
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
    mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
    const comp = unchangedLightComponent();
    const attached = { file: { name: 'data.pdf', size: 10 }, fileName: 'data.pdf', description: '', cid: null, error: null, uploading: false };
    comp.supplementaryFiles = [attached];
    const target = { files: [{ name: 'more.csv', size: 10 }], value: 'C:\\fakepath\\more.csv' };

    await comp.handleSupplementaryFiles({ target });

    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(comp.supplementaryFiles).toEqual([attached]);
    expect(target.value).toBe('');
    expect(mockStores.toast.show).toHaveBeenCalledWith(
      'Please confirm your identity again, then try once more.',
      'error',
    );
  });
});

// The review checklist is the one form field whose loss changes what goes on
// chain rather than only what the user retypes: a passwordless account's entry
// gate is allowed to navigate to ORCID while no new file is held, on the
// premise that everything else is drafted, and a returning form that silently
// dropped its ticks resubmits without `addresses_reviews`. Restore reconciles
// against the reviews the paper actually carries, because a tick is meaningless
// once its review is gone from the checklist.
describe('editPage draft carries the addressed-review ticks', () => {
  const DRAFT_KEY = 'pevo-draft-edit-alice-p1';

  const REV_ONE = { author: 'carol', permlink: 'rev-1', body: 'first review' };
  const REV_TWO = { author: 'dave', permlink: 'rev-2', body: 'second review' };

  function addressed(rev) {
    return { author: rev.author, permlink: rev.permlink };
  }

  // Only the fields _restoreDraft reads. `title` is the shape sentinel the
  // restore gates on, so every fixture carries it as a string.
  function storedDraft(extra = {}) {
    return JSON.stringify({
      title: 'Drafted Title',
      abstract: 'drafted abstract',
      body: 'drafted body',
      keywordsText: 'quantum',
      ...extra,
    });
  }

  // The shared createComponent() leaves $refs unset, and loadPaperData defers
  // _mountEditors through the mocked $nextTick; an empty $refs lets that
  // deferred mount find no editor elements instead of dereferencing undefined.
  function loadedComponent() {
    const comp = createComponent();
    comp._mounted = true;
    comp.$refs = {};
    return comp;
  }

  function arrangeLoad(reviews) {
    fetchPaper.mockResolvedValue({
      data: {
        author: 'alice',
        permlink: 'p1',
        head_author: 'alice',
        head_permlink: 'p1',
        canonical_author: 'alice',
        canonical_permlink: 'p1',
        title: 'Old Title',
        body: '## Abstract\n\nold abstract\n\n---\n\nold body',
        json_metadata: JSON.stringify({ pevotest: { version: 1 } }),
      },
    });
    fetchPaperEnrichment.mockResolvedValue({ data: { reviews } });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockStores.auth.isConnected = true;
    mockStores.auth.isAccredited = true;
    mockStores.auth.username = 'alice';
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: true } });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('the debounced save writes the ticks into the stored draft', () => {
    vi.useFakeTimers();
    try {
      const comp = createComponent();
      comp._initialLoadDone = true;
      comp.addressedReviews = [addressed(REV_TWO)];

      comp._scheduleDraftSave();
      vi.advanceTimersByTime(2000);

      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY));
      expect(saved.addressedReviews).toEqual([addressed(REV_TWO)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a tick change schedules that save', () => {
    vi.useFakeTimers();
    const comp = createComponent();
    try {
      comp._setupReactiveBindings();

      // The registration is the assertion: without it a tick is the one
      // change on the form that never reaches the stored draft.
      const registration = comp.$watch.mock.calls.find(([expr]) => expr === 'addressedReviews');
      expect(registration).toBeDefined();

      comp._initialLoadDone = true;
      comp.toggleAddressedReview(REV_ONE.author, REV_ONE.permlink, true);
      registration[1]();
      vi.advanceTimersByTime(2000);

      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY));
      expect(saved.addressedReviews).toEqual([addressed(REV_ONE)]);
    } finally {
      comp.destroy();
      vi.useRealTimers();
    }
  });

  it('restore reinstates a tick whose review is still on the paper', async () => {
    arrangeLoad([REV_ONE, REV_TWO]);
    localStorage.setItem(DRAFT_KEY, storedDraft({ addressedReviews: [addressed(REV_TWO)] }));

    const comp = loadedComponent();
    await comp.loadPaperData();

    expect(comp.addressedReviews).toEqual([addressed(REV_TWO)]);
  });

  it('restore drops a saved tick whose review is no longer offered', async () => {
    // rev-2 is gone from the paper by the time the form comes back.
    arrangeLoad([REV_ONE]);
    localStorage.setItem(DRAFT_KEY, storedDraft({
      addressedReviews: [addressed(REV_ONE), addressed(REV_TWO)],
    }));

    const comp = loadedComponent();
    await comp.loadPaperData();

    expect(comp.addressedReviews).toEqual([addressed(REV_ONE)]);
  });

  // The whole point of carrying the field: the resubmit after the round-trip
  // broadcasts the reviews the user ticked before it.
  it('the resubmit after a restore broadcasts addresses_reviews with the restored ticks', async () => {
    broadcastOps.mockResolvedValue({ tx_id: 'tx' });
    const { invalidatePaperCache } = await import('../../src/api.js');
    invalidatePaperCache.mockResolvedValue({});
    arrangeLoad([REV_ONE, REV_TWO]);
    localStorage.setItem(DRAFT_KEY, storedDraft({ addressedReviews: [addressed(REV_TWO)] }));

    const comp = loadedComponent();
    await comp.loadPaperData();
    comp.authorName = 'Alice';

    await comp.handleSubmit();

    expect(comp.step).toBe('success');
    const commentOp = broadcastOps.mock.calls[0][1][0];
    const meta = JSON.parse(commentOp[1].json_metadata).pevotest;
    expect(meta.addresses_reviews).toEqual([addressed(REV_TWO)]);

    comp.destroy();
  });

  // The ticks live inside the one draft object, so the post-success clear
  // takes them with the text: the next visit starts from the chain, not from
  // a tick the revision already addressed.
  it('the post-success draft clear takes the ticks with it', async () => {
    broadcastOps.mockResolvedValue({ tx_id: 'tx' });
    const { invalidatePaperCache } = await import('../../src/api.js');
    invalidatePaperCache.mockResolvedValue({});
    arrangeLoad([REV_ONE, REV_TWO]);
    localStorage.setItem(DRAFT_KEY, storedDraft({ addressedReviews: [addressed(REV_TWO)] }));

    const comp = loadedComponent();
    await comp.loadPaperData();
    // Non-vacuous: the draft has to have held a tick for the clear to have
    // anything to take.
    expect(comp.addressedReviews).toEqual([addressed(REV_TWO)]);
    comp.authorName = 'Alice';
    await comp.handleSubmit();
    expect(comp.step).toBe('success');
    expect(localStorage.getItem(DRAFT_KEY)).toBe(null);
    comp.destroy();

    const reopened = loadedComponent();
    await reopened.loadPaperData();

    expect(reopened.addressedReviews).toEqual([]);
  });

  // A restored tick has to reach the rendered checkbox. The input is not
  // x-model bound (the value is an {author, permlink} pair, not a string), so
  // a checklist that only listens for @change comes back from the round-trip
  // showing every box clear while addressedReviews holds the restored set.
  it('the checklist checkbox reflects the restored set', () => {
    expect(editPageTemplate).toContain('isReviewAddressed(rev.author, rev.permlink)');

    const comp = createComponent();
    comp.addressedReviews = [addressed(REV_TWO)];

    expect(comp.isReviewAddressed(REV_TWO.author, REV_TWO.permlink)).toBe(true);
    expect(comp.isReviewAddressed(REV_ONE.author, REV_ONE.permlink)).toBe(false);
  });
});

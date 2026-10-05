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
const mockCreateEditor = vi.fn((_el, options = {}) => {
  // Holds what it was given, as an editor would, so a page reading the text
  // back gets it.
  let markdown = options.initialMarkdown || '';
  return {
    destroy: vi.fn(),
    setContent: vi.fn((md) => { markdown = md; }),
    getMarkdown: vi.fn(() => markdown),
    normalize: vi.fn(),
    setEditable: vi.fn(),
  };
});

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
  router: { params: { author: 'alice', permlink: 'p1' }, navigate: vi.fn(), remount: vi.fn() },
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
import { fetchPaper, fetchPaperEnrichment, invalidatePaperCache } from '../../src/api.js';
import { clearPasswordFactorMemo } from '../../src/lib/fresh-auth.js';
import { initEditPage, editPageTemplate } from '../../src/pages/edit.js';
import { snapshotFields } from '../../src/lib/composer-drafts.js';

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
  // A real Alpine component always has $refs. loadPaperData schedules
  // _mountEditors through the mocked $nextTick and discards the promise, so
  // an unset $refs makes that deferred mount dereference undefined and
  // surface as an unhandled rejection after the test has already passed. An
  // empty default lets the mount find no editor elements instead. Cases that
  // need live or stale refs assign their own after construction.
  comp.$refs = {};
  return comp;
}

// Stands in for the load and the editor mount, for fixtures that build
// `paper` and the form by hand: captures the account and the paper the way a
// landed load does, and takes the baseline over the form as it stands, which
// in those fixtures is the paper as loaded. A field the test changes after
// this is the user's work, which is what a draft write needs.
function markLoaded(comp) {
  comp._captureDraftTarget();
  comp._baselineFields = snapshotFields(comp._plainFields());
  comp._baselineEditors = snapshotFields(comp._editorFields());
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

      // Every field _writeDraft persists needs a watcher, or a change to it
      // never reaches the stored draft. The order mirrors that draft object so
      // a field added to one and not the other reads as a gap.
      // The three after them replace the instance when it stops matching what
      // it captured: another account, another paper, and a submit settling
      // with a replacement pending.
      expect(comp.$watch.mock.calls.map(([expr]) => expr)).toEqual([
        'title', 'abstract', 'body', 'keywordsText', 'authorName',
        'authorAffiliation', 'authorOrcid', 'newCoAuthors', 'citations',
        'addressedReviews',
        '$store.auth.username', '$store.router.params', 'step',
      ]);
      expect(storageListenersAfterInit).toBe(1);

      // init() kicks loadPaperData() off without awaiting it, so its load is
      // still in flight here and _loadInFlight is still set. Retrying against
      // that state returns at loadPaperData's entry guard, which would prove
      // the no-duplication assertions against a call that never ran. Let
      // init's own load settle first, so the retry is a real second load. The
      // flag clears a few microtask ticks out, so poll tighter than
      // vi.waitFor's 50ms default rather than pay a fixed 50ms for it.
      await vi.waitFor(() => expect(comp._loadInFlight).toBe(false), { interval: 1 });
      expect(fetchPaper).toHaveBeenCalledTimes(1);

      // Retry: simulate the user clicking the Retry button after a
      // (hypothetical) load error.
      await comp.loadPaperData();
      expect(fetchPaper).toHaveBeenCalledTimes(2);

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
        // Parsed, as the detail endpoint serves it, and the latest op's: bob's
        // continuation, which names the post it continues.
        json_metadata: { pevotest: { version: 2, continues: { author: 'alice', permlink: 'p1' } } },
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
      // The root continues nothing, whatever the served metadata names.
      expect(JSON.parse(commentOp[1].json_metadata).pevotest).not.toHaveProperty('continues');
    });

    it('non-head native edit of a continuation post sends the post it continues, not the head\'s', async () => {
      // alice/p1 <- bob/cont-1 <- carol/cont-2. Bob edits cont-1 while carol's
      // cont-2 is the head, and the served metadata is cont-2's.
      const { invalidatePaperCache } = await import('../../src/api.js');
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      invalidatePaperCache.mockResolvedValue({});

      const comp = createComponent();
      mockStores.auth.username = 'bob';
      comp.paper = {
        author: 'alice', permlink: 'p1',
        head_author: 'carol', head_permlink: 'cont-2',
        canonical_author: 'alice', canonical_permlink: 'p1',
        body: 'carol current body',
        json_metadata: { pevotest: { version: 3, continues: { author: 'bob', permlink: 'cont-1' } } },
        title: 'Carol version title',
        versions: [
          { version_number: 1, author: 'alice', permlink: 'p1' },
          { version_number: 2, author: 'bob', permlink: 'cont-1' },
          { version_number: 3, author: 'carol', permlink: 'cont-2' },
        ],
      };
      comp._originalBody = '## Abstract\n\ncarol abstract\n\n---\n\ncarol current body';
      comp.title = 'Bob revises';
      comp.abstract = 'bob abstract';
      comp.body = 'bob body revision';
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
      expect(JSON.parse(commentOp[1].json_metadata).pevotest.continues)
        .toEqual({ author: 'alice', permlink: 'p1' });
    });

    it('head native edit of a continuation post keeps the post it continues when the latest op is the root\'s', async () => {
      // alice/p1 <- bob/cont-1 <- carol/cont-2, and alice edited p1 between
      // the two continuations and again after carol's, so the served metadata
      // is p1's and names nothing to continue, and p1 has a version listed
      // between cont-1's and cont-2's.
      const { invalidatePaperCache } = await import('../../src/api.js');
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      invalidatePaperCache.mockResolvedValue({});

      const comp = createComponent();
      mockStores.auth.username = 'carol';
      comp.paper = {
        author: 'alice', permlink: 'p1',
        head_author: 'carol', head_permlink: 'cont-2',
        canonical_author: 'alice', canonical_permlink: 'p1',
        body: 'carol current body',
        json_metadata: { pevotest: { version: 5 } },
        title: 'Carol version',
        versions: [
          { version_number: 1, author: 'alice', permlink: 'p1' },
          { version_number: 2, author: 'bob', permlink: 'cont-1' },
          { version_number: 3, author: 'alice', permlink: 'p1' },
          { version_number: 4, author: 'carol', permlink: 'cont-2' },
          { version_number: 5, author: 'alice', permlink: 'p1' },
        ],
      };
      comp._originalBody = '## Abstract\n\ncarol abstract\n\n---\n\ncarol current body';
      comp.title = 'Carol version, retitled';
      comp.abstract = 'carol abstract';
      comp.body = 'carol current body';
      comp.discipline = 'Physics';
      comp.authorName = 'Carol';
      comp.authorAffiliation = 'Oxford';
      comp.authorOrcid = '';
      comp.keywordsText = 'quantum';

      await comp.handleSubmit();

      expect(comp.step).toBe('success');
      const commentOp = broadcastOps.mock.calls[0][1][0];
      expect(commentOp[1].author).toBe('carol');
      expect(commentOp[1].permlink).toBe('cont-2');
      expect(JSON.parse(commentOp[1].json_metadata).pevotest.continues)
        .toEqual({ author: 'bob', permlink: 'cont-1' });
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

  // The editors' lifecycle is bound to the form's x-if, not to the load or
  // the component: the form's root calls _mountEditors on every render, and a
  // form that left the DOM (a sign-out hides it) and came back has new
  // elements. The template half of that pairing is pinned here, and the
  // mount's own behavior is driven through _mountEditors directly, the way the
  // template's call reaches it. The real re-render (sign out, sign back in) is
  // exercised with the real Alpine and editors in
  // composer-drafts-real-editors.test.js.
  describe('the form mounts the editors on every render', () => {
    beforeEach(() => {
      mockCreateEditor.mockClear();
    });

    it("the form root inside the form's x-if calls _mountEditors", () => {
      const formIf = 'x-if="!loadingPaper && !loadError && isAuthorized && paper">';
      const at = editPageTemplate.indexOf(formIf);
      expect(at).toBeGreaterThan(-1);
      const root = editPageTemplate.slice(at + formIf.length).trimStart();
      expect(root.startsWith('<div x-init="$nextTick(() => _mountEditors())">')).toBe(true);
    });

    it('a load mounts nothing by itself', async () => {
      fetchPaper.mockResolvedValue({ data: { author: 'alice', permlink: 'p1', body: '', json_metadata: '{}' } });
      fetchPaperEnrichment.mockResolvedValue({ data: {} });

      const comp = createComponent();
      comp.$refs = { abstractEditor: {}, bodyEditor: {} };

      await comp.loadPaperData();
      await new Promise((r) => setTimeout(r, 0));

      expect(mockCreateEditor).not.toHaveBeenCalled();
      expect(comp.$nextTick).not.toHaveBeenCalled();
    });

    it('builds one editor per ref present when the mount runs', async () => {
      const comp = createComponent();
      const abstractEl = {};
      const bodyEl = {};
      comp.$refs = { abstractEditor: abstractEl, bodyEditor: bodyEl };

      await comp._mountEditors();

      expect(mockCreateEditor).toHaveBeenCalledTimes(2);
      expect(mockCreateEditor.mock.calls[0][0]).toBe(abstractEl);
      expect(mockCreateEditor.mock.calls[1][0]).toBe(bodyEl);
    });

    it('a later render destroys the pair left on the old elements and builds one on the new', async () => {
      const comp = createComponent();
      comp.$refs = { abstractEditor: {}, bodyEditor: {} };
      await comp._mountEditors();
      const [firstAbstract, firstBody] = mockCreateEditor.mock.results.map((r) => r.value);

      const abstractEl = {};
      const bodyEl = {};
      comp.$refs = { abstractEditor: abstractEl, bodyEditor: bodyEl };
      comp.abstract = 'kept abstract';
      comp.body = 'kept body';
      await comp._mountEditors();

      expect(firstAbstract.destroy).toHaveBeenCalledTimes(1);
      expect(firstBody.destroy).toHaveBeenCalledTimes(1);
      expect(mockCreateEditor).toHaveBeenCalledTimes(4);
      expect(mockCreateEditor.mock.calls[2][0]).toBe(abstractEl);
      expect(mockCreateEditor.mock.calls[3][0]).toBe(bodyEl);
      // Built from the text the form holds, not from what was loaded.
      expect(mockCreateEditor.mock.calls[2][1].initialMarkdown).toBe('kept abstract');
      expect(mockCreateEditor.mock.calls[3][1].initialMarkdown).toBe('kept body');
      expect(comp._abstractEditor).toBe(mockCreateEditor.mock.results[2].value);
      expect(comp._bodyEditor).toBe(mockCreateEditor.mock.results[3].value);
    });

    // A sign-out while the editor import is in flight hides the form and
    // takes its elements. Nothing is built then, and nothing is taken as the
    // baseline either: the served text has not been through the editors, and
    // a baseline of it would read the next render's normalising as typing.
    it('a mount that finds the elements gone builds nothing and takes no baseline', async () => {
      const comp = createComponent();
      comp.$refs = {};

      await comp._mountEditors();

      expect(mockCreateEditor).not.toHaveBeenCalled();
      expect(comp._baselineEditors).toBe(null);
    });

    // The form takes no input until the baseline exists (anything typed
    // while the editors load would otherwise be taken for the loaded form, or
    // be replaced by the restore that follows), nor while a choice stands.
    it('the form is locked until the baseline exists and while a choice stands', async () => {
      expect(editPageTemplate).toContain('<fieldset class="space-y-6 min-w-0" :disabled="formLocked">');
      const comp = createComponent();
      comp.paper = { author: 'alice', permlink: 'p1', canonical_author: 'alice', canonical_permlink: 'p1', authors: [{ hive: 'alice' }] };
      expect(comp.formLocked).toBe(true);
      comp._baselineFields = snapshotFields(comp._plainFields());
      expect(comp.formLocked).toBe(true);
      comp.$refs = { abstractEditor: {}, bodyEditor: {} };
      await comp._mountEditors();
      expect(comp.formLocked).toBe(false);
      comp.draftChoice = 'newer';
      expect(comp.formLocked).toBe(true);
    });

    // Template side of the ref pairing. The `builds one editor per ref
    // present when the mount runs` case pins the code side (_mountEditors
    // reads exactly the abstractEditor / bodyEditor $refs keys), so
    // asserting editPageTemplate carries both x-ref names makes a rename
    // on either side of the pairing fail one of the two.
    it('declares the x-ref names _mountEditors reads in the template', () => {
      expect(editPageTemplate).toContain('x-ref="abstractEditor"');
      expect(editPageTemplate).toContain('x-ref="bodyEditor"');
    });
  });

  // _mountEditors awaits a dynamic import of editor.js. If the component is
  // destroyed (Alpine teardown) between the $nextTick dispatch and the import
  // resolving, any editor instances created post-await leak (destroy()
  // already nulled _abstractEditor / _bodyEditor, so it cannot tear down
  // what we assign afterwards). The guard is the `_mounted` check right
  // after the dynamic import.
  describe('_mountEditors teardown-during-init guard', () => {
    beforeEach(() => {
      mockCreateEditor.mockClear();
    });

    it('is a no-op when the component was destroyed before the import resolved', async () => {
      const comp = createComponent();
      // Teardown racing the in-flight dynamic import: destroy() flips
      // _mounted to false.
      comp.destroy();
      expect(comp._mounted).toBe(false);

      // Live refs, so the guard is the only thing standing between the
      // resolved import and createEditor.
      comp.$refs = { abstractEditor: {}, bodyEditor: {} };

      await comp._mountEditors();

      expect(mockCreateEditor).not.toHaveBeenCalled();
      expect(comp._abstractEditor).toBe(null);
      expect(comp._bodyEditor).toBe(null);
    });

    it('still mounts editors when the component is alive at import resolution', async () => {
      const comp = createComponent();
      comp.$refs = { abstractEditor: {}, bodyEditor: {} };

      await comp._mountEditors();

      expect(mockCreateEditor).toHaveBeenCalledTimes(2);
      expect(comp._abstractEditor).toBeTruthy();
      expect(comp._bodyEditor).toBeTruthy();
    });

    // Two renders in quick succession can put two calls in flight before the
    // first import resolves. Only the later one builds, so no pair is created
    // only to be orphaned. The later call is stood in for by its first,
    // synchronous step, the generation bump: in vitest, a second dynamic
    // import of a mocked module started while the first is in flight can
    // resolve to the real module, which a browser never does.
    it('a mount superseded while its import is in flight builds nothing', async () => {
      const comp = createComponent();
      comp.$refs = { abstractEditor: {}, bodyEditor: {} };

      const superseded = comp._mountEditors();
      comp._editorMountGeneration += 1;
      await superseded;

      expect(mockCreateEditor).not.toHaveBeenCalled();
      expect(comp._abstractEditor).toBe(null);
      expect(comp._bodyEditor).toBe(null);
    });

    it('destroy() destroys the pair it holds', async () => {
      const comp = createComponent();
      comp.$refs = { abstractEditor: {}, bodyEditor: {} };
      await comp._mountEditors();
      const [abstractEditor, bodyEditor] = mockCreateEditor.mock.results.map((r) => r.value);

      comp.destroy();

      expect(abstractEditor.destroy).toHaveBeenCalledTimes(1);
      expect(bodyEditor.destroy).toHaveBeenCalledTimes(1);
      expect(comp._abstractEditor).toBe(null);
      expect(comp._bodyEditor).toBe(null);
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

describe('editPage native edit with an unchanged body', () => {
  // A head target whose body the form leaves as loaded. The chain rejects an
  // empty body, which is what the patch of an unchanged body is.
  function unchangedBodyComponent() {
    const comp = createComponent();
    mockStores.auth.username = 'alice';
    comp.paper = {
      author: 'alice', permlink: 'p1',
      head_author: 'alice', head_permlink: 'p1',
      canonical_author: 'alice', canonical_permlink: 'p1',
      body: '## Abstract\n\nsame abstract\n\n---\n\nbody text',
      json_metadata: {
        pevotest: {
          version: 1,
          keywords: ['quantum'],
          authors: [{ name: 'Alice', hive: 'alice', orcid: '', affiliation: 'MIT' }],
        },
      },
      title: 'Same Title',
      versions: [{ version_number: 1, author: 'alice', permlink: 'p1' }],
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

  beforeEach(async () => {
    vi.clearAllMocks();
    mockStores.auth.isConnected = true;
    mockStores.auth.isAccredited = true;
    const { invalidatePaperCache } = await import('../../src/api.js');
    broadcastOps.mockResolvedValue({ tx_id: 'tx' });
    invalidatePaperCache.mockResolvedValue({});
    mockSessionUpload.mockResolvedValue({ data: { cid: 'bafycid123' } });
  });

  it.each([
    ['a title', (comp) => { comp.title = 'A New Title'; }],
    ['a supplementary file', (comp) => {
      comp.supplementaryFiles = [{
        file: new Blob(['x'], { type: 'application/pdf' }),
        fileName: 'data.pdf',
        description: 'dataset',
        cid: null,
        error: null,
        uploading: false,
      }];
    }],
    ['an addressed review', (comp) => { comp.addressedReviews = [{ author: 'carol', permlink: 'rev-1' }]; }],
  ])('an edit of only %s sends the no-op patch as the body', async (_change, applyChange) => {
    const comp = unchangedBodyComponent();
    applyChange(comp);

    await comp.handleSubmit();

    expect(comp.step).toBe('success');
    const commentOp = broadcastOps.mock.calls[0][1][0];
    expect(commentOp[1].author).toBe('alice');
    expect(commentOp[1].permlink).toBe('p1');
    expect(commentOp[1].body).toBe('@@ -0,0 +0,0 @@\n');
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

  // A broadcast leg that resolves to the redirect-pending sentinel is not a
  // landing, so the draft the entry gate flushed is what survives the
  // round-trip or the refusal. That is the draft-keep half of the invariant
  // whose step-goes-idle half the remintable-401 specs pin. Each arm returns
  // from its pending check before it reaches `_finishLanded`, and nothing
  // ahead of the broadcast raises the landed flag, so the instance is still
  // what it was before the submit: it drafts, and it accepts another submit.
  // The four redirect-pending cases hold both halves, one per branch arm,
  // mounted and unmounted. A flag raised ahead of the broadcast would stop
  // drafting for the rest of the visit without any visible sign, which is why
  // the mounted pair goes on to stage a later change and a later submit.
  //
  // `$watch` is mocked in this harness, so the scheduler stands in for the
  // watcher a later change would trigger. The later submit is observed at
  // `_windowReady`, stubbed to refuse: what the gate does for this account is
  // not the point, only that handleSubmit got as far as asking it.
  async function expectStillDraftingAndSubmittable(comp, key) {
    vi.useFakeTimers();
    try {
      comp.title = 'Retitled After The Refusal';
      comp._scheduleDraftSave();
      vi.advanceTimersByTime(2000);
      expect(JSON.parse(localStorage.getItem(key)))
        .toMatchObject({ title: 'Retitled After The Refusal' });
    } finally {
      vi.useRealTimers();
    }
    const gate = vi.spyOn(comp, '_windowReady').mockResolvedValue(false);
    await comp.handleSubmit();
    expect(gate).toHaveBeenCalledTimes(1);
    expect(comp.step).toBe('idle');
    expect(comp._landed).toBe(false);
  }

  it('same-author posture: the redirect-pending broadcast keeps the flushed draft and the instance stays drafting and submittable', async () => {
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
    // A draft left behind by an earlier case must not stand in for this
    // spec's own entry-gate flush.
    localStorage.removeItem('pevo-draft-edit:alice:alice:p1');

    const comp = unchangedLightComponent();
    markLoaded(comp);
    comp.title = 'Retitled Before The Refusal';
    // Fixture-posture proof: this test exercises the same-author branch.
    expect(comp.isContinuation).toBe(false);

    await comp.handleSubmit();

    expect(comp.step).toBe('idle');
    expect(JSON.parse(localStorage.getItem('pevo-draft-edit:alice:alice:p1')))
      .toMatchObject({ title: 'Retitled Before The Refusal' });

    await expectStillDraftingAndSubmittable(comp, 'pevo-draft-edit:alice:alice:p1');
    expect(broadcastOps).toHaveBeenCalledTimes(1);
    localStorage.removeItem('pevo-draft-edit:alice:alice:p1');
  });

  it('continuation posture: the redirect-pending broadcast keeps the flushed draft and the instance stays drafting and submittable', async () => {
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
    localStorage.removeItem('pevo-draft-edit:bob:alice:p1');

    const comp = unchangedLightComponent();
    mockStores.auth.username = 'bob';
    // An accepted claim is what lets bob edit the paper, and only an account
    // that can edit it drafts on this page.
    comp.paper.authorship_claims = [{ claimer: 'bob', status: 'accepted' }];
    markLoaded(comp);
    comp.authorName = 'Bob';
    comp.title = 'Retitled Before The Refusal';
    // Fixture-posture proof: this test exercises the continuation branch.
    expect(comp.isContinuation).toBe(true);

    await comp.handleSubmit();

    expect(comp.step).toBe('idle');
    expect(JSON.parse(localStorage.getItem('pevo-draft-edit:bob:alice:p1')))
      .toMatchObject({ title: 'Retitled Before The Refusal', authorName: 'Bob' });

    await expectStillDraftingAndSubmittable(comp, 'pevo-draft-edit:bob:alice:p1');
    expect(broadcastOps).toHaveBeenCalledTimes(1);
    localStorage.removeItem('pevo-draft-edit:bob:alice:p1');
  });

  it('same-author posture: redirect-pending on an unmounted component leaves step and draft untouched', async () => {
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
    sessionStorage.setItem('pevo_fresh_auth_session_proof', JSON.stringify({
      token: 'live-window',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
      idlePeriodMs: 900_000,
    }));
    localStorage.removeItem('pevo-draft-edit:alice:alice:p1');

    const comp = unchangedLightComponent();
    markLoaded(comp);
    comp.title = 'Retitled Before The Refusal';
    expect(comp.isContinuation).toBe(false);

    // The user leaves while the broadcast is in flight and the window turns
    // out closed server-side: the pending-sentinel return must take the early
    // return, not write step on the departed component or touch its draft.
    broadcastOps.mockImplementationOnce(async () => {
      comp.destroy();
      throw Object.assign(new Error('FRESH_AUTH_REQUIRED'), {
        status: 401, code: 'FRESH_AUTH_REQUIRED', details: { reason: 'expired' },
      });
    });

    await comp.handleSubmit();

    expect(broadcastOps).toHaveBeenCalledTimes(1);
    expect(comp.step).toBe('broadcasting');
    expect(JSON.parse(localStorage.getItem('pevo-draft-edit:alice:alice:p1')))
      .toMatchObject({ title: 'Retitled Before The Refusal' });
    localStorage.removeItem('pevo-draft-edit:alice:alice:p1');
  });

  it('continuation posture: redirect-pending on an unmounted component leaves step and draft untouched', async () => {
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
    sessionStorage.setItem('pevo_fresh_auth_session_proof', JSON.stringify({
      token: 'live-window',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
      idlePeriodMs: 900_000,
    }));
    localStorage.removeItem('pevo-draft-edit:bob:alice:p1');

    const comp = unchangedLightComponent();
    mockStores.auth.username = 'bob';
    // An accepted claim is what lets bob edit the paper, and only an account
    // that can edit it drafts on this page.
    comp.paper.authorship_claims = [{ claimer: 'bob', status: 'accepted' }];
    markLoaded(comp);
    comp.authorName = 'Bob';
    comp.title = 'Retitled Before The Refusal';
    expect(comp.isContinuation).toBe(true);

    broadcastOps.mockImplementationOnce(async () => {
      comp.destroy();
      throw Object.assign(new Error('FRESH_AUTH_REQUIRED'), {
        status: 401, code: 'FRESH_AUTH_REQUIRED', details: { reason: 'expired' },
      });
    });

    await comp.handleSubmit();

    expect(broadcastOps).toHaveBeenCalledTimes(1);
    expect(comp.step).toBe('broadcasting');
    expect(JSON.parse(localStorage.getItem('pevo-draft-edit:bob:alice:p1')))
      .toMatchObject({ title: 'Retitled Before The Refusal', authorName: 'Bob' });
    localStorage.removeItem('pevo-draft-edit:bob:alice:p1');
  });

  // Whether the form holds a new file decides whether a gate may navigate:
  // new supplementary files live in component state, never in the draft, so
  // a full-page ORCID round-trip discards them. Same rule as the publish page.
  function newSupplementary() {
    return {
      file: { name: 'data.pdf', size: 10, type: 'application/pdf' },
      fileName: 'data.pdf',
      description: '',
      cid: null,
      error: null,
      uploading: false,
    };
  }

  it('a passwordless account resubmitting with a supplementary file attached is asked, and keeps the file on a decline', async () => {
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
    mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
    mockStores.broadcastConfirm.request.mockResolvedValueOnce(false);
    const comp = unchangedLightComponent();
    const attached = newSupplementary();
    comp.supplementaryFiles = [attached];

    await comp.handleSubmit();

    expect(mockStores.broadcastConfirm.request).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'confirm.reauthNavigateTitle' }),
    );
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(mockSessionUpload).not.toHaveBeenCalled();
    expect(broadcastOps).not.toHaveBeenCalled();
    expect(comp.supplementaryFiles).toEqual([attached]);
    expect(comp.step).toBe('idle');
    // A decline is the user's own choice to stop; the dialog already said
    // what the toast would.
    expect(mockStores.toast.show).not.toHaveBeenCalled();
  });

  it('a passwordless account that accepts the cost navigates, with the draft already written', async () => {
    // The draft save is debounced, so the last edits before Submit live only
    // in component state. Confirming sends the tab to ORCID on the promise
    // that the text comes back, which requires the write to happen before the
    // round-trip rather than on a timer the navigation cancels.
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
    let draftAtOrcid = null;
    mockStartOrcid.mockImplementation(async () => {
      draftAtOrcid = localStorage.getItem('pevo-draft-edit:alice:alice:p1');
      return { redirect_url: 'https://orcid.org/oauth/authorize?x=1' };
    });
    mockStores.broadcastConfirm.request.mockResolvedValueOnce(true);
    vi.stubGlobal('window', { ...globalThis.window, location: { href: '', pathname: '/edit/alice/p1' } });
    try {
      const comp = unchangedLightComponent();
      markLoaded(comp);
      comp.supplementaryFiles = [newSupplementary()];
      comp.title = 'A New Title';

      await comp.handleSubmit();

      expect(mockStores.broadcastConfirm.request).toHaveBeenCalledTimes(1);
      expect(mockStartOrcid).toHaveBeenCalledTimes(1);
      expect(window.location.href).toBe('https://orcid.org/oauth/authorize?x=1');
      expect(JSON.parse(draftAtOrcid)).toMatchObject({ title: 'A New Title' });
      expect(mockSessionUpload).not.toHaveBeenCalled();
      expect(broadcastOps).not.toHaveBeenCalled();
      expect(comp.step).toBe('idle');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('text typed while the confirm dialog is open is in the draft when the round-trip starts', async () => {
    // The gate's flush runs before the dialog opens. A yes has to write again,
    // or edits made while the dialog stood open leave with the page despite
    // the copy saying the text is kept.
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
    let draftAtOrcid = null;
    mockStartOrcid.mockImplementation(async () => {
      draftAtOrcid = localStorage.getItem('pevo-draft-edit:alice:alice:p1');
      return { redirect_url: 'https://orcid.org/oauth/authorize?x=1' };
    });
    vi.stubGlobal('window', { ...globalThis.window, location: { href: '', pathname: '/edit/alice/p1' } });
    try {
      const comp = unchangedLightComponent();
      markLoaded(comp);
      comp.supplementaryFiles = [newSupplementary()];
      mockStores.broadcastConfirm.request.mockImplementationOnce(async () => {
        comp.title = 'Typed While Asked';
        return true;
      });

      await comp.handleSubmit();

      expect(mockStartOrcid).toHaveBeenCalledTimes(1);
      expect(JSON.parse(draftAtOrcid)).toMatchObject({ title: 'Typed While Asked' });
    } finally {
      vi.unstubAllGlobals();
      localStorage.removeItem('pevo-draft-edit:alice:alice:p1');
    }
  });

  it('a yes that arrives after the page unmounted navigates nowhere', async () => {
    // The dialog can outlive the page. A yes answered for a page the user
    // already left must not send a dead page to ORCID; it ends the way a
    // decline does, silently.
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
    mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
    vi.stubGlobal('window', { ...globalThis.window, location: { href: '', pathname: '/edit/alice/p1' } });
    try {
      const comp = unchangedLightComponent();
      comp.supplementaryFiles = [newSupplementary()];
      mockStores.broadcastConfirm.request.mockImplementationOnce(async () => {
        comp.destroy();
        return true;
      });

      await comp.handleSubmit();

      expect(mockStores.broadcastConfirm.request).toHaveBeenCalledTimes(1);
      expect(mockStartOrcid).not.toHaveBeenCalled();
      expect(window.location.href).toBe('');
      expect(mockSessionUpload).not.toHaveBeenCalled();
      expect(broadcastOps).not.toHaveBeenCalled();
      expect(mockStores.toast.show).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('when the new file is the only change, the offer is the only way out', async () => {
    // Removing the files is the move a bare refusal implies, and on this
    // arrangement it is a dead end: the form is then unchanged, and the
    // no-changes check sits ahead of the gate deliberately so an unchanged
    // form never costs a round-trip. So the gate has to ask here, or this
    // edit cannot be made at all.
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
    mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
    mockStores.broadcastConfirm.request.mockResolvedValueOnce(false);
    const comp = unchangedLightComponent();
    comp.supplementaryFiles = [newSupplementary()];

    await comp.handleSubmit();

    expect(mockStores.broadcastConfirm.request).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'confirm.reauthNavigateTitle' }),
    );
    expect(comp.step).toBe('idle');

    // The implied alternative, taken: the form is now unchanged and never
    // reaches a gate at all.
    comp.supplementaryFiles = [];

    await comp.handleSubmit();

    expect(comp.step).toBe('error');
    expect(comp.errorMessage).toBe('edit.noChanges');
    expect(mockStores.broadcastConfirm.request).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).not.toHaveBeenCalled();
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

  // The pre-broadcast gates override the computed posture with two literals,
  // and both are load-bearing precisely when the form no longer holds what
  // the computed posture would have read. The supplementary remove button
  // carries no disabled binding, so a file removed while its upload leg is in
  // flight leaves `holdsAttachedFiles` false at the gate with the pins already
  // paid for. From there the computed posture would allow a navigation that
  // discards them, and the offer would invite the user to take it. The two
  // gates sit in mutually exclusive branches, so neither twin can stand in
  // for the other.
  function inFlightRemovalArrangement(comp) {
    sessionStorage.setItem('pevo_fresh_auth_session_proof', JSON.stringify({
      token: 'live-window',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
      idlePeriodMs: 900_000,
    }));
    comp.supplementaryFiles = [newSupplementary()];
    mockSessionUpload.mockImplementation(async () => {
      // The user hits remove while the pin is being paid for, and the window
      // lapses across the same leg.
      comp.supplementaryFiles = [];
      sessionStorage.removeItem('pevo_fresh_auth_session_proof');
      return { data: { cid: 'bafycid123' } };
    });
  }

  it('the same-author pre-broadcast gate refuses a file removed mid-upload, and offers nothing', async () => {
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
    mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
    const comp = unchangedLightComponent();
    comp.title = 'A New Title';
    inFlightRemovalArrangement(comp);
    // Fixture-posture proof: this test exercises the same-author branch.
    expect(comp.isContinuation).toBe(false);

    await comp.handleSubmit();

    expect(mockSessionUpload).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(broadcastOps).not.toHaveBeenCalled();
    expect(mockStores.broadcastConfirm.request).not.toHaveBeenCalled();
    expect(comp.step).toBe('idle');
    expect(mockStores.toast.show).toHaveBeenCalledWith(
      'Please confirm your identity again, then try once more.',
      'error',
    );
  });

  it('the continuation pre-broadcast gate refuses a file removed mid-upload, and offers nothing', async () => {
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
    mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
    const comp = unchangedLightComponent();
    mockStores.auth.username = 'bob';
    comp.authorName = 'Bob';
    inFlightRemovalArrangement(comp);
    // Fixture-posture proof: this test exercises the continuation branch.
    expect(comp.isContinuation).toBe(true);

    await comp.handleSubmit();

    expect(mockSessionUpload).toHaveBeenCalledTimes(1);
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(broadcastOps).not.toHaveBeenCalled();
    expect(mockStores.broadcastConfirm.request).not.toHaveBeenCalled();
    expect(comp.step).toBe('idle');
    expect(mockStores.toast.show).toHaveBeenCalledWith(
      'Please confirm your identity again, then try once more.',
      'error',
    );
  });

  it('picking more supplementary files with one already attached refuses a passwordless account without navigation and keeps it', async () => {
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
    mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
    const comp = unchangedLightComponent();
    const attached = newSupplementary();
    comp.supplementaryFiles = [attached];
    const target = { files: [{ name: 'more.csv', size: 10 }], value: 'C:\\fakepath\\more.csv' };

    mockStores.broadcastConfirm.request.mockResolvedValueOnce(false);

    await comp.handleSupplementaryFiles({ target });

    expect(mockStores.broadcastConfirm.request).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'confirm.reauthNavigateTitle' }),
    );
    expect(mockStartOrcid).not.toHaveBeenCalled();
    expect(comp.supplementaryFiles).toEqual([attached]);
    expect(target.value).toBe('');
    expect(mockStores.toast.show).not.toHaveBeenCalled();
  });
});

// The review checklist is the one form field whose loss changes what goes on
// chain rather than only what the user retypes: a passwordless account's entry
// gate is allowed to navigate to ORCID while no new file is held, on the
// premise that everything else is drafted, and a returning form that silently
// dropped its ticks resubmits without `addresses_reviews`. Restore reconciles
// against the reviews the paper actually carries, because a tick is meaningless
// once its review is gone from the checklist.
// ARCHITECTURE.md § 8, "The instance is bound to the account and the paper it
// loaded for". The watchers on the store's username and the router params call
// these handlers, and the one on `step` calls _remountWhenSettled; this harness
// mocks $watch, so the cases call them where a watcher would.
describe('editPage is replaced when the account or the paper changes under it', () => {
  function loadedFixture() {
    const comp = createComponent();
    comp.paper = {
      author: 'alice', permlink: 'p1', head_author: 'alice', head_permlink: 'p1',
      canonical_author: 'alice', canonical_permlink: 'p1', title: 'T', body: '',
      json_metadata: {}, authors: [{ name: 'Alice', hive: 'alice' }, { name: 'Bob', hive: 'bob' }],
      versions: [{ version_number: 1, block_num: 100, author: 'alice', permlink: 'p1' }],
    };
    comp._routeAuthor = 'alice';
    comp._routePermlink = 'p1';
    markLoaded(comp);
    return comp;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockStores.auth.username = 'alice';
    mockStores.router.route = 'edit';
  });

  afterEach(() => {
    mockStores.auth.username = 'alice';
    mockStores.router.params = { author: 'alice', permlink: 'p1' };
    delete mockStores.router.route;
    localStorage.clear();
  });

  it('another account replaces the instance, after flushing the pending save under the captured key', () => {
    vi.useFakeTimers();
    try {
      const comp = loadedFixture();
      comp.title = 'Alice typed';
      comp._scheduleDraftSave();

      mockStores.auth.username = 'bob';
      comp._onAccountChange('bob');

      expect(mockStores.router.remount).toHaveBeenCalledTimes(1);
      expect(JSON.parse(localStorage.getItem('pevo-draft-edit:alice:alice:p1'))).toMatchObject({ title: 'Alice typed' });
      expect(localStorage.getItem('pevo-draft-edit:bob:alice:p1')).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a sign-in under a load that captured no account replaces the instance too', () => {
    mockStores.auth.username = null;
    const comp = loadedFixture();
    expect(comp._draftAccount).toBe(null);

    comp._onAccountChange('alice');

    expect(mockStores.router.remount).toHaveBeenCalledTimes(1);
  });

  it('nothing is replaced before the load has captured anything', () => {
    const comp = createComponent();
    comp._onAccountChange('bob');
    expect(mockStores.router.remount).not.toHaveBeenCalled();
  });

  it('a change to no account, or back to the captured one, keeps the instance', () => {
    const comp = loadedFixture();
    comp._onAccountChange(null);
    comp._onAccountChange('alice');
    expect(mockStores.router.remount).not.toHaveBeenCalled();
  });

  it('route params naming another author, with the same permlink, replace the instance', () => {
    const comp = loadedFixture();
    comp._onRouteParamsChange({ author: 'bob', permlink: 'p1' });
    expect(mockStores.router.remount).toHaveBeenCalledTimes(1);
  });

  it('route params naming another paper replace the instance; the same paper or another route does not', () => {
    const comp = loadedFixture();

    comp._onRouteParamsChange({ author: 'alice', permlink: 'p1' });
    mockStores.router.route = 'paper-detail';
    comp._onRouteParamsChange({ author: 'alice', permlink: 'p2' });
    expect(mockStores.router.remount).not.toHaveBeenCalled();

    mockStores.router.route = 'edit';
    comp._onRouteParamsChange({ author: 'alice', permlink: 'p2' });
    expect(mockStores.router.remount).toHaveBeenCalledTimes(1);
  });

  // A dragged row is not a form control, so the fieldset's lock does not
  // reach it: the handler refuses while the form is locked.
  it('a citation drag is refused while the form is locked', () => {
    const comp = createComponent();
    comp.citations = [{ author: 'a' }, { author: 'b' }];
    comp.dragIndex = 0;
    comp.dragCitationDrop(1);
    expect(comp.citations.map((c) => c.author)).toEqual(['a', 'b']);

    const loaded = loadedFixture();
    loaded.citations = [{ author: 'a' }, { author: 'b' }];
    loaded.dragIndex = 0;
    loaded.dragCitationDrop(1);
    expect(loaded.citations.map((c) => c.author)).toEqual(['b', 'a']);
    loaded.draftChoice = 'newer';
    loaded.dragIndex = 0;
    loaded.dragCitationDrop(1);
    expect(loaded.citations.map((c) => c.author)).toEqual(['b', 'a']);
  });

  it('waits for a submit in flight to settle before replacing the instance', () => {
    const comp = loadedFixture();
    comp.step = 'broadcasting';

    comp._onRouteParamsChange({ author: 'alice', permlink: 'p2' });
    expect(mockStores.router.remount).not.toHaveBeenCalled();

    comp.step = 'success';
    comp._remountWhenSettled();
    expect(mockStores.router.remount).toHaveBeenCalledTimes(1);
  });
});

describe('editPage draft carries the addressed-review ticks', () => {
  // The key of the account the test signed in: alice on the same-author
  // arm, bob on the continuation arm. The paper is alice/p1 either way.
  const draftKey = () => `pevo-draft-edit:${mockStores.auth.username}:alice:p1`;
  // The head marker of the paper arrangeLoad serves.
  const LOADED_MARKER = 'alice/p1/1/100';

  const REV_ONE = { author: 'carol', permlink: 'rev-1', body: 'first review' };
  const REV_TWO = { author: 'dave', permlink: 'rev-2', body: 'second review' };

  function addressed(rev) {
    return { author: rev.author, permlink: rev.permlink };
  }

  // Only the fields _restoreDraft reads. `title` is the shape sentinel the
  // restore gates on, so every fixture carries it as a string, and the head
  // marker is the loaded paper's, so the restore is the silent one.
  function storedDraft(extra = {}) {
    return JSON.stringify({
      title: 'Drafted Title',
      abstract: 'drafted abstract',
      body: 'drafted body',
      keywordsText: 'quantum',
      savedAt: 1,
      head_marker: LOADED_MARKER,
      ...extra,
    });
  }

  function loadedComponent() {
    const comp = createComponent();
    comp._mounted = true;
    // The rendered form's editor elements: the mount builds the pair on them
    // and only then takes the editor half of the baseline.
    comp.$refs = { abstractEditor: {}, bodyEditor: {} };
    return comp;
  }

  // The load, then the editor mount the rendered form's root runs: the mount
  // takes the editor half of the baseline and restores.
  async function loadForm(comp) {
    await comp.loadPaperData();
    await comp._mountEditors();
  }

  // `paperExtra` merges into the paper the detail endpoint returns, for the
  // fields a case needs beyond the single-post default: `authors` is the one
  // the continuation case wants, since _prefillForm seats the broadcaster from
  // that cumulative-union list.
  function arrangeLoad(reviews, paperExtra = {}) {
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
        versions: [{ version_number: 1, block_num: 100, author: 'alice', permlink: 'p1' }],
        ...paperExtra,
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

  it('the debounced save writes the ticks into the stored draft', async () => {
    arrangeLoad([REV_ONE, REV_TWO]);
    const comp = loadedComponent();
    await loadForm(comp);
    vi.useFakeTimers();
    try {
      comp.addressedReviews = [addressed(REV_TWO)];

      comp._scheduleDraftSave();
      vi.advanceTimersByTime(2000);

      const saved = JSON.parse(localStorage.getItem(draftKey()));
      expect(saved.addressedReviews).toEqual([addressed(REV_TWO)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a tick change schedules that save', async () => {
    arrangeLoad([REV_ONE, REV_TWO]);
    const comp = loadedComponent();
    comp._setupReactiveBindings();
    await loadForm(comp);
    vi.useFakeTimers();
    try {
      // The registration is the assertion: without it a tick is the one
      // change on the form that never reaches the stored draft.
      const registration = comp.$watch.mock.calls.find(([expr]) => expr === 'addressedReviews');
      expect(registration).toBeDefined();

      comp.toggleAddressedReview(REV_ONE.author, REV_ONE.permlink, true);
      registration[1]();
      vi.advanceTimersByTime(2000);

      const saved = JSON.parse(localStorage.getItem(draftKey()));
      expect(saved.addressedReviews).toEqual([addressed(REV_ONE)]);
    } finally {
      comp.destroy();
      vi.useRealTimers();
    }
  });

  // Between the load and the editor mount the key is captured and the plain
  // half of the baseline is taken, but not the editor half. A save the
  // load's own field changes armed can fire in that window when the editor
  // chunk is slow; it must write nothing, and above all not replace the
  // stored draft the restore is about to bring back.
  it('a write after the load and before the editors have mounted writes nothing', async () => {
    arrangeLoad([REV_ONE, REV_TWO]);
    const stored = storedDraft({ addressedReviews: [addressed(REV_TWO)] });
    localStorage.setItem(draftKey(), stored);

    const comp = loadedComponent();
    await comp.loadPaperData();
    expect(comp._draftKey).toBe(draftKey());
    expect(comp._baselineEditors).toBe(null);

    comp._flushDraftSave();

    expect(localStorage.getItem(draftKey())).toBe(stored);
  });

  it('restore reinstates a tick whose review is still on the paper', async () => {
    arrangeLoad([REV_ONE, REV_TWO]);
    localStorage.setItem(draftKey(), storedDraft({ addressedReviews: [addressed(REV_TWO)] }));

    const comp = loadedComponent();
    await loadForm(comp);

    expect(comp.addressedReviews).toEqual([addressed(REV_TWO)]);
  });

  it('restore drops a saved tick whose review is no longer offered', async () => {
    // rev-2 is gone from the paper by the time the form comes back.
    arrangeLoad([REV_ONE]);
    localStorage.setItem(draftKey(), storedDraft({
      addressedReviews: [addressed(REV_ONE), addressed(REV_TWO)],
    }));

    const comp = loadedComponent();
    await loadForm(comp);

    expect(comp.addressedReviews).toEqual([addressed(REV_ONE)]);
  });

  // The whole point of carrying the field: the resubmit after the round-trip
  // broadcasts the reviews the user ticked before it.
  it('the resubmit after a restore broadcasts addresses_reviews with the restored ticks', async () => {
    broadcastOps.mockResolvedValue({ tx_id: 'tx' });
    const { invalidatePaperCache } = await import('../../src/api.js');
    invalidatePaperCache.mockResolvedValue({});
    arrangeLoad([REV_ONE, REV_TWO]);
    localStorage.setItem(draftKey(), storedDraft({ addressedReviews: [addressed(REV_TWO)] }));

    const comp = loadedComponent();
    await loadForm(comp);
    comp.authorName = 'Alice';

    await comp.handleSubmit();

    expect(comp.step).toBe('success');
    const commentOp = broadcastOps.mock.calls[0][1][0];
    const meta = JSON.parse(commentOp[1].json_metadata).pevotest;
    expect(meta.addresses_reviews).toEqual([addressed(REV_TWO)]);

    comp.destroy();
  });

  // The ticks live inside the one draft object, so the landing clear takes
  // them with the text: the next visit starts from the chain, not from a tick
  // the revision already addressed.
  it('the landing clear takes the ticks with it', async () => {
    broadcastOps.mockResolvedValue({ tx_id: 'tx' });
    const { invalidatePaperCache } = await import('../../src/api.js');
    invalidatePaperCache.mockResolvedValue({});
    arrangeLoad([REV_ONE, REV_TWO]);
    localStorage.setItem(draftKey(), storedDraft({ addressedReviews: [addressed(REV_TWO)] }));

    const comp = loadedComponent();
    await loadForm(comp);
    // Non-vacuous: the draft has to have held a tick for the clear to have
    // anything to take.
    expect(comp.addressedReviews).toEqual([addressed(REV_TWO)]);
    comp.authorName = 'Alice';
    await comp.handleSubmit();
    expect(comp.step).toBe('success');
    expect(localStorage.getItem(draftKey())).toBe(null);
    comp.destroy();

    const reopened = loadedComponent();
    await loadForm(reopened);

    expect(reopened.addressedReviews).toEqual([]);
  });

  // A rejected enrichment used to fall through to the restore with `reviews`
  // still empty. The reconciliation then pruned every saved tick against a
  // list that only meant the reviews could not be fetched, and the restore
  // left the instance drafting, so the next watched change rewrote the draft
  // without them: a transient outage permanently lost what the user ticked,
  // and the checklist card (x-if on reviews.length) was not even rendered to
  // show it. Failing the load instead leaves the draft untouched and the Retry
  // card as the way through.
  it('a rejected enrichment fails the load and leaves the saved ticks alone', async () => {
    vi.useFakeTimers();
    try {
      arrangeLoad([REV_ONE, REV_TWO]);
      fetchPaperEnrichment.mockRejectedValue(new Error('enrichment unavailable'));
      localStorage.setItem(draftKey(), storedDraft({ addressedReviews: [addressed(REV_TWO)] }));

      const comp = loadedComponent();
      await comp.loadPaperData();

      expect(comp.loadError).toBe('edit.loadError');
      expect(comp.addressedReviews).toEqual([]);
      // The missing baseline is the mechanism: the restore never ran, so
      // nothing was pruned, and _writeDraft stays a no-op for the rest of the
      // visit.
      expect(comp._baselineFields).toBeNull();

      // What a watched change would leave armed on the returning form.
      comp._scheduleDraftSave();
      vi.advanceTimersByTime(2000);

      const saved = JSON.parse(localStorage.getItem(draftKey()));
      expect(saved.addressedReviews).toEqual([addressed(REV_TWO)]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Landing is terminal for a composer instance (ARCHITECTURE.md § 8). A
  // broadcast call that resolves with a result ends the instance through
  // `_finishLanded`: `_markLanded` raises the landed flag, cancels the
  // debounce and removes the draft once, by the key handleSubmit captured
  // before its first await. The cache invalidation runs next, best effort and
  // mounted or not. Only the `step` write and the navigate timer sit behind
  // the `_mounted` guard. From then on `_writeDraft` refuses every writer and
  // handleSubmit refuses every submit.
  //
  // The two arms of handleSubmit share that tail. The landing specs pin each
  // tail behavior on one arm, and each arm's entry into the tail on its own:
  // the two unmount-during-the-broadcast specs go red when their arm stops
  // calling `_finishLanded`.
  //
  // `$watch` is mocked in this harness, so the scheduler stands in for the
  // watcher a changed field would trigger. The load and the editor mount
  // leave the baseline taken and the key captured, and every "nothing was
  // written" assertion depends on that: `_writeDraft` is a no-op before them,
  // so a spec built on an unloaded component would pass with no barrier at
  // all.
  async function sameAuthorForm() {
    arrangeLoad([REV_ONE, REV_TWO]);
    const comp = loadedComponent();
    await loadForm(comp);
    comp.authorName = 'Alice';
    comp.toggleAddressedReview(REV_ONE.author, REV_ONE.permlink, true);
    // Fixture-posture proof: the same-author branch, on a loaded component.
    expect(comp.isContinuation).toBe(false);
    expect(comp._hasBaseline).toBe(true);
    return comp;
  }

  async function continuationForm() {
    arrangeLoad([REV_ONE, REV_TWO], {
      authors: [{ name: 'Alice', hive: 'alice' }, { name: 'Bob', hive: 'bob' }],
    });
    const comp = loadedComponent();
    mockStores.auth.username = 'bob';
    await loadForm(comp);
    comp.toggleAddressedReview(REV_ONE.author, REV_ONE.permlink, true);
    // Fixture-posture proof: the continuation branch, on a loaded component.
    expect(comp.isContinuation).toBe(true);
    expect(comp._hasBaseline).toBe(true);
    return comp;
  }

  // A file-input change event. The selection goes through `_windowReady`,
  // whose flush writes the draft synchronously: the one writer that needs
  // neither a watched change nor the debounce delay.
  function fileSelection() {
    return { target: { files: [{ name: 'more.csv', size: 10 }], value: 'C:\\fakepath\\more.csv' } };
  }

  // The form stays interactive while step is 'broadcasting', and
  // `_windowReady`'s flush is behind us by then, so a change made there
  // leaves a save armed across the landing. `_markLanded` cancels it. Storage
  // cannot show the cancel, because an uncancelled timer would fire into
  // `_writeDraft`'s refusal and write nothing either way. Two things can: the
  // timer handle, and whether the armed save ever calls `_writeDraft` once the
  // debounce delay has passed. The call count is the behavioral half, and it
  // is what tells a real cancel from a handle that was only set to null. What
  // the cancel buys is that a landed instance, which may already be
  // unmounted, leaves no timer behind.
  it('the landing cancels a save the debounce still has armed', async () => {
    vi.useFakeTimers();
    try {
      invalidatePaperCache.mockResolvedValue({});
      const comp = await sameAuthorForm();

      // A keystroke landing while the edit is in flight. The handle is
      // captured so the armed state is proven from outside the mock.
      let timerDuringBroadcast = null;
      broadcastOps.mockImplementation(async () => {
        comp.title = 'Retitled while the edit was in flight';
        comp._scheduleDraftSave();
        timerDuringBroadcast = comp._draftTimer;
        return { tx_id: 'tx' };
      });

      await comp.handleSubmit();

      // Non-vacuous: the debounce really was armed when the broadcast resolved.
      expect(timerDuringBroadcast).not.toBe(null);
      expect(comp.step).toBe('success');
      expect(localStorage.getItem(draftKey())).toBe(null);

      // Watch the writer from here on. The spy calls through, and the armed
      // save resolves `_writeDraft` on the component when it fires, so a save
      // that survived the landing shows up as a call.
      const writer = vi.spyOn(comp, '_writeDraft');
      vi.advanceTimersByTime(2000);

      expect(writer).not.toHaveBeenCalled();
      expect(comp._draftTimer).toBe(null);
      comp.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  // Twin of `the landing cancels a save the debounce still has armed` on the
  // continuation arm, so the cancel in `_markLanded` has a catcher on each
  // arm. The handle is also read the moment handleSubmit returns, before any
  // time passes: a landed instance holds no armed save at all, which is a
  // stronger claim than the armed save never reaching the writer.
  it('the continuation landing cancels a save the debounce still has armed', async () => {
    vi.useFakeTimers();
    try {
      invalidatePaperCache.mockResolvedValue({});
      const comp = await continuationForm();

      let timerDuringBroadcast = null;
      broadcastOps.mockImplementation(async () => {
        comp.title = 'Retitled while the revision was in flight';
        comp._scheduleDraftSave();
        timerDuringBroadcast = comp._draftTimer;
        return { tx_id: 'tx' };
      });

      await comp.handleSubmit();

      // Non-vacuous: the debounce really was armed when the broadcast resolved.
      expect(timerDuringBroadcast).not.toBe(null);
      expect(comp.step).toBe('success');
      expect(comp._draftTimer).toBe(null);
      expect(localStorage.getItem(draftKey())).toBe(null);

      const writer = vi.spyOn(comp, '_writeDraft');
      vi.advanceTimersByTime(2000);

      expect(writer).not.toHaveBeenCalled();
      expect(comp._draftTimer).toBe(null);
      comp.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  // Leaving the page while the broadcast is in flight must cost neither the
  // landing clear nor the cache invalidation. The draft outlives the
  // component, and a spent one restores ticks the revision already addressed;
  // ticks alone pass the no-changes check, so an otherwise no-op resubmit
  // would re-declare addresses_reviews. The paper's readers need the eviction
  // whether or not this component is there to see it, or they are served the
  // pre-edit paper until the cache entry expires. So both run ahead of the
  // `_mounted` guard, and only `step` and the navigate timer stay behind it.
  //
  // By the time the broadcast resolves, the router params name the page the
  // user went to, which holds a draft of its own. The landing clear uses the
  // key captured at load, which the params do not move, so that draft is left
  // alone and the spent one is the one removed.
  it('an unmount during the broadcast still drops the draft the landed edit spent', async () => {
    vi.useFakeTimers();
    const OTHER_KEY = 'pevo-draft-edit:alice:bob:p9';
    try {
      invalidatePaperCache.mockResolvedValue({});
      const comp = await sameAuthorForm();

      let draftDuringBroadcast = null;
      broadcastOps.mockImplementation(async () => {
        draftDuringBroadcast = localStorage.getItem(draftKey());
        comp.destroy();
        mockStores.router.params = { author: 'bob', permlink: 'p9' };
        localStorage.setItem(OTHER_KEY, storedDraft());
        return { tx_id: 'tx' };
      });

      await comp.handleSubmit();

      expect(broadcastOps).toHaveBeenCalledTimes(1);
      // Non-vacuous: the gate's flush wrote the ticked draft, so the landing
      // clear has something to drop, and the params now name the other paper
      // while the captured key still names this one.
      expect(JSON.parse(draftDuringBroadcast).addressedReviews).toEqual([addressed(REV_ONE)]);
      expect(mockStores.router.params).toEqual({ author: 'bob', permlink: 'p9' });
      expect(comp._draftKey).toBe(draftKey());
      expect(localStorage.getItem(draftKey())).toBe(null);
      expect(localStorage.getItem(OTHER_KEY)).toBe(storedDraft());
      expect(invalidatePaperCache).toHaveBeenCalledTimes(1);
      expect(invalidatePaperCache).toHaveBeenCalledWith('alice', 'p1');
      // The component is gone, so its step and its navigate stay untouched.
      expect(comp.step).toBe('broadcasting');
      vi.advanceTimersByTime(3000);
      expect(mockStores.router.navigate).not.toHaveBeenCalled();
    } finally {
      mockStores.router.params = { author: 'alice', permlink: 'p1' };
      vi.useRealTimers();
    }
  });

  // Twin of `an unmount during the broadcast still drops the draft the landed
  // edit spent` on the continuation arm. The continuation and same-author
  // legs are mutually exclusive, so a fixture resolving isContinuation false
  // proves nothing about this arm's entry into `_finishLanded`.
  it('an unmount during the continuation broadcast still drops the draft the landed post spent', async () => {
    vi.useFakeTimers();
    const OTHER_KEY = 'pevo-draft-edit:bob:bob:p9';
    try {
      invalidatePaperCache.mockResolvedValue({});
      const comp = await continuationForm();

      let draftDuringBroadcast = null;
      broadcastOps.mockImplementation(async () => {
        draftDuringBroadcast = localStorage.getItem(draftKey());
        comp.destroy();
        mockStores.router.params = { author: 'bob', permlink: 'p9' };
        localStorage.setItem(OTHER_KEY, storedDraft());
        return { tx_id: 'tx' };
      });

      await comp.handleSubmit();

      expect(broadcastOps).toHaveBeenCalledTimes(1);
      // Non-vacuous: the gate's flush wrote the ticked draft, so the landing
      // clear has something to drop, and the params now name the other paper
      // while the captured key still names this one.
      expect(JSON.parse(draftDuringBroadcast).addressedReviews).toEqual([addressed(REV_ONE)]);
      expect(mockStores.router.params).toEqual({ author: 'bob', permlink: 'p9' });
      expect(comp._draftKey).toBe(draftKey());
      expect(localStorage.getItem(draftKey())).toBe(null);
      expect(localStorage.getItem(OTHER_KEY)).toBe(storedDraft());
      expect(invalidatePaperCache).toHaveBeenCalledTimes(1);
      expect(invalidatePaperCache).toHaveBeenCalledWith('alice', 'p1');
      expect(comp.step).toBe('broadcasting');
      vi.advanceTimersByTime(3000);
      expect(mockStores.router.navigate).not.toHaveBeenCalled();
    } finally {
      mockStores.router.params = { author: 'alice', permlink: 'p1' };
      vi.useRealTimers();
    }
  });

  // The post is on chain by the time the invalidation is requested, so a
  // rejection there is not a failed edit. The route is authenticated and rate
  // limited, and a 401 or a 429 rejects as readily as a network error.
  // Reporting any of them as `common.editFailed` invites a second submit of a
  // post that landed. `_finishLanded` catches the rejection where it awaits
  // the call, logs the raw error, and carries on to the same success state a
  // resolving invalidation reaches.
  it('a rejecting cache invalidation still ends in success, with the rejection logged and the navigate armed', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rejection = new Error('invalidate unavailable');
      invalidatePaperCache.mockRejectedValue(rejection);
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      const comp = await continuationForm();

      await comp.handleSubmit();

      expect(broadcastOps).toHaveBeenCalledTimes(1);
      // Non-vacuous: the invalidation was requested, and it is what rejected.
      expect(invalidatePaperCache).toHaveBeenCalledTimes(1);
      expect(comp.step).toBe('success');
      expect(comp.errorMessage).toBe('');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith('[edit invalidate]', rejection);
      expect(localStorage.getItem(draftKey())).toBe(null);

      expect(mockStores.router.navigate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1500);
      expect(mockStores.router.navigate).toHaveBeenCalledTimes(1);
      expect(mockStores.router.navigate).toHaveBeenCalledWith('/paper/alice/p1');
      comp.destroy();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  // A keystroke inside the invalidation await arms the debounce after the
  // landing clear has run, and nothing past the landing cancels it. The
  // scheduler is deliberately not where the refusal lives, so the timer is
  // armed and does fire, two seconds later, into `_writeDraft`'s refusal.
  // Rejections correlate with slow networks, which is when that window is
  // widest.
  it('a save armed during a rejecting invalidation fires into the write barrier', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const comp = await sameAuthorForm();

      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      // The timer handle is captured and asserted once handleSubmit has
      // returned: an assertion throwing inside the mock would be swallowed by
      // the catch in `_finishLanded` that the rejection feeds.
      let timerDuringInvalidation = null;
      invalidatePaperCache.mockImplementation(async () => {
        comp.title = 'Retitled while the invalidation was in flight';
        comp._scheduleDraftSave();
        timerDuringInvalidation = comp._draftTimer;
        throw new Error('invalidate unavailable');
      });

      await comp.handleSubmit();

      // Non-vacuous: the debounce really was armed inside the window, and it
      // is still armed, so the save does fire.
      expect(timerDuringInvalidation).not.toBe(null);
      expect(comp._draftTimer).toBe(timerDuringInvalidation);
      expect(comp.step).toBe('success');
      expect(localStorage.getItem(draftKey())).toBe(null);

      vi.advanceTimersByTime(2000);

      expect(comp._draftTimer).toBe(timerDuringInvalidation);
      expect(localStorage.getItem(draftKey())).toBe(null);
      comp.destroy();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  // The resolving counterpart of `a save armed during a rejecting
  // invalidation fires into the write barrier`, with the save FIRING inside
  // the invalidation await
  // and the user leaving before the await settles. destroy() has nothing
  // pending to cancel by then, and nothing past the landing removes the entry
  // a second time, so the barrier is all that keeps the spent draft out of
  // storage. The await can hang up to the request timeout, which is the
  // window a user leaves through.
  it('a save armed and fired inside the invalidation await writes nothing', async () => {
    vi.useFakeTimers();
    try {
      const comp = await sameAuthorForm();

      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      let timerDuringInvalidation = null;
      let draftAfterFire = 'unset';
      invalidatePaperCache.mockImplementation(async () => {
        comp.title = 'Retitled while the invalidation was in flight';
        comp._scheduleDraftSave();
        timerDuringInvalidation = comp._draftTimer;
        vi.advanceTimersByTime(2000);
        draftAfterFire = localStorage.getItem(draftKey());
        comp.destroy();
        return {};
      });

      await comp.handleSubmit();

      expect(broadcastOps).toHaveBeenCalledTimes(1);
      // Non-vacuous: the scheduler did arm the save that then fired.
      expect(timerDuringInvalidation).not.toBe(null);
      expect(draftAfterFire).toBe(null);
      expect(localStorage.getItem(draftKey())).toBe(null);
      expect(comp.step).toBe('broadcasting');
    } finally {
      vi.useRealTimers();
    }
  });

  // A file selection is the writer a refusal at the scheduler would miss: it
  // reaches `_writeDraft` through `_windowReady`'s flush, synchronously, with
  // no watched change and no debounce. The refusal therefore has to sit in
  // `_writeDraft` itself. Staged on the continuation arm, inside the
  // invalidation await.
  it('a file selection during the invalidation await writes nothing', async () => {
    const comp = await continuationForm();

    broadcastOps.mockResolvedValue({ tx_id: 'tx' });
    let draftAfterSelection = 'unset';
    invalidatePaperCache.mockImplementation(async () => {
      await comp.handleSupplementaryFiles(fileSelection());
      draftAfterSelection = localStorage.getItem(draftKey());
      return {};
    });

    await comp.handleSubmit();

    // Non-vacuous: the selection ran to its end, past the gate's flush, and
    // attached the file.
    expect(comp.supplementaryFiles).toHaveLength(1);
    expect(draftAfterSelection).toBe(null);
    expect(localStorage.getItem(draftKey())).toBe(null);
    expect(comp.step).toBe('success');
    comp.destroy();
  });

  // The success state rests for 1.5 s before the navigate, with the form
  // still live. A resting state has no exit to hang a clear on, and destroy()
  // cancels a pending timer, not a write that already happened. The barrier
  // is what answers a file selection made there.
  it('a file selection in the success window writes nothing', async () => {
    vi.useFakeTimers();
    try {
      invalidatePaperCache.mockResolvedValue({});
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      const comp = await sameAuthorForm();

      await comp.handleSubmit();

      expect(comp.step).toBe('success');
      expect(localStorage.getItem(draftKey())).toBe(null);

      await comp.handleSupplementaryFiles(fileSelection());

      // Non-vacuous: the selection ran to its end and attached the file, and
      // the navigate timer has not fired yet.
      expect(comp.supplementaryFiles).toHaveLength(1);
      expect(mockStores.router.navigate).not.toHaveBeenCalled();
      expect(localStorage.getItem(draftKey())).toBe(null);

      vi.advanceTimersByTime(1500);

      expect(mockStores.router.navigate).toHaveBeenCalledWith('/paper/alice/p1');
      expect(localStorage.getItem(draftKey())).toBe(null);
      comp.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  // The draft is removed once, at landing. A removal repeated past the
  // invalidation await would run by key after the component is gone, and a
  // later visit to the same paper shares that key: whatever it drafted while
  // the earlier instance's invalidation was still pending would be deleted.
  // The later visit is staged as a direct write under the key, after the
  // unmount, inside the mocked invalidation.
  async function expectLaterVisitDraftSurvivesResolvingInvalidation(comp) {
    const laterVisitDraft = storedDraft({ title: 'Drafted by a later visit' });

    broadcastOps.mockResolvedValue({ tx_id: 'tx' });
    let draftAtInvalidation = 'unset';
    invalidatePaperCache.mockImplementation(async () => {
      draftAtInvalidation = localStorage.getItem(draftKey());
      comp.destroy();
      localStorage.setItem(draftKey(), laterVisitDraft);
      return {};
    });

    await comp.handleSubmit();

    expect(invalidatePaperCache).toHaveBeenCalledTimes(1);
    // Non-vacuous: the landing clear had already emptied the key, so what
    // sits under it now can only be the later visit's write.
    expect(draftAtInvalidation).toBe(null);
    expect(localStorage.getItem(draftKey())).toBe(laterVisitDraft);
  }

  it('a draft a later visit wrote during a resolving invalidation is still there when handleSubmit returns', async () => {
    await expectLaterVisitDraftSurvivesResolvingInvalidation(await continuationForm());
  });

  // The same staging entered from the same-author arm. The removal being
  // guarded against would sit in `_finishLanded`, which both arms share, so
  // this adds the other arm's entry, not a second behavior.
  it('same-author arm: a draft a later visit wrote during a resolving invalidation is still there when handleSubmit returns', async () => {
    await expectLaterVisitDraftSurvivesResolvingInvalidation(await sameAuthorForm());
  });

  // The rejecting counterpart of
  // `expectLaterVisitDraftSurvivesResolvingInvalidation`, run from each arm.
  // The rejection is caught
  // inside `_finishLanded`, so it reaches neither the terminal catch nor any
  // removal, and the later visit's draft survives it as well.
  async function expectLaterVisitDraftSurvivesRejectingInvalidation(comp) {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const laterVisitDraft = storedDraft({ title: 'Drafted by a later visit' });

      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      let draftAtInvalidation = 'unset';
      invalidatePaperCache.mockImplementation(async () => {
        draftAtInvalidation = localStorage.getItem(draftKey());
        comp.destroy();
        localStorage.setItem(draftKey(), laterVisitDraft);
        throw new Error('invalidate unavailable');
      });

      await comp.handleSubmit();

      expect(invalidatePaperCache).toHaveBeenCalledTimes(1);
      // Non-vacuous: the landing clear had already emptied the key.
      expect(draftAtInvalidation).toBe(null);
      expect(localStorage.getItem(draftKey())).toBe(laterVisitDraft);
      // Unmounted, so neither the success state nor the failure state.
      expect(comp.step).toBe('broadcasting');
      expect(comp.errorMessage).toBe('');
    } finally {
      warnSpy.mockRestore();
    }
  }

  it('a draft a later visit wrote during a rejecting invalidation is still there when handleSubmit returns', async () => {
    await expectLaterVisitDraftSurvivesRejectingInvalidation(await sameAuthorForm());
  });

  it('continuation arm: a draft a later visit wrote during a rejecting invalidation is still there when handleSubmit returns', async () => {
    await expectLaterVisitDraftSurvivesRejectingInvalidation(await continuationForm());
  });

  // `isSubmitting` excludes 'success', so without a refusal of its own the
  // submit is live for the 1.5 s before the navigate. The instance still
  // holds the pre-edit body as its diff base, so a second native edit would
  // send a patch against a body the chain no longer holds, and a second
  // continuation would be a second post. handleSubmit returns before it
  // touches `step` or reaches any gate, so the refusal leaves no trace.
  it('a second submit on a landed instance broadcasts nothing, leaves step alone and writes no draft', async () => {
    invalidatePaperCache.mockResolvedValue({});
    broadcastOps.mockResolvedValue({ tx_id: 'tx' });
    const comp = await sameAuthorForm();
    // Fixture-posture proof: a fresh instance has not landed.
    expect(comp._landed).toBe(false);

    await comp.handleSubmit();

    expect(comp._landed).toBe(true);
    expect(comp.step).toBe('success');
    expect(broadcastOps).toHaveBeenCalledTimes(1);

    // A change that would pass the no-changes check on its own, so nothing
    // but the landed refusal stands between this submit and a broadcast.
    comp.title = 'Retitled after the landing';
    const gate = vi.spyOn(comp, '_windowReady');
    await comp.handleSubmit();

    expect(broadcastOps).toHaveBeenCalledTimes(1);
    expect(invalidatePaperCache).toHaveBeenCalledTimes(1);
    expect(gate).not.toHaveBeenCalled();
    expect(comp.step).toBe('success');
    expect(comp.errorMessage).toBe('');
    expect(localStorage.getItem(draftKey())).toBe(null);
    comp.destroy();
  });

  // A spec fails on its first false assertion, so in `a second submit on a
  // landed instance broadcasts nothing, leaves step alone and writes no
  // draft` only the broadcast count is ever the deciding one. The specs built
  // on `landedSameAuthorForm` each lead with one of the other clauses,
  // observed at a point the refusal alone decides, so that a refusal moved
  // further down handleSubmit is named by the clause it broke.
  async function landedSameAuthorForm() {
    invalidatePaperCache.mockResolvedValue({});
    broadcastOps.mockResolvedValue({ tx_id: 'tx' });
    const comp = await sameAuthorForm();
    await comp.handleSubmit();
    // Fixture-posture proof: landed, resting in the success window, with a
    // change that passes the no-changes check on its own.
    expect(comp._landed).toBe(true);
    expect(comp.step).toBe('success');
    expect(localStorage.getItem(draftKey())).toBe(null);
    comp.title = 'Retitled after the landing';
    return comp;
  }

  // handleSubmit leaves 'success' for 'authorizing' synchronously, ahead of
  // its first await, so `step` is read before the returned promise is
  // awaited. Read afterwards it would show 'success' again either way: a
  // second submit that went through lands too.
  it('a second submit on a landed instance does not move step, even before its first await', async () => {
    const comp = await landedSameAuthorForm();

    const second = comp.handleSubmit();

    expect(comp.step).toBe('success');
    expect(comp.errorMessage).toBe('');
    await second;
    expect(comp.step).toBe('success');
    comp.destroy();
  });

  it('a second submit on a landed instance reaches no acquisition gate', async () => {
    const comp = await landedSameAuthorForm();
    const gate = vi.spyOn(comp, '_windowReady');

    await comp.handleSubmit();

    expect(gate).not.toHaveBeenCalled();
    comp.destroy();
  });

  // Storage stays empty after a second submit for two reasons at once: the
  // refusal in handleSubmit returns before the gate's flush, and the refusal
  // in `_writeDraft` would answer that flush anyway. The empty key therefore
  // cannot say which of them held. The call count can: a submit that is
  // refused where it should be never asks the writer at all.
  it('a second submit on a landed instance never reaches the draft writer', async () => {
    const comp = await landedSameAuthorForm();
    const writer = vi.spyOn(comp, '_writeDraft');

    await comp.handleSubmit();

    expect(writer).not.toHaveBeenCalled();
    expect(localStorage.getItem(draftKey())).toBe(null);
    comp.destroy();
  });

  // A landed instance touches nothing under its key, and the form shows what
  // was saved until the navigation, so the restored card goes and its Discard
  // is refused: it would re-run the prefill and remove whatever a later visit
  // has written under the key since.
  it("the restored card's Discard is refused once landed, and the card is gone", async () => {
    expect(editPageTemplate).toContain('x-if="draftRestored && draftSavedAt && !_landed"');
    const comp = await landedSameAuthorForm();
    comp.draftRestored = true;
    comp.draftSavedAt = 1;
    localStorage.setItem(draftKey(), storedDraft({ title: 'A later visit' }));

    comp.discardDraft();

    expect(comp.title).toBe('Retitled after the landing');
    expect(comp.addressedReviews).toEqual([addressed(REV_ONE)]);
    expect(comp.draftRestored).toBe(true);
    expect(JSON.parse(localStorage.getItem(draftKey()))).toMatchObject({ title: 'A later visit' });
    comp.destroy();
  });

  // The button is the other half of the refusal. The landed flag is its own
  // term in the binding; `isSubmitting` and the label expression are left as
  // they were, so the button reads its idle label, disabled.
  it('the submit button is disabled by the landed flag', () => {
    expect(editPageTemplate).toContain(
      '<button type="submit" class="btn-primary w-full sm:w-auto shrink-0" :disabled="isSubmitting || _landed"',
    );
  });

  // A rejected broadcast is not a landing. What the code knows is only that
  // the broadcast call did not resolve: the transaction can still be on chain
  // (ARCHITECTURE.md § 8, Limits), and the client cannot tell. The draft
  // `_windowReady` flushed is kept either way, because losing typed work is
  // the worse outcome, and the instance stays what it was before the submit:
  // it keeps drafting, and it accepts another submit. A landed flag raised
  // ahead of the broadcast await would break both without any visible sign,
  // and each arm has its own broadcast await, so each arm has its own case.
  async function expectRejectedBroadcastLeavesTheInstanceLive(comp) {
    comp.title = 'Retitled before a failing broadcast';
    broadcastOps.mockRejectedValue(new Error('broadcast unavailable'));

    await comp.handleSubmit();

    expect(broadcastOps).toHaveBeenCalledTimes(1);
    expect(invalidatePaperCache).not.toHaveBeenCalled();
    expect(comp.step).toBe('error');
    expect(comp.errorMessage).toBe('common.editFailed');
    expect(comp._landed).toBe(false);
    const saved = JSON.parse(localStorage.getItem(draftKey()));
    expect(saved.title).toBe('Retitled before a failing broadcast');
    expect(saved.addressedReviews).toEqual([addressed(REV_ONE)]);

    // A later change is saved by the debounce.
    vi.useFakeTimers();
    try {
      comp.title = 'Retitled after the failed broadcast';
      comp._scheduleDraftSave();
      vi.advanceTimersByTime(2000);
      expect(JSON.parse(localStorage.getItem(draftKey())).title)
        .toBe('Retitled after the failed broadcast');
    } finally {
      vi.useRealTimers();
    }

    // A later submit reaches the broadcast again.
    await comp.handleSubmit();

    expect(broadcastOps).toHaveBeenCalledTimes(2);
    expect(comp.step).toBe('error');
    comp.destroy();
  }

  it('a broadcast call that does not resolve keeps the flushed draft and leaves the instance drafting and submittable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expectRejectedBroadcastLeavesTheInstanceLive(await sameAuthorForm());
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a continuation broadcast call that does not resolve keeps the flushed draft and leaves the instance drafting and submittable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expectRejectedBroadcastLeavesTheInstanceLive(await continuationForm());
    } finally {
      warnSpy.mockRestore();
    }
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

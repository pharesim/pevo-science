import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Composer drafts in the real app (ARCHITECTURE.md § 8, "Composer Drafts").
//
// pages-publish.test.js and pages-edit.test.js drive the page factories with
// a mocked $watch, a mocked editor and a baseline set by hand, so they cannot
// see what decides most of a draft's binding: the save every watched field
// arms, the text the real editors rewrite when they mount, the form's x-if
// taking the editors with it, and a remount through pageMount. This file boots
// the whole app once under jsdom (index.html's body, main.js, the real Alpine,
// the real tiptap editors) and drives it the way a user does: the router, the
// auth store's own sign-in and teardown paths, typed input and the editors'
// own commands. Only what leaves the browser is replaced: fetch answers from
// this file's fixture papers and accreditations, and Keychain is a stub that
// records what it is asked to broadcast. Timers are faked so the two-second draft debounce costs nothing;
// every wait advances them.

// The first page load transforms the editor chunk, which under a loaded
// machine takes longer than the default waits allow.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const WAIT = { interval: 5, timeout: 15_000 };

const ROOT = resolve(__dirname, '../..');
const INDEX_HTML = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const BODY_HTML = INDEX_HTML
  .slice(INDEX_HTML.indexOf('>', INDEX_HTML.indexOf('<body')) + 1, INDEX_HTML.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');
const EN_MESSAGES = readFileSync(resolve(ROOT, 'public/messages/en.json'), 'utf8');

// A served body the body editor rewrites when it mounts: the list comes back
// with other spacing. That rewrite alone used to make every load write a draft.
const LIST_BODY = '## Abstract\n\nThe abstract.\n\n---\n\nIntro.\n\n* one\n* two\n';

const AUTHORS = [
  { name: 'Alice A', hive: 'alice', orcid: '0000-0001-0000-0001', affiliation: 'Uni A' },
  { name: 'Bob B', hive: 'bob', orcid: '', affiliation: 'Uni B' },
];

function paperFixture(permlink, extra = {}) {
  return {
    author: 'alice',
    permlink,
    title: `Paper ${permlink}`,
    body: LIST_BODY,
    head_author: 'alice',
    head_permlink: permlink,
    canonical_author: 'alice',
    canonical_permlink: permlink,
    json_metadata: { pevotest: { type: 'paper', version: 1, discipline: 'Physics', keywords: [], authors: AUTHORS } },
    authors: AUTHORS,
    versions: [{ version_number: 1, block_num: 100, author: 'alice', permlink }],
    ...extra,
  };
}

// What the paper endpoints serve, by `<author>/<permlink>`. Reset per test.
let papers = {};
// Accreditation status per account, as the polling reads it.
const ACCREDITATIONS = {
  alice: { name: 'Alice A', institution: 'Uni A' },
  bob: { name: 'Bob B', institution: 'Uni B' },
  carol: { name: 'Carol C', institution: 'Uni C' },
  eve: { name: 'Eve E', institution: 'Uni E' },
};
// What the enrichment endpoint serves, by `<author>/<permlink>`. Reset per test.
let enrichments = {};
// What Keychain was asked to broadcast, and how it answers: at once, with
// success, unless a test holds the answer to settle it later.
let broadcasts = [];
let answerBroadcast = null;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function fakeFetch(input) {
  const url = typeof input === 'string' ? input : input.url;
  const path = url.split('?')[0];
  if (path.startsWith('/messages/')) return new Response(EN_MESSAGES, { status: 200 });
  let m = path.match(/^\/api\/papers\/([^/]+)\/([^/]+)\/enrichment$/);
  if (m) return json({ data: enrichments[`${m[1]}/${m[2]}`] || { reviews: [], authorship_claims: [] } });
  m = path.match(/^\/api\/papers\/([^/]+)\/([^/]+)\/invalidate$/);
  if (m) return json({ data: {} });
  m = path.match(/^\/api\/papers\/([^/]+)\/([^/]+)$/);
  if (m) {
    const served = papers[`${m[1]}/${m[2]}`];
    return served ? json({ data: served }) : json({ error: { code: 'NOT_FOUND' } }, 404);
  }
  m = path.match(/^\/api\/accreditations\/([^/]+)$/);
  if (m) {
    const accreditation = ACCREDITATIONS[m[1]] || null;
    return json({ data: { is_accredited: !!accreditation, accreditation } });
  }
  return json({ data: [] });
}

let Alpine;
let router;
let auth;
let handleSessionInconsistency;

// Let effects, watchers and the editors' dynamic import run. Advancing the
// fake clock also releases Alpine's $nextTick, which rides on setTimeout.
async function settle(ms = 20) {
  await vi.advanceTimersByTimeAsync(ms);
}

// Past the draft debounce, so any save a watched field armed has fired.
async function pastDebounce() {
  await vi.advanceTimersByTimeAsync(2100);
}

// The page's root element. pageMount renders a new one for every instance,
// so it is what tells one instance from its replacement; Alpine.$data hands
// back a new proxy on every call.
function pageEl(name) {
  return document.querySelector(`[x-data="${name}"]`);
}

function page(name) {
  const el = pageEl(name);
  return el ? Alpine.$data(el) : null;
}

// Wait for pageMount to have replaced the instance rendered on `oldEl`.
async function replaced(name, oldEl) {
  await vi.waitFor(() => {
    expect(pageEl(name)).not.toBeNull();
    expect(pageEl(name)).not.toBe(oldEl);
  }, WAIT);
}

// Every stored composer draft, by key.
function drafts() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('pevo-draft')) out[key] = JSON.parse(localStorage.getItem(key));
  }
  return out;
}

function signIn(username, { accredited = true } = {}) {
  auth.loginFromResponse({
    token: `token-${username}`,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    username,
    custody: 'self',
    is_accredited: accredited,
    accreditation: accredited ? ACCREDITATIONS[username] : null,
  });
}

// A fresh page instance for `path`: leave for another route first, so the
// router's route-name change makes pageMount render the page anew.
async function visit(path, name) {
  router.navigate('/about');
  await settle();
  router.navigate(path);
  await vi.waitFor(() => expect(page(name)).not.toBeNull(), WAIT);
  return page(name);
}

// The editors are up and the instance has taken its baseline, which is also
// when it restores.
async function editorsReady(name) {
  await vi.waitFor(() => {
    const comp = page(name);
    expect(comp?._baselineEditors).not.toBeNull();
    expect(document.querySelectorAll(`[x-data="${name}"] .ProseMirror`)).toHaveLength(2);
  }, WAIT);
  return page(name);
}

function type(selector, value) {
  const input = document.querySelector(selector);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// One editor of a page, by the x-ref its mount point carries.
function editorEl(name, ref) {
  return document.querySelector(`[x-data="${name}"] [x-ref="${ref}"]`);
}

// Switch an editor to its markdown source view through its toolbar button.
function toMarkdownMode(name, ref) {
  editorEl(name, ref).querySelector('[data-action="markdownToggle"]').click();
}

function markdownTextarea(name, ref) {
  return editorEl(name, ref).querySelector('[data-md-textarea]');
}

function charCounter(name, ref) {
  return editorEl(name, ref).querySelector('[data-char-count]');
}

describe('composer drafts in the real app', () => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.stubGlobal('fetch', fakeFetch);
    window.__PEVO_CONFIG__ = { appTag: 'pevotest' };
    window.hive_keychain = {
      requestBroadcast(username, operations, keyType, callback) {
        broadcasts.push({ username, operations });
        if (answerBroadcast) answerBroadcast(callback);
        else callback({ success: true, result: { id: `tx-${broadcasts.length}` } });
      },
    };
    window.scrollTo = () => {};
    window.history.replaceState(null, '', '/en/about');
    document.body.innerHTML = BODY_HTML;
    await import('../../src/main.js');
    ({ handleSessionInconsistency } = await import('../../src/lib/fresh-auth.js'));
    Alpine = window.Alpine;
    await vi.waitFor(() => expect(Alpine.store('router')).toBeTruthy(), WAIT);
    router = Alpine.store('router');
    auth = Alpine.store('auth');
    await vi.waitFor(() => expect(document.querySelector('[x-data="aboutPage"], [x-data="pageMount"] > div > *')).toBeTruthy(), WAIT);
  });

  beforeEach(async () => {
    papers = {
      'alice/p1': paperFixture('p1'),
      'alice/p2': paperFixture('p2'),
    };
    enrichments = {};
    broadcasts = [];
    answerBroadcast = null;
    router.navigate('/about');
    await settle();
    if (auth.isConnected) auth.disconnect();
    await settle();
    for (const key of Object.keys(drafts())) localStorage.removeItem(key);
    localStorage.removeItem('pevo-citation-collection');
  });

  afterAll(() => {
    // Tear the app down while the document still exists, so no observer
    // fires into an environment that is already gone.
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  describe('a draft holds user work only', () => {
    it('an edit-page load whose editors rewrite the served body writes no draft until the user types', async () => {
      signIn('alice');
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      // Non-vacuous: the body editor did rewrite what was served.
      expect(comp.body).not.toBe('Intro.\n\n* one\n* two\n');
      expect(comp.body).toContain('one');
      expect(comp.editorsAtBaseline).toBe(true);

      await pastDebounce();
      expect(drafts()).toEqual({});

      type('#edit-title', 'A new title');
      await pastDebounce();
      expect(drafts()).toEqual({
        'pevo-draft-edit:alice:alice:p1': expect.objectContaining({
          title: 'A new title',
          head_marker: 'alice/p1/1/100',
        }),
      });
    });

    it('a form typed back to its baseline drops the stored draft', async () => {
      signIn('alice');
      await visit('/edit/alice/p1', 'editPage');
      await editorsReady('editPage');
      type('#edit-title', 'A new title');
      await pastDebounce();
      expect(Object.keys(drafts())).toEqual(['pevo-draft-edit:alice:alice:p1']);

      type('#edit-title', 'Paper p1');
      await pastDebounce();
      expect(drafts()).toEqual({});
    });

    it('a publish-page load writes nothing until the user types', async () => {
      signIn('alice');
      await visit('/publish', 'publishPage');
      const comp = await editorsReady('publishPage');
      // The accreditation prefill is not the user's work.
      expect(comp.authorName).toBe('Alice A');

      await pastDebounce();
      expect(drafts()).toEqual({});

      comp._bodyEditor.editor.commands.insertContent('Typed body');
      await pastDebounce();
      expect(drafts()['pevo-draft-publish:alice']).toMatchObject({ body: expect.stringContaining('Typed body') });
    });

    it('a signed-out visitor drafts nothing on either page', async () => {
      // Every storage write, not only the ones under a draft key: a write with
      // no key captured would land under "null".
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      const draftWrites = () => setItem.mock.calls
        .map(([key]) => String(key))
        .filter((key) => key.startsWith('pevo-draft') || key === 'null' || key === 'undefined');
      try {
        await visit('/publish', 'publishPage');
        await editorsReady('publishPage');
        type('#paper-title', 'Typed while signed out');
        await pastDebounce();
        page('publishPage')._flushDraftSave();
        expect(draftWrites()).toEqual([]);

        await visit('/edit/alice/p1', 'editPage');
        await settle(100);
        expect(page('editPage').paper).not.toBeNull();
        page('editPage')._flushDraftSave();
        await pastDebounce();
        expect(draftWrites()).toEqual([]);
        expect(drafts()).toEqual({});
      } finally {
        setItem.mockRestore();
      }
    });

    it('an account that cannot edit the paper drafts nothing on the edit page', async () => {
      signIn('carol');
      const comp = await visit('/edit/alice/p1', 'editPage');
      await vi.waitFor(() => expect(comp.loadingPaper).toBe(false), WAIT);
      expect(comp.isAuthorized).toBe(false);
      expect(comp._draftKey).toBe(null);
      comp._flushDraftSave();
      await pastDebounce();
      expect(drafts()).toEqual({});
    });

    it('a signed-in account that is not yet accredited keeps drafting on the publish page', async () => {
      signIn('dave', { accredited: false });
      await visit('/publish', 'publishPage');
      const comp = await editorsReady('publishPage');
      expect(comp.isAccredited).toBe(false);
      type('#paper-title', 'Drafted before accreditation');
      await pastDebounce();
      expect(drafts()['pevo-draft-publish:dave']).toMatchObject({ title: 'Drafted before accreditation' });
    });
  });

  describe('drafts are bound to the account', () => {
    it("one account's edit draft is not restored for another, and a mounted form is replaced when the other signs in", async () => {
      signIn('alice');
      await visit('/edit/alice/p1', 'editPage');
      await editorsReady('editPage');
      const aliceEl = pageEl('editPage');
      type('#edit-title', 'Alice was here');
      // Signed out and in as bob before the debounce fired: the replacement
      // flushes alice's pending save under alice's key first.
      auth.disconnect();
      await settle();
      signIn('bob');
      await replaced('editPage', aliceEl);
      const bobPage = await editorsReady('editPage');

      expect(bobPage.title).toBe('Paper p1');
      expect(bobPage.draftRestored).toBe(false);
      expect(bobPage.authorName).toBe('Bob B');
      expect(drafts()).toEqual({
        'pevo-draft-edit:alice:alice:p1': expect.objectContaining({ title: 'Alice was here', authorName: 'Alice A' }),
      });

      // bob's save broadcasts bob's own entry, and alice's entry as it was.
      type('#edit-title', 'Retitled by bob');
      await settle();
      document.querySelector('[x-data="editPage"] form button[type="submit"]').click();
      await vi.waitFor(() => expect(broadcasts).toHaveLength(1), WAIT);
      const [, op] = broadcasts[0].operations[0];
      expect(broadcasts[0].username).toBe('bob');
      expect(JSON.parse(op.json_metadata).pevotest.authors).toEqual([
        { name: 'Alice A', hive: 'alice', orcid: '0000-0001-0000-0001', affiliation: 'Uni A' },
        { name: 'Bob B', hive: 'bob', orcid: '', affiliation: 'Uni B' },
      ]);
    });

    it("one account's publish draft is not restored for another", async () => {
      signIn('alice');
      await visit('/publish', 'publishPage');
      await editorsReady('publishPage');
      const aliceEl = pageEl('publishPage');
      type('#paper-title', 'Alice publishes');
      await pastDebounce();
      auth.disconnect();
      await settle();
      signIn('bob');
      await replaced('publishPage', aliceEl);
      const bobPage = await editorsReady('publishPage');

      expect(bobPage._draftAccount).toBe('bob');
      expect(bobPage.title).toBe('');
      expect(bobPage.draftRestored).toBe(false);
      expect(Object.keys(drafts())).toEqual(['pevo-draft-publish:alice']);
    });

    it('text typed on the publish page while signed out survives an in-page sign-in and is drafted for that account', async () => {
      const comp = await visit('/publish', 'publishPage');
      await editorsReady('publishPage');
      const el = pageEl('publishPage');
      type('#paper-title', 'Signed-out work');
      type('#author-name', 'Dr. Eve Example');
      await settle();
      signIn('eve');
      await settle();

      // The same instance, adopted rather than replaced.
      expect(pageEl('publishPage')).toBe(el);
      expect(comp._draftAccount).toBe('eve');
      expect(comp.title).toBe('Signed-out work');
      // The prefill filled only the author fields the user left empty.
      expect(comp.authorName).toBe('Dr. Eve Example');
      expect(comp.authorAffiliation).toBe('Uni E');
      expect(drafts()).toEqual({
        'pevo-draft-publish:eve': expect.objectContaining({
          title: 'Signed-out work', authorName: 'Dr. Eve Example', authorAffiliation: 'Uni E',
        }),
      });
    });

    it('a sign-in under a signed-out form that holds nothing drafts nothing: the prefill it brings is not work', async () => {
      const comp = await visit('/publish', 'publishPage');
      await editorsReady('publishPage');
      signIn('eve');
      await settle();
      expect(comp._draftAccount).toBe('eve');
      expect(comp.authorName).toBe('Eve E');
      await pastDebounce();
      expect(drafts()).toEqual({});
    });

    it('a sign-in under a signed-out form that holds work, for an account with a stored draft, asks before either replaces the other', async () => {
      localStorage.setItem('pevo-draft-publish:eve', JSON.stringify({ title: 'Stored earlier', abstract: '', body: 'Stored body', savedAt: Date.now() - 60_000 }));
      const comp = await visit('/publish', 'publishPage');
      await editorsReady('publishPage');
      type('#paper-title', 'Signed-out work');
      await settle();
      signIn('eve');
      await settle();

      expect(comp.draftChoice).toBe('saved');
      const card = document.querySelector('[data-testid="draft-choice-card"]');
      expect(card.querySelector('p').textContent).toBe('You have a saved draft from 1 minute ago. Restore replaces what you typed here.');
      expect(card.querySelector('.btn-primary').textContent).toBe('Restore');
      expect(document.querySelector('[x-data="publishPage"] fieldset').disabled).toBe(true);
      expect(comp._abstractEditor.editor.isEditable).toBe(false);
      expect(comp._bodyEditor.editor.isEditable).toBe(false);
      expect(comp.title).toBe('Signed-out work');
      // Nothing overwrites the stored draft while the card stands.
      comp._flushDraftSave();
      await pastDebounce();
      expect(drafts()['pevo-draft-publish:eve']).toMatchObject({ title: 'Stored earlier' });

      document.querySelector('[data-testid="draft-choice-card"] .btn-primary').click();
      await settle();
      expect(comp.draftChoice).toBe(null);
      expect(comp.title).toBe('Stored earlier');
      expect(comp.body).toBe('Stored body');
      expect(comp._bodyEditor.editor.isEditable).toBe(true);
      expect(document.querySelector('[data-testid="draft-restored-card"]')).not.toBeNull();
    });

    it("the choice card's Restore puts the draft's body into an editor in markdown mode, and stores the draft whole", async () => {
      localStorage.setItem('pevo-draft-publish:eve', JSON.stringify({ title: 'Stored earlier', abstract: '', body: 'Stored body', savedAt: Date.now() - 60_000 }));
      const comp = await visit('/publish', 'publishPage');
      await editorsReady('publishPage');
      toMarkdownMode('publishPage', 'bodyEditor');
      type('[x-data="publishPage"] [x-ref="bodyEditor"] [data-md-textarea]', 'Typed in markdown');
      type('#paper-title', 'Signed-out work');
      await settle();
      expect(comp.body).toBe('Typed in markdown');
      signIn('eve');
      await settle();
      expect(comp.draftChoice).toBe('saved');

      document.querySelector('[data-testid="draft-choice-card"] .btn-primary').click();
      await settle();
      expect(comp.title).toBe('Stored earlier');
      expect(comp.body).toBe('Stored body');
      expect(markdownTextarea('publishPage', 'bodyEditor').value).toBe('Stored body');
      expect(drafts()['pevo-draft-publish:eve']).toMatchObject({ title: 'Stored earlier', body: 'Stored body' });
    });

    it('another account that signs in while the adoption choice card stands adopts the instance in its place, with its own author fields', async () => {
      localStorage.setItem('pevo-draft-publish:eve', JSON.stringify({ title: 'Stored earlier', abstract: '', body: 'Stored body', savedAt: Date.now() - 60_000 }));
      const comp = await visit('/publish', 'publishPage');
      await editorsReady('publishPage');
      const el = pageEl('publishPage');
      type('#paper-title', 'Signed-out work');
      await settle();
      signIn('eve');
      await settle();
      expect(comp.draftChoice).toBe('saved');
      expect(comp.authorName).toBe('Eve E');
      auth.disconnect();
      await settle();
      expect(comp.draftChoice).toBe('saved');

      signIn('bob');
      await settle();
      expect(pageEl('publishPage')).toBe(el);
      expect(comp.draftChoice).toBe(null);
      expect(comp._draftAccount).toBe('bob');
      expect(comp.title).toBe('Signed-out work');
      expect(comp.authorName).toBe('Bob B');
      expect(comp.authorAffiliation).toBe('Uni B');
      expect(document.querySelector('[x-data="publishPage"] fieldset').disabled).toBe(false);
      expect(drafts()).toEqual({
        'pevo-draft-publish:eve': expect.objectContaining({ title: 'Stored earlier', body: 'Stored body' }),
        'pevo-draft-publish:bob': expect.objectContaining({ title: 'Signed-out work', authorName: 'Bob B', authorAffiliation: 'Uni B' }),
      });
      await pastDebounce();
      expect(pageEl('publishPage')).toBe(el);
    });

    it('a provisional adoption gives back only the author fields its prefill filled, value and baseline', async () => {
      localStorage.setItem('pevo-draft-publish:eve', JSON.stringify({ title: 'Stored earlier', abstract: '', body: '', savedAt: Date.now() - 60_000 }));
      const comp = await visit('/publish', 'publishPage');
      await editorsReady('publishPage');
      type('#paper-title', 'Signed-out work');
      type('#author-name', 'Typed Name');
      await settle();
      signIn('eve');
      await settle();
      expect(comp.draftChoice).toBe('saved');
      expect(comp.authorName).toBe('Typed Name');
      expect(comp.authorAffiliation).toBe('Uni E');

      // Straight from one account to the next, and to one with no
      // accreditation, so no prefill hides a field left filled.
      signIn('dave', { accredited: false });
      await settle();
      expect(comp._draftAccount).toBe('dave');
      expect(comp.draftChoice).toBe(null);
      expect(comp.authorName).toBe('Typed Name');
      expect(comp.authorAffiliation).toBe('');

      // Typed back to the form as loaded: nothing left is dave's work.
      type('#paper-title', '');
      type('#author-name', '');
      await pastDebounce();
      expect(drafts()).toEqual({
        'pevo-draft-publish:eve': expect.objectContaining({ title: 'Stored earlier' }),
      });
    });

    it("the choice card's Discard keeps what was typed and drafts it", async () => {
      localStorage.setItem('pevo-draft-publish:eve', JSON.stringify({ title: 'Stored earlier', abstract: '', body: '', savedAt: Date.now() - 60_000 }));
      const comp = await visit('/publish', 'publishPage');
      await editorsReady('publishPage');
      type('#paper-title', 'Signed-out work');
      await settle();
      signIn('eve');
      await settle();
      expect(comp.draftChoice).toBe('saved');

      comp.discardPendingDraft();
      await settle();
      expect(comp.title).toBe('Signed-out work');
      expect(drafts()['pevo-draft-publish:eve']).toMatchObject({ title: 'Signed-out work' });
    });

    it("the choice card's Discard gives the empty author fields the prefill an accreditation that arrived under the card held back, and the prefill alone is not work", async () => {
      localStorage.setItem('pevo-draft-publish:eve', JSON.stringify({ title: 'Stored earlier', abstract: '', body: '', savedAt: Date.now() - 60_000 }));
      const comp = await visit('/publish', 'publishPage');
      await editorsReady('publishPage');
      type('#paper-title', 'Signed-out work');
      await settle();
      // The modal's email path: no accreditation with the session; the
      // store's polling fetches it while the card stands.
      auth.loginFromResponse({
        token: 'token-eve', expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        username: 'eve', custody: 'light', is_accredited: false, accreditation: null,
      });
      await settle();
      expect(comp.draftChoice).toBe('saved');
      await vi.waitFor(() => expect(auth.accreditation).not.toBeNull(), WAIT);
      await settle();
      // Non-vacuous: the card held the form as it was.
      expect(comp.draftChoice).toBe('saved');
      expect(comp.authorName).toBe('');
      expect(comp.authorAffiliation).toBe('');

      document.querySelector('[data-testid="draft-choice-card"] button:not(.btn-primary)').click();
      await settle();
      expect(comp.draftChoice).toBe(null);
      expect(comp.title).toBe('Signed-out work');
      expect(comp.authorName).toBe('Eve E');
      expect(comp.authorAffiliation).toBe('Uni E');
      expect(drafts()['pevo-draft-publish:eve']).toMatchObject({ title: 'Signed-out work', authorName: 'Eve E', authorAffiliation: 'Uni E' });
      // With the typed title gone, the form is back at its baseline.
      type('#paper-title', '');
      await pastDebounce();
      expect(drafts()).toEqual({});
    });

    it("the choice card's Restore moves the baseline with the prefill it gives the draft's empty author fields, so the prefill alone is not work", async () => {
      localStorage.setItem('pevo-draft-publish:eve', JSON.stringify({
        title: 'Stored earlier', abstract: '', body: '', authorName: '', authorAffiliation: '', savedAt: Date.now() - 60_000,
      }));
      const comp = await visit('/publish', 'publishPage');
      await editorsReady('publishPage');
      type('#paper-title', 'Signed-out work');
      await settle();
      // The modal's email path: the accreditation arrives while the card
      // stands, too late for the adoption's prefill.
      auth.loginFromResponse({
        token: 'token-eve', expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        username: 'eve', custody: 'light', is_accredited: false, accreditation: null,
      });
      await settle();
      expect(comp.draftChoice).toBe('saved');
      await vi.waitFor(() => expect(auth.accreditation).not.toBeNull(), WAIT);
      await settle();
      expect(comp.authorName).toBe('');

      document.querySelector('[data-testid="draft-choice-card"] .btn-primary').click();
      await settle();
      expect(comp.title).toBe('Stored earlier');
      expect(comp.authorName).toBe('Eve E');
      expect(comp.authorAffiliation).toBe('Uni E');
      // With the restored title gone, the form is back at its baseline.
      type('#paper-title', '');
      await pastDebounce();
      expect(drafts()).toEqual({});
    });

    it('a sign-in under a signed-out form that holds nothing restores the stored draft as a load would', async () => {
      localStorage.setItem('pevo-draft-publish:eve', JSON.stringify({ title: 'Stored earlier', abstract: '', body: '', savedAt: Date.now() - 60_000 }));
      const comp = await visit('/publish', 'publishPage');
      await editorsReady('publishPage');
      signIn('eve');
      await settle();
      expect(comp.draftChoice).toBe(null);
      expect(comp.title).toBe('Stored earlier');
      expect(comp.draftRestored).toBe(true);
    });

    it('a signed-out form leaves the citation collection alone, and the sign-in restores the draft and then merges it', async () => {
      localStorage.setItem('pevo-draft-publish:eve', JSON.stringify({ title: 'Stored earlier', abstract: '', body: '', citations: [], savedAt: Date.now() - 60_000 }));
      localStorage.setItem('pevo-citation-collection', JSON.stringify([{ author: 'zed', permlink: 'cited', title: 'Cited' }]));
      const comp = await visit('/publish', 'publishPage');
      await editorsReady('publishPage');
      expect(comp.citations).toEqual([]);
      expect(localStorage.getItem('pevo-citation-collection')).not.toBeNull();

      signIn('eve');
      await settle();
      expect(comp.draftChoice).toBe(null);
      expect(comp.title).toBe('Stored earlier');
      expect(comp.citations.map((c) => c.permlink)).toEqual(['cited']);
      expect(localStorage.getItem('pevo-citation-collection')).toBeNull();
      await pastDebounce();
      expect(drafts()['pevo-draft-publish:eve'].citations.map((c) => c.permlink)).toEqual(['cited']);
    });

    it('an email sign-in, whose accreditation arrives after the username, still gets the prefill on empty author fields', async () => {
      const comp = await visit('/publish', 'publishPage');
      await editorsReady('publishPage');
      type('#paper-title', 'Signed-out work');
      await settle();
      // The modal's email path: no accreditation with the session; the
      // store's polling fetches it.
      auth.loginFromResponse({
        token: 'token-eve', expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        username: 'eve', custody: 'light', is_accredited: false, accreditation: null,
      });
      await vi.waitFor(() => expect(auth.accreditation).not.toBeNull(), WAIT);
      await settle();
      expect(comp.authorName).toBe('Eve E');
      expect(comp.authorAffiliation).toBe('Uni E');
      // A prefill is not typing: only the title is the user's work.
      await pastDebounce();
      expect(drafts()['pevo-draft-publish:eve']).toMatchObject({ title: 'Signed-out work', authorName: 'Eve E' });
    });

    it('a restore whose empty author fields take the prefill does not date the draft as new', async () => {
      signIn('eve');
      const savedAt = Date.now() - 3 * 86_400_000;
      localStorage.setItem('pevo-draft-publish:eve', JSON.stringify({
        title: 'Drafted before accreditation', abstract: '', body: '', discipline: '', keywordsText: '',
        coAuthors: [], citations: [], authorName: '', authorAffiliation: '', authorOrcid: '', savedAt,
      }));
      await visit('/publish', 'publishPage');
      const comp = await editorsReady('publishPage');
      expect(comp.title).toBe('Drafted before accreditation');
      expect(comp.authorName).toBe('Eve E');
      await pastDebounce();
      expect(drafts()['pevo-draft-publish:eve'].savedAt).toBe(savedAt);
    });

    it("the choice card's Restore replaces typed author fields with the draft's, or with the prefill where the draft holds none", async () => {
      localStorage.setItem('pevo-draft-publish:eve', JSON.stringify({
        title: 'Stored earlier', abstract: '', body: '', authorName: '', authorAffiliation: 'Draft Uni', savedAt: Date.now() - 60_000,
      }));
      const comp = await visit('/publish', 'publishPage');
      await editorsReady('publishPage');
      type('#author-name', 'Typed Name');
      type('#author-affiliation', 'Typed Uni');
      await settle();
      signIn('eve');
      await settle();
      expect(comp.draftChoice).toBe('saved');

      comp.restorePendingDraft();
      expect(comp.title).toBe('Stored earlier');
      expect(comp.authorName).toBe('Eve E');
      expect(comp.authorAffiliation).toBe('Draft Uni');
    });

    it("the publish page's restored card Discard removes the draft at once and empties the form", async () => {
      signIn('eve');
      localStorage.setItem('pevo-draft-publish:eve', JSON.stringify({ title: 'Stored earlier', abstract: 'A', body: 'B', savedAt: Date.now() - 60_000 }));
      await visit('/publish', 'publishPage');
      const comp = await editorsReady('publishPage');
      expect(comp.title).toBe('Stored earlier');

      document.querySelector('[data-testid="draft-restored-card"] button').click();
      expect(drafts()).toEqual({});
      await settle();
      expect(comp.title).toBe('');
      expect(comp._bodyEditor.getMarkdown()).toBe('');
      expect(comp.authorName).toBe('Eve E');
      await pastDebounce();
      expect(drafts()).toEqual({});
    });

    it("the publish page's restored card Discard keeps the citations the collection merge added, and drafts them at once", async () => {
      signIn('eve');
      localStorage.setItem('pevo-draft-publish:eve', JSON.stringify({
        title: 'Stored earlier', abstract: 'A', body: 'B',
        citations: [{ author: 'yan', permlink: 'drafted', title: 'Drafted', reputation_relevant: true }],
        savedAt: Date.now() - 60_000,
      }));
      localStorage.setItem('pevo-citation-collection', JSON.stringify([{ author: 'zed', permlink: 'cited', title: 'Cited' }]));
      await visit('/publish', 'publishPage');
      const comp = await editorsReady('publishPage');
      expect(comp.citations.map((c) => c.permlink)).toEqual(['drafted', 'cited']);
      expect(localStorage.getItem('pevo-citation-collection')).toBeNull();

      document.querySelector('[data-testid="draft-restored-card"] button').click();
      expect(comp.title).toBe('');
      expect(comp.citations.map((c) => c.permlink)).toEqual(['cited']);
      expect(drafts()).toEqual({
        'pevo-draft-publish:eve': expect.objectContaining({
          title: '', citations: [expect.objectContaining({ author: 'zed', permlink: 'cited' })],
        }),
      });
    });

    it("the publish page's restored card Discard does not put back a merged citation the user removed", async () => {
      signIn('eve');
      localStorage.setItem('pevo-draft-publish:eve', JSON.stringify({
        title: 'Stored earlier', abstract: 'A', body: 'B', citations: [], savedAt: Date.now() - 60_000,
      }));
      localStorage.setItem('pevo-citation-collection', JSON.stringify([
        { author: 'zed', permlink: 'cited', title: 'Cited' },
        { author: 'xia', permlink: 'kept', title: 'Kept' },
      ]));
      await visit('/publish', 'publishPage');
      const comp = await editorsReady('publishPage');
      expect(comp.citations.map((c) => c.permlink)).toEqual(['cited', 'kept']);
      comp.removeCitation(0);

      document.querySelector('[data-testid="draft-restored-card"] button').click();
      expect(comp.citations.map((c) => c.permlink)).toEqual(['kept']);
      expect(drafts()['pevo-draft-publish:eve'].citations.map((c) => c.permlink)).toEqual(['kept']);
    });

    it('text typed after a session teardown is drafted under the key the instance captured', async () => {
      signIn('alice');
      await visit('/publish', 'publishPage');
      await editorsReady('publishPage');
      const el = pageEl('publishPage');
      handleSessionInconsistency();
      await settle();
      expect(auth.username).toBe(null);

      type('#paper-title', 'Typed after the teardown');
      await pastDebounce();
      expect(pageEl('publishPage')).toBe(el);
      expect(drafts()['pevo-draft-publish:alice']).toMatchObject({ title: 'Typed after the teardown' });
    });

    it('a sign-out and back in on a mounted edit page brings the editors back, and the pending save lands under the captured key', async () => {
      signIn('alice');
      await visit('/edit/alice/p1', 'editPage');
      await editorsReady('editPage');
      const el = pageEl('editPage');
      type('#edit-title', 'Before the sign-out');
      auth.disconnect();
      await settle();
      // The form is gone with the account; the save it armed still lands.
      expect(document.querySelectorAll('[x-data="editPage"] .ProseMirror')).toHaveLength(0);
      await pastDebounce();
      expect(drafts()['pevo-draft-edit:alice:alice:p1']).toMatchObject({ title: 'Before the sign-out' });

      signIn('alice');
      const comp = await editorsReady('editPage');
      expect(pageEl('editPage')).toBe(el);
      expect(comp.title).toBe('Before the sign-out');
      expect(comp._bodyEditor.getMarkdown()).toContain('one');
      // The baseline is still the paper as loaded, not the form the new
      // editors came back to: what was typed is still the user's work.
      expect(comp.editorsAtBaseline).toBe(true);
      comp._flushDraftSave();
      expect(drafts()['pevo-draft-edit:alice:alice:p1']).toMatchObject({ title: 'Before the sign-out' });
    });

    it('the baseline outlives a re-render: work typed only in an editor is still work after the same account signs back in', async () => {
      signIn('alice');
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      comp._bodyEditor.editor.commands.insertContent('Typed body');
      await pastDebounce();
      const typedBody = drafts()['pevo-draft-edit:alice:alice:p1'].body;
      expect(typedBody).toContain('Typed body');

      auth.disconnect();
      await settle();
      signIn('alice');
      const back = await editorsReady('editPage');
      expect(back.editorsAtBaseline).toBe(false);
      back._flushDraftSave();
      expect(drafts()['pevo-draft-edit:alice:alice:p1']).toMatchObject({ body: typedBody });
    });

    it("the edit page's sign-in call to action brings up the form with the editors and the account's author fields", async () => {
      const comp = await visit('/edit/alice/p1', 'editPage');
      await vi.waitFor(() => expect(comp.loadingPaper).toBe(false), WAIT);
      const el = pageEl('editPage');
      signIn('alice');
      await replaced('editPage', el);
      const fresh = await editorsReady('editPage');
      expect(fresh.authorName).toBe('Alice A');
      expect(fresh.authorOrcid).toBe('0000-0001-0000-0001');
    });

    it('legacy entries are never restored and go on the first load with an account; a sign-out keeps the bound ones', async () => {
      localStorage.setItem('pevo-draft-publish', JSON.stringify({ title: 'Legacy publish', authorName: 'Someone Else', savedAt: 1 }));
      localStorage.setItem('pevo-draft-edit-alice-p1', JSON.stringify({ title: 'Legacy edit', authorName: 'Someone Else', savedAt: 1 }));
      await visit('/publish', 'publishPage');
      await editorsReady('publishPage');
      // No account: nothing is restored, and nothing is deleted either.
      expect(page('publishPage').title).toBe('');
      expect(Object.keys(drafts()).sort()).toEqual(['pevo-draft-edit-alice-p1', 'pevo-draft-publish']);

      // The sign-in under the mounted form adopts it, and the adoption is a
      // load with an account.
      signIn('alice');
      await settle();
      expect(drafts()).toEqual({});
      // So is a signed-in publish load, and a signed-in edit load.
      localStorage.setItem('pevo-draft-publish', JSON.stringify({ title: 'Legacy publish', savedAt: 1 }));
      localStorage.setItem('pevo-draft-edit-alice-p1', JSON.stringify({ title: 'Legacy edit', savedAt: 1 }));
      await visit('/publish', 'publishPage');
      await editorsReady('publishPage');
      expect(page('publishPage').title).toBe('');
      expect(drafts()).toEqual({});

      localStorage.setItem('pevo-draft-edit-alice-p1', JSON.stringify({ title: 'Legacy edit', savedAt: 1 }));
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      expect(comp.title).toBe('Paper p1');
      expect(drafts()).toEqual({});

      type('#edit-title', 'Kept across a sign-out');
      await pastDebounce();
      auth.disconnect();
      await settle();
      expect(Object.keys(drafts())).toEqual(['pevo-draft-edit:alice:alice:p1']);
    });
  });

  describe('drafts are bound to the paper and its head', () => {
    it('after a history jump between two edit entries, no write lands under the other paper\'s key', async () => {
      signIn('alice');
      await visit('/edit/alice/p1', 'editPage');
      await editorsReady('editPage');
      router.navigate('/edit/alice/p2');
      await vi.waitFor(() => expect(page('editPage')._routePermlink).toBe('p2'), WAIT);
      await editorsReady('editPage');
      type('#edit-title', 'Typed on p2');

      window.history.back();
      await vi.waitFor(() => expect(page('editPage')._routePermlink).toBe('p1'), WAIT);
      const p1Page = await editorsReady('editPage');
      expect(p1Page.title).toBe('Paper p1');
      await pastDebounce();

      // p2's pending save was flushed under p2's key before the replacement,
      // and nothing of p2 reached p1's key.
      expect(drafts()).toEqual({
        'pevo-draft-edit:alice:alice:p2': expect.objectContaining({ title: 'Typed on p2' }),
      });
    });

    it('a draft written against the head the page loaded is restored silently, with the restored card', async () => {
      signIn('alice');
      localStorage.setItem('pevo-draft-edit:alice:alice:p1', JSON.stringify({
        title: 'Drafted title', abstract: 'The abstract.', body: 'Drafted body', keywordsText: '',
        authorName: 'Alice A', authorAffiliation: 'Uni A', authorOrcid: '0000-0001-0000-0001',
        newCoAuthors: [], citations: [], addressedReviews: [], savedAt: Date.now() - 60_000,
        head_marker: 'alice/p1/1/100',
      }));
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      expect(comp.draftChoice).toBe(null);
      expect(comp.title).toBe('Drafted title');
      expect(comp._bodyEditor.getMarkdown()).toBe('Drafted body');
      expect(document.querySelector('[data-testid="draft-restored-card"]')).not.toBeNull();
      // Restoring is not typing: the stored draft keeps its time.
      const savedAt = drafts()['pevo-draft-edit:alice:alice:p1'].savedAt;
      await pastDebounce();
      expect(drafts()['pevo-draft-edit:alice:alice:p1'].savedAt).toBe(savedAt);

      // Discard returns the form to the paper as loaded, and removes the
      // draft at once, not at the next save.
      document.querySelector('[data-testid="draft-restored-card"] button').click();
      expect(drafts()).toEqual({});
      await settle();
      expect(comp.title).toBe('Paper p1');
      // The body field is the text the editor holds, as after the first
      // mount, not the served text it was handed.
      expect(comp._bodyEditor.getMarkdown()).toContain('one');
      expect(comp.body).toBe(comp._bodyEditor.getMarkdown());
      expect(comp.body).not.toBe('Intro.\n\n* one\n* two\n');
      expect(comp.editorsAtBaseline).toBe(true);
      await pastDebounce();
      expect(drafts()).toEqual({});
    });

    it("the restored card's Discard returns an editor in markdown mode to the loaded body", async () => {
      signIn('alice');
      localStorage.setItem('pevo-draft-edit:alice:alice:p1', JSON.stringify({
        title: 'Drafted title', abstract: 'The abstract.', body: 'Drafted body', keywordsText: '',
        authorName: 'Alice A', authorAffiliation: 'Uni A', authorOrcid: '0000-0001-0000-0001',
        newCoAuthors: [], citations: [], addressedReviews: [], savedAt: Date.now() - 60_000,
        head_marker: 'alice/p1/1/100',
      }));
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      expect(comp.body).toBe('Drafted body');
      toMarkdownMode('editPage', 'bodyEditor');
      expect(markdownTextarea('editPage', 'bodyEditor').value).toBe('Drafted body');

      document.querySelector('[data-testid="draft-restored-card"] button').click();
      await settle();
      expect(comp.title).toBe('Paper p1');
      expect(comp.body).toContain('one');
      expect(comp.body).not.toContain('Drafted');
      // The text the editor holds, as after the first mount, not the served
      // text it was handed.
      expect(comp.body).not.toBe('Intro.\n\n* one\n* two\n');
      expect(markdownTextarea('editPage', 'bodyEditor').value).toBe(comp.body);
      expect(charCounter('editPage', 'bodyEditor').textContent).toBe(String(comp.body.length));
      expect(comp.editorsAtBaseline).toBe(true);
      await pastDebounce();
      expect(drafts()).toEqual({});

      // Back in visual mode, an edit undone leaves the form at its baseline.
      toMarkdownMode('editPage', 'bodyEditor');
      comp._bodyEditor.editor.commands.insertContentAt(1, 'X');
      comp._bodyEditor.editor.commands.deleteRange({ from: 1, to: 2 });
      await pastDebounce();
      expect(comp.editorsAtBaseline).toBe(true);
      expect(drafts()).toEqual({});
    });

    it("after the restored card's Discard in markdown mode, a sign-out and back in drafts nothing", async () => {
      signIn('alice');
      localStorage.setItem('pevo-draft-edit:alice:alice:p1', JSON.stringify({
        title: 'Drafted title', abstract: 'The abstract.', body: 'Drafted body', keywordsText: '',
        authorName: 'Alice A', authorAffiliation: 'Uni A', authorOrcid: '0000-0001-0000-0001',
        newCoAuthors: [], citations: [], addressedReviews: [], savedAt: Date.now() - 60_000,
        head_marker: 'alice/p1/1/100',
      }));
      await visit('/edit/alice/p1', 'editPage');
      await editorsReady('editPage');
      toMarkdownMode('editPage', 'bodyEditor');
      document.querySelector('[data-testid="draft-restored-card"] button').click();
      await settle();

      // The re-render builds the editors in visual mode from the form's text.
      auth.disconnect();
      await settle();
      signIn('alice');
      const back = await editorsReady('editPage');
      await pastDebounce();
      expect(back.editorsAtBaseline).toBe(true);
      expect(drafts()).toEqual({});
    });

    it("the restored card's Discard keeps the citations the collection merge added, and drafts them at once", async () => {
      papers['alice/p1'] = paperFixture('p1', {
        json_metadata: { pevotest: {
          type: 'paper', version: 1, discipline: 'Physics', keywords: [], authors: AUTHORS,
          citations: [{ author: 'yan', permlink: 'served', title: 'Served' }],
        } },
      });
      signIn('alice');
      localStorage.setItem('pevo-draft-edit:alice:alice:p1', JSON.stringify({
        title: 'Drafted title', abstract: 'The abstract.', body: 'Drafted body', keywordsText: '',
        authorName: 'Alice A', authorAffiliation: 'Uni A', authorOrcid: '0000-0001-0000-0001',
        newCoAuthors: [], citations: [], addressedReviews: [], savedAt: Date.now() - 60_000,
        head_marker: 'alice/p1/1/100',
      }));
      localStorage.setItem('pevo-citation-collection', JSON.stringify([{ author: 'zed', permlink: 'cited', title: 'Cited' }]));
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      expect(comp.draftRestored).toBe(true);
      expect(comp.citations.map((c) => c.permlink)).toEqual(['cited']);
      expect(localStorage.getItem('pevo-citation-collection')).toBeNull();

      document.querySelector('[data-testid="draft-restored-card"] button').click();
      expect(comp.title).toBe('Paper p1');
      expect(comp.citations.map((c) => c.permlink)).toEqual(['served', 'cited']);
      expect(drafts()).toEqual({
        'pevo-draft-edit:alice:alice:p1': expect.objectContaining({
          title: 'Paper p1',
          citations: [expect.objectContaining({ permlink: 'served' }), expect.objectContaining({ permlink: 'cited' })],
        }),
      });
    });

    it("the restored card's Discard does not put back a merged citation the user removed", async () => {
      signIn('alice');
      localStorage.setItem('pevo-draft-edit:alice:alice:p1', JSON.stringify({
        title: 'Drafted title', abstract: 'The abstract.', body: 'Drafted body', keywordsText: '',
        authorName: 'Alice A', authorAffiliation: 'Uni A', authorOrcid: '0000-0001-0000-0001',
        newCoAuthors: [], citations: [], addressedReviews: [], savedAt: Date.now() - 60_000,
        head_marker: 'alice/p1/1/100',
      }));
      localStorage.setItem('pevo-citation-collection', JSON.stringify([
        { author: 'zed', permlink: 'cited', title: 'Cited' },
        { author: 'xia', permlink: 'kept', title: 'Kept' },
      ]));
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      expect(comp.citations.map((c) => c.permlink)).toEqual(['cited', 'kept']);
      comp.removeCitation(0);

      document.querySelector('[data-testid="draft-restored-card"] button').click();
      expect(comp.citations.map((c) => c.permlink)).toEqual(['kept']);
      expect(drafts()['pevo-draft-edit:alice:alice:p1'].citations.map((c) => c.permlink)).toEqual(['kept']);
    });

    it('a draft that changed only the body is restored and kept: the baseline is the loaded form, not the restored one', async () => {
      signIn('alice');
      localStorage.setItem('pevo-draft-edit:alice:alice:p1', JSON.stringify({
        title: 'Paper p1', abstract: 'The abstract.', body: 'Only the body changed', keywordsText: '',
        authorName: 'Alice A', authorAffiliation: 'Uni A', authorOrcid: '0000-0001-0000-0001',
        newCoAuthors: [], citations: [], addressedReviews: [], savedAt: Date.now() - 60_000,
        head_marker: 'alice/p1/1/100',
      }));
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      expect(comp.body).toBe('Only the body changed');
      expect(comp.editorsAtBaseline).toBe(false);
      await pastDebounce();
      expect(drafts()['pevo-draft-edit:alice:alice:p1']).toMatchObject({ body: 'Only the body changed' });
    });

    it('a draft written against another head waits on the newer-version card, read-only, and Restore binds it to this head', async () => {
      signIn('alice');
      localStorage.setItem('pevo-draft-edit:alice:alice:p1', JSON.stringify({
        title: 'Drafted title', abstract: 'The abstract.', body: 'Drafted body', keywordsText: '',
        authorName: 'Alice A', authorAffiliation: 'Uni A', authorOrcid: '0000-0001-0000-0001',
        newCoAuthors: [], citations: [], addressedReviews: [], savedAt: Date.now() - 60_000,
        head_marker: 'alice/p1/1/90',
      }));
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');

      expect(comp.draftChoice).toBe('newer');
      expect(comp.title).toBe('Paper p1');
      expect(document.querySelector('[data-testid="draft-choice-card"] p').textContent).toContain('newer version');
      expect(document.querySelector('[data-testid="draft-choice-card"] .btn-primary').textContent).toBe('Restore');
      expect(document.querySelector('[x-data="editPage"] fieldset').disabled).toBe(true);
      expect(comp._abstractEditor.editor.isEditable).toBe(false);
      expect(comp._bodyEditor.editor.isEditable).toBe(false);
      comp._flushDraftSave();
      await pastDebounce();
      expect(drafts()['pevo-draft-edit:alice:alice:p1']).toMatchObject({ title: 'Drafted title', head_marker: 'alice/p1/1/90' });

      document.querySelector('[data-testid="draft-choice-card"] .btn-primary').click();
      await settle();
      expect(comp.draftChoice).toBe(null);
      expect(comp.title).toBe('Drafted title');
      expect(comp._bodyEditor.editor.isEditable).toBe(true);
      expect(document.querySelector('[data-testid="draft-restored-card"]')).not.toBeNull();
      expect(drafts()['pevo-draft-edit:alice:alice:p1']).toMatchObject({ title: 'Drafted title', head_marker: 'alice/p1/1/100' });
    });

    it("the newer-version card's Discard keeps the loaded version and drops the draft", async () => {
      signIn('alice');
      localStorage.setItem('pevo-draft-edit:alice:alice:p1', JSON.stringify({
        title: 'Drafted title', abstract: 'The abstract.', body: 'Drafted body', savedAt: Date.now() - 60_000,
        head_marker: 'alice/p1/1/90',
      }));
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      expect(comp.draftChoice).toBe('newer');

      document.querySelector('[data-testid="draft-choice-card"] button:not(.btn-primary)').click();
      await settle();
      expect(comp.draftChoice).toBe(null);
      expect(comp.title).toBe('Paper p1');
      expect(comp._bodyEditor.editor.isEditable).toBe(true);
      expect(drafts()).toEqual({});
    });

    it('when the loaded paper has no head marker, the card says the page could not check', async () => {
      papers['alice/p1'] = paperFixture('p1', { versions: [{ version_number: 1, block_num: 0 }] });
      signIn('alice');
      localStorage.setItem('pevo-draft-edit:alice:alice:p1', JSON.stringify({
        title: 'Drafted title', abstract: '', body: '', savedAt: Date.now() - 60_000,
        head_marker: 'alice/p1/1/100',
      }));
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      expect(comp.draftChoice).toBe('unchecked');
      expect(document.querySelector('[data-testid="draft-choice-card"] p').textContent).toContain('could not check');
    });

    it('a draft written with no head marker waits on the could-not-check card, whether or not the paper now has one', async () => {
      signIn('alice');
      const stored = {
        title: 'Drafted title', abstract: '', body: '', savedAt: Date.now() - 60_000, head_marker: null,
      };
      localStorage.setItem('pevo-draft-edit:alice:alice:p1', JSON.stringify(stored));
      await visit('/edit/alice/p1', 'editPage');
      let comp = await editorsReady('editPage');
      expect(comp.draftChoice).toBe('unchecked');
      expect(comp.title).toBe('Paper p1');
      expect(document.querySelector('[data-testid="draft-choice-card"] p').textContent).toContain('could not check');

      // Both null: the stub again. Equal, but nothing was checked.
      papers['alice/p1'] = paperFixture('p1', { versions: [{ version_number: 1, block_num: 0 }] });
      await visit('/edit/alice/p1', 'editPage');
      comp = await editorsReady('editPage');
      expect(comp.draftChoice).toBe('unchecked');
      expect(comp.title).toBe('Paper p1');
    });

    it('Restore puts back author fields the draft had cleared, and stores them cleared', async () => {
      signIn('alice');
      localStorage.setItem('pevo-draft-edit:alice:alice:p1', JSON.stringify({
        title: 'Drafted title', abstract: 'The abstract.', body: 'Drafted body', keywordsText: '',
        authorName: 'Alice A', authorAffiliation: '', authorOrcid: '',
        newCoAuthors: [], citations: [], addressedReviews: [], savedAt: Date.now() - 60_000,
        head_marker: 'alice/p1/1/90',
      }));
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      expect(comp.authorOrcid).toBe('0000-0001-0000-0001');

      comp.restorePendingDraft();
      await pastDebounce();
      expect(comp.authorAffiliation).toBe('');
      expect(comp.authorOrcid).toBe('');
      expect(drafts()['pevo-draft-edit:alice:alice:p1']).toMatchObject({ authorAffiliation: '', authorOrcid: '' });
    });

    it("the restored card's Discard empties the rows and ticks only the draft added", async () => {
      enrichments['alice/p1'] = {
        reviews: [{ author: 'carol', permlink: 'rev-1', body: 'A review' }],
        authorship_claims: [],
      };
      signIn('alice');
      localStorage.setItem('pevo-draft-edit:alice:alice:p1', JSON.stringify({
        title: 'Drafted title', abstract: 'The abstract.', body: 'Drafted body', keywordsText: '',
        authorName: 'Alice A', authorAffiliation: 'Uni A', authorOrcid: '0000-0001-0000-0001',
        newCoAuthors: [{ name: 'Dan D', hive: '', orcid: '', affiliation: '' }], citations: [],
        addressedReviews: [{ author: 'carol', permlink: 'rev-1' }], savedAt: Date.now() - 60_000,
        head_marker: 'alice/p1/1/100',
      }));
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      expect(comp.newCoAuthors).toHaveLength(1);
      expect(comp.addressedReviews).toEqual([{ author: 'carol', permlink: 'rev-1' }]);

      comp.discardDraft();
      await pastDebounce();
      expect(comp.newCoAuthors).toEqual([]);
      expect(comp.addressedReviews).toEqual([]);
      expect(drafts()).toEqual({});
    });

    it("the restored card's Discard empties the author fields of an accepted claimer the paper does not list", async () => {
      enrichments['alice/p1'] = { reviews: [], authorship_claims: [{ claimer: 'carol', status: 'accepted' }] };
      signIn('carol');
      localStorage.setItem('pevo-draft-edit:carol:alice:p1', JSON.stringify({
        title: 'Drafted title', abstract: 'The abstract.', body: 'Drafted body', keywordsText: '',
        authorName: 'Carol Draft', authorAffiliation: 'Draft Uni', authorOrcid: '0000-0009-0000-0009',
        newCoAuthors: [], citations: [], addressedReviews: [], savedAt: Date.now() - 60_000,
        head_marker: 'alice/p1/1/100',
      }));
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      expect(comp.authorName).toBe('Carol Draft');

      comp.discardDraft();
      expect(comp.authorName).toBe('');
      expect(comp.authorAffiliation).toBe('');
      expect(comp.authorOrcid).toBe('');
    });

    it('a restore that reorders the ticks does not date the draft as new', async () => {
      enrichments['alice/p1'] = {
        reviews: [
          { author: 'carol', permlink: 'rev-1', body: 'First' },
          { author: 'dave', permlink: 'rev-2', body: 'Second' },
        ],
        authorship_claims: [],
      };
      signIn('alice');
      const savedAt = Date.now() - 3 * 86_400_000;
      localStorage.setItem('pevo-draft-edit:alice:alice:p1', JSON.stringify({
        title: 'Drafted title', abstract: 'The abstract.', body: 'Drafted body', keywordsText: '',
        authorName: 'Alice A', authorAffiliation: 'Uni A', authorOrcid: '0000-0001-0000-0001',
        newCoAuthors: [], citations: [],
        addressedReviews: [{ author: 'dave', permlink: 'rev-2' }, { author: 'carol', permlink: 'rev-1' }],
        savedAt, head_marker: 'alice/p1/1/100',
      }));
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      expect(comp.addressedReviews.map((r) => r.permlink)).toEqual(['rev-1', 'rev-2']);
      await pastDebounce();
      expect(drafts()['pevo-draft-edit:alice:alice:p1'].savedAt).toBe(savedAt);
      expect(document.querySelector('[data-testid="draft-restored-card"] p').textContent).toContain('3 days ago');
    });

    it('a re-rendered form keeps the lock the choice card holds', async () => {
      signIn('alice');
      localStorage.setItem('pevo-draft-edit:alice:alice:p1', JSON.stringify({
        title: 'Drafted title', abstract: '', body: '', savedAt: Date.now() - 60_000, head_marker: 'alice/p1/1/90',
      }));
      await visit('/edit/alice/p1', 'editPage');
      await editorsReady('editPage');
      const el = pageEl('editPage');
      auth.disconnect();
      await settle();
      signIn('alice');
      await vi.waitFor(() => expect(document.querySelectorAll('[x-data="editPage"] .ProseMirror')).toHaveLength(2), WAIT);
      await settle();
      const comp = page('editPage');
      expect(pageEl('editPage')).toBe(el);
      expect(comp.draftChoice).toBe('newer');
      expect(comp._abstractEditor.editor.isEditable).toBe(false);
      expect(comp._bodyEditor.editor.isEditable).toBe(false);
    });

    it('an edit page opened under a pair other than the canonical one drafts under the canonical key', async () => {
      papers['bob/cont'] = paperFixture('cont', {
        author: 'bob', head_author: 'bob', canonical_author: 'alice', canonical_permlink: 'p1',
        versions: [{ version_number: 1, block_num: 100, author: 'alice', permlink: 'p1' }, { version_number: 2, block_num: 120, author: 'bob', permlink: 'cont' }],
      });
      signIn('alice');
      await visit('/edit/bob/cont', 'editPage');
      const comp = await editorsReady('editPage');
      expect(comp._draftKey).toBe('pevo-draft-edit:alice:alice:p1');
      type('#edit-title', 'Typed on the continuation');
      await pastDebounce();
      expect(Object.keys(drafts())).toEqual(['pevo-draft-edit:alice:alice:p1']);
    });

    it("a passwordless account's draft comes back on the return from the ORCID round-trip", async () => {
      // The round-trip reloads the page for the same account and the same
      // head; a new instance stands in for the reload.
      signIn('alice');
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      const el = pageEl('editPage');
      type('#edit-title', 'Typed before the round-trip');
      comp._flushDraftSave();
      // The typing's watcher arms its save while the instance is still up, so
      // leaving clears it. Armed after the instance is gone, the save would
      // fire into a later test and write this draft back there.
      await settle();

      await visit('/edit/alice/p1', 'editPage');
      const returned = await editorsReady('editPage');
      expect(pageEl('editPage')).not.toBe(el);
      expect(returned.draftChoice).toBe(null);
      expect(returned.title).toBe('Typed before the round-trip');
    });
  });

  describe('an account change during a submit replaces the instance once the submit settles', () => {
    // Keychain holds its answer, so the submit sits in 'broadcasting' while
    // the other account signs in; the answer is a rejection, so the submit
    // settles without landing.
    function holdBroadcast() {
      let answer;
      answerBroadcast = (callback) => { answer = callback; };
      return () => answer({ success: false, message: 'rejected' });
    }

    it('on the publish page', async () => {
      signIn('alice');
      await visit('/publish', 'publishPage');
      const comp = await editorsReady('publishPage');
      const el = pageEl('publishPage');
      type('#paper-title', 'Alice publishes');
      type('#discipline', 'Physics');
      comp._abstractEditor.editor.commands.insertContent('An abstract');
      await settle();
      const reject = holdBroadcast();
      document.querySelector('[x-data="publishPage"] form button[type="submit"]').click();
      await vi.waitFor(() => expect(broadcasts).toHaveLength(1), WAIT);
      expect(comp.step).toBe('broadcasting');

      signIn('bob');
      await settle(100);
      expect(pageEl('publishPage')).toBe(el);

      reject();
      await replaced('publishPage', el);
      const fresh = await editorsReady('publishPage');
      expect(fresh._draftAccount).toBe('bob');
      expect(fresh.authorName).toBe('Bob B');
      expect(drafts()['pevo-draft-publish:alice']).toMatchObject({ title: 'Alice publishes' });
    });

    it('on the edit page', async () => {
      signIn('alice');
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      const el = pageEl('editPage');
      type('#edit-title', 'Alice retitles');
      await settle();
      const reject = holdBroadcast();
      document.querySelector('[x-data="editPage"] form button[type="submit"]').click();
      await vi.waitFor(() => expect(broadcasts).toHaveLength(1), WAIT);
      expect(comp.step).toBe('broadcasting');

      signIn('bob');
      await settle(100);
      expect(pageEl('editPage')).toBe(el);

      reject();
      await replaced('editPage', el);
      const fresh = await editorsReady('editPage');
      expect(fresh._draftAccount).toBe('bob');
      expect(fresh.authorName).toBe('Bob B');
    });
  });

  describe('a replacement requested during a broadcast that lands is dropped: the landed instance navigates to the paper', () => {
    // Keychain holds its answer, so the submit sits in 'broadcasting' while
    // the other account signs in; the answer is a success, so it lands.
    function holdBroadcast() {
      let answer;
      answerBroadcast = (callback) => { answer = callback; };
      return () => answer({ success: true, result: { id: 'tx-held' } });
    }

    it('on the publish page', async () => {
      signIn('alice');
      await visit('/publish', 'publishPage');
      const comp = await editorsReady('publishPage');
      const el = pageEl('publishPage');
      type('#paper-title', 'Alice publishes');
      type('#discipline', 'Physics');
      comp._abstractEditor.editor.commands.insertContent('An abstract');
      await settle();
      const land = holdBroadcast();
      document.querySelector('[x-data="publishPage"] form button[type="submit"]').click();
      await vi.waitFor(() => expect(broadcasts).toHaveLength(1), WAIT);
      expect(comp.step).toBe('broadcasting');
      signIn('bob');
      await settle(100);

      land();
      await vi.waitFor(() => expect(comp.step).toBe('success'), WAIT);
      await settle(100);
      expect(pageEl('publishPage')).toBe(el);
      const [, op] = broadcasts[0].operations[0];
      await vi.waitFor(() => expect(router.route).toBe('paper-detail'), WAIT);
      expect(router.params).toEqual({ author: 'alice', permlink: op.permlink });
      expect(drafts()).toEqual({});
    });

    it('on the edit page', async () => {
      signIn('alice');
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      const el = pageEl('editPage');
      type('#edit-title', 'Alice retitles');
      await settle();
      const land = holdBroadcast();
      document.querySelector('[x-data="editPage"] form button[type="submit"]').click();
      await vi.waitFor(() => expect(broadcasts).toHaveLength(1), WAIT);
      expect(comp.step).toBe('broadcasting');
      signIn('bob');
      await settle(100);

      land();
      await vi.waitFor(() => expect(comp.step).toBe('success'), WAIT);
      await settle(100);
      expect(pageEl('editPage')).toBe(el);
      await vi.waitFor(() => expect(router.route).toBe('paper-detail'), WAIT);
      expect(router.params).toEqual({ author: 'alice', permlink: 'p1' });
      expect(drafts()).toEqual({});
    });
  });

  describe('a citation collection merge drafts what it adds at once, and a landed instance leaves the collection alone', () => {
    const COLLECTION = [{ author: 'zed', permlink: 'cited', title: 'Cited' }];
    const PUBLISH_KEY = 'pevo-draft-publish:alice';
    const EDIT_KEY = 'pevo-draft-edit:alice:alice:p1';

    // Another tab cites a paper: it writes the collection, and this tab hears
    // of it through a storage event.
    function citeInAnotherTab() {
      const value = JSON.stringify(COLLECTION);
      localStorage.setItem('pevo-citation-collection', value);
      window.dispatchEvent(new StorageEvent('storage', { key: 'pevo-citation-collection', newValue: value }));
    }

    // Leave the page while the save the merge armed is still pending, so
    // destroy() clears it unfired. The merge and the navigation are separate
    // events, as they are for a user: the citations watcher's callback has run
    // and armed the save before the page is left. A navigation in the same
    // tick would let that callback arm a save on the destroyed instance.
    async function leaveAtOnce(comp) {
      await settle();
      expect(comp._draftTimer).not.toBe(null);
      router.navigate('/about');
      await settle();
      expect(comp._draftTimer).toBe(null);
      expect(comp._storageListener).toBe(null);
    }

    function draftedCitations(key) {
      return drafts()[key]?.citations?.map((c) => c.permlink);
    }

    it('on the publish page, for a merge at load', async () => {
      signIn('alice');
      localStorage.setItem('pevo-citation-collection', JSON.stringify(COLLECTION));
      await visit('/publish', 'publishPage');
      const comp = await editorsReady('publishPage');
      expect(comp.citations.map((c) => c.permlink)).toEqual(['cited']);
      expect(localStorage.getItem('pevo-citation-collection')).toBeNull();
      await leaveAtOnce(comp);
      expect(draftedCitations(PUBLISH_KEY)).toEqual(['cited']);
    });

    it('on the publish page, for a merge from another tab', async () => {
      signIn('alice');
      await visit('/publish', 'publishPage');
      const comp = await editorsReady('publishPage');
      citeInAnotherTab();
      expect(comp.citations.map((c) => c.permlink)).toEqual(['cited']);
      expect(localStorage.getItem('pevo-citation-collection')).toBeNull();
      await leaveAtOnce(comp);
      expect(draftedCitations(PUBLISH_KEY)).toEqual(['cited']);
    });

    it('on the edit page, for a merge at load', async () => {
      signIn('alice');
      localStorage.setItem('pevo-citation-collection', JSON.stringify(COLLECTION));
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      expect(comp.citations.map((c) => c.permlink)).toEqual(['cited']);
      expect(localStorage.getItem('pevo-citation-collection')).toBeNull();
      await leaveAtOnce(comp);
      expect(draftedCitations(EDIT_KEY)).toEqual(['cited']);
    });

    it('on the edit page, for a merge from another tab', async () => {
      signIn('alice');
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      citeInAnotherTab();
      expect(comp.citations.map((c) => c.permlink)).toEqual(['cited']);
      expect(localStorage.getItem('pevo-citation-collection')).toBeNull();
      await leaveAtOnce(comp);
      expect(draftedCitations(EDIT_KEY)).toEqual(['cited']);
    });

    it('on the publish page, a cite the form already holds writes nothing over a draft another tab stored', async () => {
      signIn('alice');
      localStorage.setItem('pevo-citation-collection', JSON.stringify(COLLECTION));
      await visit('/publish', 'publishPage');
      const comp = await editorsReady('publishPage');
      expect(comp.citations.map((c) => c.permlink)).toEqual(['cited']);
      await pastDebounce();
      // Another tab of the account stored its own work since.
      const other = { title: 'Other tab work', savedAt: 12345 };
      localStorage.setItem(PUBLISH_KEY, JSON.stringify(other));

      citeInAnotherTab();
      expect(localStorage.getItem('pevo-citation-collection')).toBeNull();
      await pastDebounce();
      expect(drafts()[PUBLISH_KEY]).toEqual(other);
    });

    it('on the edit page, a cite the paper already holds writes nothing over a draft another tab stored', async () => {
      papers['alice/p1'] = paperFixture('p1', {
        json_metadata: { pevotest: { type: 'paper', version: 1, discipline: 'Physics', keywords: [], authors: AUTHORS, citations: COLLECTION } },
      });
      signIn('alice');
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      expect(comp.citations.map((c) => c.permlink)).toEqual(['cited']);
      await pastDebounce();
      // Another tab on the same paper stored its work after this one loaded,
      // so this form is still at its baseline.
      const other = { title: 'Other tab work', savedAt: 12345, head_marker: 'alice/p1/1/100' };
      localStorage.setItem(EDIT_KEY, JSON.stringify(other));

      citeInAnotherTab();
      expect(localStorage.getItem('pevo-citation-collection')).toBeNull();
      await pastDebounce();
      expect(drafts()[EDIT_KEY]).toEqual(other);
    });

    it('a landed publish page leaves a cite from another tab in the collection', async () => {
      signIn('alice');
      await visit('/publish', 'publishPage');
      const comp = await editorsReady('publishPage');
      type('#paper-title', 'Alice publishes');
      type('#discipline', 'Physics');
      comp._abstractEditor.editor.commands.insertContent('An abstract');
      await settle();
      document.querySelector('[x-data="publishPage"] form button[type="submit"]').click();
      await vi.waitFor(() => expect(comp.step).toBe('success'), WAIT);
      expect(comp._landed).toBe(true);

      citeInAnotherTab();
      expect(comp.citations).toEqual([]);
      expect(JSON.parse(localStorage.getItem('pevo-citation-collection'))).toEqual(COLLECTION);
      await vi.waitFor(() => expect(router.route).toBe('paper-detail'), WAIT);
      expect(drafts()).toEqual({});
      expect(JSON.parse(localStorage.getItem('pevo-citation-collection'))).toEqual(COLLECTION);
    });

    it('a landed edit page leaves a cite from another tab in the collection', async () => {
      signIn('alice');
      await visit('/edit/alice/p1', 'editPage');
      const comp = await editorsReady('editPage');
      type('#edit-title', 'Alice retitles');
      await settle();
      document.querySelector('[x-data="editPage"] form button[type="submit"]').click();
      await vi.waitFor(() => expect(comp.step).toBe('success'), WAIT);
      expect(comp._landed).toBe(true);

      citeInAnotherTab();
      expect(comp.citations).toEqual([]);
      expect(JSON.parse(localStorage.getItem('pevo-citation-collection'))).toEqual(COLLECTION);
      await vi.waitFor(() => expect(router.route).toBe('paper-detail'), WAIT);
      expect(drafts()).toEqual({});
      expect(JSON.parse(localStorage.getItem('pevo-citation-collection'))).toEqual(COLLECTION);
    });
  });
});

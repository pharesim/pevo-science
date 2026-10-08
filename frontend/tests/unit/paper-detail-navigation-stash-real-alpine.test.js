import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NAVIGATION_STASH_KEY } from '../../src/lib/subject-bound-keys.js';

// A comment kept across the session-auth ORCID round-trip, taken back on the
// paper page in the real app.
//
// The composer and paper-page unit suites call the Alpine.data factories with
// a mocked Alpine, so they never see what makes a restored comment visible:
// the review card's `showComments` initial expression evaluated once per card
// by the keyed x-for, the review thread its x-if then mounts, the reply
// composers x-html renders into each comment tree, the `comment-restored`
// event a composer dispatches on a later tick, and the x-on in the tree
// template that opens that composer's reply box. This file boots the whole app
// once under jsdom (index.html's body, main.js, the real Alpine) and visits a
// paper page with a record already in the navigation-stash slot, the state the
// ORCID return leaves behind.
//
// Nothing in the app is mocked. Only what leaves the browser is replaced:
// fetch answers from this file's fixture paper, reviews and comment trees.
// No broadcast and no fresh-auth acquisition runs here; the record is seeded
// in the shape the session-auth redirect writes.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const WAIT = { interval: 5, timeout: 10_000 };

const ROOT = resolve(__dirname, '../..');
const INDEX_HTML = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const BODY_HTML = INDEX_HTML
  .slice(INDEX_HTML.indexOf('>', INDEX_HTML.indexOf('<body')) + 1, INDEX_HTML.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');
const EN_MESSAGES = readFileSync(resolve(ROOT, 'public/messages/en.json'), 'utf8');

const PAPER = {
  author: 'alice',
  permlink: 'p1',
  title: 'Paper p1',
  body: '## Abstract\n\nThe abstract.\n\n---\n\nIntro.',
  head_author: 'alice',
  head_permlink: 'p1',
  canonical_author: 'alice',
  canonical_permlink: 'p1',
  json_metadata: { pevotest: { type: 'paper', version: 1, discipline: 'Physics', keywords: [], authors: [] } },
  authors: [{ name: 'Alice A', hive: 'alice', orcid: '', affiliation: 'Uni A' }],
  versions: [{ version_number: 1, block_num: 100, author: 'alice', permlink: 'p1' }],
};

function review(author, permlink, { anonymous = false } = {}) {
  return {
    author,
    permlink,
    body: `Review by ${author}`,
    created: '2026-10-01T00:00:00Z',
    rating: { methodology: 3, novelty: 3, clarity: 3, significance: 3 },
    is_anonymous: anonymous,
    is_accredited: true,
    net_votes: 0,
  };
}

function comment(author, permlink, replies = []) {
  return { author, permlink, body: `Comment ${permlink}`, created: '2026-10-02T00:00:00Z', net_votes: 0, replies };
}

// The review cards. Each card a record does not name renders before the one
// it does, so a card-open check that matched too loosely would open it while
// the record is still in the slot. The two anonymous reviews share their
// author, the proxy account that posts every anonymous review.
const ENRICHMENT = {
  reviews: [
    review('dave', 'rd'),
    review('bob', 'rb'),
    review('anonproxy', 'ra1', { anonymous: true }),
    review('anonproxy', 'ra2', { anonymous: true }),
  ],
  authorship_claims: [],
};

// Comment trees by thread root: the paper's discussion and each review's
// thread. frank's rc2 is a reply nested under eve's rc1 in bob's thread.
const COMMENTS = {
  'alice/p1': [comment('eve', 'c1'), comment('frank', 'c2')],
  'bob/rb': [comment('eve', 'rc1', [comment('frank', 'rc2')])],
  'dave/rd': [comment('eve', 'rd1')],
  'anonproxy/ra1': [],
  'anonproxy/ra2': [],
};

const ACCREDITATIONS = {
  carol: { name: 'Carol C', institution: 'Uni C' },
};

// Which comment trees the page asked for, by thread root.
let commentFetches = [];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function fakeFetch(input) {
  const url = typeof input === 'string' ? input : input.url;
  const path = url.split('?')[0];
  if (path.startsWith('/messages/')) return new Response(EN_MESSAGES, { status: 200 });
  let m = path.match(/^\/api\/papers\/([^/]+)\/([^/]+)\/enrichment$/);
  if (m) return json({ data: `${m[1]}/${m[2]}` === 'alice/p1' ? ENRICHMENT : { reviews: [], authorship_claims: [] } });
  m = path.match(/^\/api\/papers\/([^/]+)\/([^/]+)\/comments$/);
  if (m) {
    commentFetches.push(`${m[1]}/${m[2]}`);
    return json({ data: COMMENTS[`${m[1]}/${m[2]}`] || [] });
  }
  m = path.match(/^\/api\/papers\/([^/]+)\/([^/]+)$/);
  if (m) {
    return `${m[1]}/${m[2]}` === 'alice/p1' ? json({ data: PAPER }) : json({ error: { code: 'NOT_FOUND' } }, 404);
  }
  m = path.match(/^\/api\/accreditations\/([^/]+)$/);
  if (m) {
    const accreditation = ACCREDITATIONS[m[1]] || null;
    return json({ data: { is_accredited: !!accreditation, accreditation } });
  }
  return json({ data: [] });
}

let router;
let auth;
// The elements Element#scrollIntoView was called on, each with whether it was
// displayed at that moment: a hidden element has no position to scroll to.
let scrolled = [];

// Let effects, $nextTick callbacks and resolved fetches run.
async function ticks(n = 10) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

// A light account, signed in the way the auth store's own login path does it.
function signInLight(username) {
  auth.loginFromResponse({
    token: `token-${username}`,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    username,
    custody: 'light',
    is_accredited: true,
    accreditation: ACCREDITATIONS[username],
  });
}

// The record the session-auth redirect writes for a comment composer.
function seedCommentRecord(subject, target, body) {
  sessionStorage.setItem(NAVIGATION_STASH_KEY, JSON.stringify({
    surface: 'comment',
    target,
    subject,
    payload: { body },
    savedAt: Date.now(),
  }));
}

// A fresh paper-page instance: leave for another route first, so the route
// change makes pageMount render the page anew.
async function visitPaper() {
  router.navigate('/about');
  await ticks();
  router.navigate('/paper/alice/p1');
  await vi.waitFor(() => expect(document.querySelector('[x-data="paperDetailPage"]')).not.toBeNull(), WAIT);
}

// Shown on screen: connected, and neither it nor any ancestor hidden by x-show.
function isDisplayed(el) {
  if (!el?.isConnected) return false;
  for (let node = el; node && node !== document.body; node = node.parentElement) {
    if (node.style?.display === 'none') return false;
  }
  return true;
}

// The first element in `scope` whose x-data expression starts with `prefix`.
// Matched in JS: jsdom's selector engine misreads these expressions inside an
// attribute selector.
function byXData(scope, prefix) {
  return [...scope.querySelectorAll('[x-data]')].find((el) => el.getAttribute('x-data').startsWith(prefix)) || null;
}

function discussionSection() {
  const pageEl = document.querySelector('[x-data="paperDetailPage"]');
  return pageEl && byXData(pageEl, 'threadedComments({ paperAuthor: paper.author');
}

// The textarea of the composer in `scope` whose x-data starts with `prefix`.
function composerTextarea(scope, prefix) {
  return byXData(scope, `commentComposer({ parentAuthor: ${prefix}`)?.querySelector('textarea') || null;
}

function reviewCard(author, permlink) {
  return document.getElementById(`review-${author}-${permlink}`);
}

// The thread a review card mounts when its comments are open.
function reviewThread(card) {
  return byXData(card, 'threadedComments({ paperAuthor: rev.author');
}

// The reply box x-html renders for one comment: the x-show wrapper and the
// composer's textarea inside it.
function replyBox(scope, author, permlink) {
  const expr = `replyOpen['comment-${author}-${permlink}']`;
  const wrapper = [...scope.querySelectorAll('[x-show]')].find((el) => el.getAttribute('x-show') === expr) || null;
  return { wrapper, textarea: wrapper?.querySelector('textarea') || null };
}

describe('a comment kept across the ORCID round-trip on the paper page (real Alpine)', () => {
  beforeAll(async () => {
    vi.stubGlobal('fetch', fakeFetch);
    window.__PEVO_CONFIG__ = { appTag: 'pevotest' };
    window.scrollTo = () => {};
    // jsdom has no scrollIntoView; record the restored composer's scroll.
    Element.prototype.scrollIntoView = function scrollIntoView() {
      scrolled.push({ el: this, displayed: isDisplayed(this) });
    };
    window.history.replaceState(null, '', '/en/about');
    document.body.innerHTML = BODY_HTML;
    await import('../../src/main.js');
    await vi.waitFor(() => expect(window.Alpine?.store('router')).toBeTruthy(), WAIT);
    router = window.Alpine.store('router');
    auth = window.Alpine.store('auth');
    await vi.waitFor(() => expect(document.querySelector('[x-data="pageMount"] > div > *')).toBeTruthy(), WAIT);
  });

  beforeEach(async () => {
    commentFetches = [];
    router.navigate('/about');
    await ticks();
    if (auth.isConnected) auth.disconnect();
    await ticks();
    sessionStorage.removeItem(NAVIGATION_STASH_KEY);
    // A restored composer scrolls two frames after it mounts, so the previous
    // case's scroll can still be pending here.
    await new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); });
    scrolled = [];
  });

  afterAll(() => {
    // Tear the app down while the document still exists, so no observer
    // fires into an environment that is already gone.
    document.body.innerHTML = '';
    delete Element.prototype.scrollIntoView;
    vi.unstubAllGlobals();
  });

  it('a reply to a discussion comment comes back in that comment\'s reply box, opened and scrolled to, and only there', async () => {
    signInLight('carol');
    seedCommentRecord('carol', {
      rootAuthor: 'alice', rootPermlink: 'p1', parentAuthor: 'eve', parentPermlink: 'c1',
    }, 'A reply to eve, kept');

    await visitPaper();
    const section = await vi.waitFor(() => {
      const el = discussionSection();
      expect(replyBox(el, 'eve', 'c1').textarea).not.toBeNull();
      return el;
    }, WAIT);
    await ticks();

    const restored = replyBox(section, 'eve', 'c1');
    await vi.waitFor(() => expect(isDisplayed(restored.wrapper)).toBe(true), WAIT);
    expect(restored.textarea.value).toBe('A reply to eve, kept');

    const sibling = replyBox(section, 'frank', 'c2');
    expect(sibling.wrapper.style.display).toBe('none');
    expect(sibling.textarea.value).toBe('');
    // The discussion's own composer does not take a reply to a comment.
    const topComposer = composerTextarea(section, 'paper.author');
    expect(topComposer.value).toBe('');

    expect(sessionStorage.getItem(NAVIGATION_STASH_KEY)).toBeNull();
    await vi.waitFor(() => expect(scrolled).toContainEqual({ el: restored.wrapper.firstElementChild, displayed: true }), WAIT);

    // A record whose root is the paper opens no review card.
    await vi.waitFor(() => expect(reviewCard('bob', 'rb')).not.toBeNull(), WAIT);
    expect(reviewThread(reviewCard('bob', 'rb'))).toBeNull();
    expect(reviewThread(reviewCard('dave', 'rd'))).toBeNull();
  });

  it('a top-level comment on the paper comes back in the discussion composer', async () => {
    signInLight('carol');
    seedCommentRecord('carol', {
      rootAuthor: 'alice', rootPermlink: 'p1', parentAuthor: 'alice', parentPermlink: 'p1',
    }, 'A comment on the paper, kept');

    await visitPaper();
    const textarea = await vi.waitFor(() => {
      const el = discussionSection() && composerTextarea(discussionSection(), 'paper.author');
      expect(el).not.toBeNull();
      return el;
    }, WAIT);
    await vi.waitFor(() => expect(textarea.value).toBe('A comment on the paper, kept'), WAIT);
    expect(isDisplayed(textarea)).toBe(true);
    expect(sessionStorage.getItem(NAVIGATION_STASH_KEY)).toBeNull();

    // The comment trees rendered after the take and stayed closed.
    await vi.waitFor(() => expect(replyBox(discussionSection(), 'eve', 'c1').wrapper).not.toBeNull(), WAIT);
    await ticks();
    expect(replyBox(discussionSection(), 'eve', 'c1').wrapper.style.display).toBe('none');
    expect(replyBox(discussionSection(), 'frank', 'c2').wrapper.style.display).toBe('none');
  });

  it("a comment on a review opens that review's card, and the review's composer holds it", async () => {
    signInLight('carol');
    seedCommentRecord('carol', {
      rootAuthor: 'bob', rootPermlink: 'rb', parentAuthor: 'bob', parentPermlink: 'rb',
    }, 'A comment on bob\'s review, kept');

    await visitPaper();
    const card = await vi.waitFor(() => {
      const el = reviewCard('bob', 'rb');
      expect(el).not.toBeNull();
      return el;
    }, WAIT);

    const thread = await vi.waitFor(() => {
      const el = reviewThread(card);
      expect(el).not.toBeNull();
      return el;
    }, WAIT);
    const textarea = composerTextarea(thread, 'rev.author');
    await vi.waitFor(() => expect(textarea.value).toBe('A comment on bob\'s review, kept'), WAIT);
    expect(isDisplayed(textarea)).toBe(true);
    await vi.waitFor(() => expect(commentFetches).toContain('bob/rb'), WAIT);
    expect(sessionStorage.getItem(NAVIGATION_STASH_KEY)).toBeNull();

    // The other review's card, created while the record was still in the
    // slot, stays collapsed, and the discussion composer is left empty.
    expect(reviewThread(reviewCard('dave', 'rd'))).toBeNull();
    expect(commentFetches).not.toContain('dave/rd');
    const topComposer = composerTextarea(discussionSection(), 'paper.author');
    expect(topComposer.value).toBe('');
  });

  it('a comment on one of two anonymous reviews opens only that review\'s card, though both share the proxy author', async () => {
    signInLight('carol');
    seedCommentRecord('carol', {
      rootAuthor: 'anonproxy', rootPermlink: 'ra2', parentAuthor: 'anonproxy', parentPermlink: 'ra2',
    }, 'A comment on the second anonymous review, kept');

    await visitPaper();
    const card = await vi.waitFor(() => {
      const el = reviewCard('anonproxy', 'ra2');
      expect(el).not.toBeNull();
      expect(reviewThread(el)).not.toBeNull();
      return el;
    }, WAIT);
    const textarea = composerTextarea(reviewThread(card), 'rev.author');
    await vi.waitFor(() => expect(textarea.value).toBe('A comment on the second anonymous review, kept'), WAIT);
    expect(sessionStorage.getItem(NAVIGATION_STASH_KEY)).toBeNull();

    expect(reviewThread(reviewCard('anonproxy', 'ra1'))).toBeNull();
    expect(commentFetches).not.toContain('anonproxy/ra1');
  });

  it("a reply nested in a review's thread opens the card, loads the thread, and comes back in the nested reply box", async () => {
    signInLight('carol');
    seedCommentRecord('carol', {
      rootAuthor: 'bob', rootPermlink: 'rb', parentAuthor: 'frank', parentPermlink: 'rc2',
    }, 'A reply to frank in bob\'s thread, kept');

    await visitPaper();
    const card = await vi.waitFor(() => {
      const el = reviewCard('bob', 'rb');
      expect(el).not.toBeNull();
      return el;
    }, WAIT);
    const thread = await vi.waitFor(() => {
      const el = reviewThread(card);
      expect(el).not.toBeNull();
      expect(replyBox(el, 'frank', 'rc2').textarea).not.toBeNull();
      return el;
    }, WAIT);
    await ticks();

    const restored = replyBox(thread, 'frank', 'rc2');
    await vi.waitFor(() => expect(isDisplayed(restored.wrapper)).toBe(true), WAIT);
    expect(restored.textarea.value).toBe('A reply to frank in bob\'s thread, kept');

    // The parent comment's own reply box and the review's composer stay as
    // they were: neither is the composer the record names.
    const parentBox = replyBox(thread, 'eve', 'rc1');
    expect(parentBox.wrapper.style.display).toBe('none');
    expect(parentBox.textarea.value).toBe('');
    const reviewComposer = composerTextarea(thread, 'rev.author');
    expect(reviewComposer.value).toBe('');

    expect(sessionStorage.getItem(NAVIGATION_STASH_KEY)).toBeNull();
    expect(reviewThread(reviewCard('dave', 'rd'))).toBeNull();
  });

  it('with no record in the slot, every review card stays collapsed and every reply box closed', async () => {
    signInLight('carol');

    await visitPaper();
    await vi.waitFor(() => {
      expect(reviewCard('bob', 'rb')).not.toBeNull();
      expect(reviewCard('dave', 'rd')).not.toBeNull();
      expect(replyBox(discussionSection(), 'eve', 'c1').wrapper).not.toBeNull();
    }, WAIT);
    await ticks(20);

    for (const [author, permlink] of [['dave', 'rd'], ['bob', 'rb'], ['anonproxy', 'ra1'], ['anonproxy', 'ra2']]) {
      expect(reviewCard(author, permlink)).not.toBeNull();
      expect(reviewThread(reviewCard(author, permlink))).toBeNull();
    }
    expect(commentFetches).toEqual(['alice/p1']);
    expect(replyBox(discussionSection(), 'eve', 'c1').wrapper.style.display).toBe('none');
    expect(replyBox(discussionSection(), 'frank', 'c2').wrapper.style.display).toBe('none');
    expect(scrolled).toEqual([]);
  });
});

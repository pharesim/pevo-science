// A publish submit is a batch of legs: the PDF upload, each supplementary
// upload, then the broadcast. A subject teardown that lands while the submit
// is under way (a login as another account in another tab, reaching this tab
// through the storage event) must stop every leg after it. The next upload
// would otherwise acquire a window for whoever the tab now represents,
// prompting them and spending their mint on the departed account's files, and
// the broadcast would still go out under the username captured at submit
// entry.
//
// Real here: the auth store (`initAuth`) and its subject scrub,
// `lib/fresh-auth.js` with its teardown guard and window cache, and
// `lib/ipfs-upload.js#uploadFile`. The subject
// change is driven through the store's own storage-event handler rather than
// a staged helper, so the generation the submit's guard reads is the one the
// real scrub bumps. `pages-publish.test.js` routes `uploadFile` through a
// stub, which can show neither a prompt nor a mint inside an upload leg; that
// is what this file adds.
//
// Mocking justification (clause-a of project-CLAUDE.md "Carve-out for
// deterministic edge-case coverage"): `uploadFileToIpfs`, `fetchEmailStatus`
// and `mintSessionAuthProof` each perform a real fetch(). A case that lands
// the subject change inside a transfer needs that transfer to settle on the
// test's signal rather than the network's, and the factor read and the mint
// have to answer for the account that has just signed in, on cue. `broadcastOps` is mocked so a broadcast that must not be issued shows
// up as a call rather than a chain write. `crypto.js#sha256File` is stubbed
// because the fixture's files are plain objects that carry no bytes.
// `fetchAccreditationStatus` answers the accreditation poll the store starts
// on sign-in, and the config stub pins the app tag and the upload limit. The
// other stubs (`startOrcid`, `consentOpRequestFields`, `fetchAccreditations`,
// keychain, request signing, the editor) stand in for dependencies no case
// exercises.
// Clause-b: no auth middleware is mocked and no cryptographic verification is
// bypassed; these cases assert which client legs run after the subject
// changed. Clause-c: `frontend/tests/e2e/non-consent-fresh-auth.spec.js`
// drives a publish with a PDF through the real upload pre-flight, transfer and
// broadcast; no e2e spec changes the subject while a submit is between its
// legs, so that class is covered here only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { stores, mockUploadFileToIpfs, mockMintSessionAuthProof, mockFetchEmailStatus } = vi.hoisted(() => ({
  stores: {},
  mockUploadFileToIpfs: vi.fn(),
  mockMintSessionAuthProof: vi.fn(),
  mockFetchEmailStatus: vi.fn(),
}));

// A named store registry, so `initAuth()` registers the real auth store and
// every `Alpine.store('auth')` read in the page and in fresh-auth.js
// resolves to that same object.
vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name, def) => {
      if (def !== undefined) stores[name] = def;
      return stores[name] ?? {};
    }),
  },
}));

vi.mock('../../src/api.js', () => ({
  uploadFileToIpfs: (...a) => mockUploadFileToIpfs(...a),
  mintSessionAuthProof: (...a) => mockMintSessionAuthProof(...a),
  fetchEmailStatus: (...a) => mockFetchEmailStatus(...a),
  startOrcid: vi.fn(),
  consentOpRequestFields: (t) => t,
  fetchAccreditationStatus: vi.fn(async () => ({ data: null })),
  fetchAccreditations: vi.fn(async () => ({ data: [] })),
}));

vi.mock('../../src/signer.js', () => ({ broadcastOps: vi.fn() }));
vi.mock('../../src/keychain.js', () => ({ waitForKeychain: vi.fn(async () => false) }));
vi.mock('../../src/sign-request.js', () => ({ signRequest: vi.fn() }));
vi.mock('../../src/editor.js', () => ({ createEditor: vi.fn() }));
vi.mock('../../src/crypto.js', async (importOriginal) => ({
  ...(await importOriginal()),
  sha256File: vi.fn(async () => 'abc123'),
}));
vi.mock('../../src/config.js', () => ({
  getAppTag: () => 'pevotest',
  getAppId: () => 'pevotest/1.0',
  getMaxUploadSize: () => 50 * 1024 * 1024,
  getMaxUploadSizeMB: () => 50,
}));

import Alpine from 'alpinejs';
import { broadcastOps } from '../../src/signer.js';
import { initAuth } from '../../src/auth.js';
import { initPublishPage } from '../../src/pages/publish.js';
import {
  cacheSessionProof,
  clearCachedSessionProof,
  clearPasswordFactorMemo,
  abandonInFlightAcquisitions,
} from '../../src/lib/fresh-auth.js';

const SESSION_KEY = 'pevo_session';
const FUTURE = '2099-01-01T00:00:00.000Z';
// A localized value distinct from every English fallback, so the one message
// the user gets can be named: the teardown cancel, not some other refusal.
const TEARDOWN_MESSAGE = 'LOCALIZED-teardown-cancel';

let auth;
// The component under test, destroyed after every case so a red run's
// landed submit cannot leave its navigate timer behind.
let comp = null;

// A macrotask hop: what a transfer on the network costs, and the earliest
// point a storage event from another tab can reach this one.
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

// Another tab signs in as `username`: it writes the session, and this tab's
// store takes it up through the storage event, running its subject scrub.
function crossTabLogin(username) {
  const saved = JSON.stringify({
    token: `${username}-jwt`,
    username,
    expiresAt: FUTURE,
    isAccredited: true,
    accreditation: null,
    custody: 'light',
  });
  localStorage.setItem(SESSION_KEY, saved);
  auth._handleStorageEvent({ key: SESSION_KEY, newValue: saved });
}

// The transfer leg as the network would run it. The subject change to
// mallory, when a case stages one, lands while the `landOn`-th transfer is
// still in flight; that transfer then completes, so the leg itself succeeds
// and only the legs after it see a different subject.
function transfers({ landOn = null } = {}) {
  mockUploadFileToIpfs.mockImplementation(async (file) => {
    const n = mockUploadFileToIpfs.mock.calls.length;
    await tick();
    if (n === landOn) crossTabLogin('mallory');
    return { status: 'ok', data: { cid: `bafy-${n}`, filename: file.name, type: 'text/csv', size: 10 } };
  });
}

function supplementary(name) {
  return { file: { name, size: 10, type: 'text/csv' }, fileName: name, description: '', uploading: false, cid: null, error: null };
}

function submittableComponent() {
  initPublishPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  comp = factory();
  comp.$t = (key) => key;
  comp.$watch = vi.fn();
  comp.$nextTick = vi.fn((fn) => fn && fn());
  comp.$refs = { abstractEditor: null, bodyEditor: null };
  comp.title = 'My Paper';
  comp.abstract = 'Paper abstract';
  comp.body = 'Body text';
  comp.discipline = 'Physics';
  comp.authorName = 'Alice';
  return comp;
}

// Every user-facing outcome these cases care about, in one value, so a red
// run names every clause that broke rather than the first one.
function outcome() {
  return {
    transfers: mockUploadFileToIpfs.mock.calls.length,
    prompts: stores.reauthModal.request.mock.calls.length,
    mints: mockMintSessionAuthProof.mock.calls.length,
    broadcasts: broadcastOps.mock.calls.length,
    messages: stores.toast.show.mock.calls.map(([msg]) => msg),
    step: comp.step,
    errorMessage: comp.errorMessage,
    rowErrors: comp.supplementaryFiles.map((sf) => sf.error),
    uploading: comp.supplementaryFiles.map((sf) => sf.uploading),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  // Module state outlives a case: the in-memory window mirror, the factor
  // memo, and any flight a failing case left parked.
  clearCachedSessionProof();
  clearPasswordFactorMemo();
  abandonInFlightAcquisitions();
  stores.toast = { show: vi.fn() };
  stores.router = { params: {}, query: {}, navigate: vi.fn(), remount: vi.fn() };
  stores.broadcastConfirm = { request: vi.fn(async () => true) };
  stores.reauthModal = { request: vi.fn(async () => 'hunter2'), cancel: vi.fn() };
  stores.i18n = { messages: { auth: { reauthCancelled: TEARDOWN_MESSAGE } } };
  mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: true } });
  mockMintSessionAuthProof.mockImplementation(async () => ({
    fresh_auth_proof: `${auth.username}-window`,
    expires_at: new Date(Date.now() + 900_000).toISOString(),
    absolute_expires_at: new Date(Date.now() + 7_200_000).toISOString(),
    mechanism: 'password',
  }));
  broadcastOps.mockResolvedValue({ tx_id: 'tx' });
  initAuth();
  auth = stores.auth;
  auth.loginFromResponse({
    token: 'alice-jwt', expires_at: FUTURE, username: 'alice', custody: 'light',
    is_accredited: true, accreditation: null,
  });
  // Alice opened her window when she picked the files, so the submit's own
  // gates are cache hits and every prompt or mint a case observes is one
  // charged after the subject changed.
  cacheSessionProof(
    'alice-window',
    new Date(Date.now() + 900_000).toISOString(),
    new Date(Date.now() + 7_200_000).toISOString(),
  );
});

afterEach(() => {
  comp?.destroy();
  comp = null;
  auth._stopAccreditationPolling();
});

describe('publish submit: one subject across every leg', () => {
  it('without a subject change, every leg runs on the one window and lands', async () => {
    // The control for the stopped batches: the same fixture with no teardown
    // reaches the broadcast, so a case that sees no broadcast was stopped,
    // not stranded by its own scaffolding.
    transfers();
    submittableComponent();
    comp.supplementaryFiles = [supplementary('s1.csv'), supplementary('s2.csv')];

    await comp.handleSubmit();

    expect(outcome()).toEqual({
      transfers: 2, prompts: 0, mints: 0, broadcasts: 1, messages: [],
      step: 'success', errorMessage: '', rowErrors: [null, null], uploading: [false, false],
    });
    expect(mockUploadFileToIpfs.mock.calls.map(([, opts]) => opts?.freshAuthProof))
      .toEqual(['alice-window', 'alice-window']);
    expect(broadcastOps.mock.calls[0][2]).toMatchObject({ freshAuthProof: 'alice-window' });
  });

  it('a subject change between two supplementary uploads stops the batch: no further upload, no prompt, no mint, one message', async () => {
    transfers({ landOn: 1 });
    submittableComponent();
    comp.supplementaryFiles = [supplementary('s1.csv'), supplementary('s2.csv')];

    await comp.handleSubmit();

    // The teardown did land, inside the first transfer.
    expect(auth.username).toBe('mallory');
    expect(outcome()).toEqual({
      transfers: 1, prompts: 0, mints: 0, broadcasts: 0, messages: [TEARDOWN_MESSAGE],
      step: 'idle', errorMessage: '', rowErrors: [null, null], uploading: [false, false],
    });
  });

  it('a subject change between the last upload and the broadcast stops the submit before the broadcast is issued', async () => {
    transfers({ landOn: 1 });
    submittableComponent();
    comp.pdfFile = { name: 'paper.pdf', size: 1024, type: 'application/pdf' };

    await comp.handleSubmit();

    expect(auth.username).toBe('mallory');
    // The pre-broadcast gate is a leg too: a prompt or a mint there would
    // spend the new subject's credential on the departed subject's publish.
    expect(outcome()).toEqual({
      transfers: 1, prompts: 0, mints: 0, broadcasts: 0, messages: [TEARDOWN_MESSAGE],
      step: 'idle', errorMessage: '', rowErrors: [], uploading: [],
    });
  });

  it('a subject change while the publish confirmation is open stops the submit before the first upload', async () => {
    // The guard opens at submit entry, so the dwell on the dialog is inside
    // the batch it spans.
    transfers();
    stores.broadcastConfirm.request.mockImplementation(async () => {
      await tick();
      crossTabLogin('mallory');
      return true;
    });
    submittableComponent();
    comp.pdfFile = { name: 'paper.pdf', size: 1024, type: 'application/pdf' };

    await comp.handleSubmit();

    expect(outcome()).toEqual({
      transfers: 0, prompts: 0, mints: 0, broadcasts: 0, messages: [TEARDOWN_MESSAGE],
      step: 'idle', errorMessage: '', rowErrors: [], uploading: [],
    });
  });

  it('a subject change while the entry gate offers the navigation stops the submit before the confirmation and every leg', async () => {
    // Alice has no password, so with a file held the entry gate refuses the
    // navigating factor and offers it. Mallory signs in while the offer is
    // open and has a password, so the yes re-acquires for her and the gate
    // answers ready. That re-acquisition's prompt and mint are not asserted.
    clearCachedSessionProof();
    mockFetchEmailStatus.mockImplementation(async () => ({ data: { hasPassword: auth.username !== 'alice' } }));
    stores.broadcastConfirm.request.mockImplementationOnce(async () => {
      await tick();
      crossTabLogin('mallory');
      return true;
    });
    transfers();
    submittableComponent();
    comp.supplementaryFiles = [supplementary('s1.csv')];

    await comp.handleSubmit();

    expect(auth.username).toBe('mallory');
    const dialogs = stores.broadcastConfirm.request.mock.calls.map(([{ title }]) => title);
    expect({ ...outcome(), dialogs }).toMatchObject({
      transfers: 0, broadcasts: 0, messages: [TEARDOWN_MESSAGE], step: 'idle', uploading: [false],
      dialogs: ['confirm.reauthNavigateTitle'],
    });
  });
});

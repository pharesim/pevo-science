import { describe, it, expect, vi, beforeEach } from 'vitest';

// The upload surface driven through the REAL session window, rather than
// through a stubbed `ensureSessionWindow`.
//
// `lib-ipfs-upload.test.js` is the orchestration suite: it replaces
// `lib/fresh-auth.js` wholesale at the module boundary and drives each window
// outcome by returning the outcome object directly. That is the right shape for
// the retry legs and the teardown gating it covers, and the wrong shape for one
// question it cannot ask: what the upload path does with a proof the window
// hands over as READY while the value itself is unusable. A stubbed gate can
// only return outcomes someone chose to write down, so a falsy-but-ready proof
// escaping the real gate is invisible there by construction.
//
// So this file keeps `lib/fresh-auth.js` real and joins the two layers at
// `api.js` instead. The window is acquired the way production acquires it (the
// factor read, the password prompt, the mint, the cache write) and the proof it
// produces travels into `uploadFile` unexamined by any test double.
//
// Mocking justification (clause-a of project-CLAUDE.md "Carve-out for
// deterministic edge-case coverage"): every function mocked here is an `api.js`
// export that performs a real fetch(). Reproducing a mint that answers with a
// malformed proof means a backend that violates its own response contract,
// which no live deployment can be asked for; and `uploadFileToIpfs` hashes the
// file through `sha256File` before its first request, and `sha256File` calls
// `file.arrayBuffer()`, which jsdom's Blob does not implement (`crypto.test.js`
// records the same gap); `crypto.subtle` itself is present, as
// `harness.test.js` asserts. The window itself, the gate, the eviction and the
// upload orchestration are all real.
//
// `mockUploadFileToIpfs` MIRRORS one real behavior rather than inventing one:
// `uploadFileToIpfs` throws FRESH_AUTH_REQUIRED with `reason: 'missing'`
// client-side, before any request, when a non-self-custody caller passes no
// proof. That throw is the whole consequence of taking the unproofed branch on
// a light account, so a mirror that skipped it would let the case under test
// look like a success.
//
// Auth-focus carve-out (clause-b): no auth middleware is mocked and no
// cryptographic verification is bypassed. The proof is minted and verified
// server-side; these tests assert which proof the upload path attaches and what
// it does when the window hands it one it cannot use.
//
// Clause-c real-path companion: `frontend/tests/e2e/non-consent-fresh-auth.spec.js`
// drives this same join against the real backend. Its publish test acquires the
// window at file selection through the real POST /custody/session-auth, then
// asserts the real POST /ipfs/upload-token pre-flight carried that window proof
// and that the real POST /ipfs/upload transfer returned a CID. That test skips
// itself when HAF indexes no accredited researcher, so the companion is
// environment-gated. A mint answering with a malformed proof has no real-path
// companion and cannot have one: it is a backend contract violation.

const mockUploadFileToIpfs = vi.fn();
const mockMintSessionAuthProof = vi.fn();
const mockFetchEmailStatus = vi.fn();
const mockStartOrcid = vi.fn();

vi.mock('../../src/api.js', async (importOriginal) => {
  // Spread the real module so ApiRequestError (and every other real export)
  // stays available; override only the four functions that would leave the
  // process. Tests build errors via the real ApiRequestError so the shape stays
  // honest -- the class carries `code`, never `status`
  // (test-fabricated-error-shape convention).
  const actual = await importOriginal();
  return {
    ...actual,
    uploadFileToIpfs: (...a) => mockUploadFileToIpfs(...a),
    mintSessionAuthProof: (...a) => mockMintSessionAuthProof(...a),
    fetchEmailStatus: (...a) => mockFetchEmailStatus(...a),
    startOrcid: (...a) => mockStartOrcid(...a),
  };
});

const mockReauthModal = { request: vi.fn() };
const mockToastStore = { show: vi.fn() };
const mockAuthStore = {
  custody: 'light', username: 'alice', token: 'jwt', isConnected: true, disconnect: vi.fn(),
};

vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name) => {
      if (name === 'auth') return mockAuthStore;
      if (name === 'toast') return mockToastStore;
      if (name === 'reauthModal') return mockReauthModal;
      if (name === 'i18n') return { messages: {} };
      return {};
    }),
  },
}));

const { uploadFile, describeUploadError, UPLOAD_REAUTH_FAILED, UPLOAD_SESSION_TORN_DOWN } =
  await import('../../src/lib/ipfs-upload.js');
const { clearCachedSessionProof, clearPasswordFactorMemo, abandonInFlightAcquisitions } =
  await import('../../src/lib/fresh-auth.js');
const { ApiRequestError } = await import('../../src/api.js');

const IDLE_MS = 900_000;       // 15 minutes, the backend's idle period
const ABSOLUTE_MS = 7_200_000; // 2 hours, the backend's absolute cap

function issuance(token) {
  return {
    fresh_auth_proof: token,
    expires_at: new Date(Date.now() + IDLE_MS).toISOString(),
    absolute_expires_at: new Date(Date.now() + ABSOLUTE_MS).toISOString(),
    mechanism: 'password',
  };
}

const file = () => new Blob(['x'], { type: 'application/pdf' });
const okUpload = (cid) => ({ status: 'ok', data: { cid, filename: 'f', type: 'application/pdf', size: 1 } });

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  clearCachedSessionProof();
  // The tab-lifetime memo and the acquisition slots both outlive a single case:
  // the memo would carry one case's `hasPassword` answer into the next, and a
  // flight parked by a failing case would be JOINED by the next one instead of
  // its own cold acquisition, reporting one red case as several.
  clearPasswordFactorMemo();
  abandonInFlightAcquisitions();
  mockAuthStore.custody = 'light';
  mockAuthStore.username = 'alice';
  // The production disconnect as far as this module can see it: the liveness
  // flag drops and the subject scrub abandons every flight in the air.
  mockAuthStore.isConnected = true;
  mockAuthStore.disconnect.mockImplementation(() => {
    mockAuthStore.isConnected = false;
    abandonInFlightAcquisitions();
  });
  mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
  mockReauthModal.request.mockResolvedValue('hunter2');
  mockMintSessionAuthProof.mockImplementation(async () => issuance('window-proof'));
  mockUploadFileToIpfs.mockImplementation(async (_f, opts) => {
    if (mockAuthStore.custody !== 'self' && !opts?.freshAuthProof) {
      throw new ApiRequestError(
        'FRESH_AUTH_REQUIRED',
        'Re-authentication required to upload',
        null,
        { reason: 'missing' },
      );
    }
    return okUpload('QmCid');
  });
});

describe('the upload pre-flight over the real window', () => {
  it('a live window reaches the pre-flight as the proof it was minted as', async () => {
    // The control for the empty-string case. Without it a refusal there
    // could come from scaffolding that never opens a window at all, and the
    // red would prove nothing about the empty-string proof.
    await expect(uploadFile(file())).resolves.toEqual(okUpload('QmCid'));

    expect(mockUploadFileToIpfs).toHaveBeenCalledWith(expect.anything(), { freshAuthProof: 'window-proof' });
    expect(mockReauthModal.request).toHaveBeenCalledTimes(1);
  });

  it('self-custody still takes the unproofed call, with no window acquired', async () => {
    // The branch the empty-string case is wrongly routed into, asserted for the
    // account it actually belongs to. Keychain signs the pre-flight descriptor
    // per request, so `ensureSessionWindow` hands back a null proof and no
    // re-auth act is owed; a fix that made the falsy branch itself refuse
    // would break this and not the empty-string case.
    mockAuthStore.custody = 'self';

    await expect(uploadFile(file())).resolves.toEqual(okUpload('QmCid'));

    expect(mockUploadFileToIpfs).toHaveBeenCalledWith(expect.anything());
    expect(mockUploadFileToIpfs.mock.calls[0]).toHaveLength(1);
    expect(mockReauthModal.request).not.toHaveBeenCalled();
    expect(mockMintSessionAuthProof).not.toHaveBeenCalled();
  });

  it('a window minted from an empty-string proof is refused, not spent on an unproofed upload', async () => {
    // `''` is falsy AND a string, so a gate that narrows on the TYPE alone
    // hands it over as ready and the pre-flight reads it exactly as it reads
    // self-custody's null: no proof needed. The light account then takes the
    // unproofed call above, which `api.js` refuses client-side before any
    // request.
    //
    // Three separate things go wrong at once there, and each assertion below
    // pins one. The unproofed call happens at all. Its rejection is raised
    // AHEAD of the try that owns the retry legs, so it escapes as a raw
    // ApiRequestError with no attempt re-made, even though `reason: 'missing'`
    // is remintable. And a raw ApiRequestError carries no upload code, so
    // `describeUploadError` falls to its default and the user is told the
    // upload failed rather than that re-authentication is the way through.
    mockMintSessionAuthProof.mockImplementation(async () => ({
      ...issuance('window-proof'),
      fresh_auth_proof: '',
    }));

    const err = await uploadFile(file()).then(() => null, (e) => e);

    expect(err?.code).toBe(UPLOAD_REAUTH_FAILED);
    expect(describeUploadError(err)).toBe('settings.reauthFailed');
    expect(mockUploadFileToIpfs).not.toHaveBeenCalled();
  });
});

describe('a corrupted session detected on the upload surface', () => {
  const mismatch = () => new ApiRequestError(
    'FRESH_AUTH_REQUIRED',
    'FRESH_AUTH_REQUIRED',
    null,
    { reason: 'username_mismatch' },
  );

  it('two uploads detecting the same corrupted session tear down and report once', async () => {
    // Inline images go up side by side, so one corrupted session can be
    // detected by every transfer in the air. The user is owed one teardown
    // and one re-login message for it; each upload still rejects with the
    // already-reported code so the page stacks nothing on top.
    const rejects = [];
    mockUploadFileToIpfs.mockImplementation(
      () => new Promise((_, reject) => { rejects.push(reject); }),
    );

    const first = uploadFile(file()).then(() => null, (e) => e);
    const second = uploadFile(file()).then(() => null, (e) => e);
    await vi.waitFor(() => expect(rejects).toHaveLength(2));

    rejects[0](mismatch());
    rejects[1](mismatch());

    expect((await first)?.code).toBe(UPLOAD_SESSION_TORN_DOWN);
    expect((await second)?.code).toBe(UPLOAD_SESSION_TORN_DOWN);
    expect(mockAuthStore.disconnect).toHaveBeenCalledTimes(1);
    expect(mockToastStore.show).toHaveBeenCalledTimes(1);
    expect(mockToastStore.show).toHaveBeenCalledWith(
      'Session inconsistency detected. Please sign in again.',
      'error',
    );
  });
});
